"""Device bridge: register this machine's tools with a remote agent server.

The server exposes a WebSocket for "devices". On connect we send a ``hello`` with the tool catalog
(local tools under server ``local`` and every MCP server under its own name, each with
``inputSchema`` and ``annotations``); the server acknowledges with ``ready`` and later sends
``mcp_call {request_id, server, tool, args, context, deadline_ms}``. We answer
``mcp_result {request_id, ok, result}``; ``mcp_cancel`` aborts an in-flight call; a ``ping`` goes
out every 20 s. Reconnects back off 5 s * 1.8^n capped at 60 s; a 401/403 refreshes the token.

Every call goes through the engine's policy: ``block`` is refused, ``ask`` is refused unless the
bridge runs with ``trust``, and everything lands in the audit log.
"""

from __future__ import annotations

import asyncio
import json
import logging
import platform
import socket
import time
import uuid
from typing import Any, Optional

from .engine import Engine
from .providers.agentserver import AgentServerProvider

log = logging.getLogger("missile.bridge")


class DeviceBridge:
    def __init__(self, engine: Engine, provider_id: str, device_name: str = "", trust: bool = False):
        self.engine = engine
        self.provider_id = provider_id
        self.device_name = device_name or f"{socket.gethostname()} · missile-studio"
        self.device_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"missile-studio:{socket.gethostname()}"))
        self.trust = trust
        self.status = "idle"
        self.error = ""
        self.tool_count = 0
        self.calls = 0
        self._stop = asyncio.Event()
        self._task: Optional[asyncio.Task] = None
        self._ws = None
        self._inflight: dict[str, asyncio.Task] = {}
        self._seq = 0

    def as_dict(self) -> dict:
        return {"provider_id": self.provider_id, "status": self.status, "error": self.error, "tool_count": self.tool_count, "calls": self.calls, "device_name": self.device_name, "device_id": self.device_id}

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._stop.clear()
            self._task = asyncio.create_task(self._run(), name="device-bridge")

    async def stop(self) -> None:
        self._stop.set()
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        self.status = "stopped"

    # ------------------------------------------------------------
    def _catalog(self) -> list[dict]:
        tools = []
        for t in self.engine.all_tools():
            tools.append(
                {
                    "server": t.server,
                    "name": t.name,
                    "description": t.description or t.name,
                    "inputSchema": t.input_schema or {"type": "object", "properties": {}},
                    "annotations": {"readOnlyHint": t.read_only, "destructiveHint": t.destructive, "openWorldHint": t.open_world},
                }
            )
        return tools

    async def _run(self) -> None:
        import websockets

        backoff = 5.0
        provider = self.engine.provider(self.provider_id)
        if not isinstance(provider, AgentServerProvider):
            self.status = "failed"
            self.error = "provider is not an agent server provider"
            return
        session = provider.session()
        while not self._stop.is_set():
            try:
                await session.ensure()
                base = session.base_url.replace("https://", "wss://").replace("http://", "ws://")
                url = f"{base}/api/tools/ws/connector-mcp/{session.user_id}"
                self.status = "connecting"
                async with websockets.connect(url, additional_headers={"Authorization": f"Bearer {session.access_token}"}, max_size=32 * 1024 * 1024, ping_interval=None, open_timeout=30) as ws:
                    self._ws = ws
                    self.status = "connected"
                    self.error = ""
                    opened = time.time()
                    await self._hello(ws)
                    pinger = asyncio.create_task(self._pinger(ws))
                    try:
                        async for raw in ws:
                            await self._handle(ws, raw)
                    finally:
                        pinger.cancel()
                    if time.time() - opened > 1.2:
                        backoff = 5.0
            except asyncio.CancelledError:
                raise
            except Exception as e:
                msg = str(e)
                self.error = f"{type(e).__name__}: {msg}"
                self.status = "disconnected"
                log.warning("bridge disconnected: %s", self.error)
                if "401" in msg or "403" in msg:
                    try:
                        await session.refresh()
                        backoff = 5.0
                    except Exception as e2:
                        self.error = f"auth refresh failed: {e2}"
            finally:
                self._ws = None
            if self._stop.is_set():
                break
            await asyncio.sleep(backoff)
            backoff = min(backoff * 1.8, 60.0)
        self.status = "stopped"

    async def _hello(self, ws) -> None:
        self._seq += 1
        tools = self._catalog()
        self.tool_count = len(tools)
        msg = {
            "type": "hello",
            "catalog_id": f"{int(time.time() * 1000)}-{self._seq}",
            "tools": tools,
            "device_id": self.device_id,
            "device_name": self.device_name,
            "device_platform": {"Windows": "win32", "Darwin": "darwin"}.get(platform.system(), "linux"),
        }
        await ws.send(json.dumps(msg, ensure_ascii=False))

    async def refresh_catalog(self) -> None:
        if self._ws is not None and self.status == "connected":
            await self._hello(self._ws)

    async def _pinger(self, ws) -> None:
        while True:
            await asyncio.sleep(20)
            await ws.send(json.dumps({"type": "ping"}))

    async def _handle(self, ws, raw: Any) -> None:
        try:
            msg = json.loads(raw)
        except Exception:
            return
        t = msg.get("type")
        if t == "ready":
            log.info("bridge ready: %s tools", msg.get("tool_count"))
        elif t == "mcp_call":
            rid = msg.get("request_id")
            self._inflight[rid] = asyncio.create_task(self._do_call(ws, msg))
        elif t == "mcp_cancel":
            task = self._inflight.pop(msg.get("request_id"), None)
            if task:
                task.cancel()
        elif t == "pong":
            pass

    async def _do_call(self, ws, msg: dict) -> None:
        rid = msg.get("request_id")
        server = msg.get("server", "")
        tool_name = msg.get("tool", "")
        args = msg.get("args") or {}
        deadline_ms = msg.get("deadline_ms")
        timeout = max(1.0, (deadline_ms - 1000) / 1000.0) if deadline_ms else 130.0
        self.calls += 1
        try:
            tool = next((x for x in self.engine.all_tools() if x.server == server and x.name == tool_name), None)
            if tool is None:
                await ws.send(json.dumps({"type": "mcp_result", "request_id": rid, "ok": False, "error": f"unknown tool {server}/{tool_name}"}))
                return
            decision, reason = self.engine.decide(tool, args, conversation_id="bridge")
            if decision == "block" or (decision == "ask" and not self.trust):
                # The caller is a remote agent; without a human we refuse ask-level tools unless --trust.
                await ws.send(json.dumps({"type": "mcp_result", "request_id": rid, "ok": True, "result": {"content": [{"type": "text", "text": f"[DENIED] {tool.full_name}: {reason}. Allow it in missile-studio policy or start the bridge with --trust."}], "isError": True}}))
                self.engine.store.audit(conversation_id="bridge", tool=tool.full_name, arguments=args, decision="deny", is_error=True, duration_ms=0, result_excerpt=reason)
                return
            t0 = time.time()
            res = await asyncio.wait_for(self.engine.call_tool(tool, args), timeout=timeout)
            dur = int((time.time() - t0) * 1000)
            self.engine.store.audit(conversation_id="bridge", tool=tool.full_name, arguments=args, decision="allow", is_error=bool(res.get("is_error")), duration_ms=dur, result_excerpt=str(res.get("text", ""))[:2000])
            content = [c for c in res.get("content", []) if c.get("type") in ("text", "image")]
            for c in content:
                if c.get("type") == "image":
                    c["mimeType"] = c.pop("mime_type", "image/png")
            await ws.send(json.dumps({"type": "mcp_result", "request_id": rid, "ok": True, "result": {"content": content or [{"type": "text", "text": res.get("text", "")}], "isError": bool(res.get("is_error"))}}, ensure_ascii=False))
        except asyncio.TimeoutError:
            await ws.send(json.dumps({"type": "mcp_result", "request_id": rid, "ok": False, "error": f"[LOCAL_TIMEOUT] {tool_name} exceeded {timeout:.0f}s"}))
        except asyncio.CancelledError:
            pass
        except Exception as e:
            try:
                await ws.send(json.dumps({"type": "mcp_result", "request_id": rid, "ok": False, "error": f"{type(e).__name__}: {e}"}))
            except Exception:
                pass
        finally:
            self._inflight.pop(rid, None)
