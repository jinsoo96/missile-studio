"""Google Gemini provider (generateContent streaming over SSE, function calling)."""

from __future__ import annotations

import json
from typing import Any, AsyncIterator, Optional

from .base import BaseProvider, GenerationOptions, ProviderError, content_to_text, error_text, read_sse, split_system


def _scrub_schema(schema: Any) -> Any:
    """Gemini rejects some JSON-schema keywords; drop them recursively."""
    if isinstance(schema, dict):
        out = {}
        for k, v in schema.items():
            if k in ("$schema", "additionalProperties", "default", "examples", "title", "$id", "$defs", "definitions", "pattern", "format"):
                continue
            out[k] = _scrub_schema(v)
        if out.get("type") == "object" and "properties" not in out:
            out["properties"] = {}
        return out
    if isinstance(schema, list):
        return [_scrub_schema(x) for x in schema]
    return schema


def to_gemini_contents(messages: list[dict]) -> list[dict]:
    out: list[dict] = []
    for m in messages:
        role = m.get("role")
        if role == "user":
            c = m.get("content")
            parts: list[dict] = []
            if isinstance(c, list):
                for p in c:
                    if isinstance(p, dict) and p.get("type") == "image_url":
                        url = (p.get("image_url") or {}).get("url", "")
                        if url.startswith("data:"):
                            head, b64 = url.split(",", 1)
                            parts.append({"inlineData": {"mimeType": head[5:].split(";")[0], "data": b64}})
                    elif isinstance(p, dict) and p.get("type") == "text":
                        parts.append({"text": p.get("text", "")})
            else:
                parts.append({"text": str(c or "")})
            out.append({"role": "user", "parts": parts or [{"text": ""}]})
        elif role == "assistant":
            parts = []
            text = content_to_text(m.get("content"))
            if text:
                parts.append({"text": text})
            for c in m.get("tool_calls") or []:
                parts.append({"functionCall": {"name": c["name"], "args": c.get("arguments") or {}}})
            if parts:
                out.append({"role": "model", "parts": parts})
        elif role == "tool":
            raw = m.get("content")
            try:
                val = json.loads(raw) if isinstance(raw, str) else raw
            except Exception:
                val = raw
            if not isinstance(val, dict):
                val = {"result": val}
            part = {"functionResponse": {"name": m.get("name", "tool"), "response": val}}
            if out and out[-1]["role"] == "user" and any("functionResponse" in p for p in out[-1]["parts"]):
                out[-1]["parts"].append(part)
            else:
                out.append({"role": "user", "parts": [part]})
    return out


class GeminiProvider(BaseProvider):
    kind = "gemini"

    def _base(self) -> str:
        return (self.cfg.base_url or "https://generativelanguage.googleapis.com").rstrip("/")

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json", "x-goog-api-key": self.cfg.resolved_api_key()}
        h.update(self.cfg.headers)
        return h

    async def list_models(self) -> list[str]:
        r = await self.client.get(f"{self._base()}/v1beta/models?pageSize=200", headers=self._headers(), timeout=20.0)
        if r.status_code >= 400:
            raise ProviderError(await error_text(r))
        names = []
        for m in r.json().get("models", []):
            if "generateContent" in (m.get("supportedGenerationMethods") or []):
                names.append(m.get("name", "").replace("models/", ""))
        return names

    async def stream(
        self,
        model: str,
        messages: list[dict],
        tools: Optional[list[dict]] = None,
        options: Optional[GenerationOptions] = None,
    ) -> AsyncIterator[dict]:
        options = options or GenerationOptions()
        system, rest = split_system(messages)
        body: dict[str, Any] = {"contents": to_gemini_contents(rest)}
        if system:
            body["systemInstruction"] = {"parts": [{"text": system}]}
        if tools:
            body["tools"] = [
                {
                    "functionDeclarations": [
                        {"name": t["name"], "description": (t.get("description") or "")[:1024], "parameters": _scrub_schema(t.get("input_schema") or {"type": "object", "properties": {}})}
                        for t in tools
                    ]
                }
            ]
        gen: dict[str, Any] = {}
        if options.temperature is not None:
            gen["temperature"] = options.temperature
        if options.max_tokens:
            gen["maxOutputTokens"] = options.max_tokens
        if gen:
            body["generationConfig"] = gen
        for k, v in {**self.cfg.extra_body, **options.extra_body}.items():
            if k == "generationConfig" and isinstance(v, dict):
                body.setdefault("generationConfig", {}).update(v)
            else:
                body[k] = v

        url = f"{self._base()}/v1beta/models/{model}:streamGenerateContent?alt=sse"
        emitted_calls = False
        finish = "stop"
        n = 0
        try:
            async with self.client.stream("POST", url, headers=self._headers(), json=body) as resp:
                if resp.status_code >= 400:
                    yield {"type": "error", "message": await error_text(resp)}
                    return
                async for _event, data in read_sse(resp):
                    try:
                        payload = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    if payload.get("error"):
                        yield {"type": "error", "message": str(payload["error"].get("message", payload["error"]))}
                        return
                    um = payload.get("usageMetadata")
                    if um:
                        yield {"type": "usage", "input_tokens": um.get("promptTokenCount", 0) or 0, "output_tokens": um.get("candidatesTokenCount", 0) or 0}
                    for cand in payload.get("candidates") or []:
                        for part in (cand.get("content") or {}).get("parts") or []:
                            if part.get("thought") and part.get("text"):
                                yield {"type": "thinking_delta", "text": part["text"]}
                            elif part.get("text"):
                                yield {"type": "text_delta", "text": part["text"]}
                            elif part.get("functionCall"):
                                fc = part["functionCall"]
                                n += 1
                                yield {"type": "tool_call", "id": f"gemini_call_{n}", "name": fc.get("name", ""), "arguments": fc.get("args") or {}}
                                emitted_calls = True
                        fr = cand.get("finishReason")
                        if fr == "MAX_TOKENS":
                            finish = "length"
        except Exception as e:
            yield {"type": "error", "message": f"{type(e).__name__}: {e}"}
            return
        yield {"type": "done", "finish_reason": "tool_calls" if emitted_calls else finish}
