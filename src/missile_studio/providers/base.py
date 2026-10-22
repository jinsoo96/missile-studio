"""Provider contract.

Canonical message format (OpenAI-like, provider adapters translate from this):

    {"role": "system", "content": "..."}
    {"role": "user", "content": "..." | [{"type": "text", "text": ...}, {"type": "image_url", "image_url": {"url": "data:..."}}]}
    {"role": "assistant", "content": "...", "tool_calls": [{"id": "...", "name": "...", "arguments": {...}}], "thinking": "..."}
    {"role": "tool", "tool_call_id": "...", "name": "...", "content": "..." , "is_error": false}

Tool definition format (one shape, adapters translate):

    {"name": "server__tool", "description": "...", "input_schema": {json schema}}

Streaming events yielded by ``BaseProvider.stream``:

    {"type": "text_delta", "text": str}
    {"type": "thinking_delta", "text": str}
    {"type": "tool_call", "id": str, "name": str, "arguments": dict}   # emitted once complete
    {"type": "usage", "input_tokens": int, "output_tokens": int}
    {"type": "done", "finish_reason": "stop" | "tool_calls" | "length" | "error"}
    {"type": "error", "message": str}
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Optional

import httpx

from ..config import ProviderConfig


class ProviderError(RuntimeError):
    pass


@dataclass
class GenerationOptions:
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    # merged into the provider request body (vendor-specific switches)
    extra_body: dict[str, Any] = field(default_factory=dict)
    # out-of-band context for adapters that need it (conversation_id, interaction_id, device id); never sent as-is
    context: dict[str, Any] = field(default_factory=dict)


def _json_loads_lenient(raw: str) -> dict:
    raw = (raw or "").strip()
    if not raw:
        return {}
    try:
        v = json.loads(raw)
        return v if isinstance(v, dict) else {"value": v}
    except json.JSONDecodeError:
        # Some models emit two concatenated objects or trailing junk; keep the first object.
        depth = 0
        for i, ch in enumerate(raw):
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(raw[: i + 1])
                    except json.JSONDecodeError:
                        break
        return {"_raw": raw}


class BaseProvider:
    kind = "base"

    def __init__(self, cfg: ProviderConfig, client: Optional[httpx.AsyncClient] = None):
        self.cfg = cfg
        self._client = client

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=20.0), verify=not self.cfg.allow_insecure_tls)
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def list_models(self) -> list[str]:
        raise NotImplementedError

    async def stream(
        self,
        model: str,
        messages: list[dict],
        tools: Optional[list[dict]] = None,
        options: Optional[GenerationOptions] = None,
    ) -> AsyncIterator[dict]:
        raise NotImplementedError
        yield {}  # pragma: no cover

    async def complete(self, model: str, messages: list[dict], options: Optional[GenerationOptions] = None) -> str:
        parts: list[str] = []
        async for ev in self.stream(model, messages, None, options):
            if ev["type"] == "text_delta":
                parts.append(ev["text"])
            elif ev["type"] == "error":
                raise ProviderError(ev["message"])
        return "".join(parts)


def split_system(messages: list[dict]) -> tuple[str, list[dict]]:
    """Return (joined system text, remaining messages)."""
    sys_parts: list[str] = []
    rest: list[dict] = []
    for m in messages:
        if m.get("role") == "system":
            c = m.get("content")
            if isinstance(c, list):
                c = "\n".join(p.get("text", "") for p in c if isinstance(p, dict))
            if c:
                sys_parts.append(str(c))
        else:
            rest.append(m)
    return "\n\n".join(sys_parts), rest


def content_to_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for p in content:
            if isinstance(p, dict):
                if p.get("type") == "text":
                    out.append(p.get("text", ""))
                elif p.get("type") == "image_url":
                    out.append("[image]")
            else:
                out.append(str(p))
        return "\n".join(out)
    return str(content)


async def read_sse(resp: httpx.Response) -> AsyncIterator[tuple[str, str]]:
    """Yield (event, data) tuples from a text/event-stream response."""
    event = "message"
    data_lines: list[str] = []
    async for line in resp.aiter_lines():
        if line == "":
            if data_lines:
                yield event, "\n".join(data_lines)
            event, data_lines = "message", []
            continue
        if line.startswith(":"):
            continue
        if line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
    if data_lines:
        yield event, "\n".join(data_lines)


async def error_text(resp: httpx.Response) -> str:
    try:
        body = await resp.aread()
        text = body.decode("utf-8", "replace")
    except Exception:  # pragma: no cover
        text = ""
    return f"HTTP {resp.status_code} from {resp.request.url.host}: {text[:800] or '(empty response body)'}"
