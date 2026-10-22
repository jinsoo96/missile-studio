"""OpenAI-compatible Chat Completions provider.

Covers OpenAI, vLLM, Ollama (/v1), LM Studio, llama.cpp, DashScope, OpenRouter, Groq,
DeepSeek, Mistral, xAI, LiteLLM and any gateway that speaks /v1/chat/completions.

Known provider quirks handled here:
- ``reasoning_content`` (DeepSeek, Qwen) is surfaced as thinking_delta.
- Tool-call argument deltas are accumulated per index and emitted once at the end of the
  assistant turn (or when finish_reason arrives).
- ``extra_body`` from the provider config is merged into every request (Qwen thinking switch,
  OpenRouter routing, etc.).
- Model discovery: ``GET /models``; Ollama hosts also answer ``/api/tags`` which lists models
  that are pulled but not yet loaded.
"""

from __future__ import annotations

import json
import re
from typing import Any, AsyncIterator, Optional

from .base import BaseProvider, GenerationOptions, ProviderError, error_text, read_sse

# a 400 that means "this server cannot take tool definitions" (vLLM started without a tool-call parser, and friends)
_TOOLS_UNSUPPORTED = re.compile(r"tool.?choice|enable-auto-tool-choice|tool-call-parser|does not support tools|tools? (?:is|are) not supported|unsupported.{0,20}tools", re.I)


def to_openai_messages(messages: list[dict]) -> list[dict]:
    out: list[dict] = []
    for m in messages:
        role = m.get("role")
        if role == "assistant":
            item: dict[str, Any] = {"role": "assistant", "content": m.get("content") or ""}
            calls = m.get("tool_calls") or []
            if calls:
                item["tool_calls"] = [
                    {
                        "id": c["id"],
                        "type": "function",
                        "function": {"name": c["name"], "arguments": json.dumps(c.get("arguments") or {}, ensure_ascii=False)},
                    }
                    for c in calls
                ]
                if not item["content"]:
                    item["content"] = None
            out.append(item)
        elif role == "tool":
            out.append({"role": "tool", "tool_call_id": m.get("tool_call_id", ""), "content": str(m.get("content") or "")})
        else:
            out.append({"role": role or "user", "content": m.get("content") or ""})
    return out


def to_openai_tools(tools: Optional[list[dict]]) -> Optional[list[dict]]:
    if not tools:
        return None
    return [
        {
            "type": "function",
            "function": {
                "name": t["name"],
                "description": (t.get("description") or "")[:1024],
                "parameters": t.get("input_schema") or {"type": "object", "properties": {}},
            },
        }
        for t in tools
    ]


class OpenAICompatProvider(BaseProvider):
    kind = "openai"

    def _headers(self, stream: bool = False) -> dict[str, str]:
        h = {"Content-Type": "application/json", "Accept": "text/event-stream" if stream else "application/json"}
        key = self.cfg.resolved_api_key()
        h["Authorization"] = f"Bearer {key or 'EMPTY'}"
        h.update(self.cfg.headers)
        return h

    def _base(self) -> str:
        base = (self.cfg.base_url or "https://api.openai.com/v1").rstrip("/")
        return base

    async def list_models(self) -> list[str]:
        base = self._base()
        r = await self.client.get(f"{base}/models", headers=self._headers(), timeout=20.0)
        if r.status_code >= 400:
            # Ollama hosts expose /api/tags without /v1
            if base.endswith("/v1"):
                r2 = await self.client.get(base[:-3] + "/api/tags", timeout=20.0)
                if r2.status_code < 400:
                    return sorted(m.get("name", "") for m in r2.json().get("models", []))
            raise ProviderError(await error_text(r))
        data = r.json()
        items = data.get("data") if isinstance(data, dict) else data
        ids = []
        for it in items or []:
            if isinstance(it, dict) and it.get("id"):
                ids.append(it["id"])
            elif isinstance(it, str):
                ids.append(it)
        return sorted(set(ids))

    async def stream(
        self,
        model: str,
        messages: list[dict],
        tools: Optional[list[dict]] = None,
        options: Optional[GenerationOptions] = None,
    ) -> AsyncIterator[dict]:
        options = options or GenerationOptions()
        body: dict[str, Any] = {
            "model": model,
            "messages": to_openai_messages(messages),
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        oa_tools = to_openai_tools(tools)
        if oa_tools:
            body["tools"] = oa_tools
        if options.temperature is not None:
            body["temperature"] = options.temperature
        if options.max_tokens:
            body["max_tokens"] = options.max_tokens
        for k, v in {**self.cfg.extra_body, **options.extra_body}.items():
            body[k] = v

        url = f"{self._base()}/chat/completions"
        pending: dict[int, dict[str, Any]] = {}
        finish: Optional[str] = None
        emitted_calls = False
        got_usage = False
        try:
            for _attempt in range(3):  # at most two fallbacks: drop stream_options, then drop tools
                async with self.client.stream("POST", url, headers=self._headers(stream=True), json=body) as resp:
                    if resp.status_code >= 400:
                        msg = await error_text(resp)
                        if "stream_options" in msg and "stream_options" in body:
                            body.pop("stream_options", None)  # some servers reject it
                            continue
                        if "tools" in body and _TOOLS_UNSUPPORTED.search(msg):
                            # vLLM without --enable-auto-tool-choice (and similar servers): tell the engine, which
                            # re-sends with the tools described in the prompt instead (see ToolCallScanner)
                            yield {"type": "status", "event": "tools_unsupported", "data": {"message": msg[:300]}}
                            yield {"type": "done", "finish_reason": "tools_unsupported"}
                            return
                        yield {"type": "error", "message": msg}
                        return
                    async for ev in self._consume(resp, pending):
                        if ev["type"] == "done":
                            finish = ev["finish_reason"]
                            continue
                        if ev["type"] == "usage":
                            got_usage = True
                        yield ev
                    break
        except Exception as e:  # network / decoding
            yield {"type": "error", "message": f"{type(e).__name__}: {e}"}
            return

        for idx in sorted(pending):
            c = pending[idx]
            from .base import _json_loads_lenient

            yield {"type": "tool_call", "id": c.get("id") or f"call_{idx}", "name": c.get("name", ""), "arguments": _json_loads_lenient(c.get("arguments", ""))}
            emitted_calls = True
        if not got_usage:
            pass
        yield {"type": "done", "finish_reason": "tool_calls" if emitted_calls else (finish or "stop")}

    async def _consume(self, resp, pending: dict[int, dict[str, Any]]) -> AsyncIterator[dict]:
        async for _event, data in read_sse(resp):
            if data.strip() == "[DONE]":
                break
            try:
                chunk = json.loads(data)
            except json.JSONDecodeError:
                continue
            if isinstance(chunk, dict) and chunk.get("error"):
                err = chunk["error"]
                yield {"type": "error", "message": err.get("message") if isinstance(err, dict) else str(err)}
                return
            usage = chunk.get("usage") if isinstance(chunk, dict) else None
            if usage:
                yield {"type": "usage", "input_tokens": usage.get("prompt_tokens", 0) or 0, "output_tokens": usage.get("completion_tokens", 0) or 0}
            for choice in chunk.get("choices") or []:
                delta = choice.get("delta") or {}
                reasoning = delta.get("reasoning_content") or delta.get("reasoning")
                if reasoning:
                    yield {"type": "thinking_delta", "text": reasoning}
                text = delta.get("content")
                if text:
                    yield {"type": "text_delta", "text": text}
                for tc in delta.get("tool_calls") or []:
                    idx = tc.get("index", 0)
                    slot = pending.setdefault(idx, {"id": "", "name": "", "arguments": ""})
                    if tc.get("id"):
                        slot["id"] = tc["id"]
                    fn = tc.get("function") or {}
                    if fn.get("name"):
                        slot["name"] += fn["name"] if not slot["name"] else ""
                        if not slot["name"]:
                            slot["name"] = fn["name"]
                    if fn.get("arguments"):
                        slot["arguments"] += fn["arguments"]
                fr = choice.get("finish_reason")
                if fr:
                    yield {"type": "done", "finish_reason": fr}
