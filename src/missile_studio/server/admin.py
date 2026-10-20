"""Admin console backend: login sessions, typed settings, dashboard, tokens, events, system, retention.

Security model
--------------
- Admin users (table ``admin_users``) log in with username + password (PBKDF2-SHA256, 200k rounds).
- A session is an HS256 JWT (12h) in the httpOnly cookie ``missile_admin``; SameSite=lax. The signing
  secret lives in ``<MISSILE_HOME>/secret.key`` and is created on first use.
- Every mutating admin call made with the cookie must also carry ``X-Requested-With: missile-admin``
  (a cross-site page cannot add that header without a CORS preflight, which we never grant).
- The owner API token (config ``server.token``) and API tokens with the ``admin`` scope may call the
  same endpoints with ``Authorization: Bearer`` (scripts, CLI); they skip the CSRF header.
- Login attempts are rate limited per client IP (sliding window). Every admin action is written to
  the ``events`` table; secret values never appear in details.
"""

from __future__ import annotations

import asyncio
import base64
import collections
import hashlib
import hmac
import json
import os
import platform
import secrets
import shutil
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from .. import __version__
from ..config import ToolPolicy, config_path, home_dir, log_dir, save_config

SESSION_COOKIE = "missile_admin"
SESSION_TTL = 12 * 3600
CSRF_HEADER = "x-requested-with"
CSRF_VALUE = "missile-admin"
PBKDF2_ROUNDS = 200_000
START_TIME = time.time()


# ---------------------------------------------------------------- crypto helpers

def _secret() -> bytes:
    p = home_dir() / "secret.key"
    if p.exists():
        return p.read_bytes().strip()
    s = secrets.token_bytes(32)
    p.write_bytes(base64.b64encode(s))
    try:
        if os.name != "nt":
            os.chmod(p, 0o600)
    except OSError:
        pass
    return base64.b64encode(s)


def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), salt, PBKDF2_ROUNDS)
    return f"pbkdf2${PBKDF2_ROUNDS}${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"


def verify_password(pw: str, stored: str) -> bool:
    try:
        _, rounds, salt_b64, dk_b64 = stored.split("$")
        dk = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), base64.b64decode(salt_b64), int(rounds))
        return hmac.compare_digest(dk, base64.b64decode(dk_b64))
    except Exception:
        return False


def _b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _b64u_dec(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def jwt_encode(payload: dict) -> str:
    header = _b64u(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    body = _b64u(json.dumps(payload, separators=(",", ":")).encode())
    sig = hmac.new(_secret(), f"{header}.{body}".encode(), hashlib.sha256).digest()
    return f"{header}.{body}.{_b64u(sig)}"


def jwt_decode(token: str) -> Optional[dict]:
    try:
        header, body, sig = token.split(".")
        expect = hmac.new(_secret(), f"{header}.{body}".encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(expect, _b64u_dec(sig)):
            return None
        payload = json.loads(_b64u_dec(body))
        if payload.get("exp", 0) < time.time():
            return None
        return payload
    except Exception:
        return None


class SlidingWindowLimiter:
    def __init__(self, limit: int, window: float):
        self.limit, self.window = limit, window
        self._hits: dict[str, collections.deque] = {}

    def allow(self, key: str) -> bool:
        now = time.time()
        if len(self._hits) > 10_000:
            self._hits.clear()
        dq = self._hits.setdefault(key, collections.deque())
        while dq and dq[0] < now - self.window:
            dq.popleft()
        if len(dq) >= self.limit:
            return False
        dq.append(now)
        return True


def client_ip(request: Request) -> str:
    for h in ("cf-connecting-ip", "x-forwarded-for"):
        v = request.headers.get(h)
        if v:
            return v.split(",")[0].strip()
    return request.client.host if request.client else "?"


# ---------------------------------------------------------------- typed settings registry

@dataclass
class SettingDef:
    key: str
    kind: str  # str | secret | int | bool | enum
    default: Any
    group: str
    help: str = ""
    choices: Optional[list[str]] = None
    min: Optional[int] = None
    max: Optional[int] = None
    source: str = "kv"  # kv | config


DEFINITIONS: tuple[SettingDef, ...] = (
    SettingDef("studio_name", "str", "missile-studio", "general", "Shown in the admin header."),
    SettingDef("maintenance_mode", "bool", False, "general", "Reject new chat turns for everyone except admins."),
    SettingDef("default_provider", "enum", "", "models", "Provider used by new chats.", source="config"),
    SettingDef("default_model", "str", "", "models", "Model used by new chats (must belong to the default provider).", source="config"),
    SettingDef("policy_default", "enum", "ask", "tools", "Tools that write or run things.", choices=["allow", "ask", "block"], source="config"),
    SettingDef("policy_read_only_default", "enum", "allow", "tools", "Read-only tools.", choices=["allow", "ask", "block"], source="config"),
    SettingDef("builtin_shell", "bool", True, "tools", "Local shell tool.", source="config"),
    SettingDef("builtin_filesystem", "bool", True, "tools", "Local file tools.", source="config"),
    SettingDef("builtin_web", "bool", True, "tools", "Local fetch_url tool.", source="config"),
    SettingDef("workspace", "str", "", "tools", "Folder local tools are confined to (empty = <home>/workspace).", source="config"),
    SettingDef("server_token", "secret", "", "access", "Owner API token. Rotating it logs every browser out.", source="config"),
    SettingDef("login_rate_limit", "int", 10, "access", "Admin login attempts per minute per IP.", min=3, max=100),
    SettingDef("upload_max_mb", "int", 25, "general", "Largest attachment accepted by the chat.", min=1, max=500),
    SettingDef("retention_days", "int", 0, "retention", "Delete chats idle longer than this (0 = keep forever)."),
    SettingDef("event_retention_days", "int", 365, "retention", "Delete admin/system events older than this."),
    SettingDef("audit_retention_days", "int", 365, "retention", "Delete tool audit rows older than this."),
)
DEF_BY_KEY = {d.key: d for d in DEFINITIONS}


def _coerce(d: SettingDef, v: Any) -> Any:
    if d.kind == "bool":
        if isinstance(v, str):
            v = v.strip().lower() in ("1", "true", "yes", "on")
        return bool(v)
    if d.kind == "int":
        try:
            iv = int(v)
        except (TypeError, ValueError):
            raise HTTPException(400, f"{d.key}: not an integer")
        if d.min is not None and iv < d.min:
            raise HTTPException(400, f"{d.key}: minimum is {d.min}")
        if d.max is not None and iv > d.max:
            raise HTTPException(400, f"{d.key}: maximum is {d.max}")
        return iv
    if d.kind == "enum":
        v = str(v or "")
        if d.choices is not None and v not in d.choices:
            raise HTTPException(400, f"{d.key}: must be one of {d.choices}")
        return v
    return str(v if v is not None else "")


def _mask(v: str) -> str:
    if not v:
        return ""
    return v[:4] + "…" + v[-4:] if len(v) > 10 else "…"


class SettingsRegistry:
    """Reads/writes settings that live either in config.json or in the kv table."""

    def __init__(self, engine, store, app_state):
        self.engine, self.store, self.app_state = engine, store, app_state

    def _get(self, d: SettingDef) -> Any:
        cfg = self.engine.cfg
        if d.source == "config":
            return {
                "default_provider": cfg.default.provider,
                "default_model": cfg.default.model,
                "policy_default": cfg.tool_policy.default,
                "policy_read_only_default": cfg.tool_policy.read_only_default,
                "builtin_shell": cfg.builtin_tools.shell,
                "builtin_filesystem": cfg.builtin_tools.filesystem,
                "builtin_web": cfg.builtin_tools.web,
                "workspace": cfg.builtin_tools.workspace,
                "server_token": cfg.server.token,
            }[d.key]
        return self.store.get_setting(d.key, d.default)

    def get(self, key: str) -> Any:
        return self._get(DEF_BY_KEY[key])

    def public_view(self) -> list[dict]:
        out = []
        for d in DEFINITIONS:
            v = self._get(d)
            item = {"key": d.key, "kind": d.kind, "group": d.group, "help": d.help, "choices": d.choices, "min": d.min, "max": d.max, "source": d.source}
            if d.kind == "secret":
                item["value"] = _mask(str(v or ""))
                item["hasValue"] = bool(v)
            else:
                item["value"] = v
            if d.key == "default_provider":
                item["choices"] = [p.id for p in self.engine.cfg.providers]
            out.append(item)
        return out

    async def update(self, changes: dict) -> list[str]:
        changed: list[str] = []
        cfg = self.engine.cfg
        need_apply = False
        for key, raw in changes.items():
            d = DEF_BY_KEY.get(key)
            if d is None:
                raise HTTPException(400, f"unknown setting {key}")
            v = _coerce(d, raw) if d.kind != "secret" else str(raw or "")
            if d.source == "kv":
                if self.store.get_setting(key, d.default) != v:
                    self.store.set_setting(key, v)
                    changed.append(key)
                continue
            if key == "default_provider":
                if v and cfg.provider(v) is None:
                    raise HTTPException(400, "unknown provider")
                if cfg.default.provider != v:
                    cfg.default.provider = v
                    p = cfg.provider(v)
                    cfg.default.model = p.default_model if p else ""
                    changed.append(key)
            elif key == "default_model":
                if cfg.default.model != v:
                    cfg.default.model = v
                    changed.append(key)
            elif key == "policy_default":
                if cfg.tool_policy.default != v:
                    cfg.tool_policy.default = v
                    changed.append(key)
            elif key == "policy_read_only_default":
                if cfg.tool_policy.read_only_default != v:
                    cfg.tool_policy.read_only_default = v
                    changed.append(key)
            elif key in ("builtin_shell", "builtin_filesystem", "builtin_web", "workspace"):
                attr = {"builtin_shell": "shell", "builtin_filesystem": "filesystem", "builtin_web": "web", "workspace": "workspace"}[key]
                if getattr(cfg.builtin_tools, attr) != v:
                    setattr(cfg.builtin_tools, attr, v)
                    changed.append(key)
                    need_apply = True
            elif key == "server_token":
                if v == "":
                    continue  # empty means "keep"
                if v == "rotate":
                    v = secrets.token_urlsafe(24)
                if cfg.server.token != v:
                    cfg.server.token = v
                    self.app_state.token = v
                    changed.append(key)
        if changed:
            if need_apply:
                await self.engine.apply_config(cfg)
            else:
                save_config(cfg)
        return changed


# ---------------------------------------------------------------- system info

def memory_info() -> dict:
    try:
        if os.name == "nt":
            import ctypes

            class MS(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong), ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong), ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong), ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong), ("sullAvailExtendedVirtual", ctypes.c_ulonglong)]

            ms = MS()
            ms.dwLength = ctypes.sizeof(MS)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(ms))
            return {"total": ms.ullTotalPhys, "available": ms.ullAvailPhys, "percent": ms.dwMemoryLoad}
        info = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, v = line.split(":", 1)
                info[k] = int(v.strip().split()[0]) * 1024
        total, avail = info.get("MemTotal", 0), info.get("MemAvailable", 0)
        return {"total": total, "available": avail, "percent": int(100 * (1 - avail / total)) if total else 0}
    except Exception:
        return {}


def process_rss() -> int:
    try:
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes

            class PMC(ctypes.Structure):
                _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]

            pmc = PMC()
            pmc.cb = ctypes.sizeof(PMC)
            ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.windll.kernel32.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb)
            return int(pmc.WorkingSetSize)
        with open("/proc/self/statm") as f:
            return int(f.read().split()[1]) * os.sysconf("SC_PAGE_SIZE")
    except Exception:
        return 0


def system_info(engine, store, app_state) -> dict:
    home = home_dir()
    try:
        du = shutil.disk_usage(str(home))
        disk = {"total": du.total, "free": du.free, "used": du.used}
    except Exception:
        disk = {}
    logs = []
    for p in sorted(log_dir().glob("*.log")):
        try:
            logs.append({"name": p.name, "size": p.stat().st_size, "mtime": p.stat().st_mtime})
        except OSError:
            pass
    load = None
    if hasattr(os, "getloadavg"):
        try:
            load = list(os.getloadavg())
        except OSError:
            load = None
    return {
        "version": __version__,
        "python": sys.version.split()[0],
        "platform": f"{platform.system()} {platform.release()} ({platform.machine()})",
        "hostname": platform.node(),
        "pid": os.getpid(),
        "uptime_s": int(time.time() - START_TIME),
        "started_at": START_TIME,
        "home": str(home),
        "config_path": str(config_path()),
        "db_size": store.db_size(),
        "disk": disk,
        "memory": memory_info(),
        "process_rss": process_rss(),
        "load": load,
        "logs": logs,
        "active_turns": len(getattr(app_state, "turn_tasks", {}) or {}),
        "bridges": [b.as_dict() for b in getattr(app_state, "bridges", {}).values()],
        "totals": store.totals(),
        "bound": {"host": engine.cfg.server.host, "port": engine.cfg.server.port, "token": bool(app_state.token)},
    }


def warnings_for(engine, store, app_state) -> list[dict]:
    out: list[dict] = []
    admins = store.list_admins()
    if any(a["must_change_password"] for a in admins):
        out.append({"code": "default_admin_password", "text": "An admin account still uses its generated password.", "fix": "account"})
    if not engine.cfg.providers:
        out.append({"code": "no_providers", "text": "No model provider configured; chats cannot start.", "fix": "settings"})
    for p in engine.cfg.providers:
        if p.kind in ("openai", "anthropic", "gemini") and not p.resolved_api_key() and not any(h in (p.base_url or "") for h in ("127.0.0.1", "localhost", "host.docker.internal")):
            out.append({"code": "provider_no_key", "text": f"Provider '{p.id}' has no API key.", "fix": "settings"})
    for s in engine.mcp.status():
        if s["status"] == "failed":
            out.append({"code": "mcp_failed", "text": f"MCP server '{s['name']}' failed: {(s.get('error') or '')[:120]}", "fix": "system"})
    if engine.cfg.server.host not in ("127.0.0.1", "localhost", "::1") and not app_state.token:
        out.append({"code": "public_no_token", "text": "Server is reachable from other machines without an access token.", "fix": "settings"})
    if store.get_setting("maintenance_mode", False):
        out.append({"code": "maintenance_mode", "text": "Maintenance mode is on: chat is disabled for non-admins.", "fix": "settings"})
    return out


# ---------------------------------------------------------------- bootstrap / retention

def bootstrap_admin(store) -> Optional[tuple[str, str]]:
    """Create the first admin with a random password. Returns (username, password) when created."""
    if store.list_admins():
        return None
    pw = secrets.token_urlsafe(12)
    store.upsert_admin("admin", hash_password(pw), must_change=True)
    store.event("info", "auth", "admin account created with a generated password", {"username": "admin"}, actor="system")
    return "admin", pw


async def retention_loop(engine, store, interval: float = 6 * 3600) -> None:
    while True:
        try:
            reg_days = int(store.get_setting("retention_days", 0) or 0)
            ev_days = int(store.get_setting("event_retention_days", 365) or 0)
            au_days = int(store.get_setting("audit_retention_days", 365) or 0)
            res = store.prune(reg_days, ev_days, au_days)
            if any(res.values()):
                store.event("info", "system", "retention cleanup", res, actor="system")
        except Exception as e:  # pragma: no cover
            store.event("warn", "system", f"retention failed: {e}", actor="system")
        await asyncio.sleep(interval)


# ---------------------------------------------------------------- router

class LoginIn(BaseModel):
    username: str
    password: str


class PasswordIn(BaseModel):
    current_password: str
    new_password: str


class TokenIn(BaseModel):
    name: str
    scopes: str = "chat"  # chat | admin


class SettingsIn(BaseModel):
    changes: dict


class AdminIn(BaseModel):
    username: str
    password: str = ""


def create_admin_router(engine, store, app_state, principal_of) -> APIRouter:
    """``principal_of(request)`` resolves Bearer/cookie auth to {"role", "actor", "via"}."""
    r = APIRouter(prefix="/api/admin")
    registry = SettingsRegistry(engine, store, app_state)
    app_state.settings_registry = registry
    limiter = SlidingWindowLimiter(10, 60)

    def current_admin(request: Request) -> dict:
        p = principal_of(request)
        if p["role"] != "admin":
            raise HTTPException(401, "unauthorized")
        return p

    def csrf_guard(request: Request) -> None:
        p = principal_of(request)
        if p.get("via") == "cookie" and request.method not in ("GET", "HEAD", "OPTIONS"):
            if request.headers.get(CSRF_HEADER, "").lower() != CSRF_VALUE:
                raise HTTPException(403, "csrf")

    guarded = [Depends(current_admin), Depends(csrf_guard)]

    # ---- auth
    @r.post("/auth/login")
    async def login(body: LoginIn, request: Request, response: Response):
        limiter.limit = int(store.get_setting("login_rate_limit", 10) or 10)
        ip = client_ip(request)
        if not limiter.allow(ip):
            store.event("warn", "auth", "login rate limited", {"ip": ip}, actor=body.username[:64])
            raise HTTPException(429, "rate_limited")
        user = store.get_admin(body.username)
        if not user or not verify_password(body.password, user["password_hash"]):
            store.event("warn", "auth", "login failed", {"ip": ip, "username": body.username[:64]})
            raise HTTPException(401, "invalid_credentials")
        tok = jwt_encode({"sub": user["username"], "iat": int(time.time()), "exp": int(time.time() + SESSION_TTL), "typ": "admin"})
        secure = (request.headers.get("x-forwarded-proto") == "https") or request.url.scheme == "https"
        response.set_cookie(SESSION_COOKIE, tok, httponly=True, samesite="lax", secure=secure, max_age=SESSION_TTL, path="/")
        store.touch_admin_login(user["username"])
        store.event("info", "auth", "login", {"ip": ip}, actor=user["username"])
        return {"username": user["username"], "mustChangePassword": bool(user["must_change_password"])}

    @r.post("/auth/logout")
    async def logout(response: Response, request: Request):
        response.delete_cookie(SESSION_COOKIE, path="/")
        return {"ok": True}

    @r.get("/auth/me")
    async def me(request: Request):
        p = principal_of(request)
        if p["role"] != "admin":
            raise HTTPException(401, "unauthorized")
        user = store.get_admin(p["actor"]) if p.get("via") == "cookie" else None
        return {"username": p["actor"], "via": p.get("via"), "mustChangePassword": bool(user["must_change_password"]) if user else False, "studio_name": store.get_setting("studio_name", "missile-studio")}

    @r.post("/auth/password", dependencies=guarded)
    async def change_password(body: PasswordIn, request: Request):
        p = principal_of(request)
        user = store.get_admin(p["actor"])
        if not user:
            raise HTTPException(400, "password change needs a cookie session of an admin user")
        if not verify_password(body.current_password, user["password_hash"]):
            raise HTTPException(400, "wrong_password")
        if len(body.new_password) < 8 or body.new_password == body.current_password:
            raise HTTPException(400, "new password must be at least 8 characters and different")
        store.upsert_admin(user["username"], hash_password(body.new_password), must_change=False)
        store.event("info", "auth", "password changed", actor=user["username"])
        return {"ok": True}

    # ---- admin users
    @r.get("/users", dependencies=[Depends(current_admin)])
    async def users():
        return store.list_admins()

    @r.post("/users", dependencies=guarded)
    async def upsert_user(body: AdminIn, request: Request):
        p = principal_of(request)
        pw = body.password or secrets.token_urlsafe(12)
        store.upsert_admin(body.username.strip(), hash_password(pw), must_change=not body.password)
        store.event("info", "auth", "admin user upserted", {"username": body.username}, actor=p["actor"])
        return {"username": body.username, "password": pw if not body.password else None}

    @r.delete("/users/{username}", dependencies=guarded)
    async def delete_user(username: str, request: Request):
        p = principal_of(request)
        if username == p["actor"]:
            raise HTTPException(400, "cannot delete yourself")
        if len(store.list_admins()) <= 1:
            raise HTTPException(400, "keep at least one admin")
        ok = store.delete_admin(username)
        store.event("info", "auth", "admin user deleted", {"username": username}, actor=p["actor"])
        return {"ok": ok}

    # ---- dashboard
    @r.get("/overview", dependencies=[Depends(current_admin)])
    async def overview():
        now = time.time()
        day = store.stats(now - 86400)
        week = store.stats(now - 7 * 86400)
        return {
            "version": __version__,
            "studio_name": store.get_setting("studio_name", "missile-studio"),
            "uptime_s": int(now - START_TIME),
            "maintenance": bool(store.get_setting("maintenance_mode", False)),
            "warnings": warnings_for(engine, store, app_state),
            "day": day,
            "week": week,
            "hourly": store.hourly(24),
            "top_tools": store.top_tools(now - 7 * 86400),
            "usage_by_model": store.usage_by_model(now - 7 * 86400),
            "providers": [{"id": p.id, "kind": p.kind, "label": p.label, "has_key": bool(p.resolved_api_key()), "models": len(p.models), "enabled": p.enabled} for p in engine.cfg.providers],
            "mcp": engine.mcp.status(),
            "bridges": [b.as_dict() for b in getattr(app_state, "bridges", {}).values()],
            "active_turns": len(getattr(app_state, "turn_tasks", {}) or {}),
            "pending_approvals": len(engine.approvals.pending),
            "totals": store.totals(),
            "recent_events": store.list_events(limit=8),
        }

    # ---- conversations
    @r.get("/conversations", dependencies=[Depends(current_admin)])
    async def conversations(q: str = "", limit: int = 50, offset: int = 0):
        limit = max(1, min(limit, 200))
        return {"items": store.list_conversations(limit=limit, offset=offset, q=q), "total": store.count_conversations(q)}

    @r.get("/conversations/{cid}", dependencies=[Depends(current_admin)])
    async def conversation(cid: str):
        conv = store.get_conversation(cid)
        if not conv:
            raise HTTPException(404, "not found")
        conv["messages"] = store.get_messages(cid)
        conv["audit"] = store.list_audit(limit=100, conversation_id=cid)
        return conv

    @r.delete("/conversations/{cid}", dependencies=guarded)
    async def delete_conversation(cid: str, request: Request):
        p = principal_of(request)
        store.delete_conversation(cid)
        store.event("info", "data", "conversation deleted", {"id": cid}, actor=p["actor"])
        return {"ok": True}

    # ---- tokens
    @r.get("/tokens", dependencies=[Depends(current_admin)])
    async def tokens():
        return store.list_tokens()

    @r.post("/tokens", dependencies=guarded)
    async def create_token(body: TokenIn, request: Request):
        p = principal_of(request)
        scopes = "admin" if body.scopes == "admin" else "chat"
        plain = "msl_" + secrets.token_urlsafe(24)
        t = store.create_token(body.name.strip() or "token", plain, scopes, p["actor"])
        store.event("info", "access", "api token created", {"id": t["id"], "name": t["name"], "scopes": scopes}, actor=p["actor"])
        return {**t, "token": plain}

    @r.delete("/tokens/{tid}", dependencies=guarded)
    async def revoke_token(tid: str, request: Request):
        p = principal_of(request)
        ok = store.revoke_token(tid)
        store.event("info", "access", "api token revoked", {"id": tid}, actor=p["actor"])
        return {"ok": ok}

    # ---- settings
    @r.get("/settings", dependencies=[Depends(current_admin)])
    async def get_settings():
        return {"items": registry.public_view(), "groups": ["general", "models", "tools", "access", "retention"]}

    @r.put("/settings", dependencies=guarded)
    async def put_settings(body: SettingsIn, request: Request):
        p = principal_of(request)
        changed = await registry.update(body.changes)
        if changed:
            store.event("info", "settings", "settings changed", {"keys": changed, "values": {k: ("(secret updated)" if DEF_BY_KEY[k].kind == "secret" else body.changes.get(k)) for k in changed}}, actor=p["actor"])
        return {"changed": changed, "items": registry.public_view()}

    # ---- health actions
    @r.post("/providers/{pid}/test", dependencies=guarded)
    async def test_provider(pid: str, request: Request):
        pc = engine.cfg.provider(pid)
        if not pc:
            raise HTTPException(404, "no such provider")
        res = await engine.test_provider(pc)
        store.event("info" if res.get("ok") else "warn", "settings", f"provider test {pid}: {'ok' if res.get('ok') else 'failed'}", {"error": res.get("error")}, actor=principal_of(request)["actor"])
        return res

    @r.post("/mcp/{name}/restart", dependencies=guarded)
    async def restart_mcp(name: str, request: Request):
        if name not in engine.mcp.servers:
            raise HTTPException(404, "no such server")
        await engine.mcp.restart(name)
        store.event("info", "settings", f"mcp restart {name}", actor=principal_of(request)["actor"])
        return {"ok": True}

    # ---- events / system / data
    @r.get("/events", dependencies=[Depends(current_admin)])
    async def events(category: str = "", level: str = "", before: Optional[int] = None, limit: int = 100):
        limit = max(1, min(limit, 500))
        rows = store.list_events(category=category, level=level, before=before, limit=limit + 1)
        next_before = rows[-1]["id"] if len(rows) > limit else None
        return {"items": rows[:limit], "next_before": next_before}

    @r.get("/system", dependencies=[Depends(current_admin)])
    async def system():
        return system_info(engine, store, app_state)

    @r.get("/logs/{name}", dependencies=[Depends(current_admin)])
    async def log_tail(name: str, lines: int = 200):
        p = (log_dir() / name).resolve()
        if p.parent != log_dir().resolve() or not p.exists():
            raise HTTPException(404, "no such log")
        data = p.read_bytes()[-200_000:].decode("utf-8", "replace")
        return {"name": name, "lines": data.splitlines()[-max(1, min(lines, 2000)):]}

    @r.post("/data/prune", dependencies=guarded)
    async def prune(request: Request):
        p = principal_of(request)
        res = store.prune(int(store.get_setting("retention_days", 0) or 0), int(store.get_setting("event_retention_days", 365) or 0), int(store.get_setting("audit_retention_days", 365) or 0))
        store.event("info", "data", "manual retention run", res, actor=p["actor"])
        return res

    @r.post("/data/vacuum", dependencies=guarded)
    async def vacuum(request: Request):
        before = store.db_size()
        store.vacuum()
        after = store.db_size()
        store.event("info", "data", "vacuum", {"before": before, "after": after}, actor=principal_of(request)["actor"])
        return {"before": before, "after": after}

    @r.get("/data/export", dependencies=[Depends(current_admin)])
    async def export_config():
        cfg = engine.cfg.model_dump(mode="json")
        for pr in cfg.get("providers", []):
            pr["api_key"] = ""
            pr["password"] = ""
        cfg["server"]["token"] = ""
        return {"config": cfg, "settings": store.all_settings(), "exported_at": time.time(), "note": "secrets stripped"}

    return r
