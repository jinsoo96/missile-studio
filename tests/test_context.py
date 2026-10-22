"""Small contexts: Korean-aware token estimate, shaping a request to fit, and recovering from a context-length 400."""

from __future__ import annotations

from missile_studio.config import ProviderConfig
from missile_studio.engine import _estimate_tokens, _fit_messages, _tail_tokens, _text_tokens

from .test_api import H, client, read_sse  # noqa: F401  (fixture)
from .test_mcp_and_engine import FakeProvider

ALLOW = {"default": "allow", "read_only_default": "allow", "rules": {}}


def _chat(client, cid, text, **extra):
    with client.stream("POST", "/api/chat", json={"conversation_id": cid, "text": text, **extra}, headers=H) as r:
        return read_sse(r)


def test_token_estimate_counts_korean_per_character():
    ko = "가" * 300
    en = "a" * 300
    assert _text_tokens(ko) >= 300 and _text_tokens(en) <= 110
    assert _estimate_tokens([{"role": "user", "content": [{"type": "text", "text": "x"}, {"type": "image_url", "image_url": {"url": "data:..."}}]}]) > 1500
    assert _tail_tokens("abc " * 1000, 50).endswith("abc ") and _text_tokens(_tail_tokens("가" * 1000, 100)) <= 100


def test_fit_messages_shortens_results_drops_old_images_then_old_turns():
    big = "가" * 3000
    msgs = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "first question"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "a", "name": "t", "arguments": {}}]},
        {"role": "tool", "tool_call_id": "a", "name": "t", "content": big},
        {"role": "user", "content": [{"type": "text", "text": "(image returned by t)"}, {"type": "image_url", "image_url": {"url": "data:1"}}]},
        {"role": "assistant", "content": "answer one"},
        {"role": "user", "content": "second question"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "b", "name": "t", "arguments": {}}]},
        {"role": "tool", "tool_call_id": "b", "name": "t", "content": big},
        {"role": "user", "content": [{"type": "text", "text": "(image returned by t)"}, {"type": "image_url", "image_url": {"url": "data:2"}}]},
        {"role": "assistant", "content": "answer two"},
        {"role": "user", "content": "third question"},
    ]
    same, changed = _fit_messages(msgs, 100_000)
    assert not changed and same is msgs
    out, changed = _fit_messages(msgs, 7000)
    assert changed and len(out) == len(msgs) and out[0] == msgs[0] and out[-1] == msgs[-1]
    # the old result is shortened, the old image dropped, the latest image and the recent result kept whole
    assert len(out[3]["content"]) < 1400 and "shortened" in out[3]["content"]
    assert isinstance(out[4]["content"], str) and "omitted" in out[4]["content"]
    assert out[8]["content"] == big and isinstance(out[9]["content"], list)
    # a smaller limit also drops the first exchange from a user boundary and says so
    out2, _ = _fit_messages(msgs, 5200)
    assert out2[0]["role"] == "system" and out2[1]["role"] == "user" and out2[1]["content"].startswith("(earlier messages were omitted")
    assert not any(m.get("role") == "tool" and m.get("tool_call_id") == "a" for m in out2)
    assert out2[-1] == msgs[-1]
    # force=True shapes even when the estimate says it fits (used after the model rejected the request)
    out3, changed3 = _fit_messages(msgs, 100_000, force=True)
    assert changed3 and "shortened" in out3[3]["content"]


def test_small_context_model_gets_short_tool_results_and_recovers_from_a_400(client):
    client.put("/api/policy", json=ALLOW, headers=H)
    client.post("/api/providers", json={"id": "fake", "kind": "fake", "context_window": 4000, "default_model": "fake-1"}, headers=H)
    conv = client.post("/api/conversations", json={}, headers=H).json()
    long_text = "가나다라 " * 1200  # ~6000 chars: far more than a 4k-token model should be fed from one tool result
    FakeProvider.script = [
        [{"type": "tool_call", "id": "e1", "name": "echo__echo", "arguments": {"text": long_text}}, {"type": "done", "finish_reason": "tool_calls"}],
        [{"type": "error", "message": "HTTP 400: Input length (4312) exceeds model's maximum context length (4000)."}],
        [{"type": "text_delta", "text": "fits now"}, {"type": "done", "finish_reason": "stop"}],
    ]
    events = _chat(client, conv["id"], "echo a lot", tools="none" if False else None)
    assert not any(e["type"] == "error" for e in events)
    assert events[-1]["type"] == "done" and events[-1]["finish_reason"] == "stop"
    assert any(e.get("event") == "context_trimmed" for e in events)
    # the thread keeps the full result; the model saw a capped one (ctx // 4 = 1000 chars + note)
    msgs = client.get(f"/api/conversations/{conv['id']}", headers=H).json()["messages"]
    stored = next(m for m in msgs if m["role"] == "tool")
    assert len(stored["content"]) >= 6000
    sent = FakeProvider.seen[-1]
    tool_sent = next(m for m in sent if m.get("role") == "tool")
    assert len(tool_sent["content"]) < 1700 and "shortened" in tool_sent["content"]  # ctx // 4 = 1000 -> floor 1500 chars + note
    assert "".join(e["text"] for e in events if e["type"] == "text_delta") == "fits now"
