"""A tool call the model wrote as text instead of making it: detected, shown, and sent back once to be made properly."""

from __future__ import annotations

import json

from .test_api import H, client, read_sse  # noqa: F401  (fixture)
from .test_mcp_and_engine import FakeProvider

ALLOW = {"default": "allow", "read_only_default": "allow", "rules": {}}


def _chat(client, cid, text):
    with client.stream("POST", "/api/chat", json={"conversation_id": cid, "text": text}, headers=H) as r:
        return read_sse(r)


def _setup(client, prompt_mode: bool):
    client.put("/api/policy", json=ALLOW, headers=H)
    client.put("/api/tool-catalog", json={"mode": "off", "threshold": 24, "always": []}, headers=H)
    client.post("/api/providers", json={"id": "fake", "kind": "fake", "tools_via_prompt": prompt_mode, "default_model": "fake-1"}, headers=H)
    FakeProvider.seen.clear()  # class-level: index requests from this test only
    return client.post("/api/conversations", json={}, headers=H).json()


def test_prompt_mode_untagged_call_is_sent_back_and_then_runs(client):
    conv = _setup(client, prompt_mode=True)
    FakeProvider.script = [
        [{"type": "text_delta", "text": 'Calling it now: {"name": "echo__echo", "arguments": {"text": "hi"}}'}, {"type": "done", "finish_reason": "stop"}],
        [{"type": "text_delta", "text": '<tool_call>{"name": "echo__echo", "arguments": {"text": "hi"}}</tool_call>'}, {"type": "done", "finish_reason": "stop"}],
        [{"type": "text_delta", "text": "done"}, {"type": "done", "finish_reason": "stop"}],
    ]
    events = _chat(client, conv["id"], "echo hi")
    st = next(e for e in events if e.get("event") == "tool_call_not_run")
    assert st["data"] == {"name": "echo__echo", "reason": "as_text", "retry": True}
    # the model was told, in prompt-mode terms, how to send it
    nudge = FakeProvider.seen[1][-1]
    assert nudge["role"] == "user" and nudge["content"].startswith("(note from the studio:") and "<tool_call>" in nudge["content"]
    res = [e for e in events if e["type"] == "tool_result"]
    assert len(res) == 1 and res[0]["text"] == "hi" and events[-1]["finish_reason"] == "stop"
    # saved as a note (not a real user message): the UI shows it as a quiet line
    msgs = client.get(f"/api/conversations/{conv['id']}", headers=H).json()["messages"]
    notes = [m for m in msgs if m["role"] == "user" and (m.get("meta") or {}).get("note")]
    assert len(notes) == 1 and notes[0]["meta"]["reason"] == "as_text"


def test_native_mode_call_written_as_text_asks_for_a_real_call(client):
    conv = _setup(client, prompt_mode=False)
    FakeProvider.script = [
        [{"type": "text_delta", "text": '```json\n{"name": "echo", "arguments": {"text": "yo"}}\n```'}, {"type": "done", "finish_reason": "stop"}],
        [{"type": "tool_call", "id": "n1", "name": "echo__echo", "arguments": {"text": "yo"}}, {"type": "done", "finish_reason": "tool_calls"}],
        [{"type": "text_delta", "text": "ok"}, {"type": "done", "finish_reason": "stop"}],
    ]
    events = _chat(client, conv["id"], "echo yo")
    st = next(e for e in events if e.get("event") == "tool_call_not_run")
    assert st["data"]["name"] == "echo__echo" and st["data"]["reason"] == "as_text"
    assert "function calling" in FakeProvider.seen[1][-1]["content"]
    assert [e["text"] for e in events if e["type"] == "tool_result"] == ["yo"]


def test_call_cut_off_at_the_output_limit(client):
    conv = _setup(client, prompt_mode=True)
    FakeProvider.script = [
        [{"type": "text_delta", "text": '<tool_call>{"name": "echo__echo", "arguments": {"text": "a very long'}, {"type": "done", "finish_reason": "length"}],
        [{"type": "text_delta", "text": "I will keep it shorter."}, {"type": "done", "finish_reason": "stop"}],
    ]
    events = _chat(client, conv["id"], "echo a lot")
    st = next(e for e in events if e.get("event") == "tool_call_not_run")
    assert st["data"]["reason"] == "cut_off" and st["data"]["name"] == "echo__echo"
    assert "cut off by the output limit" in FakeProvider.seen[1][-1]["content"] and "split long content" in FakeProvider.seen[1][-1]["content"]
    assert not any(e["type"] == "tool_result" for e in events)


def test_prose_and_unknown_json_are_left_alone(client):
    conv = _setup(client, prompt_mode=True)
    FakeProvider.script = [[{"type": "text_delta", "text": 'The echo__echo tool repeats text. A person looks like {"name": "Alice", "arguments": 3}.'}, {"type": "done", "finish_reason": "stop"}]]
    events = _chat(client, conv["id"], "what does echo do?")
    assert not any(e.get("event") == "tool_call_not_run" for e in events)
    assert len(FakeProvider.seen) and events[-1]["finish_reason"] == "stop"


def test_retries_stop_after_two_notes(client):
    conv = _setup(client, prompt_mode=True)
    stuck = [{"type": "text_delta", "text": '{"name": "echo__echo", "arguments": {"text": "x"}}'}, {"type": "done", "finish_reason": "stop"}]
    FakeProvider.script = [list(stuck), list(stuck), list(stuck)]
    events = _chat(client, conv["id"], "echo x")
    sts = [e for e in events if e.get("event") == "tool_call_not_run"]
    assert [s["data"]["retry"] for s in sts] == [True, True, False]
    assert events[-1]["type"] == "done"
    msgs = client.get(f"/api/conversations/{conv['id']}", headers=H).json()["messages"]
    assert sum(1 for m in msgs if (m.get("meta") or {}).get("note")) == 2


def test_unreadable_arguments_do_not_run_the_tool(client):
    """Native calls whose arguments were cut off arrive as {"_raw": ...}: the tool must not run on half an input."""
    conv = _setup(client, prompt_mode=False)
    FakeProvider.script = [
        [{"type": "tool_call", "id": "r1", "name": "echo__echo", "arguments": {"_raw": '{"text": "half a fi'}}, {"type": "done", "finish_reason": "tool_calls"}],
        [{"type": "text_delta", "text": "retrying shorter"}, {"type": "done", "finish_reason": "stop"}],
    ]
    events = _chat(client, conv["id"], "echo")
    res = next(e for e in events if e["type"] == "tool_result")
    body = json.loads(res["text"])
    assert res["is_error"] and res["decision"] == "schema" and "not valid JSON" in body["error"] and "half a fi" in body["received"]
