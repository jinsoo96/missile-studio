"""FastAPI app: JSON API + SSE chat stream + static web UI + admin console.

Auth model
----------
- Loopback bind without a token: everyone is an admin (local trust).
- Owner token (config ``server.token`` / ``MISSILE_TOKEN``): admin. Sent as ``Authorization: Bearer``,
  the ``missile_token`` cookie (set by /api/login) or ``?token=``.
- API tokens created in the admin console: scope ``chat`` (conversations, chat, approvals, uploads,
  read-only state) or ``admin`` (everything).
- Admin console sessions: httpOnly cookie set by /api/admin/auth/login (see admin.py).
Settings-changing routes require the admin role.
"""

import asyncio
import base64
import json
import logging
import mimetypes
import re
import secrets
import time
from pathlib import Path
from typing import Any, Optional

from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile

# download types the OS tables disagree on (Windows registry vs /etc/mime.types): pin the ones the agent writes most
for _mt, _ext in (("text/markdown", ".md"), ("text/markdown", ".markdown"), ("application/json", ".json"), ("text/csv", ".csv"), ("text/yaml", ".yml"), ("text/yaml", ".yaml"), ("text/plain", ".txt"), ("text/plain", ".log"), ("font/woff2", ".woff2"), ("font/woff", ".woff")):
    mimetypes.add_type(_mt, _ext)
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .. import __version__
from ..config import PROVIDER_PRESETS, AssistantConfig, BuiltinTools, McpServerConfig, ModelPreset, ProviderConfig, StyleConfig, ToolPolicy, config_path, ensure_token, home_dir
from ..device_bridge import DeviceBridge
from ..engine import Engine, TurnRequest
from ..providers.base import ProviderError
from ..mcp.importers import export_standard, import_from, known_sources, parse_servers
from . import admin as adminmod

log = logging.getLogger("missile.server")
STATIC = Path(__file__).parent / "static"
LOOPBACK = ("127.0.0.1", "localhost", "::1")


def _builtin_view(cfg) -> dict:
    """builtin_tools for the browser: the web-search key is masked, the workspace path resolved."""
    d = cfg.builtin_tools.model_dump()
    ws = d.get("web_search") or {}
    ws["has_key"] = bool(cfg.builtin_tools.web_search.resolved_api_key())
    ws["api_key"] = "…" if ws.get("api_key") else ""
    d["web_search"] = ws
    d["workspace_resolved"] = str(cfg.builtin_tools.workspace_path())
    return d


def _mask(pc: ProviderConfig) -> dict:
    d = pc.model_dump()
    if d.get("api_key"):
        k = d["api_key"]
        d["api_key"] = (k[:4] + "…" + k[-4:]) if len(k) > 10 else "…"
        d["has_key"] = True
    else:
        d["has_key"] = bool(pc.resolved_api_key())  # an env var NAME alone is not a key: only true when the variable has a value
    if d.get("password"):
        d["password"] = "…"
        d["has_password"] = True
    return d


class LoginIn(BaseModel):
    token: str


STREAM_RETENTION = 600.0  # seconds a finished turn stays replayable for a tab that comes back
STREAM_MAX_EVENTS = 60000


class TurnStream:
    """Server-side event buffer of one turn. Any number of SSE followers can replay it from an index and then wait for more."""

    def __init__(self, conversation_id: str):
        self.conversation_id = conversation_id
        self.events: list[dict] = []
        self.done = False
        self.started_at = time.time()
        self._cond = asyncio.Condition()

    async def push(self, ev: dict) -> None:
        async with self._cond:
            if len(self.events) < STREAM_MAX_EVENTS:
                self.events.append(ev)
            self._cond.notify_all()

    async def finish(self) -> None:
        async with self._cond:
            self.done = True
            self._cond.notify_all()

    async def follow(self, after: int = 0):
        yield f"event: open\ndata: {json.dumps({'type': 'open', 'conversation_id': self.conversation_id, 'after': after, 'buffered': len(self.events)})}\n\n"
        i = max(0, int(after or 0))
        while True:
            while i < len(self.events):
                ev = self.events[i]
                i += 1
                yield f"data: {json.dumps({**ev, 'i': i}, ensure_ascii=False)}\n\n"
            if self.done:
                break
            async with self._cond:
                if i < len(self.events) or self.done:
                    continue
                try:
                    await asyncio.wait_for(self._cond.wait(), timeout=15.0)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"


class DefaultIn(BaseModel):
    provider: Optional[str] = None
    model: Optional[str] = None
    assistant: Optional[str] = None


class McpIn(BaseModel):
    name: str
    config: McpServerConfig


class ImportIn(BaseModel):
    source: str
    names: Optional[list[str]] = None
    json_text: Optional[str] = None


class ConvIn(BaseModel):
    assistant_id: str = "default"
    provider_id: str = ""
    model: str = ""
    title: str = ""


class ChatIn(BaseModel):
    conversation_id: str
    text: str
    provider_id: str = ""
    model: str = ""
    assistant_id: str = ""
    attachments: list[dict] = []
    tools: Any = None
    allow_dangerous: bool = False
    thinking: str = ""  # "" | off | on | max
    style_id: str = ""
    branch_from: str = ""  # id of the user message being edited: the new message becomes its sibling
    mode: str = ""  # "" | research
    knowledge: bool = False  # put knowledge-base excerpts for this message into context


class HeadIn(BaseModel):
    message_id: str


class DecisionIn(BaseModel):
    decision: str  # allow | allow_session | allow_always | deny


class BridgeIn(BaseModel):
    provider_id: str
    trust: bool = False
    device_name: str = ""


def create_app(engine: Engine, token: str = "") -> FastAPI:
    app = FastAPI(title="missile-studio", version=__version__, docs_url="/api/docs", openapi_url="/api/openapi.json")
    app.state.engine = engine
    app.state.token = token
    app.state.bridges = {}
    app.state.turn_tasks = {}
    app.state.turn_streams = {}
    app.state.provider_health = {}  # provider id -> {"state": ok|down|nokey|unknown, "error", "checked_at", "ms"}

    # ------------------------------------------------------------ provider health (is this model reachable right now?)
    HOSTED = ("api.openai.com", "openrouter.ai", "dashscope", "api.groq.com", "api.deepseek.com", "api.mistral.ai", "api.x.ai", "api.together", "api.fireworks", "generativelanguage")

    def _needs_key(pc: ProviderConfig) -> bool:
        return pc.kind in ("anthropic", "gemini") or any(h in (pc.base_url or "") for h in HOSTED)

    async def check_provider(pc: ProviderConfig) -> dict:
        if pc.kind != "agentserver" and _needs_key(pc) and not pc.resolved_api_key():
            return {"state": "nokey", "error": "no API key saved", "checked_at": time.time(), "ms": 0}
        t0 = time.time()
        try:
            models = await asyncio.wait_for(engine.provider(pc.id).list_models(), timeout=8.0)
            return {"state": "ok", "error": "", "checked_at": time.time(), "ms": int((time.time() - t0) * 1000), "models": len(models)}
        except Exception as e:
            msg = f"{type(e).__name__}: {e}" if not isinstance(e, ProviderError) else str(e)
            return {"state": "down", "error": msg[:220], "checked_at": time.time(), "ms": int((time.time() - t0) * 1000)}

    async def refresh_health() -> dict:
        provs = [p for p in engine.cfg.providers if p.enabled]
        results = await asyncio.gather(*(check_provider(p) for p in provs), return_exceptions=True)
        health = {}
        for p, r in zip(provs, results):
            health[p.id] = r if isinstance(r, dict) else {"state": "down", "error": str(r)[:200], "checked_at": time.time(), "ms": 0}
        app.state.provider_health = health
        return health

    async def health_loop(interval: float = 120.0) -> None:
        await asyncio.sleep(2)
        while True:
            try:
                await refresh_health()
            except Exception:  # pragma: no cover
                log.exception("provider health check failed")
            await asyncio.sleep(interval)

    def _note_health(pid: str, state: str, error: str = "") -> None:
        """A real turn is the best probe: a successful answer marks the provider ok, a transport/5xx failure marks it down."""
        if pid:
            app.state.provider_health[pid] = {"state": state, "error": error[:220], "checked_at": time.time(), "ms": 0}

    def _with_health(d: dict) -> dict:
        d["health"] = app.state.provider_health.get(d.get("id"), {"state": "unknown", "error": "", "checked_at": 0, "ms": 0})
        return d
    store = engine.store

    # ------------------------------------------------------------ auth
    def principal_of(request: Request) -> dict:
        cached = getattr(request.state, "principal", None)
        if cached:
            return cached
        p = {"role": "anon", "actor": "", "via": ""}
        tok = app.state.token
        bearer = ""
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            bearer = auth[7:].strip()
        cand = bearer or request.query_params.get("token", "") or request.cookies.get("missile_token", "")
        if tok and cand and secrets.compare_digest(cand, tok):
            p = {"role": "admin", "actor": "owner", "via": "token"}
        elif cand:
            t = store.lookup_token(cand)
            if t:
                p = {"role": "admin" if "admin" in t["scopes"] else "user", "actor": f"token:{t['name']}", "via": "token"}
        if p["role"] == "anon":
            sess = request.cookies.get(adminmod.SESSION_COOKIE)
            if sess:
                payload = adminmod.jwt_decode(sess)
                if payload and payload.get("typ") == "admin":
                    acct = store.get_admin(payload.get("sub", ""))
                    if acct:  # the role comes from the account row, so a demotion applies to live sessions too
                        p = {"role": acct.get("role") or "admin", "actor": payload["sub"], "via": "cookie"}
        if p["role"] == "anon" and not tok:
            host = request.client.host if request.client else ""
            if host in LOOPBACK or engine.cfg.server.host in LOOPBACK:
                p = {"role": "admin", "actor": "local", "via": "loopback"}
        request.state.principal = p
        return p

    def require_user(request: Request) -> dict:
        p = principal_of(request)
        if p["role"] == "anon":
            raise HTTPException(status_code=401, detail="unauthorized")
        # cookie sessions are ambient credentials: every mutation must prove it came from our own page
        if p.get("via") == "cookie" and request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get(adminmod.CSRF_HEADER, "").lower() != adminmod.CSRF_VALUE:
            raise HTTPException(status_code=403, detail="csrf")
        return p

    def require_admin(request: Request) -> dict:
        p = principal_of(request)
        if p["role"] != "admin":
            raise HTTPException(status_code=403 if p["role"] != "anon" else 401, detail="admin only")
        if p.get("via") == "cookie" and request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get(adminmod.CSRF_HEADER, "").lower() != adminmod.CSRF_VALUE:
            raise HTTPException(status_code=403, detail="csrf")
        return p

    user_dep = Depends(require_user)
    admin_dep = Depends(require_admin)

    @app.on_event("startup")
    async def _startup():
        await engine.start()
        created = adminmod.bootstrap_admin(store)
        if created:
            app.state.bootstrap_password = created[1]
            print(f"admin console: username '{created[0]}'  password '{created[1]}'  -> change it at /admin (or: ms admin reset-password)", flush=True)
        if not store.get_setting("signup_invite_code", ""):
            store.set_setting("signup_invite_code", secrets.token_urlsafe(6))  # shown in /admin -> Settings -> access
            store.event("info", "auth", "signup invite code generated", {}, actor="system")
        store.event("info", "system", "server started", {"version": __version__, "host": engine.cfg.server.host, "port": engine.cfg.server.port}, actor="system")
        app.state.retention_task = asyncio.create_task(adminmod.retention_loop(engine, store))
        app.state.health_task = asyncio.create_task(health_loop())

    @app.on_event("shutdown")
    async def _shutdown():
        for name in ("retention_task", "health_task"):
            t = getattr(app.state, name, None)
            if t:
                t.cancel()
        for b in list(app.state.bridges.values()):
            await b.stop()
        await engine.stop()

    # ------------------------------------------------------------ basics
    @app.get("/api/health")
    async def health(request: Request):
        p = principal_of(request)  # lets the UI skip its login screen when a cookie session or token cookie is already valid
        return {"ok": True, "version": __version__, "auth_required": bool(app.state.token), "signed_in": p["role"] != "anon", "via": p.get("via", ""), "signup": str(store.get_setting("signup_mode", "invite") or "invite"), "home": str(home_dir()), "maintenance": bool(store.get_setting("maintenance_mode", False))}

    @app.post("/api/login")
    async def login(body: LoginIn):
        if app.state.token and not secrets.compare_digest(body.token, app.state.token):
            if not store.lookup_token(body.token):
                raise HTTPException(401, "bad token")
        resp = JSONResponse({"ok": True})
        if app.state.token:
            resp.set_cookie("missile_token", body.token, httponly=True, samesite="lax", max_age=30 * 86400)
        return resp

    @app.get("/api/state", dependencies=[user_dep])
    async def state(request: Request):
        cfg = engine.cfg
        p = principal_of(request)
        return {
            "version": __version__,
            "home": str(home_dir()),
            "config_path": str(config_path()),
            "role": p["role"],
            "providers": [_with_health(_mask(x)) for x in cfg.providers],
            "presets": PROVIDER_PRESETS,
            "default": cfg.default.model_dump(),
            "assistants": [a.model_dump() for a in cfg.assistants],
            "mcp": engine.mcp.status(),
            "tools": [t.as_dict() for t in engine.all_tools()],
            "policy": cfg.tool_policy.model_dump(),
            "builtin_tools": _builtin_view(cfg),
            "tool_catalog": cfg.tool_catalog.model_dump(),
            "memory": cfg.memory.model_dump(),
            "knowledge": {**cfg.knowledge.model_dump(), **(engine.knowledge.status() if engine.knowledge else {})},
            "server": {"host": cfg.server.host, "port": cfg.server.port, "auth_required": bool(app.state.token)},
            "approvals": [a.as_dict() for a in engine.approvals.pending.values()],
            "bridges": [b.as_dict() for b in app.state.bridges.values()],
            "maintenance": bool(store.get_setting("maintenance_mode", False)),
            "model_presets": [p.model_dump() for p in cfg.effective_presets()],
            "presets_configured": bool(cfg.presets),
            "styles": [st.model_dump() for st in cfg.styles],
        }

    @app.put("/api/presets", dependencies=[admin_dep])
    async def put_presets(body: list[ModelPreset]):
        engine.cfg.presets = body
        engine.save()
        return [p.model_dump() for p in engine.cfg.effective_presets()]

    @app.post("/api/styles", dependencies=[admin_dep])
    async def upsert_style(body: StyleConfig):
        cfg = engine.cfg
        if cfg.style(body.id):
            cfg.styles = [body if x.id == body.id else x for x in cfg.styles]
        else:
            cfg.styles.append(body)
        engine.save()
        return [st.model_dump() for st in cfg.styles]

    @app.delete("/api/styles/{sid}", dependencies=[admin_dep])
    async def delete_style(sid: str):
        engine.cfg.styles = [x for x in engine.cfg.styles if x.id != sid]
        engine.save()
        return {"ok": True}

    # ------------------------------------------------------------ providers
    @app.get("/api/providers", dependencies=[user_dep])
    async def providers():
        return [_with_health(_mask(p)) for p in engine.cfg.providers]

    @app.get("/api/providers/health", dependencies=[user_dep])
    async def providers_health(refresh: int = 0):
        """Reachability per provider (ok / down / nokey), from the periodic probe or, with refresh=1, checked now."""
        if refresh:
            await refresh_health()
        return {pid: app.state.provider_health.get(pid, {"state": "unknown"}) for pid in (p.id for p in engine.cfg.providers)}

    @app.post("/api/providers", dependencies=[admin_dep])
    async def upsert_provider(body: dict):
        cfg = engine.cfg
        existing = cfg.provider(body.get("id", ""))
        body.pop("has_key", None)
        body.pop("has_password", None)
        if existing is not None:
            if not body.get("api_key") or "…" in str(body.get("api_key")):
                body["api_key"] = existing.api_key
            if not body.get("password") or "…" in str(body.get("password")):
                body["password"] = existing.password
            merged = {**existing.model_dump(), **body}
            pc = ProviderConfig.model_validate(merged)
            cfg.providers = [pc if p.id == pc.id else p for p in cfg.providers]
        else:
            pc = ProviderConfig.model_validate(body)
            cfg.providers.append(pc)
        if not cfg.default.provider:
            cfg.default.provider = pc.id
            cfg.default.model = pc.default_model
        engine._providers.pop(pc.id, None)
        engine.save()
        return _mask(pc)

    @app.delete("/api/providers/{pid}", dependencies=[admin_dep])
    async def delete_provider(pid: str):
        cfg = engine.cfg
        cfg.providers = [p for p in cfg.providers if p.id != pid]
        if cfg.default.provider == pid:
            cfg.default.provider = cfg.providers[0].id if cfg.providers else ""
            cfg.default.model = cfg.providers[0].default_model if cfg.providers else ""
        engine._providers.pop(pid, None)
        engine.save()
        return {"ok": True}

    @app.post("/api/providers/{pid}/models", dependencies=[admin_dep])
    async def discover(pid: str):
        try:
            models = await engine.discover_models(pid)
        except Exception as e:
            raise HTTPException(400, str(e))
        return {"models": models}

    @app.post("/api/providers/test", dependencies=[admin_dep])
    async def test_provider(body: dict):
        existing = engine.cfg.provider(body.get("id", ""))
        if existing is not None:
            # a partial body (just the id, or a changed field) is tested on top of the saved provider, so the saved
            # key is never sent to a default base URL it does not belong to
            if not body.get("api_key") or "…" in str(body.get("api_key")):
                body["api_key"] = existing.api_key
            if not body.get("password") or "…" in str(body.get("password")):
                body["password"] = existing.password
            body = {**existing.model_dump(), **body}
        body.pop("has_key", None)
        body.pop("has_password", None)
        pc = ProviderConfig.model_validate(body)
        return await engine.test_provider(pc)

    @app.post("/api/default", dependencies=[admin_dep])
    async def set_default(body: DefaultIn):
        d = engine.cfg.default
        if body.provider is not None:
            d.provider = body.provider
        if body.model is not None:
            d.model = body.model
        if body.assistant is not None:
            d.assistant = body.assistant
        engine.save()
        return d.model_dump()

    # ------------------------------------------------------------ assistants
    @app.get("/api/assistants", dependencies=[user_dep])
    async def assistants():
        return [a.model_dump() for a in engine.cfg.assistants]

    @app.post("/api/assistants", dependencies=[admin_dep])
    async def upsert_assistant(body: dict):
        a = AssistantConfig.model_validate(body)
        cfg = engine.cfg
        if cfg.assistant(a.id):
            cfg.assistants = [a if x.id == a.id else x for x in cfg.assistants]
        else:
            cfg.assistants.append(a)
        engine.save()
        return a.model_dump()

    @app.delete("/api/assistants/{aid}", dependencies=[admin_dep])
    async def delete_assistant(aid: str):
        if aid == "default":
            raise HTTPException(400, "cannot delete the default assistant")
        engine.cfg.assistants = [x for x in engine.cfg.assistants if x.id != aid]
        engine.save()
        return {"ok": True}

    # ------------------------------------------------------------ mcp
    @app.get("/api/mcp", dependencies=[user_dep])
    async def mcp_status():
        return engine.mcp.status()

    @app.post("/api/mcp", dependencies=[admin_dep])
    async def mcp_upsert(body: McpIn):
        name = body.name.strip()
        if not name:
            raise HTTPException(400, "name required")
        engine.cfg.mcp_servers[name] = body.config
        engine.save()
        await engine.mcp.configure(engine.cfg.mcp_servers)
        return {"ok": True}

    @app.delete("/api/mcp/{name}", dependencies=[admin_dep])
    async def mcp_delete(name: str):
        engine.cfg.mcp_servers.pop(name, None)
        engine.save()
        await engine.mcp.configure(engine.cfg.mcp_servers)
        return {"ok": True}

    @app.post("/api/mcp/{name}/restart", dependencies=[admin_dep])
    async def mcp_restart(name: str):
        if name not in engine.mcp.servers:
            raise HTTPException(404, "no such server")
        await engine.mcp.restart(name)
        return {"ok": True}

    @app.get("/api/mcp/import/sources", dependencies=[admin_dep])
    async def mcp_sources():
        out = []
        for name, paths in known_sources().items():
            found, files = import_from(name)
            out.append({"source": name, "paths": [str(p) for p in paths], "available": bool(files), "servers": list(found.keys())})
        return out

    @app.post("/api/mcp/import", dependencies=[admin_dep])
    async def mcp_import(body: ImportIn):
        if body.json_text:
            try:
                found = parse_servers(json.loads(body.json_text))
            except Exception as e:
                raise HTTPException(400, f"bad json: {e}")
        else:
            found, _files = import_from(body.source)
        added = []
        for name, c in found.items():
            if body.names and name not in body.names:
                continue
            engine.cfg.mcp_servers[name] = c
            added.append(name)
        engine.save()
        await engine.mcp.configure(engine.cfg.mcp_servers)
        return {"added": added}

    @app.get("/api/mcp/export", dependencies=[user_dep])
    async def mcp_export():
        return export_standard(engine.cfg.mcp_servers)

    # ------------------------------------------------------------ tools / policy
    @app.get("/api/tools", dependencies=[user_dep])
    async def tools():
        return [t.as_dict() for t in engine.all_tools()]

    @app.get("/api/policy", dependencies=[user_dep])
    async def get_policy():
        return engine.cfg.tool_policy.model_dump()

    @app.put("/api/policy", dependencies=[admin_dep])
    async def put_policy(body: ToolPolicy):
        engine.cfg.tool_policy = body
        engine.save()
        return body.model_dump()

    @app.put("/api/builtin-tools", dependencies=[admin_dep])
    async def put_builtin(body: dict):
        ws = body.get("web_search") or {}
        if ws.get("api_key") in ("…", "***"):  # the masked value from /api/state: keep the stored key
            ws["api_key"] = engine.cfg.builtin_tools.web_search.api_key
        engine.cfg.builtin_tools = BuiltinTools.model_validate(body)
        await engine.apply_config(engine.cfg)
        engine.save()
        return _builtin_view(engine.cfg)

    # ------------------------------------------------------------ search, memory, knowledge
    @app.get("/api/search", dependencies=[user_dep])
    async def search(q: str = "", limit: int = 30):
        return {"q": q, "hits": store.search_messages(q, max(1, min(limit, 100)))}

    class MemoryIn(BaseModel):
        text: str
        tags: str = ""

    class MemorySettingsIn(BaseModel):
        enabled: bool = True
        recall_k: int = 5

    @app.get("/api/memory", dependencies=[user_dep])
    async def memory_list(q: str = ""):
        return {"enabled": engine.cfg.memory.enabled, "recall_k": engine.cfg.memory.recall_k, "items": store.search_memories(q, 50) if q else store.list_memories()}

    @app.post("/api/memory", dependencies=[user_dep])
    async def memory_add(body: MemoryIn, request: Request):
        if not body.text.strip():
            raise HTTPException(400, "empty")
        m = store.add_memory(body.text, source=principal_of(request)["actor"], tags=body.tags)
        store.event("info", "data", "memory added", {"id": m["id"]}, actor=principal_of(request)["actor"])
        return m

    @app.put("/api/memory/{mid}", dependencies=[user_dep])
    async def memory_update(mid: str, body: MemoryIn):
        if not store.update_memory(mid, body.text):
            raise HTTPException(404, "no such memory")
        return store.get_memory(mid)

    @app.delete("/api/memory/{mid}", dependencies=[user_dep])
    async def memory_delete(mid: str):
        return {"ok": store.delete_memory(mid)}

    class ToolCatalogIn(BaseModel):
        mode: str = "auto"
        threshold: int = 24
        always: Any = None  # list or comma-separated string

    @app.put("/api/tool-catalog", dependencies=[admin_dep])
    async def tool_catalog(body: ToolCatalogIn):
        cc = engine.cfg.tool_catalog
        if body.mode in ("auto", "on", "off"):
            cc.mode = body.mode
        cc.threshold = max(1, min(int(body.threshold or 24), 500))
        if isinstance(body.always, str):
            cc.always = [s.strip() for s in body.always.split(",") if s.strip()]
        elif isinstance(body.always, list):
            cc.always = [str(s).strip() for s in body.always if str(s).strip()]
        engine.save()
        return cc.model_dump()

    @app.put("/api/memory-settings", dependencies=[admin_dep])  # not under /api/memory/{mid}
    async def memory_settings(body: MemorySettingsIn):
        engine.cfg.memory.enabled = body.enabled
        engine.cfg.memory.recall_k = max(0, min(body.recall_k, 20))
        await engine.apply_config(engine.cfg)
        engine.save()
        return engine.cfg.memory.model_dump()

    class KbSourceIn(BaseModel):
        path: str

    class KbSettingsIn(BaseModel):
        embeddings_provider: str = ""
        embeddings_model: str = ""
        chunk_chars: int = 900
        top_k: int = 6

    @app.get("/api/knowledge", dependencies=[user_dep])
    async def knowledge_status():
        return engine.knowledge.status() if engine.knowledge else {"error": "knowledge base unavailable"}

    @app.post("/api/knowledge/sources", dependencies=[admin_dep])
    async def knowledge_add(body: KbSourceIn, request: Request):
        p = Path(body.path).expanduser()
        if not p.exists():
            raise HTTPException(404, f"not found: {p}")
        src = store.kb_add_source(str(p.resolve()))
        if str(p.resolve()) not in engine.cfg.knowledge.sources:
            engine.cfg.knowledge.sources.append(str(p.resolve()))
            engine.save()
        store.event("info", "data", "knowledge source added", {"path": str(p)}, actor=principal_of(request)["actor"])
        asyncio.create_task(engine.knowledge.reindex(src["id"]))
        return src

    @app.delete("/api/knowledge/sources/{sid}", dependencies=[admin_dep])
    async def knowledge_delete(sid: str):
        src = next((s for s in store.kb_list_sources() if s["id"] == sid), None)
        if not src:
            raise HTTPException(404, "no such source")
        store.kb_delete_source(sid)
        engine.cfg.knowledge.sources = [s for s in engine.cfg.knowledge.sources if s != src["path"]]
        engine.save()
        return {"ok": True}

    @app.post("/api/knowledge/reindex", dependencies=[admin_dep])
    async def knowledge_reindex(wait: bool = False):
        if wait:
            return await engine.knowledge.reindex()
        asyncio.create_task(engine.knowledge.reindex())
        return {"ok": True, "started": True}

    @app.get("/api/knowledge/search", dependencies=[user_dep])
    async def knowledge_search(q: str = "", k: int = 6):
        return {"q": q, "hits": await engine.knowledge.search(q, max(1, min(k, 20)))}

    @app.put("/api/knowledge/settings", dependencies=[admin_dep])
    async def knowledge_settings(body: KbSettingsIn):
        kc = engine.cfg.knowledge
        kc.embeddings_provider, kc.embeddings_model = body.embeddings_provider, body.embeddings_model
        kc.chunk_chars, kc.top_k = max(200, min(body.chunk_chars, 4000)), max(1, min(body.top_k, 20))
        engine.save()
        return kc.model_dump()

    # ------------------------------------------------------------ conversations
    @app.get("/api/conversations", dependencies=[user_dep])
    async def conversations():
        rows = store.list_conversations()
        for r in rows:
            r["running"] = r["id"] in app.state.turn_tasks
        return rows

    @app.post("/api/conversations", dependencies=[user_dep])
    async def create_conversation(body: ConvIn):
        return store.create_conversation(title=body.title, assistant_id=body.assistant_id, provider_id=body.provider_id, model=body.model)

    @app.get("/api/conversations/{cid}", dependencies=[user_dep])
    async def get_conversation(cid: str):
        conv = store.get_conversation(cid)
        if not conv:
            raise HTTPException(404, "not found")
        conv["messages"] = store.get_messages(cid)
        conv["branches"] = store.branch_info(cid, conv["messages"])
        return conv

    @app.patch("/api/conversations/{cid}", dependencies=[user_dep])
    async def patch_conversation(cid: str, body: dict):
        allowed = {k: v for k, v in body.items() if k in ("title", "assistant_id", "provider_id", "model", "style_id")}
        store.update_conversation(cid, **allowed)
        return store.get_conversation(cid)

    @app.post("/api/conversations/{cid}/head", dependencies=[user_dep])
    async def switch_branch(cid: str, body: HeadIn):
        """Make a sibling the visible branch: the head moves to the deepest message under it."""
        if not store.get_conversation(cid):
            raise HTTPException(404, "not found")
        store.set_head(cid, store.leaf_of(cid, body.message_id))
        conv = store.get_conversation(cid)
        conv["messages"] = store.get_messages(cid)
        conv["branches"] = store.branch_info(cid, conv["messages"])
        return conv

    @app.delete("/api/conversations/{cid}", dependencies=[user_dep])
    async def delete_conversation(cid: str):
        store.delete_conversation(cid)
        return {"ok": True}

    # ------------------------------------------------------------ chat
    @app.post("/api/chat", dependencies=[user_dep])
    async def chat(body: ChatIn, request: Request):
        p = principal_of(request)
        if store.get_setting("maintenance_mode", False) and p["role"] != "admin":
            raise HTTPException(503, "maintenance mode: chat is paused by the administrator")
        if body.conversation_id in app.state.turn_tasks:
            raise HTTPException(409, "a turn is already running for this conversation")
        if body.branch_from:
            # editing an earlier message: rewind the head to its parent, the new message becomes a sibling
            store.set_head(body.conversation_id, store.parent_of(body.conversation_id, body.branch_from))
        if body.style_id:
            store.update_conversation(body.conversation_id, style_id=body.style_id)
        req = TurnRequest(
            conversation_id=body.conversation_id,
            user_text=body.text,
            attachments=body.attachments,
            provider_id=body.provider_id,
            model=body.model,
            assistant_id=body.assistant_id,
            tools_override=body.tools,
            allow_dangerous=body.allow_dangerous and p["role"] == "admin",
            thinking=body.thinking,
            style_id=body.style_id,
            mode=body.mode,
            knowledge=body.knowledge,
        )
        # The turn runs on the server in its own task and writes to a buffer; the browser only *follows* that
        # buffer. Closing the tab therefore does not stop the turn, and a new tab can reattach and replay.
        ts = TurnStream(body.conversation_id)
        app.state.turn_streams[body.conversation_id] = ts

        async def producer():
            try:
                used_pid, got_text, err = "", False, ""
                async for ev in engine.run_turn(req):
                    await ts.push(ev)
                    et = ev.get("type")
                    if et == "message" and (ev.get("message") or {}).get("role") == "assistant":
                        used_pid = ((ev["message"].get("meta") or {}).get("provider")) or used_pid
                    elif et == "text_delta" or et == "tool_call":
                        got_text = True
                    elif et == "error":
                        err = str(ev.get("message", ""))
                if used_pid and got_text:
                    _note_health(used_pid, "ok")
                elif used_pid and err and (re.search(r"\b5\d\d\b|Connect|timed out|timeout|RemoteProtocol|ReadError", err)):
                    _note_health(used_pid, "down", err)
            except asyncio.CancelledError:
                await ts.push({"type": "done", "finish_reason": "cancelled"})
            except Exception as e:  # pragma: no cover
                log.exception("turn failed")
                await ts.push({"type": "error", "message": f"{type(e).__name__}: {e}"})
                await ts.push({"type": "done", "finish_reason": "error"})
            finally:
                await ts.finish()
                app.state.turn_tasks.pop(body.conversation_id, None)
                asyncio.get_running_loop().call_later(STREAM_RETENTION, lambda: app.state.turn_streams.pop(body.conversation_id, None) if app.state.turn_streams.get(body.conversation_id) is ts else None)

        task = asyncio.create_task(producer())
        app.state.turn_tasks[body.conversation_id] = task
        return StreamingResponse(ts.follow(0), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"})

    @app.get("/api/chat/{cid}/stream", dependencies=[user_dep])
    async def chat_stream(cid: str, after: int = 0):
        """Reattach to a running (or just finished) turn: replays buffered events from ``after``, then follows live."""
        ts = app.state.turn_streams.get(cid)
        if ts is None:
            raise HTTPException(404, "no turn stream for this conversation")
        return StreamingResponse(ts.follow(after), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"})

    @app.post("/api/chat/{cid}/stop", dependencies=[user_dep])
    async def stop_chat(cid: str):
        task = app.state.turn_tasks.get(cid)
        if task:
            task.cancel()
            return {"ok": True, "stopped": True}
        return {"ok": True, "stopped": False}

    # ------------------------------------------------------------ approvals / audit
    @app.get("/api/approvals", dependencies=[user_dep])
    async def approvals():
        return [a.as_dict() for a in engine.approvals.pending.values()]

    @app.post("/api/approvals/{call_id}", dependencies=[user_dep])
    async def decide(call_id: str, body: DecisionIn, request: Request):
        if body.decision not in ("allow", "allow_session", "allow_always", "deny"):
            raise HTTPException(400, "bad decision")
        if body.decision == "allow_always" and principal_of(request)["role"] != "admin":
            body.decision = "allow_session"
        ok = engine.approvals.resolve(call_id, body.decision)
        return {"ok": ok}

    @app.get("/api/audit", dependencies=[user_dep])
    async def audit(limit: int = 200, conversation_id: str = ""):
        return store.list_audit(limit=limit, conversation_id=conversation_id)

    # ------------------------------------------------------------ uploads
    @app.post("/api/upload", dependencies=[user_dep])
    async def upload(file: UploadFile = File(...)):
        data = await file.read()
        max_mb = int(store.get_setting("upload_max_mb", 25) or 25)
        if len(data) > max_mb * 1024 * 1024:
            raise HTTPException(413, f"file too large ({max_mb}MB)")
        ctype = file.content_type or mimetypes.guess_type(file.filename or "")[0] or "application/octet-stream"
        if ctype.startswith("image/"):
            return {"name": file.filename, "data_url": f"data:{ctype};base64,{base64.b64encode(data).decode()}", "size": len(data)}
        text: Optional[str] = None
        if ctype == "application/pdf" or (file.filename or "").lower().endswith(".pdf"):
            try:
                import io

                from pypdf import PdfReader  # optional dependency

                reader = PdfReader(io.BytesIO(data))
                text = "\n".join((p.extract_text() or "") for p in reader.pages)
            except Exception:
                text = None
        if text is None:
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError:
                try:
                    text = data.decode("cp949")
                except UnicodeDecodeError:
                    raise HTTPException(415, "binary file not supported (text, markdown, code, pdf, images)")
        if len(text) > 400_000:
            text = text[:400_000] + "\n... [truncated]"
        return {"name": file.filename, "text": text, "size": len(data)}

    # ------------------------------------------------------------ agent server
    @app.get("/api/agents/{pid}", dependencies=[user_dep])
    async def list_agents(pid: str):
        from ..providers.agentserver import AgentServerProvider

        p = engine.provider(pid)
        if not isinstance(p, AgentServerProvider):
            raise HTTPException(400, "not an agent server provider")
        try:
            return await p.list_agents()
        except Exception as e:
            raise HTTPException(400, str(e))

    @app.get("/api/bridge", dependencies=[user_dep])
    async def bridges():
        return [b.as_dict() for b in app.state.bridges.values()]

    @app.post("/api/bridge/start", dependencies=[admin_dep])
    async def bridge_start(body: BridgeIn):
        if body.provider_id in app.state.bridges:
            await app.state.bridges[body.provider_id].stop()
        b = DeviceBridge(engine, body.provider_id, device_name=body.device_name, trust=body.trust)
        app.state.bridges[body.provider_id] = b
        b.start()
        await asyncio.sleep(0.5)
        return b.as_dict()

    @app.post("/api/bridge/stop", dependencies=[admin_dep])
    async def bridge_stop(body: BridgeIn):
        b = app.state.bridges.pop(body.provider_id, None)
        if b:
            await b.stop()
        return {"ok": True}

    # ------------------------------------------------------------ workspace (IDE drawer)
    SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache", ".history"}

    def _ws_resolve(rel: str) -> Path:
        try:
            return engine.local._resolve(rel or ".")
        except PermissionError as e:
            raise HTTPException(403, str(e))

    @app.get("/api/workspace/tree", dependencies=[user_dep])
    async def ws_tree(path: str = "."):
        root = _ws_resolve(path)
        if not root.exists():
            raise HTTPException(404, "no such folder")
        if not root.is_dir():
            raise HTTPException(400, "not a folder")
        entries = []
        try:
            for e in sorted(root.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
                if e.name in SKIP_DIRS:
                    continue
                try:
                    st = e.stat()
                except OSError:
                    continue
                entries.append({"name": e.name, "dir": e.is_dir(), "size": 0 if e.is_dir() else st.st_size, "mtime": st.st_mtime, "path": str(e.relative_to(engine.local.workspace)).replace("\\", "/")})
                if len(entries) >= 2000:
                    break
        except OSError as e:
            raise HTTPException(400, str(e))
        return {"root": str(engine.local.workspace), "path": str(root.relative_to(engine.local.workspace)).replace("\\", "/") if root != engine.local.workspace else ".", "entries": entries}

    @app.get("/api/workspace/file", dependencies=[user_dep])
    async def ws_read(path: str):
        p = _ws_resolve(path)
        if not p.is_file():
            raise HTTPException(404, "no such file")
        size = p.stat().st_size
        if size > 2 * 1024 * 1024:
            raise HTTPException(413, "file larger than 2MB")
        data = p.read_bytes()
        if b"\x00" in data[:8000]:
            raise HTTPException(415, "binary file")
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            text = data.decode("cp949", "replace")
        return {"path": path, "content": text, "size": size, "mtime": p.stat().st_mtime}

    @app.get("/api/workspace/download", dependencies=[user_dep])
    async def ws_download(path: str):
        """Any file in the workspace as an attachment (binary too): what the agent wrote, what you saved."""
        p = _ws_resolve(path)
        if not p.is_file():
            raise HTTPException(404, "no such file")
        if p.stat().st_size > 512 * 1024 * 1024:
            raise HTTPException(413, "file larger than 512MB")
        mt = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
        return FileResponse(p, media_type=mt, filename=p.name, headers={"Cache-Control": "no-store"})

    class WsFileIn(BaseModel):
        path: str
        content: str

    def _history_dir() -> Path:
        d = engine.local.workspace / ".history"
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _history_key(rel: str) -> str:
        return rel.replace("\\", "/").strip("/").replace("/", "__")

    @app.put("/api/workspace/file", dependencies=[admin_dep])
    async def ws_write(body: WsFileIn, request: Request):
        p = _ws_resolve(body.path)
        p.parent.mkdir(parents=True, exist_ok=True)
        versioned = False
        if p.exists() and p.is_file():
            try:
                old = p.read_bytes()
                if old != body.content.encode("utf-8"):
                    key = _history_key(body.path)
                    (_history_dir() / f"{key}.{int(time.time() * 1000)}.bak").write_bytes(old)
                    versioned = True
                    for b in sorted(_history_dir().glob(f"{key}.*.bak"))[:-20]:
                        b.unlink(missing_ok=True)
            except OSError:
                pass
        with p.open("w", encoding="utf-8", newline="\n") as f:
            f.write(body.content)
        store.event("info", "data", "workspace file saved", {"path": body.path, "bytes": len(body.content), "versioned": versioned}, actor=principal_of(request)["actor"])
        return {"ok": True, "path": body.path, "size": p.stat().st_size, "mtime": p.stat().st_mtime, "versioned": versioned}

    @app.get("/api/workspace/history", dependencies=[user_dep])
    async def ws_history(path: str):
        key = _history_key(path)
        out = []
        for b in sorted(_history_dir().glob(f"{key}.*.bak"), reverse=True):
            try:
                ts = int(b.name[len(key) + 1 : -4]) / 1000
            except ValueError:
                ts = b.stat().st_mtime
            out.append({"name": b.name, "ts": ts, "size": b.stat().st_size})
        return {"path": path, "versions": out}

    @app.get("/api/workspace/history/file", dependencies=[user_dep])
    async def ws_history_file(name: str):
        b = (_history_dir() / name).resolve()
        if b.parent != _history_dir().resolve() or not b.exists():
            raise HTTPException(404, "no such version")
        data = b.read_bytes()
        try:
            return {"name": name, "content": data.decode("utf-8")}
        except UnicodeDecodeError:
            return {"name": name, "content": data.decode("cp949", "replace")}

    @app.delete("/api/workspace/file", dependencies=[admin_dep])
    async def ws_delete(path: str, request: Request):
        p = _ws_resolve(path)
        if p == engine.local.workspace:
            raise HTTPException(400, "cannot delete the workspace root")
        if p.is_dir():
            import shutil

            shutil.rmtree(p)
        elif p.exists():
            p.unlink()
        else:
            raise HTTPException(404, "no such path")
        store.event("info", "data", "workspace path deleted", {"path": path}, actor=principal_of(request)["actor"])
        return {"ok": True}

    class WsRunIn(BaseModel):
        command: str
        cwd: str = ""
        timeout_seconds: int = 120

    @app.post("/api/workspace/run", dependencies=[admin_dep])
    async def ws_run(body: WsRunIn, request: Request):
        if not engine.cfg.builtin_tools.shell:
            raise HTTPException(400, "the local shell tool is disabled in settings")
        t0 = time.time()
        out = await engine.local.run_shell(body.command, timeout_seconds=max(1, min(body.timeout_seconds, 600)), cwd=body.cwd)
        store.audit(conversation_id="workspace", tool="workspace__run", arguments={"command": body.command, "cwd": body.cwd}, decision="human", is_error=not out.rstrip().endswith("[exit 0]"), duration_ms=int((time.time() - t0) * 1000), result_excerpt=out[:2000])
        return {"output": out, "duration_ms": int((time.time() - t0) * 1000)}

    # ------------------------------------------------------------ admin console
    app.include_router(adminmod.create_admin_router(engine, store, app.state, principal_of))

    # ------------------------------------------------------------ static
    @app.middleware("http")
    async def _static_no_cache(request: Request, call_next):
        resp = await call_next(request)
        if request.url.path.startswith("/static/"):
            resp.headers["Cache-Control"] = "no-cache"  # revalidate (ETag) so UI updates land without a hard reload
        return resp

    app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")

    @app.get("/")
    async def index():
        return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-store, max-age=0, must-revalidate", "Pragma": "no-cache", "Expires": "0"})

    @app.get("/admin")
    @app.get("/admin/{rest:path}")
    async def admin_index(rest: str = ""):
        return FileResponse(STATIC / "admin.html", headers={"Cache-Control": "no-store, max-age=0, must-revalidate", "Pragma": "no-cache", "Expires": "0"})

    @app.get("/favicon.ico")
    async def favicon():
        # the brand mark (static/brand/*) is the owner's avatar; replace those files to rebrand
        return FileResponse(STATIC / "brand" / "favicon.png", media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})

    return app


def run_server(host: str, port: int, token: str = "", open_browser: bool = False, log_level: str = "info") -> None:
    import uvicorn

    from ..config import load_config

    cfg = load_config()
    cfg.server.host = host
    cfg.server.port = port
    if token:
        cfg.server.token = token
    tok = ensure_token(cfg, persist=True)
    engine = Engine(cfg)
    app = create_app(engine, tok)
    url = f"http://{'127.0.0.1' if host in ('0.0.0.0', '::') else host}:{port}/"
    print(f"missile-studio {__version__}  ->  {url}" + (f"?token={tok}" if tok else ""))
    print(f"admin console: {url}admin   config: {config_path()}")
    if tok:
        print("auth token required (also usable as `Authorization: Bearer <token>`)")
    if open_browser:
        import webbrowser

        webbrowser.open(url + (f"?token={tok}" if tok else ""))
    uvicorn.run(app, host=host, port=port, log_level=log_level, access_log=False)
