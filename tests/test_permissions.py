"""Per-chat permission modes (ask / allow all / read-only) and automatic knowledge retrieval and research hints."""

from __future__ import annotations

import threading
import time

from .test_api import H, client, read_sse  # noqa: F401  (fixture)
from .test_mcp_and_engine import FakeProvider

ASK = {"default": "ask", "read_only_default": "allow", "rules": {}}


def _chat(client, cid, text, **extra):
    with client.stream("POST", "/api/chat", json={"conversation_id": cid, "text": text, **extra}, headers=H) as r:
        return read_sse(r)


def _answer_approvals(client, decision: str):
    def run():
        for _ in range(100):
            time.sleep(0.1)
            pend = client.get("/api/approvals", headers=H).json()
            if pend:
                client.post(f"/api/approvals/{pend[0]['id']}", json={"decision": decision}, headers=H)
                return

    th = threading.Thread(target=run, daemon=True)
    th.start()
    return th


def test_allow_all_mode_runs_without_asking(client):
    client.put("/api/policy", json=ASK, headers=H)
    conv = client.post("/api/conversations", json={}, headers=H).json()
    FakeProvider.script = [
        [{"type": "tool_call", "id": "c1", "name": "echo__shout_destructive", "arguments": {"text": "z"}}, {"type": "done", "finish_reason": "tool_calls"}],
        [{"type": "text_delta", "text": "done"}, {"type": "done", "finish_reason": "stop"}],
    ]
    events = _chat(client, conv["id"], "shout z", permission="auto")
    assert not any(e["type"] == "approval_required" for e in events)
    res = next(e for e in events if e["type"] == "tool_result")
    assert res["text"] == "Z!" and res["decision"] == "allow"


def test_readonly_mode_blocks_writes_and_allows_reads(client):
    client.put("/api/policy", json=ASK, headers=H)
    conv = client.post("/api/conversations", json={}, headers=H).json()
    FakeProvider.script = [
        [{"type": "tool_call", "id": "c1", "name": "echo__shout_destructive", "arguments": {"text": "z"}}, {"type": "tool_call", "id": "c2", "name": "echo__echo", "arguments": {"text": "hi"}}, {"type": "done", "finish_reason": "tool_calls"}],
        [{"type": "text_delta", "text": "done"}, {"type": "done", "finish_reason": "stop"}],
    ]
    events = _chat(client, conv["id"], "both", permission="readonly")
    assert not any(e["type"] == "approval_required" for e in events)
    results = {e["name"]: e for e in events if e["type"] == "tool_result"}
    assert results["echo__shout_destructive"]["decision"] == "block" and "read-only mode" in results["echo__shout_destructive"]["text"]
    assert results["echo__echo"]["decision"] == "allow" and results["echo__echo"]["text"] == "hi"


def test_allow_all_still_asks_for_dangerous_shell_and_respects_block_rules(client):
    client.put("/api/policy", json={**ASK, "rules": {"echo__add": "block"}}, headers=H)
    conv = client.post("/api/conversations", json={}, headers=H).json()
    FakeProvider.script = [
        [{"type": "tool_call", "id": "c1", "name": "local__run_shell", "arguments": {"command": "git push --force origin main"}}, {"type": "tool_call", "id": "c2", "name": "echo__add", "arguments": {"a": 1, "b": 2}}, {"type": "done", "finish_reason": "tool_calls"}],
        [{"type": "text_delta", "text": "done"}, {"type": "done", "finish_reason": "stop"}],
    ]
    th = _answer_approvals(client, "deny")
    events = _chat(client, conv["id"], "push it", permission="auto")
    th.join(timeout=5)
    ask = next(e for e in events if e["type"] == "approval_required")
    assert ask["name"] == "local__run_shell" and "dangerous" in ask["reason"]
    results = {e["name"]: e for e in events if e["type"] == "tool_result"}
    assert results["local__run_shell"]["decision"] == "deny"
    assert results["echo__add"]["decision"] == "block"


def test_knowledge_is_automatic_once_indexed(client, tmp_path):
    d = tmp_path / "kb"
    d.mkdir()
    (d / "notes.md").write_text("The launcher codename is Sparrowhawk. It launches at dawn from the north pad.", encoding="utf-8")
    client.post("/api/knowledge/sources", json={"path": str(d)}, headers=H)
    assert client.post("/api/knowledge/reindex?wait=true", headers=H).json().get("ok")
    conv = client.post("/api/conversations", json={}, headers=H).json()
    FakeProvider.script = [[{"type": "text_delta", "text": "Sparrowhawk"}, {"type": "done", "finish_reason": "stop"}]]
    events = _chat(client, conv["id"], "what is the launcher codename?", tools="none")
    kev = next(e for e in events if e["type"] == "status" and e.get("event") == "knowledge")
    assert kev["data"]["auto"] is True and kev["data"]["hits"]
    assert "Sparrowhawk" in FakeProvider.seen[-1][0]["content"]
    # a very short message is not looked up; switched off in settings nothing is injected
    FakeProvider.script = [[{"type": "text_delta", "text": "hi"}, {"type": "done", "finish_reason": "stop"}]]
    assert not any(e.get("event") == "knowledge" for e in _chat(client, conv["id"], "hi", tools="none"))
    assert client.put("/api/knowledge/settings", json={"auto": False}, headers=H).json()["auto"] is False
    FakeProvider.script = [[{"type": "text_delta", "text": "?"}, {"type": "done", "finish_reason": "stop"}]]
    assert not any(e.get("event") == "knowledge" for e in _chat(client, conv["id"], "what is the launcher codename?", tools="none"))
    # forcing it still works
    FakeProvider.script = [[{"type": "text_delta", "text": "?"}, {"type": "done", "finish_reason": "stop"}]]
    assert any(e.get("event") == "knowledge" and e["data"]["auto"] is False for e in _chat(client, conv["id"], "what is the launcher codename?", tools="none", knowledge=True))


def test_research_hint_only_with_web_tools(client):
    conv = client.post("/api/conversations", json={}, headers=H).json()
    FakeProvider.script = [[{"type": "text_delta", "text": "hello"}, {"type": "done", "finish_reason": "stop"}]]
    _chat(client, conv["id"], "hello there")
    assert "look them up before answering" in FakeProvider.seen[-1][0]["content"]
    FakeProvider.script = [[{"type": "text_delta", "text": "hello"}, {"type": "done", "finish_reason": "stop"}]]
    _chat(client, conv["id"], "hello again", tools="none")
    assert "look them up before answering" not in FakeProvider.seen[-1][0]["content"]
    FakeProvider.script = [[{"type": "text_delta", "text": "report"}, {"type": "done", "finish_reason": "stop"}]]
    _chat(client, conv["id"], "compare things", mode="research")
    sys_prompt = FakeProvider.seen[-1][0]["content"]
    assert "Research mode." in sys_prompt and "look them up before answering" not in sys_prompt
