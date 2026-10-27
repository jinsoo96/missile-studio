"""Running a shared studio: what studio users may see and use, their limits, account control, backups."""

from __future__ import annotations

import base64
import sqlite3
from pathlib import Path

from missile_studio.config import ProviderConfig
from missile_studio.providers import REGISTRY

from .test_api import H, client, read_sse  # noqa: F401  (fixture)
from .test_mcp_and_engine import FakeProvider
from .test_user_accounts import U, _sign_in_user

DONE = [{"type": "text_delta", "text": "ok"}, {"type": "done", "finish_reason": "stop"}]
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


class DownProvider(FakeProvider):
    kind = "fakedown"

    async def list_models(self):
        raise ConnectionError("unreachable")


def _settings(client, **changes):
    r = client.put("/api/admin/settings", json={"changes": changes}, headers=H)
    assert r.status_code == 200, r.text


def _chat(client, cid, text, **extra):
    FakeProvider.script = [list(DONE)]
    with client.stream("POST", "/api/chat", json={"conversation_id": cid, "text": text, **extra}, headers=U) as r:
        assert r.status_code == 200, r.read()
        return read_sse(r)


def _add_provider(client, pid, kind="fake", models=("big-1", "small-1")):
    eng = client.app.state.engine
    eng.cfg.providers.append(ProviderConfig.model_construct(id=pid, kind=kind, label=pid, base_url="http://10.0.0.9:8000/v1", models=list(models), default_model=models[0], api_key="k-" + pid + "-secret", headers={"X-Secret": "s"}, enabled=True, context_window=0, max_images=0, endpoint_file=""))


def test_users_see_nothing_about_this_machine(client):
    assert client.get("/api/health").json()["home"] == ""
    assert client.get("/api/health", headers=H).json()["home"]
    _sign_in_user(client)
    st = client.get("/api/state").json()
    assert st["home"] == "" and st["config_path"] == "" and "host" not in st["server"]
    for p in st["providers"] + client.get("/api/providers").json():
        assert not {"base_url", "api_key", "headers", "endpoint_file", "extra_body", "email", "password"} & set(p), p
    assert st["mcp"] == [] and client.get("/api/mcp").json() == []  # user_tools web: no MCP tools, so no servers either
    assert st["policy"]["rules"] == {} and client.get("/api/policy").json()["rules"] == {}
    assert st["wake"] == [] and client.get("/api/wake").json() == [] and client.get("/api/bridge").json() == []
    _settings(client, user_tools="read-only")
    servers = client.get("/api/mcp").json()
    assert servers and all(s["config"] == {} and set(s) == {"name", "status", "tool_count", "error", "config"} for s in servers)
    assert client.get("/api/mcp", headers=H).json()[0]["config"]["command"]  # admins still see the setup


def test_users_chat_only_with_the_allowed_models(client):
    _add_provider(client, "pricey")
    REGISTRY["fakedown"] = DownProvider
    _add_provider(client, "flaky", kind="fakedown", models=("f-1",))
    _sign_in_user(client)
    # no setting: the studio's default model only
    st = client.get("/api/state").json()
    assert [p["id"] for p in st["providers"]] == ["fake"] and st["default"]["provider"] == "fake"
    conv = client.post("/api/conversations", json={}, headers=U).json()
    _chat(client, conv["id"], "hi", provider_id="pricey", model="big-1")
    assert client.get(f"/api/conversations/{conv['id']}").json()["provider_id"] == "fake"
    # one model of one provider, then a whole provider
    _settings(client, user_models="pricey:small-1, fake")
    st = client.get("/api/state").json()
    assert {p["id"]: p["models"] for p in st["providers"]} == {"fake": ["fake-1"], "pricey": ["small-1"]}
    assert (st["default"]["provider"], st["default"]["model"]) == ("pricey", "small-1")
    _chat(client, conv["id"], "big please", provider_id="pricey", model="big-1")
    c = client.get(f"/api/conversations/{conv['id']}").json()
    assert (c["provider_id"], c["model"]) == ("pricey", "small-1")
    # the first choice is down: the next allowed one answers
    _settings(client, user_models="flaky, fake")
    client.app.state.provider_health["flaky"] = {"state": "down", "error": "x", "checked_at": 0, "ms": 0}
    conv2 = client.post("/api/conversations", json={}, headers=U).json()
    _chat(client, conv2["id"], "anyone there")
    assert client.get(f"/api/conversations/{conv2['id']}").json()["provider_id"] == "fake"
    assert client.get("/api/agents/pricey").status_code == 404
    # nothing allowed resolves: a clear refusal, not a turn on some other model
    _settings(client, user_models="nosuch")
    assert client.post("/api/chat", json={"conversation_id": conv2["id"], "text": "x"}, headers=U).status_code == 503
    assert any(w["code"] == "user_model_unknown" for w in client.get("/api/admin/overview", headers=H).json()["warnings"])
    # admins pick freely
    admin_conv = client.post("/api/conversations", json={}, headers=H).json()
    FakeProvider.script = [list(DONE)]
    with client.stream("POST", "/api/chat", json={"conversation_id": admin_conv["id"], "text": "hi", "provider_id": "pricey", "model": "big-1"}, headers=H) as r:
        read_sse(r)
    assert client.get(f"/api/conversations/{admin_conv['id']}", headers=H).json()["model"] == "big-1"


def test_user_limits(client):
    _sign_in_user(client)
    conv = client.post("/api/conversations", json={}, headers=U).json()
    _settings(client, user_daily_turns=2)
    _chat(client, conv["id"], "one")
    _chat(client, conv["id"], "two")
    assert client.post("/api/chat", json={"conversation_id": conv["id"], "text": "three"}, headers=U).status_code == 429
    _settings(client, user_daily_turns=0, user_concurrent_turns=1)
    other = client.post("/api/conversations", json={}, headers=U).json()
    client.app.state.turn_tasks["busy"] = object()  # an answer of theirs still running in another chat
    client.app.state.turn_owner["busy"] = "mina"
    assert client.post("/api/chat", json={"conversation_id": other["id"], "text": "x"}, headers=U).status_code == 429
    client.app.state.turn_tasks.pop("busy")
    client.app.state.turn_owner.pop("busy")
    _settings(client, user_storage_mb=1)
    _chat(client, other["id"], "a big paste", attachments=[{"name": "a.txt", "text": "x" * 1_200_000}])
    assert client.post("/api/chat", json={"conversation_id": other["id"], "text": "more"}, headers=U).status_code == 413
    usage = {u["owner"]: u for u in client.get("/api/admin/overview", headers=H).json()["usage_by_user"]}
    assert usage["mina"]["turns"] == 3 and usage["mina"]["bytes"] > 1_000_000


def test_user_uploads_stay_off_this_machines_disk(client, tmp_path):
    _sign_in_user(client)
    r = client.post("/api/upload", files={"file": ("dot.png", PNG, "image/png")}, headers=U).json()
    assert r["data_url"].startswith("data:image/png") and "path" not in r
    uploads = Path(client.app.state.engine.local.workspace) / "uploads"
    assert not uploads.exists() or not any(uploads.iterdir())
    assert client.post("/api/upload", files={"file": ("dot.png", PNG, "image/png")}, headers=H).json()["path"]


def test_lock_sign_out_everywhere_and_own_password(client):
    _sign_in_user(client)
    assert client.get("/api/state").status_code == 200
    assert client.post("/api/admin/users/mina/disabled", json={"disabled": True}, headers=H).status_code == 200
    assert client.get("/api/state").status_code == 401  # the live session stops at once
    assert client.post("/api/admin/auth/login", json={"username": "mina", "password": "longenough1"}).status_code == 403
    assert client.post("/api/admin/users/admin/disabled", json={"disabled": True}, headers=H).status_code == 400  # the last admin stays
    client.post("/api/admin/users/mina/disabled", json={"disabled": False}, headers=H)
    assert client.post("/api/admin/auth/login", json={"username": "mina", "password": "longenough1"}).status_code == 200
    assert client.post("/api/admin/users/mina/signout", headers=H).status_code == 200
    assert client.get("/api/state").status_code == 401
    # a studio user changes their own password: this browser stays in, an older session does not
    assert client.post("/api/admin/auth/login", json={"username": "mina", "password": "longenough1"}).status_code == 200
    old = client.cookies.get("missile_admin")
    r = client.post("/api/admin/auth/password", json={"current_password": "longenough1", "new_password": "an-even-longer-one"}, headers=U)
    assert r.status_code == 200
    assert client.get("/api/state").status_code == 200
    assert client.get("/api/state", cookies={"missile_admin": old}).status_code == 401
    assert client.post("/api/admin/auth/login", json={"username": "mina", "password": "longenough1"}).status_code == 401
    rows = {u["username"]: u for u in client.get("/api/admin/users", headers=H).json()}
    assert rows["mina"]["disabled"] == 0


def test_weak_admin_password_and_signup_cap(client):
    client.post("/api/admin/users", json={"username": "ops", "password": "admin123", "role": "admin"}, headers=H)
    assert client.post("/api/admin/auth/login", json={"username": "ops", "password": "admin123"}).status_code == 200
    client.cookies.clear()
    codes = {w["code"] for w in client.get("/api/admin/overview", headers=H).json()["warnings"]}
    assert "weak_admin_password" in codes
    _settings(client, signup_mode="open", signup_max_users=1)
    assert client.post("/api/admin/auth/signup", json={"username": "first", "password": "longenough1"}).status_code == 200
    client.cookies.clear()
    assert client.post("/api/admin/auth/signup", json={"username": "second", "password": "longenough1"}).status_code == 403


def test_forwarded_ip_headers_do_not_reset_the_login_limit(client):
    _settings(client, login_rate_limit=3)
    codes = [client.post("/api/admin/auth/login", json={"username": "admin", "password": "wrong"}, headers={"X-Forwarded-For": f"10.0.0.{i}", "CF-Connecting-IP": f"10.1.0.{i}"}).status_code for i in range(5)]
    assert codes[:3] == [401, 401, 401] and 429 in codes[3:]


def test_backups(client):
    client.post("/api/conversations", json={"title": "keep me"}, headers=H)
    r = client.post("/api/admin/data/backup", headers=H).json()
    assert r["ok"], r
    db = Path(r["path"]) / "studio.db"
    titles = [t for (t,) in sqlite3.connect(str(db)).execute("SELECT title FROM conversations")]
    assert "keep me" in titles
    _settings(client, backup_keep=2)
    for _ in range(2):
        assert client.post("/api/admin/data/backup", headers=H).json()["ok"]
    items = client.get("/api/admin/system", headers=H).json()["backups"]["items"]
    assert len(items) == 2 and not Path(r["path"]).exists()  # the oldest was pruned
    _settings(client, backup_interval_hours=0)
    assert "backup_off" in {w["code"] for w in client.get("/api/admin/overview", headers=H).json()["warnings"]}
