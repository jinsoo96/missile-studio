"""Tools through the prompt: servers that reject tool definitions (vLLM without a tool-call parser)."""

from __future__ import annotations

import json

import httpx

from missile_studio.config import ProviderConfig
from missile_studio.engine import ToolCallScanner
from missile_studio.providers.openai_compat import OpenAICompatProvider

from .test_api import H, client, read_sse  # noqa: F401  (fixture)
from .test_mcp_and_engine import FakeProvider
from .test_providers import collect, make


async def test_openai_compat_reports_servers_that_reject_tools():
    """A 400 about tool choice makes the adapter report tools_unsupported and stop; the engine then switches modes."""
    seen = []

    def handler(req: httpx.Request):
        body = json.loads(req.content)
        seen.append(body)
        if "tools" in body:
            return httpx.Response(400, json={"error": {"message": '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set', "type": "BadRequestError", "code": 400}})
        return httpx.Response(200, content=b"data: [DONE]\n\n", headers={"content-type": "text/event-stream"})

    p = make(OpenAICompatProvider, ProviderConfig(id="v", kind="openai", base_url="http://vllm.local/v1"), handler)
    evs = await collect(p, messages=[{"role": "user", "content": "hi"}], tools=[{"name": "t", "description": "", "input_schema": {"type": "object", "properties": {}}}])
    assert [e["type"] for e in evs] == ["status", "done"]
    assert evs[0]["event"] == "tools_unsupported" and evs[1]["finish_reason"] == "tools_unsupported"
    assert len(seen) == 1 and "tools" in seen[0]


def test_tool_call_scanner_splits_text_and_calls():
    sc = ToolCallScanner()
    shown = sc.feed("Let me check.\n<tool_ca") + sc.feed('ll>\n{"name": "local__now", "arguments": {}}\n</tool_call>\nand ') + sc.feed('<tool_call>{"name":"echo__echo","arguments":{"text":"a"}}</tool_call>')
    assert shown == "Let me check.\n\nand "
    assert [c["name"] for c in sc.calls] == ["local__now", "echo__echo"] and sc.calls[1]["arguments"] == {"text": "a"}
    assert sc.flush() == ""
    sc2 = ToolCallScanner()
    assert sc2.feed("plain <b>text</b> here") == "plain <b>text</b> here" and sc2.flush() == "" and not sc2.calls
    sc3 = ToolCallScanner()
    sc3.feed('<tool_call>{"name": "x", "arguments": {"k": 1}}')
    assert sc3.flush() == "" and sc3.calls[0]["arguments"] == {"k": 1}
    sc4 = ToolCallScanner()  # not a call: shown as text
    assert sc4.feed("<tool_call>just words</tool_call> ok") == "just words ok" and not sc4.calls


def test_prompt_mode_tools_end_to_end(client):
    """The engine switches to prompt mode, parses <tool_call> blocks, runs the tool, feeds the result back as
    <tool_response>, and remembers the switch on the provider."""
    client.put("/api/policy", json={"default": "allow", "read_only_default": "allow", "rules": {}}, headers=H)
    conv = client.post("/api/conversations", json={}, headers=H).json()
    call_text = 'Checking. <tool_call>\n{"name": "echo__echo", "arguments": {"text": "ping"}}\n</tool_call>'
    FakeProvider.script = [
        [{"type": "status", "event": "tools_unsupported", "data": {"message": "no parser"}}, {"type": "done", "finish_reason": "tools_unsupported"}],
        [{"type": "text_delta", "text": call_text[:20]}, {"type": "text_delta", "text": call_text[20:]}, {"type": "done", "finish_reason": "stop"}],
        [{"type": "text_delta", "text": "The tool said ping."}, {"type": "done", "finish_reason": "stop"}],
    ]
    with client.stream("POST", "/api/chat", json={"conversation_id": conv["id"], "text": "echo ping"}, headers=H) as r:
        events = read_sse(r)
    assert any(e["type"] == "status" and e.get("event") == "tools_via_prompt" for e in events)
    calls = [e for e in events if e["type"] == "tool_call"]
    assert calls and calls[0]["name"] == "echo__echo" and calls[0]["arguments"] == {"text": "ping"}
    res = [e for e in events if e["type"] == "tool_result"]
    assert res and res[0]["text"] == "ping" and not res[0]["is_error"]
    assert "".join(e["text"] for e in events if e["type"] == "text_delta") == "Checking. The tool said ping."
    # what the server saw: tools described in the system prompt, the call as text, the result as a user <tool_response>
    second, third = FakeProvider.seen[-2], FakeProvider.seen[-1]
    assert "<tool_call>" in second[0]["content"] and "echo__echo" in second[0]["content"]
    assert third[-2]["role"] == "assistant" and "<tool_call>" in third[-2]["content"]
    assert third[-1]["role"] == "user" and third[-1]["content"].startswith("<tool_response>") and "ping" in third[-1]["content"]
    msgs = client.get(f"/api/conversations/{conv['id']}", headers=H).json()["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant", "tool", "assistant"]
    assert msgs[1]["content"] == "Checking. " and msgs[1]["tool_calls"][0]["name"] == "echo__echo"
    prov = next(p for p in client.get("/api/providers", headers=H).json() if p["id"] == "fake")
    assert prov["tools_via_prompt"] is True
    # the next turn goes straight to prompt mode: no tools_unsupported round trip
    FakeProvider.script = [[{"type": "text_delta", "text": "direct"}, {"type": "done", "finish_reason": "stop"}]]
    with client.stream("POST", "/api/chat", json={"conversation_id": conv["id"], "text": "again"}, headers=H) as r:
        events = read_sse(r)
    assert not any(e.get("event") == "tools_via_prompt" for e in events) and "<tool_call>" in FakeProvider.seen[-1][0]["content"]
