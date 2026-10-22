"""Why each answer ended is kept on it; an answer that stops mid-sentence while tools are in play is continued once."""

from __future__ import annotations

from .test_api import H, client, read_sse  # noqa: F401  (fixture)
from .test_mcp_and_engine import FakeProvider

ALLOW = {"default": "allow", "read_only_default": "allow", "rules": {}}


def _setup(client, prompt_mode: bool = True):
    client.put("/api/policy", json=ALLOW, headers=H)
    client.put("/api/tool-catalog", json={"mode": "off", "threshold": 24, "always": []}, headers=H)
    client.post("/api/providers", json={"id": "fake", "kind": "fake", "tools_via_prompt": prompt_mode, "default_model": "fake-1"}, headers=H)
    FakeProvider.seen.clear()
    return client.post("/api/conversations", json={}, headers=H).json()


def _chat(client, cid, text, **extra):
    with client.stream("POST", "/api/chat", json={"conversation_id": cid, "text": text, **extra}, headers=H) as r:
        return read_sse(r)


def _assistants(client, cid):
    return [m for m in client.get(f"/api/conversations/{cid}", headers=H).json()["messages"] if m["role"] == "assistant"]


def test_finish_reason_and_stop_reason_are_kept_on_the_answer(client):
    conv = _setup(client)
    FakeProvider.script = [[{"type": "text_delta", "text": "All done."}, {"type": "usage", "input_tokens": 50, "output_tokens": 3},
                            {"type": "done", "finish_reason": "stop", "server_finish": "stop", "stop_reason": 151645}]]
    _chat(client, conv["id"], "hi")
    meta = _assistants(client, conv["id"])[-1]["meta"]
    assert meta["finish"] == "stop" and meta["stop_reason"] == 151645 and meta["usage"]["output_tokens"] == 3


def test_mid_sentence_stop_is_continued_once_and_the_tool_then_runs(client):
    conv = _setup(client)
    FakeProvider.script = [
        [{"type": "text_delta", "text": "panels_spec.json 전체를 읽었습니다. 이제 v2 폴더에 복"}, {"type": "usage", "input_tokens": 18224, "output_tokens": 15},
         {"type": "done", "finish_reason": "stop", "server_finish": "stop", "stop_reason": None}],
        [{"type": "text_delta", "text": '사하겠습니다.\n<tool_call>{"name": "echo__echo", "arguments": {"text": "copied"}}</tool_call>'}, {"type": "done", "finish_reason": "stop"}],
        [{"type": "text_delta", "text": "복사를 마쳤습니다."}, {"type": "done", "finish_reason": "stop"}],
    ]
    events = _chat(client, conv["id"], "ㄱㄱ")
    cut = next(e for e in events if e.get("event") == "answer_cut_off")
    assert cut["data"] == {"finish": "stop", "stop_reason": None, "output_tokens": 15, "retry": True}
    nudge = FakeProvider.seen[1][-1]
    assert nudge["role"] == "user" and "stopped mid-sentence (stop, 15 tokens)" in nudge["content"] and "<tool_call>" in nudge["content"]
    assert [e["text"] for e in events if e["type"] == "tool_result"] == ["copied"]
    msgs = client.get(f"/api/conversations/{conv['id']}", headers=H).json()["messages"]
    notes = [m for m in msgs if (m.get("meta") or {}).get("note") == "continue"]
    assert len(notes) == 1 and notes[0]["meta"]["output_tokens"] == 15


def test_only_once_per_turn(client):
    conv = _setup(client)
    cut = [{"type": "text_delta", "text": "이제부터 실제로 파일 복"}, {"type": "done", "finish_reason": "stop"}]
    FakeProvider.script = [list(cut), list(cut)]
    events = _chat(client, conv["id"], "다했나")
    flags = [e["data"]["retry"] for e in events if e.get("event") == "answer_cut_off"]
    assert flags == [True, False] and events[-1]["type"] == "done"
    msgs = client.get(f"/api/conversations/{conv['id']}", headers=H).json()["messages"]
    assert sum(1 for m in msgs if (m.get("meta") or {}).get("note") == "continue") == 1


def test_finished_answers_and_toolless_chats_are_left_alone(client):
    conv = _setup(client)
    for text in ("복사를 마쳤습니다.", "진행할까요?", "- 1단계: 파일 복사\n- 2단계: 콘티", "복사 완료"):
        FakeProvider.script = [[{"type": "text_delta", "text": text}, {"type": "done", "finish_reason": "stop"}]]
        assert not any(e.get("event") == "answer_cut_off" for e in _chat(client, conv["id"], "?"))
    # no tools in play (plain chat): a short unpunctuated reply is not second-guessed
    FakeProvider.script = [[{"type": "text_delta", "text": "그냥 복"}, {"type": "done", "finish_reason": "stop"}]]
    assert not any(e.get("event") == "answer_cut_off" for e in _chat(client, conv["id"], "?", tools="none"))


def test_output_limit_is_continued_and_flagged(client):
    conv = _setup(client, prompt_mode=False)
    FakeProvider.script = [
        [{"type": "text_delta", "text": "Here is the long explanation of the plan, step by step"}, {"type": "done", "finish_reason": "length", "server_finish": "length"}],
        [{"type": "text_delta", "text": ", and that is all."}, {"type": "done", "finish_reason": "stop"}],
    ]
    events = _chat(client, conv["id"], "explain")
    assert next(e for e in events if e.get("event") == "answer_cut_off")["data"]["finish"] == "length"
    assert _assistants(client, conv["id"])[0]["meta"]["finish"] == "length"
