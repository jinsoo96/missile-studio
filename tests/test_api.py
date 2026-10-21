"""HTTP API with FastAPI's TestClient: auth, CRUD, SSE chat stream, approvals."""

from __future__ import annotations

import json
import sys
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from missile_studio.config import Config, McpServerConfig, ProviderConfig
from missile_studio.engine import Engine
from missile_studio.providers import REGISTRY
from missile_studio.server.app import create_app
from missile_studio.store import Store

from .test_mcp_and_engine import FakeProvider, echo_cfg


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("MISSILE_HOME", str(tmp_path))
    REGISTRY["fake"] = FakeProvider
    cfg = Config()
    cfg.providers.append(ProviderConfig.model_construct(id="fake", kind="fake", models=["fake-1"], default_model="fake-1", api_key="secret-key-1234567"))
    cfg.mcp_servers["echo"] = echo_cfg()
    cfg.ensure_defaults()
    cfg.default.provider = "fake"
    cfg.default.model = "fake-1"
    eng = Engine(cfg, Store(tmp_path / "t.db"))
    app = create_app(eng, token="tok")
    with TestClient(app) as c:
        import time

        for _ in range(300):  # wait for the fixture MCP server to connect
            if any(s["status"] == "connected" for s in c.get("/api/mcp", headers={"Authorization": "Bearer tok"}).json()):
                break
            time.sleep(0.1)
        yield c
    REGISTRY.pop("fake", None)


H = {"Authorization": "Bearer tok"}


def test_auth_required(client):
    assert client.get("/api/health").status_code == 200
    assert client.get("/api/state").status_code == 401
    assert client.post("/api/login", json={"token": "wrong"}).status_code == 401
    r = client.post("/api/login", json={"token": "tok"})
    assert r.status_code == 200 and "missile_token" in r.cookies
    assert client.get("/api/state", headers=H).status_code == 200
    assert client.get("/").status_code == 200 and "<title>missile studio</title>" in client.get("/").text


def test_state_masks_secrets_and_lists_tools(client):
    st = client.get("/api/state", headers=H).json()
    p = st["providers"][0]
    assert p["has_key"] is True and "secret-key" not in p["api_key"]
    assert any(t["full_name"] == "echo__add" for t in st["tools"])
    assert st["mcp"][0]["status"] == "connected"


def test_provider_crud_keeps_secret(client):
    r = client.post("/api/providers", json={"id": "fake", "kind": "fake", "label": "renamed", "api_key": "sec…234", "default_model": "fake-1"}, headers=H)
    assert r.status_code == 200 and r.json()["label"] == "renamed"
    # secret was kept, not replaced by the masked placeholder
    eng = client.app.state.engine
    assert eng.cfg.provider("fake").api_key == "secret-key-1234567"
    r = client.post("/api/providers", json={"id": "o", "kind": "openai", "base_url": "http://x/v1"}, headers=H)
    assert r.status_code == 200
    assert client.delete("/api/providers/o", headers=H).json()["ok"]


def test_mcp_import_json_and_policy(client):
    r = client.post("/api/mcp/import", json={"source": "json", "json_text": json.dumps({"mcpServers": {"disabled1": {"command": "nonexistent-cmd", "disabled": True}}})}, headers=H)
    assert r.json()["added"] == ["disabled1"]
    st = client.get("/api/mcp", headers=H).json()
    assert {s["name"] for s in st} == {"echo", "disabled1"}
    r = client.put("/api/policy", json={"default": "allow", "read_only_default": "allow", "rules": {"echo__*": "allow"}}, headers=H)
    assert r.json()["rules"] == {"echo__*": "allow"}
    assert client.delete("/api/mcp/disabled1", headers=H).json()["ok"]


def read_sse(resp):
    events = []
    for line in resp.iter_lines():
        if line.startswith("data:"):
            events.append(json.loads(line[5:].strip()))
    return events


def test_chat_stream_with_approval(client):
    client.put("/api/policy", json={"default": "ask", "read_only_default": "allow", "rules": {}}, headers=H)
    conv = client.post("/api/conversations", json={}, headers=H).json()
    FakeProvider.script = [
        [{"type": "text_delta", "text": "working "}, {"type": "tool_call", "id": "c1", "name": "echo__shout_destructive", "arguments": {"text": "z"}}, {"type": "done", "finish_reason": "tool_calls"}],
        [{"type": "text_delta", "text": "done"}, {"type": "done", "finish_reason": "stop"}],
    ]

    # approve from another thread once the approval shows up
    def approver():
        import time

        for _ in range(100):
            time.sleep(0.1)
            pend = client.get("/api/approvals", headers=H).json()
            if pend:
                client.post(f"/api/approvals/{pend[0]['id']}", json={"decision": "allow"}, headers=H)
                return

    th = threading.Thread(target=approver, daemon=True)
    th.start()
    with client.stream("POST", "/api/chat", json={"conversation_id": conv["id"], "text": "shout z"}, headers=H) as resp:
        assert resp.status_code == 200
        events = read_sse(resp)
    th.join(timeout=5)
    types_ = [e["type"] for e in events]
    assert "approval_required" in types_ and "tool_result" in types_
    res = next(e for e in events if e["type"] == "tool_result")
    assert res["text"] == "Z!" and res["decision"] == "allow"
    assert events[-1]["type"] == "done"
    msgs = client.get(f"/api/conversations/{conv['id']}", headers=H).json()["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant", "tool", "assistant"]
    audit = client.get("/api/audit", headers=H).json()
    assert audit[0]["tool"] == "echo__shout_destructive"
    conv2 = client.get(f"/api/conversations/{conv['id']}", headers=H).json()
    assert conv2["title"] == "shout z"
    assert client.delete(f"/api/conversations/{conv['id']}", headers=H).json()["ok"]


def test_upload_text_and_image(client, tmp_path):
    r = client.post("/api/upload", files={"file": ("a.txt", b"hello", "text/plain")}, headers=H)
    assert r.json()["text"] == "hello"
    r = client.post("/api/upload", files={"file": ("a.png", b"\x89PNG....", "image/png")}, headers=H)
    assert r.json()["data_url"].startswith("data:image/png;base64,")


def test_stop_during_tool_closes_pending_calls(client):
    """Stop while a tool waits for approval: the call gets a 'cancelled' result, the card is not left running, the next turn still works."""
    client.put("/api/policy", json={"default": "ask", "read_only_default": "allow", "rules": {}}, headers=H)
    conv = client.post("/api/conversations", json={}, headers=H).json()
    FakeProvider.script = [
        [{"type": "tool_call", "id": "s1", "name": "echo__shout_destructive", "arguments": {"text": "a"}}, {"type": "tool_call", "id": "s2", "name": "echo__shout_destructive", "arguments": {"text": "b"}}, {"type": "done", "finish_reason": "tool_calls"}],
        [{"type": "text_delta", "text": "after stop"}, {"type": "done", "finish_reason": "stop"}],
    ]

    def stopper():
        import time

        for _ in range(100):
            time.sleep(0.1)
            if client.get("/api/approvals", headers=H).json():
                client.post(f"/api/chat/{conv['id']}/stop", headers=H)
                return

    th = threading.Thread(target=stopper, daemon=True)
    th.start()
    with client.stream("POST", "/api/chat", json={"conversation_id": conv["id"], "text": "shout twice"}, headers=H) as resp:
        events = read_sse(resp)
    th.join(timeout=5)
    assert any(e["type"] == "done" and e.get("finish_reason") == "cancelled" for e in events)
    msgs = client.get(f"/api/conversations/{conv['id']}", headers=H).json()["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant", "tool", "tool"]
    assert {m["tool_call_id"] for m in msgs if m["role"] == "tool"} == {"s1", "s2"}
    assert all(m["decision"] == "cancelled" and m["is_error"] for m in msgs if m["role"] == "tool")
    assert client.get("/api/audit", headers=H).json()[0]["decision"] == "cancelled"
    # the next turn sends a valid history (every tool call answered) and completes
    with client.stream("POST", "/api/chat", json={"conversation_id": conv["id"], "text": "and now?"}, headers=H) as resp:
        events = read_sse(resp)
    assert events[-1]["finish_reason"] == "stop"
    assert [m["role"] for m in FakeProvider.seen[-1]] == ["system", "user", "assistant", "tool", "tool", "user"]


def test_has_key_reflects_a_resolvable_key(client, monkeypatch):
    """has_key is true only when a key value exists: inline, or in the named env var when that var is set."""
    client.post("/api/providers", json={"id": "envp", "kind": "openai", "base_url": "https://x.invalid/v1", "api_key": "", "api_key_env": "MISSILE_TEST_KEY"}, headers=H)
    p = next(p for p in client.get("/api/providers", headers=H).json() if p["id"] == "envp")
    assert p["has_key"] is False
    monkeypatch.setenv("MISSILE_TEST_KEY", "sk-test")
    p = next(p for p in client.get("/api/providers", headers=H).json() if p["id"] == "envp")
    assert p["has_key"] is True
    client.delete("/api/providers/envp", headers=H)
