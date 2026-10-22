"""MCP client manager: one long-lived connection task per server, shared sessions.

Design notes:
- Each server gets its own asyncio task that owns the transport + ClientSession context
  managers (anyio cancel scopes must be entered/exited by the same task). Other tasks just
  call ``session.call_tool`` on the shared session object.
- A failing server never takes the others down; it goes to ``failed`` with the last error and
  the task retries with backoff (5s, x1.8, cap 60s).
- Ping every 15s; a missing pong marks the server disconnected so the next call reconnects.
- Per-call timeout (default 120s). ``tools/list_changed`` notifications refresh the catalog.
- stderr of stdio servers is written to ``<MISSILE_HOME>/logs/mcp-<name>.log``.
- Tool names are namespaced ``<server>__<tool>``; the raw name is kept for the call.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import re
import sys
import time
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import httpx

from ..config import McpServerConfig, log_dir

log = logging.getLogger("missile.mcp")

SEP = "__"
_NAME_RE = re.compile(r"[^A-Za-z0-9_-]")


def safe_server_name(name: str) -> str:
    return _NAME_RE.sub("_", name)[:40] or "server"


@dataclass
class ToolInfo:
    server: str
    name: str  # raw tool name on the server
    full_name: str  # namespaced
    description: str
    input_schema: dict
    read_only: bool = False
    destructive: bool = False
    open_world: bool = False
    title: str = ""

    def as_llm_tool(self) -> dict:
        return {"name": self.full_name, "description": self.description, "input_schema": self.input_schema or {"type": "object", "properties": {}}}

    def as_dict(self) -> dict:
        return {
            "server": self.server,
            "name": self.name,
            "full_name": self.full_name,
            "title": self.title,
            "description": self.description,
            "input_schema": self.input_schema,
            "read_only": self.read_only,
            "destructive": self.destructive,
            "open_world": self.open_world,
        }


RECONNECT_WAIT = 20.0  # seconds a tool call waits for a server that is reconnecting (restarted, network blip)


@dataclass
class ServerState:
    name: str
    cfg: McpServerConfig
    status: str = "idle"  # idle | connecting | connected | failed | disabled | stopped
    error: str = ""
    tools: list[ToolInfo] = field(default_factory=list)
    connected_at: float = 0.0
    attempts: int = 0
    server_info: dict = field(default_factory=dict)
    session: Any = None
    task: Optional[asyncio.Task] = None
    ready: asyncio.Event = field(default_factory=asyncio.Event)
    stop: asyncio.Event = field(default_factory=asyncio.Event)
    reconnect_now: asyncio.Event = field(default_factory=asyncio.Event)

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "status": self.status,
            "error": self.error,
            "tool_count": len(self.tools),
            "connected_at": self.connected_at,
            "attempts": self.attempts,
            "server_info": self.server_info,
            "config": self.cfg.model_dump(),
        }


class McpManager:
    def __init__(self, servers: Optional[dict[str, McpServerConfig]] = None, call_timeout: float = 120.0):
        self.servers: dict[str, ServerState] = {}
        self.call_timeout = call_timeout
        self._listeners: list[Any] = []
        if servers:
            for name, cfg in servers.items():
                self.servers[name] = ServerState(name=name, cfg=cfg)

    # ------------------------------------------------------------ lifecycle
    def on_change(self, cb) -> None:
        self._listeners.append(cb)

    def _notify(self, name: str) -> None:
        for cb in list(self._listeners):
            try:
                cb(name)
            except Exception:  # pragma: no cover
                pass

    async def start(self) -> None:
        for st in self.servers.values():
            self._ensure_task(st)

    def _ensure_task(self, st: ServerState) -> None:
        if not st.cfg.enabled:
            st.status = "disabled"
            return
        if st.task is None or st.task.done():
            st.stop.clear()
            st.task = asyncio.create_task(self._run(st), name=f"mcp:{st.name}")

    async def stop_all(self) -> None:
        for st in list(self.servers.values()):
            await self._stop_server(st)

    async def _stop_server(self, st: ServerState) -> None:
        st.stop.set()
        st.reconnect_now.set()
        if st.task and not st.task.done():
            try:
                await asyncio.wait_for(st.task, timeout=10.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                st.task.cancel()
                with contextlib.suppress(BaseException):
                    await st.task
        st.task = None
        st.session = None
        st.status = "stopped" if st.cfg.enabled else "disabled"
        st.ready.clear()
        self._notify(st.name)

    async def configure(self, servers: dict[str, McpServerConfig]) -> None:
        """Apply a new config map: stop removed/changed servers, start new ones."""
        for name in list(self.servers):
            if name not in servers:
                await self._stop_server(self.servers[name])
                del self.servers[name]
        for name, cfg in servers.items():
            st = self.servers.get(name)
            if st is None:
                st = ServerState(name=name, cfg=cfg)
                self.servers[name] = st
                self._ensure_task(st)
            elif st.cfg.model_dump() != cfg.model_dump():
                await self._stop_server(st)
                st.cfg = cfg
                st.error = ""
                st.attempts = 0
                self._ensure_task(st)

    async def restart(self, name: str) -> None:
        st = self.servers[name]
        await self._stop_server(st)
        st.attempts = 0
        st.error = ""
        self._ensure_task(st)

    async def wait_ready(self, timeout: float = 20.0) -> None:
        waits = [asyncio.wait_for(st.ready.wait(), timeout) for st in self.servers.values() if st.cfg.enabled]
        if waits:
            await asyncio.gather(*waits, return_exceptions=True)

    # ------------------------------------------------------------ connection task
    async def _run(self, st: ServerState) -> None:
        backoff = 5.0
        while not st.stop.is_set():
            st.status = "connecting"
            st.attempts += 1
            st.error = ""
            self._notify(st.name)
            try:
                await self._connect_and_serve(st)
                backoff = 5.0
            except asyncio.CancelledError:
                raise
            except BaseException as e:  # ExceptionGroup from anyio included
                msg = _describe_exc(e)
                st.error = msg
                st.status = "failed"
                st.session = None
                st.ready.set()  # unblock waiters; they will see status failed
                self._notify(st.name)
                log.warning("mcp %s failed: %s", st.name, msg)
                if st.stop.is_set():
                    break
                st.reconnect_now.clear()
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(st.reconnect_now.wait(), timeout=backoff)
                backoff = min(backoff * 1.8, 60.0)
                continue
            if st.stop.is_set():
                break
            # clean disconnect -> reconnect promptly
            await asyncio.sleep(1.0)
        st.status = "stopped"
        st.session = None
        self._notify(st.name)

    async def _connect_and_serve(self, st: ServerState) -> None:
        from mcp import ClientSession
        from mcp.types import ToolListChangedNotification

        cfg = st.cfg
        async with AsyncExitStack() as stack:
            errlog = None
            if cfg.transport == "stdio":
                from mcp import StdioServerParameters
                from mcp.client.stdio import stdio_client

                if not cfg.command:
                    raise RuntimeError("stdio server needs a command")
                env = {**os.environ, **{k: str(v) for k, v in cfg.env.items()}}
                env.setdefault("PYTHONUTF8", "1")
                params = StdioServerParameters(
                    command=cfg.command,
                    args=list(cfg.args),
                    env=env,
                    cwd=cfg.cwd or None,
                    encoding="utf-8",
                    encoding_error_handler="replace",
                )
                errlog = open(log_dir() / f"mcp-{safe_server_name(st.name)}.log", "a", encoding="utf-8", errors="replace")
                stack.callback(errlog.close)
                read, write = await stack.enter_async_context(stdio_client(params, errlog=errlog))
            elif cfg.transport == "sse":
                from mcp.client.sse import sse_client

                if not cfg.url:
                    raise RuntimeError("sse server needs a url")
                read, write = await stack.enter_async_context(
                    sse_client(cfg.url, headers=cfg.headers or None, timeout=30.0, sse_read_timeout=600.0)
                )
            else:
                from mcp.client.streamable_http import streamable_http_client

                if not cfg.url:
                    raise RuntimeError("http server needs a url")
                hc = httpx.AsyncClient(headers=cfg.headers or None, timeout=httpx.Timeout(600.0, connect=30.0), follow_redirects=True)
                await stack.enter_async_context(hc)
                streams = await stack.enter_async_context(streamable_http_client(cfg.url, http_client=hc))
                read, write = streams[0], streams[1]

            async def on_message(msg):
                try:
                    root = getattr(msg, "root", msg)
                    if isinstance(root, ToolListChangedNotification):
                        asyncio.get_running_loop().create_task(self._refresh_tools(st))
                except Exception:  # pragma: no cover
                    pass

            session = await stack.enter_async_context(
                ClientSession(read, write, read_timeout_seconds=self.call_timeout, message_handler=on_message)
            )
            init = await asyncio.wait_for(session.initialize(), timeout=max(10.0, cfg.timeout))
            si = getattr(init, "server_info", None) or getattr(init, "serverInfo", None)
            st.server_info = {"name": getattr(si, "name", ""), "version": getattr(si, "version", "")} if si else {}
            st.session = session
            await self._refresh_tools(st)
            st.status = "connected"
            st.connected_at = time.time()
            st.ready.set()
            self._notify(st.name)
            log.info("mcp %s connected: %d tools", st.name, len(st.tools))

            # keepalive loop
            while not st.stop.is_set():
                try:
                    await asyncio.wait_for(st.stop.wait(), timeout=15.0)
                    break
                except asyncio.TimeoutError:
                    pass
                try:
                    await asyncio.wait_for(session.send_ping(), timeout=20.0)
                except Exception as e:
                    raise RuntimeError(f"ping failed: {e}") from e

    async def _refresh_tools(self, st: ServerState) -> None:
        session = st.session
        if session is None:
            return
        result = await asyncio.wait_for(session.list_tools(), timeout=60.0)
        tools: list[ToolInfo] = []
        for t in result.tools:
            ann = getattr(t, "annotations", None)
            schema = getattr(t, "input_schema", None) or getattr(t, "inputSchema", None) or {"type": "object", "properties": {}}
            if hasattr(schema, "model_dump"):
                schema = schema.model_dump(by_alias=True, exclude_none=True)
            tools.append(
                ToolInfo(
                    server=st.name,
                    name=t.name,
                    full_name=f"{safe_server_name(st.name)}{SEP}{t.name}",
                    title=getattr(t, "title", "") or "",
                    description=t.description or "",
                    input_schema=schema,
                    read_only=bool(getattr(ann, "read_only_hint", None) or getattr(ann, "readOnlyHint", None)) if ann else False,
                    destructive=bool(getattr(ann, "destructive_hint", None) or getattr(ann, "destructiveHint", None)) if ann else False,
                    open_world=bool(getattr(ann, "open_world_hint", None)) if ann else False,
                )
            )
        st.tools = tools
        self._notify(st.name)

    # ------------------------------------------------------------ queries
    def list_tools(self) -> list[ToolInfo]:
        out: list[ToolInfo] = []
        for st in self.servers.values():
            if st.status == "connected":
                out.extend(st.tools)
        return out

    def find_tool(self, full_name: str) -> Optional[ToolInfo]:
        for t in self.list_tools():
            if t.full_name == full_name:
                return t
        return None

    def status(self) -> list[dict]:
        return [st.as_dict() for st in self.servers.values()]

    async def _await_reconnect(self, st: ServerState, wait: float) -> None:
        """A server that dropped (restarted, network blip) is usually back within seconds: skip the backoff and wait."""
        if st.status in ("disabled", "stopped") or wait <= 0:
            return
        st.reconnect_now.set()
        loop = asyncio.get_running_loop()
        deadline = loop.time() + wait
        while loop.time() < deadline and not (st.status == "connected" and st.session is not None):
            await asyncio.sleep(0.25)

    async def call_tool(self, full_name: str, arguments: dict, timeout: Optional[float] = None, reconnect_wait: float = RECONNECT_WAIT) -> dict:
        """Call a namespaced tool. Returns {"content": [...], "is_error": bool, "text": str}.
        A server that is reconnecting is waited for (up to ``reconnect_wait``) instead of reporting the tool as unknown."""
        info = self.find_tool(full_name)
        owner: Optional[ServerState] = None
        if info is None and SEP in full_name:
            srv, raw = full_name.split(SEP, 1)
            owner = next((s for s in self.servers.values() if safe_server_name(s.name) == srv), None)
            if owner is not None:
                if owner.status != "connected":
                    await self._await_reconnect(owner, reconnect_wait)
                if owner.status == "connected":
                    # the catalog may be stale (a restarted server, a tool added since): call it by its raw name
                    info = next((t for t in owner.tools if t.name == raw), None) or ToolInfo(server=owner.name, name=raw, full_name=full_name, description="", input_schema={})
        if info is None:
            if owner is not None:
                msg = f"server {owner.name} is {owner.status}" + (f" ({owner.error})" if owner.error else "") + f"; {full_name} will work again once it reconnects, try again in a moment"
            else:
                msg = f"unknown tool {full_name}"
            return {"content": [{"type": "text", "text": msg}], "is_error": True, "text": msg}
        st = self.servers[info.server]
        if st.session is None or st.status != "connected":
            await self._await_reconnect(st, reconnect_wait)
        if st.session is None or st.status != "connected":
            msg = f"server {info.server} is {st.status}" + (f" ({st.error})" if st.error else "") + "; try again in a moment"
            return {"content": [{"type": "text", "text": msg}], "is_error": True, "text": msg}
        try:
            res = await asyncio.wait_for(
                st.session.call_tool(info.name, arguments or {}, read_timeout_seconds=timeout or self.call_timeout),
                timeout=(timeout or self.call_timeout) + 5,
            )
        except asyncio.TimeoutError:
            msg = f"[TIMEOUT] {full_name} exceeded {timeout or self.call_timeout:.0f}s"
            return {"content": [{"type": "text", "text": msg}], "is_error": True, "text": msg}
        except Exception as e:
            msg = f"{type(e).__name__}: {e}"
            if "timed out" in msg.lower():
                msg = f"[TIMEOUT] {full_name} exceeded {timeout or self.call_timeout:.0f}s"
            # a broken pipe means the server died; trigger reconnect
            elif "closed" in msg.lower() or "broken" in msg.lower() or "eof" in msg.lower():
                st.reconnect_now.set()
            return {"content": [{"type": "text", "text": msg}], "is_error": True, "text": msg}
        return normalize_result(res)


def normalize_result(res: Any) -> dict:
    content_out: list[dict] = []
    texts: list[str] = []
    for c in getattr(res, "content", None) or []:
        ct = getattr(c, "type", None)
        if ct == "text":
            content_out.append({"type": "text", "text": c.text})
            texts.append(c.text)
        elif ct == "image":
            content_out.append({"type": "image", "mime_type": getattr(c, "mime_type", None) or getattr(c, "mimeType", ""), "data": c.data})
            texts.append("[image]")
        elif ct == "resource":
            r = getattr(c, "resource", None)
            txt = getattr(r, "text", None)
            if txt is not None:
                content_out.append({"type": "text", "text": txt})
                texts.append(txt)
            else:
                content_out.append({"type": "text", "text": f"[resource {getattr(r, 'uri', '')}]"})
        else:
            try:
                d = c.model_dump(by_alias=True, exclude_none=True)
            except Exception:
                d = {"type": str(ct), "text": str(c)}
            content_out.append(d)
    structured = getattr(res, "structured_content", None) or getattr(res, "structuredContent", None)
    if structured and not texts:
        import json as _json

        texts.append(_json.dumps(structured, ensure_ascii=False))
    is_error = bool(getattr(res, "is_error", None) or getattr(res, "isError", None))
    return {"content": content_out, "is_error": is_error, "text": "\n".join(texts), "structured": structured}


def _describe_exc(e: BaseException) -> str:
    subs = getattr(e, "exceptions", None)
    if subs:
        return "; ".join(_describe_exc(s) for s in subs[:3])
    msg = str(e).strip()
    return f"{type(e).__name__}: {msg}" if msg else type(e).__name__
