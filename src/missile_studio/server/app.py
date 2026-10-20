"""FastAPI app: JSON API + SSE chat stream + static web UI.

Auth: when a token is configured (always when bound to a non-loopback host), every /api route
except /api/health and /api/login requires ``Authorization: Bearer <token>`` or the cookie set
by /api/login. The UI stores the token in localStorage and sends the header.
"""

import asyncio
import base64
import json
import logging
import mimetypes
import secrets
import time
from pathlib import Path
from typing import Any, Optional

from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .. import __version__
from ..config import PROVIDER_PRESETS, AssistantConfig, Config, McpServerConfig, ProviderConfig, ToolPolicy, config_path, ensure_token, home_dir
from ..engine import Engine, TurnRequest
from ..mcp.importers import export_standard, import_from, known_sources
from ..device_bridge import DeviceBridge

log = logging.getLogger("missile.server")
STATIC = Path(__file__).parent / "static"


def _mask(pc: ProviderConfig) -> dict:
    d = pc.model_dump()
    if d.get("api_key"):
        k = d["api_key"]
        d["api_key"] = (k[:4] + "…" + k[-4:]) if len(k) > 10 else "…"
        d["has_key"] = True
    else:
        d["has_key"] = bool(pc.api_key_env)
    if d.get("password"):
        d["password"] = "…"
        d["has_password"] = True
    return d


def create_app(engine: Engine, token: str = "") -> FastAPI:
    app = FastAPI(title="missile-studio", version=__version__, docs_url="/api/docs", openapi_url="/api/openapi.json")
    app.state.engine = engine
    app.state.token = token
    app.state.bridges: dict[str, DeviceBridge] = {}
    app.state.turn_tasks: dict[str, asyncio.Task] = {}

    # ------------------------------------------------------------ auth
    def check_auth(request: Request) -> None:
        tok = app.state.token
        if not tok:
            return
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer ") and secrets.compare_digest(auth[7:].strip(), tok):
            return
        if secrets.compare_digest(request.cookies.get("missile_token", ""), tok):
            return
        q = request.query_params.get("token", "")
        if q and secrets.compare_digest(q, tok):
            return
        raise HTTPException(status_code=401, detail="unauthorized")

    auth_dep = Depends(check_auth)

    @app.on_event("startup")
    async def _startup():
        await engine.start()

    @app.on_event("shutdown")
    async def _shutdown():
        for b in list(app.state.bridges.values()):
            await b.stop()
        await engine.stop()

    # ------------------------------------------------------------ basics
    @app.get("/api/health")
    async def health():
        return {"ok": True, "version": __version__, "auth_required": bool(app.state.token), "home": str(home_dir())}

    class LoginIn(BaseModel):
        token: str

    @app.post("/api/login")
    async def login(body: LoginIn):
        if app.state.token and not secrets.compare_digest(body.token, app.state.token):
            raise HTTPException(401, "bad token")
        resp = JSONResponse({"ok": True})
        if app.state.token:
            resp.set_cookie("missile_token", app.state.token, httponly=True, samesite="lax", max_age=30 * 86400)
        return resp

    @app.get("/api/state", dependencies=[auth_dep])
    async def state():
        cfg = engine.cfg
        return {
            "version": __version__,
            "home": str(home_dir()),
            "config_path": str(config_path()),
            "providers": [_mask(p) for p in cfg.providers],
            "presets": PROVIDER_PRESETS,
            "default": cfg.default.model_dump(),
            "assistants": [a.model_dump() for a in cfg.assistants],
            "mcp": engine.mcp.status(),
            "tools": [t.as_dict() for t in engine.all_tools()],
            "policy": cfg.tool_policy.model_dump(),
            "builtin_tools": {**cfg.builtin_tools.model_dump(), "workspace_resolved": str(cfg.builtin_tools.workspace_path())},
            "server": {"host": cfg.server.host, "port": cfg.server.port, "auth_required": bool(app.state.token)},
            "approvals": [a.as_dict() for a in engine.approvals.pending.values()],
            "bridges": [b.as_dict() for b in app.state.bridges.values()],
        }

    # ------------------------------------------------------------ providers
    @app.get("/api/providers", dependencies=[auth_dep])
    async def providers():
        return [_mask(p) for p in engine.cfg.providers]

    @app.post("/api/providers", dependencies=[auth_dep])
    async def upsert_provider(body: dict):
        cfg = engine.cfg
        existing = cfg.provider(body.get("id", ""))
        if existing is not None:
            # keep secrets when the UI sends the masked placeholder
            if not body.get("api_key") or "…" in str(body.get("api_key")):
                body["api_key"] = existing.api_key
            if not body.get("password") or "…" in str(body.get("password")):
                body["password"] = existing.password
            merged = {**existing.model_dump(), **{k: v for k, v in body.items() if k != "has_key"}}
            pc = ProviderConfig.model_validate(merged)
            cfg.providers = [pc if p.id == pc.id else p for p in cfg.providers]
        else:
            body.pop("has_key", None)
            body.pop("has_password", None)
            pc = ProviderConfig.model_validate(body)
            cfg.providers.append(pc)
        if not cfg.default.provider:
            cfg.default.provider = pc.id
            cfg.default.model = pc.default_model
        engine._providers.pop(pc.id, None)
        engine.save()
        return _mask(pc)

    @app.delete("/api/providers/{pid}", dependencies=[auth_dep])
    async def delete_provider(pid: str):
        cfg = engine.cfg
        cfg.providers = [p for p in cfg.providers if p.id != pid]
        if cfg.default.provider == pid:
            cfg.default.provider = cfg.providers[0].id if cfg.providers else ""
            cfg.default.model = cfg.providers[0].default_model if cfg.providers else ""
        engine._providers.pop(pid, None)
        engine.save()
        return {"ok": True}

    @app.post("/api/providers/{pid}/models", dependencies=[auth_dep])
    async def discover(pid: str):
        try:
            models = await engine.discover_models(pid)
        except Exception as e:
            raise HTTPException(400, str(e))
        return {"models": models}

    @app.post("/api/providers/test", dependencies=[auth_dep])
    async def test_provider(body: dict):
        existing = engine.cfg.provider(body.get("id", ""))
        if existing is not None and (not body.get("api_key") or "…" in str(body.get("api_key"))):
            body["api_key"] = existing.api_key
        if existing is not None and (not body.get("password") or "…" in str(body.get("password"))):
            body["password"] = existing.password
        body.pop("has_key", None)
        body.pop("has_password", None)
        pc = ProviderConfig.model_validate(body)
        return await engine.test_provider(pc)

    class DefaultIn(BaseModel):
        provider: Optional[str] = None
        model: Optional[str] = None
        assistant: Optional[str] = None

    @app.post("/api/default", dependencies=[auth_dep])
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
    @app.get("/api/assistants", dependencies=[auth_dep])
    async def assistants():
        return [a.model_dump() for a in engine.cfg.assistants]

    @app.post("/api/assistants", dependencies=[auth_dep])
    async def upsert_assistant(body: dict):
        a = AssistantConfig.model_validate(body)
        cfg = engine.cfg
        if cfg.assistant(a.id):
            cfg.assistants = [a if x.id == a.id else x for x in cfg.assistants]
        else:
            cfg.assistants.append(a)
        engine.save()
        return a.model_dump()

    @app.delete("/api/assistants/{aid}", dependencies=[auth_dep])
    async def delete_assistant(aid: str):
        if aid == "default":
            raise HTTPException(400, "cannot delete the default assistant")
        engine.cfg.assistants = [x for x in engine.cfg.assistants if x.id != aid]
        engine.save()
        return {"ok": True}

    # ------------------------------------------------------------ mcp
    @app.get("/api/mcp", dependencies=[auth_dep])
    async def mcp_status():
        return engine.mcp.status()

    class McpIn(BaseModel):
        name: str
        config: McpServerConfig

    @app.post("/api/mcp", dependencies=[auth_dep])
    async def mcp_upsert(body: McpIn):
        name = body.name.strip()
        if not name:
            raise HTTPException(400, "name required")
        engine.cfg.mcp_servers[name] = body.config
        engine.save()
        await engine.mcp.configure(engine.cfg.mcp_servers)
        return {"ok": True}

    @app.delete("/api/mcp/{name}", dependencies=[auth_dep])
    async def mcp_delete(name: str):
        engine.cfg.mcp_servers.pop(name, None)
        engine.save()
        await engine.mcp.configure(engine.cfg.mcp_servers)
        return {"ok": True}

    @app.post("/api/mcp/{name}/restart", dependencies=[auth_dep])
    async def mcp_restart(name: str):
        if name not in engine.mcp.servers:
            raise HTTPException(404, "no such server")
        await engine.mcp.restart(name)
        return {"ok": True}

    @app.get("/api/mcp/import/sources", dependencies=[auth_dep])
    async def mcp_sources():
        out = []
        for name, paths in known_sources().items():
            found, files = import_from(name)
            out.append({"source": name, "paths": [str(p) for p in paths], "available": bool(files), "servers": list(found.keys())})
        return out

    class ImportIn(BaseModel):
        source: str
        names: Optional[list[str]] = None
        json_text: Optional[str] = None

    @app.post("/api/mcp/import", dependencies=[auth_dep])
    async def mcp_import(body: ImportIn):
        if body.json_text:
            from ..mcp.importers import parse_servers

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

    @app.get("/api/mcp/export", dependencies=[auth_dep])
    async def mcp_export():
        return export_standard(engine.cfg.mcp_servers)

    # ------------------------------------------------------------ tools / policy
    @app.get("/api/tools", dependencies=[auth_dep])
    async def tools():
        return [t.as_dict() for t in engine.all_tools()]

    @app.get("/api/policy", dependencies=[auth_dep])
    async def get_policy():
        return engine.cfg.tool_policy.model_dump()

    @app.put("/api/policy", dependencies=[auth_dep])
    async def put_policy(body: ToolPolicy):
        engine.cfg.tool_policy = body
        engine.save()
        return body.model_dump()

    @app.put("/api/builtin-tools", dependencies=[auth_dep])
    async def put_builtin(body: dict):
        from ..config import BuiltinTools

        engine.cfg.builtin_tools = BuiltinTools.model_validate(body)
        await engine.apply_config(engine.cfg)
        return engine.cfg.builtin_tools.model_dump()

    # ------------------------------------------------------------ conversations
    @app.get("/api/conversations", dependencies=[auth_dep])
    async def conversations():
        return engine.store.list_conversations()

    class ConvIn(BaseModel):
        assistant_id: str = "default"
        provider_id: str = ""
        model: str = ""
        title: str = ""

    @app.post("/api/conversations", dependencies=[auth_dep])
    async def create_conversation(body: ConvIn):
        return engine.store.create_conversation(title=body.title, assistant_id=body.assistant_id, provider_id=body.provider_id, model=body.model)

    @app.get("/api/conversations/{cid}", dependencies=[auth_dep])
    async def get_conversation(cid: str):
        conv = engine.store.get_conversation(cid)
        if not conv:
            raise HTTPException(404, "not found")
        conv["messages"] = engine.store.get_messages(cid)
        return conv

    @app.patch("/api/conversations/{cid}", dependencies=[auth_dep])
    async def patch_conversation(cid: str, body: dict):
        allowed = {k: v for k, v in body.items() if k in ("title", "assistant_id", "provider_id", "model")}
        engine.store.update_conversation(cid, **allowed)
        return engine.store.get_conversation(cid)

    @app.delete("/api/conversations/{cid}", dependencies=[auth_dep])
    async def delete_conversation(cid: str):
        engine.store.delete_conversation(cid)
        return {"ok": True}

    # ------------------------------------------------------------ chat
    class ChatIn(BaseModel):
        conversation_id: str
        text: str
        provider_id: str = ""
        model: str = ""
        assistant_id: str = ""
        attachments: list[dict] = []
        tools: Any = None
        allow_dangerous: bool = False

    @app.post("/api/chat", dependencies=[auth_dep])
    async def chat(body: ChatIn, request: Request):
        if body.conversation_id in app.state.turn_tasks:
            raise HTTPException(409, "a turn is already running for this conversation")
        req = TurnRequest(
            conversation_id=body.conversation_id,
            user_text=body.text,
            attachments=body.attachments,
            provider_id=body.provider_id,
            model=body.model,
            assistant_id=body.assistant_id,
            tools_override=body.tools,
            allow_dangerous=body.allow_dangerous,
        )
        queue: asyncio.Queue = asyncio.Queue()

        async def producer():
            try:
                async for ev in engine.run_turn(req):
                    await queue.put(ev)
            except asyncio.CancelledError:
                await queue.put({"type": "done", "finish_reason": "cancelled"})
            except Exception as e:  # pragma: no cover
                log.exception("turn failed")
                await queue.put({"type": "error", "message": f"{type(e).__name__}: {e}"})
                await queue.put({"type": "done", "finish_reason": "error"})
            finally:
                await queue.put(None)

        task = asyncio.create_task(producer())
        app.state.turn_tasks[body.conversation_id] = task

        async def gen():
            try:
                yield f"event: open\ndata: {json.dumps({'type': 'open', 'conversation_id': body.conversation_id})}\n\n"
                last = time.time()
                while True:
                    try:
                        ev = await asyncio.wait_for(queue.get(), timeout=15.0)
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
                        continue
                    if ev is None:
                        break
                    yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
                    last = time.time()
            finally:
                if not task.done():
                    task.cancel()
                app.state.turn_tasks.pop(body.conversation_id, None)

        return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"})

    @app.post("/api/chat/{cid}/stop", dependencies=[auth_dep])
    async def stop_chat(cid: str):
        task = app.state.turn_tasks.get(cid)
        if task:
            task.cancel()
            return {"ok": True, "stopped": True}
        return {"ok": True, "stopped": False}

    # ------------------------------------------------------------ approvals / audit
    @app.get("/api/approvals", dependencies=[auth_dep])
    async def approvals():
        return [a.as_dict() for a in engine.approvals.pending.values()]

    class DecisionIn(BaseModel):
        decision: str  # allow | allow_session | allow_always | deny

    @app.post("/api/approvals/{call_id}", dependencies=[auth_dep])
    async def decide(call_id: str, body: DecisionIn):
        if body.decision not in ("allow", "allow_session", "allow_always", "deny"):
            raise HTTPException(400, "bad decision")
        ok = engine.approvals.resolve(call_id, body.decision)
        return {"ok": ok}

    @app.get("/api/audit", dependencies=[auth_dep])
    async def audit(limit: int = 200, conversation_id: str = ""):
        return engine.store.list_audit(limit=limit, conversation_id=conversation_id)

    # ------------------------------------------------------------ uploads
    @app.post("/api/upload", dependencies=[auth_dep])
    async def upload(file: UploadFile = File(...)):
        data = await file.read()
        if len(data) > 25 * 1024 * 1024:
            raise HTTPException(413, "file too large (25MB)")
        ctype = file.content_type or mimetypes.guess_type(file.filename or "")[0] or "application/octet-stream"
        if ctype.startswith("image/"):
            return {"name": file.filename, "data_url": f"data:{ctype};base64,{base64.b64encode(data).decode()}", "size": len(data)}
        text: Optional[str] = None
        if ctype == "application/pdf" or (file.filename or "").lower().endswith(".pdf"):
            try:
                from pypdf import PdfReader  # optional dependency
                import io

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
    @app.get("/api/agents/{pid}", dependencies=[auth_dep])
    async def list_agents(pid: str):
        from ..providers.agentserver import AgentServerProvider

        p = engine.provider(pid)
        if not isinstance(p, AgentServerProvider):
            raise HTTPException(400, "not an agent server provider")
        try:
            return await p.list_agents()
        except Exception as e:
            raise HTTPException(400, str(e))

    class BridgeIn(BaseModel):
        provider_id: str
        trust: bool = False
        device_name: str = ""

    @app.get("/api/bridge", dependencies=[auth_dep])
    async def bridges():
        return [b.as_dict() for b in app.state.bridges.values()]

    @app.post("/api/bridge/start", dependencies=[auth_dep])
    async def bridge_start(body: BridgeIn):
        if body.provider_id in app.state.bridges:
            await app.state.bridges[body.provider_id].stop()
        b = DeviceBridge(engine, body.provider_id, device_name=body.device_name, trust=body.trust)
        app.state.bridges[body.provider_id] = b
        b.start()
        await asyncio.sleep(0.5)
        return b.as_dict()

    @app.post("/api/bridge/stop", dependencies=[auth_dep])
    async def bridge_stop(body: BridgeIn):
        b = app.state.bridges.pop(body.provider_id, None)
        if b:
            await b.stop()
        return {"ok": True}

    # ------------------------------------------------------------ static
    app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")

    @app.get("/")
    async def index():
        return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})

    @app.get("/favicon.ico")
    async def favicon():
        return Response(status_code=204)

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
    print(f"config: {config_path()}")
    if tok:
        print("auth token required (also usable as `Authorization: Bearer <token>`)")
    if open_browser:
        import webbrowser

        webbrowser.open(url + (f"?token={tok}" if tok else ""))
    uvicorn.run(app, host=host, port=port, log_level=log_level, access_log=False)
