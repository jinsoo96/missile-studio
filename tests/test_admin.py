"""Admin console: login/session/CSRF, rate limit, tokens with scopes, typed settings, events, overview, maintenance."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from missile_studio.config import Config, ProviderConfig
from missile_studio.engine import Engine
from missile_studio.providers import REGISTRY
from missile_studio.server import admin as adminmod
from missile_studio.server.app import create_app
from missile_studio.store import Store

from .test_mcp_and_engine import FakeProvider

OWNER = {"Authorization": "Bearer owner-tok"}
CSRF = {"X-Requested-With": "missile-admin"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("MISSILE_HOME", str(tmp_path))
    REGISTRY["fake"] = FakeProvider
    cfg = Config()
    cfg.providers.append(ProviderConfig.model_construct(id="fake", kind="fake", models=["fake-1"], default_model="fake-1", api_key="k", enabled=True))
    cfg.ensure_defaults()
    cfg.default.provider = "fake"
    cfg.default.model = "fake-1"
    cfg.server.token = "owner-tok"
    store = Store(tmp_path / "t.db")
    eng = Engine(cfg, store)
    app = create_app(eng, token="owner-tok")
    with TestClient(app) as c:
        c.app.state.store = store
        yield c
    REGISTRY.pop("fake", None)


def test_bootstrap_admin_and_login_flow(client):
    pw = client.app.state.bootstrap_password
    assert pw and len(pw) >= 12
    # no session -> 401
    assert client.get("/api/admin/overview").status_code == 401
    # wrong password
    r = client.post("/api/admin/auth/login", json={"username": "admin", "password": "nope"})
    assert r.status_code == 401
    # login sets the cookie and flags the generated password
    r = client.post("/api/admin/auth/login", json={"username": "admin", "password": pw})
    assert r.status_code == 200 and r.json()["mustChangePassword"] is True
    assert adminmod.SESSION_COOKIE in r.cookies
    me = client.get("/api/admin/auth/me").json()
    assert me["username"] == "admin" and me["via"] == "cookie"
    # mutating with the cookie but without the CSRF header is refused
    r = client.put("/api/admin/settings", json={"changes": {"studio_name": "x"}})
    assert r.status_code == 403
    r = client.put("/api/admin/settings", json={"changes": {"studio_name": "My studio"}}, headers=CSRF)
    assert r.status_code == 200 and "studio_name" in r.json()["changed"]
    # password change clears the flag
    r = client.post("/api/admin/auth/password", json={"current_password": pw, "new_password": "correct-horse-9"}, headers=CSRF)
    assert r.status_code == 200
    assert client.get("/api/admin/auth/me").json()["mustChangePassword"] is False
    # the overview no longer warns about the generated password
    ov = client.get("/api/admin/overview").json()
    assert not any(w["code"] == "default_admin_password" for w in ov["warnings"])
    assert ov["studio_name"] == "My studio"
    # events were written
    ev = client.get("/api/admin/events").json()["items"]
    msgs = [e["message"] for e in ev]
    assert "login" in msgs and "password changed" in msgs and "settings changed" in msgs and "login failed" in msgs
    # logout
    client.post("/api/admin/auth/logout", headers=CSRF)
    client.cookies.clear()
    assert client.get("/api/admin/overview").status_code == 401


def test_login_rate_limit(client):
    for i in range(10):
        client.post("/api/admin/auth/login", json={"username": "admin", "password": "bad"})
    r = client.post("/api/admin/auth/login", json={"username": "admin", "password": "bad"})
    assert r.status_code == 429


def test_owner_token_is_admin_and_tokens_have_scopes(client):
    # owner token works for admin endpoints without a cookie and without CSRF header
    assert client.get("/api/admin/overview", headers=OWNER).status_code == 200
    r = client.post("/api/admin/tokens", json={"name": "laptop", "scopes": "chat"}, headers=OWNER)
    assert r.status_code == 200
    chat_tok = r.json()["token"]
    assert chat_tok.startswith("msl_")
    r = client.post("/api/admin/tokens", json={"name": "ops", "scopes": "admin"}, headers=OWNER)
    admin_tok = r.json()["token"]
    H_chat = {"Authorization": "Bearer " + chat_tok}
    H_admin = {"Authorization": "Bearer " + admin_tok}
    # chat scope: can read state and create conversations, cannot change settings or use admin api
    assert client.get("/api/state", headers=H_chat).status_code == 200
    assert client.post("/api/conversations", json={}, headers=H_chat).status_code == 200
    assert client.post("/api/providers", json={"id": "x", "kind": "openai"}, headers=H_chat).status_code == 403
    assert client.get("/api/admin/overview", headers=H_chat).status_code == 401
    # admin scope: everything
    assert client.get("/api/admin/overview", headers=H_admin).status_code == 200
    assert client.put("/api/policy", json={"default": "ask", "read_only_default": "allow", "rules": {}}, headers=H_admin).status_code == 200
    # last_used is tracked, revoke works immediately
    toks = client.get("/api/admin/tokens", headers=OWNER).json()
    laptop = next(t for t in toks if t["name"] == "laptop")
    assert laptop["last_used_at"] is not None
    assert client.delete(f"/api/admin/tokens/{laptop['id']}", headers=OWNER).json()["ok"] is True
    assert client.get("/api/state", headers=H_chat).status_code == 401
    # the studio login screen also accepts api tokens
    assert client.post("/api/login", json={"token": admin_tok}).status_code == 200
    assert client.post("/api/login", json={"token": chat_tok}).status_code == 401


def test_typed_settings_validation_and_config_backed_keys(client):
    items = {i["key"]: i for i in client.get("/api/admin/settings", headers=OWNER).json()["items"]}
    assert items["server_token"]["kind"] == "secret" and items["server_token"]["hasValue"] is True and "owner-tok" not in str(items["server_token"]["value"])
    assert items["default_provider"]["choices"] == ["fake"]
    # bad values
    assert client.put("/api/admin/settings", json={"changes": {"login_rate_limit": 1}}, headers=OWNER).status_code == 400
    assert client.put("/api/admin/settings", json={"changes": {"policy_default": "maybe"}}, headers=OWNER).status_code == 400
    assert client.put("/api/admin/settings", json={"changes": {"nope": 1}}, headers=OWNER).status_code == 400
    # config-backed keys change the live engine config
    r = client.put("/api/admin/settings", json={"changes": {"policy_default": "allow", "builtin_shell": False, "retention_days": 30}}, headers=OWNER)
    assert set(r.json()["changed"]) == {"policy_default", "builtin_shell", "retention_days"}
    eng = client.app.state.engine
    assert eng.cfg.tool_policy.default == "allow" and eng.cfg.builtin_tools.shell is False
    assert all(t.name != "run_shell" for t in eng.local.infos())
    # unchanged values are not reported as changed
    r = client.put("/api/admin/settings", json={"changes": {"retention_days": 30}}, headers=OWNER)
    assert r.json()["changed"] == []
    # token rotation invalidates the old owner token
    r = client.put("/api/admin/settings", json={"changes": {"server_token": "rotate"}}, headers=OWNER)
    assert r.status_code == 200 and "server_token" in r.json()["changed"]
    assert client.get("/api/state", headers=OWNER).status_code == 401
    new_tok = eng.cfg.server.token
    assert client.get("/api/state", headers={"Authorization": "Bearer " + new_tok}).status_code == 200
    ev = client.get("/api/admin/events", headers={"Authorization": "Bearer " + new_tok}).json()["items"]
    detail = next(e for e in ev if e["message"] == "settings changed" and "server_token" in e["details"]["keys"])
    assert detail["details"]["values"]["server_token"] == "(secret updated)"


def test_maintenance_mode_blocks_users_not_admins(client):
    r = client.post("/api/admin/tokens", json={"name": "u", "scopes": "chat"}, headers=OWNER)
    H_chat = {"Authorization": "Bearer " + r.json()["token"]}
    conv = client.post("/api/conversations", json={}, headers=H_chat).json()
    client.put("/api/admin/settings", json={"changes": {"maintenance_mode": True}}, headers=OWNER)
    assert client.get("/api/health").json()["maintenance"] is True
    r = client.post("/api/chat", json={"conversation_id": conv["id"], "text": "hi"}, headers=H_chat)
    assert r.status_code == 503
    ov = client.get("/api/admin/overview", headers=OWNER).json()
    assert any(w["code"] == "maintenance_mode" for w in ov["warnings"])
    client.put("/api/admin/settings", json={"changes": {"maintenance_mode": False}}, headers=OWNER)


def test_overview_system_conversations_and_data(client):
    ov = client.get("/api/admin/overview", headers=OWNER).json()
    assert len(ov["hourly"]) == 24 and "day" in ov and ov["providers"][0]["id"] == "fake"
    s = client.get("/api/admin/system", headers=OWNER).json()
    assert s["version"] and s["python"] and s["db_size"] >= 0 and "totals" in s
    conv = client.post("/api/conversations", json={"title": "hello admin"}, headers=OWNER).json()
    r = client.get("/api/admin/conversations?q=hello", headers=OWNER).json()
    assert r["total"] == 1 and r["items"][0]["id"] == conv["id"]
    d = client.get(f"/api/admin/conversations/{conv['id']}", headers=OWNER).json()
    assert d["messages"] == [] and d["audit"] == []
    assert client.delete(f"/api/admin/conversations/{conv['id']}", headers=OWNER).json()["ok"]
    assert client.get("/api/admin/conversations", headers=OWNER).json()["total"] == 0
    exp = client.get("/api/admin/data/export", headers=OWNER).json()
    assert exp["config"]["providers"][0]["api_key"] == "" and exp["config"]["server"]["token"] == ""
    pr = client.post("/api/admin/data/prune", headers=OWNER).json()
    assert set(pr) == {"conversations", "events", "audit"}
    v = client.post("/api/admin/data/vacuum", headers=OWNER).json()
    assert v["after"] >= 0
    # admin users management
    r = client.post("/api/admin/users", json={"username": "ops"}, headers=OWNER).json()
    assert r["password"]
    assert {u["username"] for u in client.get("/api/admin/users", headers=OWNER).json()} == {"admin", "ops"}
    assert client.delete("/api/admin/users/ops", headers=OWNER).json()["ok"]


def test_admin_page_is_served(client):
    r = client.get("/admin")
    assert r.status_code == 200 and "admin.js" in r.text
    assert client.get("/admin/settings").status_code == 200
