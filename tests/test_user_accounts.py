"""Studio users (role user): their own chats only, never this machine's shell, files, memories or knowledge base."""

from __future__ import annotations

import asyncio

from missile_studio.engine import ApprovalRequest

from .test_api import H, client, read_sse  # noqa: F401  (fixture)
from .test_mcp_and_engine import FakeProvider

U = {"X-Requested-With": "missile-admin"}  # a cookie session's mutations carry the CSRF header
DONE = [{"type": "text_delta", "text": "ok"}, {"type": "done", "finish_reason": "stop"}]


def _sign_in_user(client, name="mina"):
    r = client.post("/api/admin/users", json={"username": name, "password": "longenough1", "role": "user"}, headers=H)
    assert r.status_code == 200 and r.json()["role"] == "user"
    assert client.post("/api/admin/auth/login", json={"username": name, "password": "longenough1"}).status_code == 200


def _chat(client, cid, text, headers, **extra):
    with client.stream("POST", "/api/chat", json={"conversation_id": cid, "text": text, **extra}, headers=headers) as r:
        assert r.status_code == 200
        return read_sse(r)


def test_users_see_only_their_own_chats(client):
    admin_conv = client.post("/api/conversations", json={"title": "owner plans"}, headers=H).json()
    FakeProvider.script = [[{"type": "text_delta", "text": "noted"}, {"type": "done", "finish_reason": "stop"}]]
    _chat(client, admin_conv["id"], "the zebra project budget", H)
    _sign_in_user(client)
    mine = client.post("/api/conversations", json={"title": "my chat"}, headers=U).json()
    assert mine["owner"] == "mina" and admin_conv["owner"] == ""

    assert [c["id"] for c in client.get("/api/conversations").json()] == [mine["id"]]
    a = admin_conv["id"]
    assert client.get(f"/api/conversations/{a}").status_code == 404
    assert client.patch(f"/api/conversations/{a}", json={"title": "x"}, headers=U).status_code == 404
    assert client.post(f"/api/conversations/{a}/head", json={"message_id": "m"}, headers=U).status_code == 404
    assert client.delete(f"/api/conversations/{a}", headers=U).status_code == 404
    assert client.post("/api/chat", json={"conversation_id": a, "text": "hi"}, headers=U).status_code == 404
    assert client.get(f"/api/chat/{a}/stream").status_code == 404
    assert client.post(f"/api/chat/{a}/stop", headers=U).status_code == 404
    assert client.get("/api/search?q=zebra").json()["hits"] == []
    # the admins' list is unchanged; an admin can still open a user's chat
    assert [c["id"] for c in client.get("/api/conversations", headers=H).json()] == [a]
    assert client.get(f"/api/conversations/{mine['id']}", headers=H).status_code == 200
    assert client.get("/api/search?q=zebra", headers=H).json()["hits"]
    assert client.get(f"/api/conversations/{a}", headers=H).json()["title"] == "owner plans"
    # every chat, with its owner, in the admin console
    owners = {c["id"]: c["owner"] for c in client.get("/api/admin/conversations", headers=H).json()["items"]}
    assert owners == {a: "", mine["id"]: "mina"}


def test_users_cannot_read_the_admins_data(client):
    client.post("/api/memory", json={"text": "the owner's bank is Jeju"}, headers=H)
    _sign_in_user(client)
    for path in ("/api/memory", "/api/knowledge", "/api/knowledge/search?q=x", "/api/workspace/tree", "/api/workspace/file?path=a.txt", "/api/workspace/download?path=a.txt", "/api/workspace/history?path=a.txt", "/api/mcp/export"):
        assert client.get(path).status_code == 403, path
    assert client.post("/api/memory", json={"text": "x"}, headers=U).status_code == 403
    assert client.get("/api/state").json()["role"] == "user"


def test_user_chats_get_only_the_tools_the_admin_allows(client):
    # the policy lets the shell and every tool run without asking, as an owner's own setup might
    client.put("/api/policy", json={"default": "allow", "read_only_default": "allow", "rules": {"local__run_shell": "allow"}}, headers=H)
    client.post("/api/memory", json={"text": "the owner keeps zebras at home"}, headers=H)
    _sign_in_user(client)
    st = client.get("/api/state").json()
    assert {t["full_name"] for t in st["tools"]} <= {"local__web_search", "local__now"} and st["knowledge"] == {}  # what this account can use, nothing more
    assert {t["full_name"] for t in client.get("/api/tools").json()} == {t["full_name"] for t in st["tools"]}
    assert "local__run_shell" in {t["full_name"] for t in client.get("/api/tools", headers=H).json()}
    conv = client.post("/api/conversations", json={}, headers=U).json()
    calls = [
        {"type": "tool_call", "id": "c1", "name": "local__run_shell", "arguments": {"command": "whoami"}},
        {"type": "tool_call", "id": "c2", "name": "local__read_file", "arguments": {"path": "a.txt"}},
        {"type": "tool_call", "id": "c3", "name": "echo__echo", "arguments": {"text": "hi"}},
        {"type": "tool_call", "id": "c4", "name": "echo__shout_destructive", "arguments": {"text": "z"}},
        {"type": "tool_call", "id": "c5", "name": "local__now", "arguments": {}},
        {"type": "done", "finish_reason": "tool_calls"},
    ]
    FakeProvider.seen.clear(); FakeProvider.tools_seen.clear()
    FakeProvider.script = [calls, DONE]
    events = _chat(client, conv["id"], "tell me about zebras at home", U, permission="auto")  # asking for allow-all changes nothing
    assert not any(e["type"] == "approval_required" for e in events)
    res = {e["name"]: e for e in events if e["type"] == "tool_result"}
    for name in ("local__run_shell", "local__read_file", "echo__echo", "echo__shout_destructive"):
        assert res[name]["decision"] == "block", name
    assert res["local__now"]["decision"] == "allow"
    # default level "web": no MCP tools and no local tool that touches this machine are even offered
    assert set(FakeProvider.tools_seen[0]) <= {"local__web_search", "local__now", "local__load_tools"} and "local__now" in FakeProvider.tools_seen[0]
    assert "zebras at home" not in FakeProvider.seen[0][0]["content"]  # the owner's memories stay out of the prompt

    # read-only: the MCP servers' read-only tools too, still nothing that writes or runs
    assert client.put("/api/admin/settings", json={"changes": {"user_tools": "read-only"}}, headers=H).status_code == 200
    FakeProvider.tools_seen.clear()
    FakeProvider.script = [calls, DONE]
    res = {e["name"]: e for e in _chat(client, conv["id"], "again", U) if e["type"] == "tool_result"}
    assert res["echo__echo"]["decision"] == "allow" and res["echo__echo"]["text"] == "hi"
    assert res["echo__shout_destructive"]["decision"] == "block" and res["local__run_shell"]["decision"] == "block"
    assert "echo__echo" in FakeProvider.tools_seen[0] and "echo__slow" not in FakeProvider.tools_seen[0]  # slow is not marked read-only

    # none: no tools at all
    client.put("/api/admin/settings", json={"changes": {"user_tools": "none"}}, headers=H)
    FakeProvider.tools_seen.clear()
    FakeProvider.script = [DONE]
    _chat(client, conv["id"], "plain", U)
    assert FakeProvider.tools_seen[0] == []

    # the admin's own chats keep the memory and the policy
    admin_conv = client.post("/api/conversations", json={}, headers=H).json()
    FakeProvider.seen.clear()
    FakeProvider.script = [[{"type": "tool_call", "id": "a1", "name": "echo__shout_destructive", "arguments": {"text": "z"}}, {"type": "done", "finish_reason": "tool_calls"}], DONE]
    res = {e["name"]: e for e in _chat(client, admin_conv["id"], "zebras at home", H) if e["type"] == "tool_result"}
    assert res["echo__shout_destructive"]["decision"] == "allow"
    assert "zebras at home" in FakeProvider.seen[0][0]["content"]


def test_users_cannot_see_or_answer_approvals_of_other_chats(client):
    admin_conv = client.post("/api/conversations", json={}, headers=H).json()
    eng = client.app.state.engine
    loop = asyncio.new_event_loop()
    try:
        fut = loop.create_future()
        eng.approvals.pending["call-a"] = ApprovalRequest("call-a", admin_conv["id"], "local__run_shell", {"command": "type secrets.txt"}, "asks", fut)
        _sign_in_user(client)
        assert client.get("/api/approvals").json() == []
        assert client.post("/api/approvals/call-a", json={"decision": "allow"}, headers=U).json() == {"ok": False}
        assert not fut.done()
        assert [a["id"] for a in client.get("/api/approvals", headers=H).json()] == ["call-a"]
    finally:
        eng.approvals.pending.pop("call-a", None)
        loop.close()


def test_audit_log_of_a_user_covers_their_own_chats(client):
    admin_conv = client.post("/api/conversations", json={}, headers=H).json()
    client.app.state.engine.store.audit(conversation_id=admin_conv["id"], tool="local__run_shell", arguments={"command": "type secrets.txt"}, decision="allow", is_error=False, duration_ms=1, result_excerpt="secret")
    _sign_in_user(client)
    assert client.get("/api/audit/page").json()["total"] == 0
    assert client.get("/api/audit").json() == []
    assert "secrets.txt" not in client.get("/api/audit/export").text
    assert client.get("/api/audit/page", headers=H).json()["total"] == 1


def test_the_last_admin_stays_when_user_accounts_exist(client):
    _sign_in_user(client)
    client.cookies.clear()
    assert client.delete("/api/admin/users/admin", headers=H).status_code == 400  # admin + mina: admin is still the only admin
    assert client.delete("/api/admin/users/mina", headers=H).json() == {"ok": True}
