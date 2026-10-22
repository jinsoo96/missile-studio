"""Tool catalog: with many tools the model gets one line per tool and loads the ones it needs."""

from __future__ import annotations

import json

from .test_api import H, client, read_sse  # noqa: F401  (fixture)
from .test_mcp_and_engine import FakeProvider

ALLOW = {"default": "allow", "read_only_default": "allow", "rules": {}}


def _chat(client, cid, text):
    with client.stream("POST", "/api/chat", json={"conversation_id": cid, "text": text}, headers=H) as r:
        return read_sse(r)


def test_catalog_loads_tools_on_demand(client):
    client.put("/api/policy", json=ALLOW, headers=H)
    r = client.put("/api/tool-catalog", json={"mode": "on", "threshold": 24, "always": "local__now"}, headers=H)
    assert r.json() == {"mode": "on", "threshold": 24, "always": ["local__now"]}
    assert client.get("/api/state", headers=H).json()["tool_catalog"]["mode"] == "on"
    conv = client.post("/api/conversations", json={}, headers=H).json()
    FakeProvider.tools_seen.clear()
    FakeProvider.script = [
        [{"type": "tool_call", "id": "l1", "name": "local__load_tools", "arguments": {"names": "echo__echo"}}, {"type": "done", "finish_reason": "tool_calls"}],
        [{"type": "tool_call", "id": "e1", "name": "echo__echo", "arguments": {"text": "hi"}}, {"type": "done", "finish_reason": "tool_calls"}],
        [{"type": "text_delta", "text": "done"}, {"type": "done", "finish_reason": "stop"}],
    ]
    events = _chat(client, conv["id"], "echo hi")
    # first request: only load_tools and the always-list are defined; the catalog names everything else
    assert sorted(FakeProvider.tools_seen[0]) == ["local__load_tools", "local__now"]
    sys0 = FakeProvider.seen[-3][0]["content"]
    assert "Tool catalog:" in sys0 and "- echo__echo:" in sys0 and "- echo__shout_destructive:" in sys0
    # after load_tools the next request carries echo__echo's schema, and still not the others
    assert "echo__echo" in FakeProvider.tools_seen[1] and "echo__shout_destructive" not in FakeProvider.tools_seen[1]
    res = [e for e in events if e["type"] == "tool_result"]
    assert res[0]["name"] == "local__load_tools" and not res[0]["is_error"]
    body = json.loads(res[0]["text"])
    assert body["loaded"][0]["name"] == "echo__echo" and "input_schema" in body["loaded"][0] and body["now_available"] == ["echo__echo", "local__now"]
    assert res[1]["name"] == "echo__echo" and res[1]["text"] == "hi"
    assert any(e.get("event") == "tool_catalog" and e["data"]["total"] >= 8 for e in events)
    assert any(e.get("event") == "tools_loaded" and e["data"]["names"] == ["echo__echo"] for e in events)
    # the next turn of the same conversation starts with echo__echo defined
    FakeProvider.script = [[{"type": "text_delta", "text": "ok"}, {"type": "done", "finish_reason": "stop"}]]
    _chat(client, conv["id"], "again")
    assert "echo__echo" in FakeProvider.tools_seen[-1] and "echo__add" not in FakeProvider.tools_seen[-1]


def test_catalog_direct_call_query_and_bare_names(client):
    """A catalogued tool called by name runs (and is defined afterwards); a query finds tools; a bare name resolves."""
    client.put("/api/policy", json=ALLOW, headers=H)
    client.put("/api/tool-catalog", json={"mode": "on", "threshold": 24, "always": []}, headers=H)
    conv = client.post("/api/conversations", json={}, headers=H).json()
    FakeProvider.tools_seen.clear()
    FakeProvider.script = [
        [{"type": "tool_call", "id": "a1", "name": "echo__add", "arguments": {"a": 1, "b": 2}}, {"type": "done", "finish_reason": "tool_calls"}],
        [{"type": "tool_call", "id": "l1", "name": "local__load_tools", "arguments": {"query": "shout something loudly", "limit": 2}}, {"type": "done", "finish_reason": "tool_calls"}],
        [{"type": "tool_call", "id": "b1", "name": "echo", "arguments": {"text": "bare"}}, {"type": "done", "finish_reason": "tool_calls"}],
        [{"type": "tool_call", "id": "x1", "name": "local__load_tools", "arguments": {"names": "no_such_tool"}}, {"type": "done", "finish_reason": "tool_calls"}],
        [{"type": "text_delta", "text": "3"}, {"type": "done", "finish_reason": "stop"}],
    ]
    events = _chat(client, conv["id"], "add 1 and 2")
    res = [e for e in events if e["type"] == "tool_result"]
    assert res[0]["name"] == "echo__add" and not res[0]["is_error"] and "3" in res[0]["text"]
    assert FakeProvider.tools_seen[0] == ["local__load_tools"] and "echo__add" in FakeProvider.tools_seen[1]
    loaded = json.loads(res[1]["text"])["loaded"]
    assert [t["name"] for t in loaded][0] == "echo__shout_destructive"
    assert res[2]["name"] == "echo" and res[2]["text"] == "bare" and not res[2]["is_error"]
    assert res[3]["is_error"] and json.loads(res[3]["text"])["not_found"] == ["no_such_tool"]


def test_catalog_auto_threshold(client):
    client.put("/api/policy", json=ALLOW, headers=H)
    conv = client.post("/api/conversations", json={}, headers=H).json()
    client.put("/api/tool-catalog", json={"mode": "auto", "threshold": 100}, headers=H)
    FakeProvider.tools_seen.clear()
    FakeProvider.script = [[{"type": "text_delta", "text": "a"}, {"type": "done", "finish_reason": "stop"}]]
    _chat(client, conv["id"], "hi")
    assert "local__load_tools" not in FakeProvider.tools_seen[-1] and "echo__echo" in FakeProvider.tools_seen[-1]
    client.put("/api/tool-catalog", json={"mode": "auto", "threshold": 2}, headers=H)
    FakeProvider.script = [[{"type": "text_delta", "text": "b"}, {"type": "done", "finish_reason": "stop"}]]
    _chat(client, conv["id"], "hi again")
    assert FakeProvider.tools_seen[-1] == ["local__load_tools"]
    client.put("/api/tool-catalog", json={"mode": "off", "threshold": 2}, headers=H)
    FakeProvider.script = [[{"type": "text_delta", "text": "c"}, {"type": "done", "finish_reason": "stop"}]]
    _chat(client, conv["id"], "and again")
    assert "local__load_tools" not in FakeProvider.tools_seen[-1] and "echo__echo" in FakeProvider.tools_seen[-1]


def test_catalog_in_prompt_mode(client):
    """Prompt-mode servers: the tools prompt lists only loaded tools, the catalog names the rest."""
    client.put("/api/policy", json=ALLOW, headers=H)
    client.put("/api/tool-catalog", json={"mode": "on", "threshold": 24, "always": []}, headers=H)
    client.post("/api/providers", json={"id": "fake", "kind": "fake", "tools_via_prompt": True, "default_model": "fake-1"}, headers=H)
    conv = client.post("/api/conversations", json={}, headers=H).json()
    FakeProvider.script = [
        [{"type": "text_delta", "text": '<tool_call>{"name": "local__load_tools", "arguments": {"names": "echo__echo"}}</tool_call>'}, {"type": "done", "finish_reason": "stop"}],
        [{"type": "text_delta", "text": '<tool_call>{"name": "echo__echo", "arguments": {"text": "yo"}}</tool_call>'}, {"type": "done", "finish_reason": "stop"}],
        [{"type": "text_delta", "text": "ok"}, {"type": "done", "finish_reason": "stop"}],
    ]
    events = _chat(client, conv["id"], "echo yo")
    first = FakeProvider.seen[-3][0]["content"]
    second = FakeProvider.seen[-2][0]["content"]
    assert "Tool catalog:" in first and "- echo__echo:" in first.split("Tool catalog:")[1].split("Available tools:")[0]
    assert "- local__load_tools:" in first.split("Available tools:")[1] and "- echo__echo:" not in first.split("Available tools:")[1]
    assert "- echo__echo:" in second.split("Available tools:")[1]
    res = [e for e in events if e["type"] == "tool_result"]
    assert res[1]["name"] == "echo__echo" and res[1]["text"] == "yo"
