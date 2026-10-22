"""Provider adapters against fake HTTP transports (no network)."""

from __future__ import annotations

import json

import httpx
import pytest

from missile_studio.config import ProviderConfig
from missile_studio.providers.anthropic import AnthropicProvider, to_anthropic_messages
from missile_studio.providers.gemini import GeminiProvider, to_gemini_contents
from missile_studio.providers.openai_compat import OpenAICompatProvider, to_openai_messages


def sse(*frames: str) -> bytes:
    return "".join(f"data: {f}\n\n" for f in frames).encode()


def make(provider_cls, cfg: ProviderConfig, handler):
    transport = httpx.MockTransport(handler)
    client = httpx.AsyncClient(transport=transport)
    return provider_cls(cfg, client=client)


async def collect(p, model="m", messages=None, tools=None):
    out = []
    async for ev in p.stream(model, messages or [{"role": "user", "content": "hi"}], tools):
        out.append(ev)
    return out


# ---------------------------------------------------------------- openai

@pytest.mark.asyncio
async def test_openai_text_and_tool_calls_stream():
    seen = {}

    def handler(req: httpx.Request):
        seen["body"] = json.loads(req.content)
        seen["accept"] = req.headers.get("accept")
        frames = [
            json.dumps({"choices": [{"delta": {"role": "assistant", "content": "Hel"}}]}),
            json.dumps({"choices": [{"delta": {"content": "lo"}}]}),
            json.dumps({"choices": [{"delta": {"reasoning_content": "thinking..."}}]}),
            json.dumps({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_1", "function": {"name": "echo__add", "arguments": '{"a": '}}]}}]}),
            json.dumps({"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": '1, "b": 2}'}}]}}]}),
            json.dumps({"choices": [{"delta": {}, "finish_reason": "tool_calls"}], "usage": {"prompt_tokens": 10, "completion_tokens": 5}}),
            "[DONE]",
        ]
        return httpx.Response(200, content=sse(*frames), headers={"content-type": "text/event-stream"})

    p = make(OpenAICompatProvider, ProviderConfig(id="x", kind="openai", base_url="http://fake/v1", api_key="k", extra_body={"enable_thinking": False}), handler)
    tools = [{"name": "echo__add", "description": "add", "input_schema": {"type": "object", "properties": {"a": {"type": "number"}}}}]
    evs = await collect(p, tools=tools)
    text = "".join(e["text"] for e in evs if e["type"] == "text_delta")
    assert text == "Hello"
    assert any(e["type"] == "thinking_delta" for e in evs)
    calls = [e for e in evs if e["type"] == "tool_call"]
    assert calls == [{"type": "tool_call", "id": "call_1", "name": "echo__add", "arguments": {"a": 1, "b": 2}}]
    assert evs[-1] == {"type": "done", "finish_reason": "tool_calls", "server_finish": "tool_calls", "stop_reason": None}
    assert any(e["type"] == "usage" and e["input_tokens"] == 10 for e in evs)
    assert seen["body"]["enable_thinking"] is False
    assert seen["body"]["tools"][0]["function"]["name"] == "echo__add"
    assert seen["body"]["stream"] is True
    assert seen["accept"] == "text/event-stream"


@pytest.mark.asyncio
async def test_openai_http_error_is_event():
    def handler(req):
        return httpx.Response(401, json={"error": {"message": "bad key"}})

    p = make(OpenAICompatProvider, ProviderConfig(id="x", kind="openai", base_url="http://fake/v1"), handler)
    evs = await collect(p)
    assert evs[0]["type"] == "error" and "401" in evs[0]["message"]


@pytest.mark.asyncio
async def test_openai_list_models_falls_back_to_ollama_tags():
    def handler(req):
        if req.url.path.endswith("/v1/models"):
            return httpx.Response(404)
        if req.url.path.endswith("/api/tags"):
            return httpx.Response(200, json={"models": [{"name": "qwen3:8b"}, {"name": "llama3:latest"}]})
        return httpx.Response(500)

    p = make(OpenAICompatProvider, ProviderConfig(id="o", kind="openai", base_url="http://fake:11434/v1"), handler)
    assert await p.list_models() == ["llama3:latest", "qwen3:8b"]


def test_openai_message_translation():
    msgs = [
        {"role": "system", "content": "s"},
        {"role": "user", "content": "u"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "name": "t", "arguments": {"x": 1}}]},
        {"role": "tool", "tool_call_id": "c1", "name": "t", "content": "r"},
    ]
    out = to_openai_messages(msgs)
    assert out[2]["content"] is None
    assert out[2]["tool_calls"][0]["function"]["arguments"] == '{"x": 1}'
    assert out[3] == {"role": "tool", "tool_call_id": "c1", "content": "r"}


# ---------------------------------------------------------------- anthropic

@pytest.mark.asyncio
async def test_anthropic_stream_tool_use():
    seen = {}

    def handler(req: httpx.Request):
        seen["body"] = json.loads(req.content)
        seen["headers"] = dict(req.headers)
        frames = [
            ("message_start", {"type": "message_start", "message": {"usage": {"input_tokens": 7, "output_tokens": 1}}}),
            ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
            ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hi"}}),
            ("content_block_stop", {"type": "content_block_stop", "index": 0}),
            ("content_block_start", {"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "toolu_1", "name": "echo__echo", "input": {}}}),
            ("content_block_delta", {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": '{"text": "a'}}),
            ("content_block_delta", {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": 'b"}'}}),
            ("content_block_stop", {"type": "content_block_stop", "index": 1}),
            ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 12}}),
            ("message_stop", {"type": "message_stop"}),
        ]
        body = "".join(f"event: {e}\ndata: {json.dumps(d)}\n\n" for e, d in frames).encode()
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})

    p = make(AnthropicProvider, ProviderConfig(id="a", kind="anthropic", api_key="k"), handler)
    msgs = [{"role": "system", "content": "be brief"}, {"role": "user", "content": "hi"}]
    evs = await collect(p, messages=msgs, tools=[{"name": "echo__echo", "description": "e", "input_schema": {"type": "object", "properties": {}}}])
    assert seen["body"]["system"][0]["text"] == "be brief" and seen["body"]["system"][0]["cache_control"] == {"type": "ephemeral"}  # cached system block
    assert seen["headers"]["x-api-key"] == "k"
    assert "conversation_id" not in seen["body"]
    assert [e for e in evs if e["type"] == "tool_call"] == [{"type": "tool_call", "id": "toolu_1", "name": "echo__echo", "arguments": {"text": "ab"}}]
    assert evs[-1]["finish_reason"] == "tool_calls"


def test_anthropic_message_folding():
    msgs = [
        {"role": "assistant", "content": "orphan assistant first"},
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "t1", "name": "x", "arguments": {}}]},
        {"role": "tool", "tool_call_id": "t1", "content": "res", "is_error": True},
        {"role": "user", "content": [{"type": "text", "text": "see"}, {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}]},
    ]
    out = to_anthropic_messages(msgs)
    assert out[0]["role"] == "user"  # orphan assistant dropped
    assert out[1]["content"][0]["type"] == "tool_use"
    assert out[2]["role"] == "user" and out[2]["content"][0]["type"] == "tool_result" and out[2]["content"][0]["is_error"] is True
    assert out[2]["content"][1]["type"] == "text" and out[2]["content"][2]["type"] == "image"


# ---------------------------------------------------------------- gemini

@pytest.mark.asyncio
async def test_gemini_stream_function_call():
    seen = {}

    def handler(req: httpx.Request):
        seen["url"] = str(req.url)
        seen["body"] = json.loads(req.content)
        frames = [
            json.dumps({"candidates": [{"content": {"parts": [{"text": "Sure"}]}}]}),
            json.dumps({"candidates": [{"content": {"parts": [{"functionCall": {"name": "echo__add", "args": {"a": 1, "b": 2}}}]}, "finishReason": "STOP"}], "usageMetadata": {"promptTokenCount": 3, "candidatesTokenCount": 4}}),
        ]
        return httpx.Response(200, content=sse(*frames), headers={"content-type": "text/event-stream"})

    p = make(GeminiProvider, ProviderConfig(id="g", kind="gemini", api_key="k"), handler)
    evs = await collect(p, model="gemini-2.5-flash", tools=[{"name": "echo__add", "description": "d", "input_schema": {"type": "object", "properties": {"a": {"type": "number", "default": 1}}, "additionalProperties": False}}])
    assert "streamGenerateContent?alt=sse" in seen["url"]
    decl = seen["body"]["tools"][0]["functionDeclarations"][0]
    assert "additionalProperties" not in decl["parameters"] and "default" not in decl["parameters"]["properties"]["a"]
    assert [e for e in evs if e["type"] == "tool_call"][0]["arguments"] == {"a": 1, "b": 2}
    assert evs[-1]["finish_reason"] == "tool_calls"


def test_gemini_contents_tool_results_grouped():
    msgs = [
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "1", "name": "a", "arguments": {}}, {"id": "2", "name": "b", "arguments": {}}]},
        {"role": "tool", "tool_call_id": "1", "name": "a", "content": "ra"},
        {"role": "tool", "tool_call_id": "2", "name": "b", "content": '{"k": 1}'},
    ]
    out = to_gemini_contents(msgs)
    assert out[1]["role"] == "model" and len(out[1]["parts"]) == 2
    assert out[2]["role"] == "user" and len(out[2]["parts"]) == 2
    assert out[2]["parts"][1]["functionResponse"]["response"] == {"k": 1}
