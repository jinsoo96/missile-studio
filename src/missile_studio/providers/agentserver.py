"""Remote agent server provider: chat with agents hosted on an agent platform.

The platform exposes an HTTP API with e-mail/password login, an agent (workflow) list and a
server-sent-events chat endpoint. The "model" of this provider is the agent:
``<workflow_id>`` or ``<workflow_id>|<workflow_name>``.

Tool calls run on the platform side; this machine's tools reach it through the device bridge
(``missile_studio.device_bridge``), so this provider never emits tool_call events itself.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
import uuid
from typing import Any, AsyncIterator, Optional

from .base import BaseProvider, GenerationOptions, ProviderError, content_to_text, error_text, read_sse


def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


class AgentServerSession:
    """Login + token refresh shared by the provider and the bridge."""

    def __init__(self, base_url: str, email: str, password: str, client, allow_insecure: bool = False):
        self.base_url = base_url.rstrip("/")
        self.email = email
        self.password = password
        self.client = client
        self.access_token = ""
        self.refresh_token = ""
        self.user_id = ""
        self.username = ""
        self._lock = asyncio.Lock()
        self._logged_at = 0.0

    async def login(self) -> None:
        async with self._lock:
            body = {"email": self.email, "password": sha256_hex(self.password), "token": None}
            r = await self.client.post(f"{self.base_url}/api/auth/login", json=body, timeout=30.0)
            if r.status_code >= 400:
                raise ProviderError(await error_text(r))
            data = r.json()
            if not data.get("access_token"):
                raise ProviderError(f"agent server login failed: {data.get('message') or data}")
            self.access_token = data["access_token"]
            self.refresh_token = data.get("refresh_token", "")
            self.user_id = str(data.get("user_id", ""))
            self.username = data.get("username", "")
            self._logged_at = time.time()

    async def ensure(self) -> None:
        if not self.access_token:
            await self.login()

    async def refresh(self) -> None:
        if not self.refresh_token:
            await self.login()
            return
        r = await self.client.post(f"{self.base_url}/api/auth/refresh", json={"refresh_token": self.refresh_token}, timeout=30.0)
        if r.status_code < 400 and r.json().get("access_token"):
            self.access_token = r.json()["access_token"]
        else:
            await self.login()

    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.access_token}"}


class AgentServerProvider(BaseProvider):
    kind = "agentserver"

    def __init__(self, cfg, client=None):
        super().__init__(cfg, client)
        self._session: Optional[AgentServerSession] = None
        self._agents: list[dict] = []
        self._interactions: dict[str, str] = {}  # conversation key -> interaction_id

    def session(self) -> XgenSession:
        if self._session is None:
            if not self.cfg.base_url:
                raise ProviderError("agent server provider needs base_url")
            self._session = AgentServerSession(self.cfg.base_url, self.cfg.email, self.cfg.password, self.client, self.cfg.allow_insecure_tls)
        return self._session

    async def _get(self, path: str, **kw) -> Any:
        s = self.session()
        await s.ensure()
        r = await self.client.get(f"{s.base_url}{path}", headers={**s.headers(), **self.cfg.headers}, timeout=30.0, **kw)
        if r.status_code in (401, 403):
            await s.refresh()
            r = await self.client.get(f"{s.base_url}{path}", headers={**s.headers(), **self.cfg.headers}, timeout=30.0, **kw)
        if r.status_code >= 400:
            raise ProviderError(await error_text(r))
        return r.json()

    async def list_agents(self) -> list[dict]:
        out: list[dict] = []
        for owner in ("personal", "shared"):
            try:
                data = await self._get(f"/api/agentflow/list/detail?page=1&page_size=100&search=&status=&owner={owner}")
            except ProviderError:
                if owner == "shared":
                    continue
                raise
            items = data.get("items") or data.get("workflows") or []
            for it in items:
                wid = it.get("workflow_id") or it.get("id")
                if not wid:
                    continue
                out.append({"id": str(wid), "name": it.get("workflow_name") or it.get("name") or str(wid), "owner": owner, "raw": it})
        self._agents = out
        return out

    async def list_models(self) -> list[str]:
        agents = await self.list_agents()
        return [f"{a['id']}|{a['name']}" for a in agents]

    def _split_model(self, model: str) -> tuple[str, str]:
        if "|" in model:
            wid, name = model.split("|", 1)
            return wid.strip(), name.strip()
        for a in self._agents:
            if a["id"] == model:
                return a["id"], a["name"]
        return model.strip(), model.strip()

    async def stop(self, interaction_id: str) -> None:
        s = self.session()
        await s.ensure()
        await self.client.post(f"{s.base_url}/api/agentflow/execute/stop/{interaction_id}", headers=s.headers(), timeout=15.0)

    async def stream(
        self,
        model: str,
        messages: list[dict],
        tools: Optional[list[dict]] = None,
        options: Optional[GenerationOptions] = None,
    ) -> AsyncIterator[dict]:
        options = options or GenerationOptions()
        wid, wname = self._split_model(model)
        if not wname or wname == wid:
            # try to resolve the name from the agent list once
            if not self._agents:
                try:
                    await self.list_agents()
                except Exception:
                    pass
            for a in self._agents:
                if a["id"] == wid:
                    wname = a["name"]
        # The server keeps the conversation under interaction_id; we key it by the
        # conversation id passed through options.context["conversation_id"].
        conv_key = str(options.context.get("conversation_id") or "default")
        interaction_id = self._interactions.get(conv_key) or options.context.get("interaction_id") or str(uuid.uuid4())
        self._interactions[conv_key] = interaction_id
        # Last user message is the input; earlier turns already live on the server for this interaction.
        last_user = ""
        for m in reversed(messages):
            if m.get("role") == "user":
                last_user = content_to_text(m.get("content"))
                break
        body = {
            "workflow_name": wname,
            "workflow_id": wid,
            "input_data": last_user,
            "interaction_id": interaction_id,
            "selected_collections": [],
            "selected_files": [],
            "include_logs": False,
            "include_node_status": False,
            "include_tool_events": True,
            "response_format": "stream",
            "client_surface": "connector",
        }
        dev_id = options.context.get("client_device_id")
        if dev_id:
            body["client_device_id"] = dev_id
        s = self.session()
        try:
            await s.ensure()
        except ProviderError as e:
            yield {"type": "error", "message": str(e)}
            return
        headers = {**s.headers(), **self.cfg.headers, "Accept": "text/event-stream", "Content-Type": "application/json"}
        url = f"{s.base_url}/api/agentflow/execute/based-id/stream"
        yield {"type": "meta", "interaction_id": interaction_id, "workflow_id": wid, "workflow_name": wname}
        try:
            async with self.client.stream("POST", url, headers=headers, json=body, timeout=None) as resp:
                if resp.status_code in (401, 403):
                    await s.refresh()
                    headers.update(s.headers())
                    async with self.client.stream("POST", url, headers=headers, json=body, timeout=None) as resp2:
                        if resp2.status_code >= 400:
                            yield {"type": "error", "message": await error_text(resp2)}
                            return
                        async for ev in self._consume(resp2):
                            yield ev
                elif resp.status_code >= 400:
                    yield {"type": "error", "message": await error_text(resp)}
                    return
                else:
                    async for ev in self._consume(resp):
                        yield ev
        except Exception as e:
            yield {"type": "error", "message": f"{type(e).__name__}: {e}"}
            return
        yield {"type": "done", "finish_reason": "stop"}

    async def _consume(self, resp) -> AsyncIterator[dict]:
        async for event, data in read_sse(resp):
            try:
                payload = json.loads(data)
            except json.JSONDecodeError:
                if data.strip():
                    yield {"type": "text_delta", "text": data}
                continue
            if not isinstance(payload, dict):
                continue
            t = payload.get("type") or payload.get("event_type") or event
            if event == "tool" or t in ("tool_call", "tool_start", "tool_result", "tool_error"):
                et = payload.get("event_type") or t
                yield {
                    "type": "remote_tool",
                    "event": et,
                    "name": payload.get("tool_name", ""),
                    "input": payload.get("tool_input"),
                    "result": payload.get("result"),
                    "error": payload.get("error"),
                    "duration_ms": payload.get("duration_ms"),
                }
            elif t == "data":
                c = payload.get("content")
                if c:
                    yield {"type": "text_delta", "text": str(c)}
            elif t == "error":
                yield {"type": "error", "message": str(payload.get("detail") or payload.get("message") or payload)}
                return
            elif t == "end":
                return
            elif t in ("llm_progress", "log", "node_status", "execution_io", "summary", "llm_end", "turn_queued"):
                # progress noise: surface as status so the UI can show "thinking"
                yield {"type": "status", "event": t, "data": payload}
            elif t in ("quota_exceeded", "execution_suspended"):
                yield {"type": "error", "message": f"agent server {t}: {payload}"}
                return
