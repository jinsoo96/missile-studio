"""Anthropic Messages API provider (streaming, tools, thinking blocks)."""

from __future__ import annotations

import json
from typing import Any, AsyncIterator, Optional

from .base import BaseProvider, GenerationOptions, ProviderError, _json_loads_lenient, content_to_text, error_text, read_sse, split_system

ANTHROPIC_VERSION = "2023-06-01"


def _user_content(content: Any) -> Any:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for p in content:
            if not isinstance(p, dict):
                out.append({"type": "text", "text": str(p)})
            elif p.get("type") == "text":
                out.append({"type": "text", "text": p.get("text", "")})
            elif p.get("type") == "image_url":
                url = (p.get("image_url") or {}).get("url", "")
                if url.startswith("data:"):
                    head, b64 = url.split(",", 1)
                    media = head[5:].split(";")[0]
                    out.append({"type": "image", "source": {"type": "base64", "media_type": media, "data": b64}})
                else:
                    out.append({"type": "image", "source": {"type": "url", "url": url}})
        return out or ""
    return str(content or "")


def to_anthropic_messages(messages: list[dict]) -> list[dict]:
    """Collapse canonical messages into Anthropic's alternating user/assistant turns."""
    out: list[dict] = []

    def push(role: str, blocks: list[dict]) -> None:
        if out and out[-1]["role"] == role:
            out[-1]["content"].extend(blocks)
        else:
            out.append({"role": role, "content": list(blocks)})

    for m in messages:
        role = m.get("role")
        if role == "user":
            c = _user_content(m.get("content"))
            blocks = [{"type": "text", "text": c}] if isinstance(c, str) else c
            push("user", blocks)
        elif role == "assistant":
            blocks: list[dict] = []
            text = content_to_text(m.get("content"))
            if text:
                blocks.append({"type": "text", "text": text})
            for c in m.get("tool_calls") or []:
                blocks.append({"type": "tool_use", "id": c["id"], "name": c["name"], "input": c.get("arguments") or {}})
            if blocks:
                push("assistant", blocks)
        elif role == "tool":
            push(
                "user",
                [
                    {
                        "type": "tool_result",
                        "tool_use_id": m.get("tool_call_id", ""),
                        "content": str(m.get("content") or ""),
                        "is_error": bool(m.get("is_error")),
                    }
                ],
            )
    # Anthropic requires the first message to be from the user
    while out and out[0]["role"] != "user":
        out.pop(0)
    # strip empty text blocks
    for m in out:
        m["content"] = [b for b in m["content"] if not (b.get("type") == "text" and not b.get("text"))] or [{"type": "text", "text": "(empty)"}]
    return out


class AnthropicProvider(BaseProvider):
    kind = "anthropic"

    def _headers(self) -> dict[str, str]:
        h = {
            "Content-Type": "application/json",
            "anthropic-version": ANTHROPIC_VERSION,
            "x-api-key": self.cfg.resolved_api_key(),
        }
        h.update(self.cfg.headers)
        return h

    def _base(self) -> str:
        return (self.cfg.base_url or "https://api.anthropic.com").rstrip("/")

    async def list_models(self) -> list[str]:
        r = await self.client.get(f"{self._base()}/v1/models?limit=100", headers=self._headers(), timeout=20.0)
        if r.status_code >= 400:
            raise ProviderError(await error_text(r))
        return [m["id"] for m in r.json().get("data", [])]

    async def stream(
        self,
        model: str,
        messages: list[dict],
        tools: Optional[list[dict]] = None,
        options: Optional[GenerationOptions] = None,
    ) -> AsyncIterator[dict]:
        options = options or GenerationOptions()
        system, rest = split_system(messages)
        body: dict[str, Any] = {
            "model": model,
            "messages": to_anthropic_messages(rest),
            "max_tokens": options.max_tokens or 8192,
            "stream": True,
        }
        if system:
            body["system"] = system
        if tools:
            body["tools"] = [
                {"name": t["name"], "description": (t.get("description") or "")[:1024], "input_schema": t.get("input_schema") or {"type": "object", "properties": {}}}
                for t in tools
            ]
        if options.temperature is not None:
            body["temperature"] = options.temperature
        for k, v in {**self.cfg.extra_body, **options.extra_body}.items():
            body[k] = v

        blocks: dict[int, dict[str, Any]] = {}
        stop_reason = "stop"
        emitted_calls = False
        try:
            async with self.client.stream("POST", f"{self._base()}/v1/messages", headers=self._headers(), json=body) as resp:
                if resp.status_code >= 400:
                    yield {"type": "error", "message": await error_text(resp)}
                    return
                async for event, data in read_sse(resp):
                    try:
                        payload = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    et = payload.get("type") or event
                    if et == "content_block_start":
                        idx = payload.get("index", 0)
                        cb = payload.get("content_block") or {}
                        blocks[idx] = {"type": cb.get("type"), "id": cb.get("id"), "name": cb.get("name"), "json": ""}
                    elif et == "content_block_delta":
                        idx = payload.get("index", 0)
                        d = payload.get("delta") or {}
                        dt = d.get("type")
                        if dt == "text_delta":
                            yield {"type": "text_delta", "text": d.get("text", "")}
                        elif dt == "thinking_delta":
                            yield {"type": "thinking_delta", "text": d.get("thinking", "")}
                        elif dt == "input_json_delta":
                            blocks.setdefault(idx, {"type": "tool_use", "json": ""})["json"] += d.get("partial_json", "")
                    elif et == "content_block_stop":
                        idx = payload.get("index", 0)
                        b = blocks.get(idx)
                        if b and b.get("type") == "tool_use":
                            yield {"type": "tool_call", "id": b.get("id") or f"toolu_{idx}", "name": b.get("name", ""), "arguments": _json_loads_lenient(b.get("json", ""))}
                            emitted_calls = True
                    elif et == "message_start":
                        u = (payload.get("message") or {}).get("usage") or {}
                        if u:
                            yield {"type": "usage", "input_tokens": u.get("input_tokens", 0), "output_tokens": u.get("output_tokens", 0)}
                    elif et == "message_delta":
                        sr = (payload.get("delta") or {}).get("stop_reason")
                        if sr:
                            stop_reason = sr
                        u = payload.get("usage") or {}
                        if u:
                            yield {"type": "usage", "input_tokens": u.get("input_tokens", 0) or 0, "output_tokens": u.get("output_tokens", 0) or 0}
                    elif et == "error":
                        err = payload.get("error") or {}
                        yield {"type": "error", "message": err.get("message", "anthropic stream error")}
                        return
        except Exception as e:
            yield {"type": "error", "message": f"{type(e).__name__}: {e}"}
            return
        fr = "tool_calls" if emitted_calls or stop_reason == "tool_use" else ("length" if stop_reason == "max_tokens" else "stop")
        yield {"type": "done", "finish_reason": fr}
