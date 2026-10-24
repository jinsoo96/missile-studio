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


def test_fold_turn_keeps_recent_steps_and_valid_pairs():
    """One turn with many tool calls: the oldest steps fold into a one-line log, the newest two stay whole."""
    from missile_studio.engine import _fold_turn

    big = "가" * 600
    msgs = [{"role": "system", "content": "sys"}, {"role": "user", "content": "do many things"}]
    for i in range(10):
        msgs.append({"role": "assistant", "content": "", "tool_calls": [{"id": f"c{i}", "name": f"srv__tool{i}", "arguments": {"n": i}}]})
        msgs.append({"role": "tool", "tool_call_id": f"c{i}", "name": f"srv__tool{i}", "content": f"result {i} " + big})
    before = _estimate_tokens(msgs)
    out, changed = _fit_messages(msgs, 3000)
    assert changed and _estimate_tokens(out) < before and _estimate_tokens(out) <= 3200
    assert out[0]["role"] == "system" and out[1]["content"] == "do many things"
    folded = out[2]
    assert folded["role"] == "assistant" and "folded" in folded["content"] and "srv__tool0(" in folded["content"] and "result 0" in folded["content"]
    # the last two call/result pairs are intact and every remaining call has its result
    assert out[-1]["tool_call_id"] == "c9" and out[-3]["tool_call_id"] == "c8" and out[-2]["tool_calls"][0]["id"] == "c9"
    ids = [c["id"] for m in out if m.get("tool_calls") for c in m["tool_calls"]]
    assert all(any(m.get("tool_call_id") == cid for m in out) for cid in ids)
    assert _fold_turn(msgs[:6], 10) == msgs[:6]  # two blocks or fewer: nothing to fold


def test_long_tool_loop_on_a_small_model_folds_instead_of_failing(client):
    client.put("/api/policy", json=ALLOW, headers=H)
    client.post("/api/providers", json={"id": "fake", "kind": "fake", "context_window": 3000, "default_model": "fake-1"}, headers=H)
    conv = client.post("/api/conversations", json={}, headers=H).json()
    step = "가나다 " * 150  # ~600 chars per result
    FakeProvider.script = [[{"type": "tool_call", "id": f"e{i}", "name": "echo__echo", "arguments": {"text": f"{i} " + step}}, {"type": "done", "finish_reason": "tool_calls"}] for i in range(8)]
    FakeProvider.script.append([{"type": "text_delta", "text": "all done"}, {"type": "done", "finish_reason": "stop"}])
    events = _chat(client, conv["id"], "loop a lot", tools=None)
    assert not any(e["type"] == "error" for e in events) and events[-1]["finish_reason"] == "stop"
    assert sum(1 for e in events if e["type"] == "tool_result") == 8
    assert any(e.get("event") == "context_trimmed" for e in events)
    last = FakeProvider.seen[-1]
    assert any(m.get("role") == "assistant" and "folded" in str(m.get("content")) for m in last)
    assert _estimate_tokens(last) <= 3000  # the floor is the system prompt + the two newest steps; it stays inside the window
    # the stored thread still has every step
    msgs = client.get(f"/api/conversations/{conv['id']}", headers=H).json()["messages"]
    assert sum(1 for m in msgs if m["role"] == "tool") == 8


def test_cap_images_keeps_newest_images_only():
    from missile_studio.engine import _cap_images

    def img(n):
        return {"role": "user", "content": [{"type": "text", "text": f"(image {n})"}, {"type": "image_url", "image_url": {"url": f"data:{n}"}}]}

    msgs = [{"role": "system", "content": "sys"}] + [img(k) for k in range(6)] + [{"role": "user", "content": "now"}]
    out = _cap_images(msgs, 4)
    kept = [p["image_url"]["url"] for m in out if isinstance(m.get("content"), list) for p in m["content"] if p.get("type") == "image_url"]
    assert kept == ["data:2", "data:3", "data:4", "data:5"]
    assert out[1]["content"].startswith("(an image shown earlier was omitted") and out[-1]["content"] == "now"
    assert _cap_images(msgs, 0) is msgs  # no known cap: untouched
    two = [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "data:a"}}, {"type": "image_url", "image_url": {"url": "data:b"}}]}]
    assert [p["image_url"]["url"] for p in _cap_images(two, 1)[0]["content"]] == ["data:b"]


def test_image_limit_400_is_learned_and_older_images_are_left_out(client):
    """vLLM answers 400 'At most N image(s) may be provided in one prompt': the provider remembers N and the request is sent again
    with only the newest N images (a contact-sheet tool called many times piles images up long before the context is full)."""
    client.post("/api/providers", json={"id": "fake", "kind": "fake", "default_model": "fake-1"}, headers=H)
    ups = [client.post("/api/upload", files={"file": (f"{k}.png", b"\x89PNG" + bytes([k]), "image/png")}, headers=H).json() for k in range(3)]
    conv = client.post("/api/conversations", json={}, headers=H).json()
    FakeProvider.script = [
        [{"type": "error", "message": 'HTTP 400: {"error":{"message":"At most 2 image(s) may be provided in one prompt. (parameter=image)"}}'}],
        [{"type": "text_delta", "text": "seen"}, {"type": "done", "finish_reason": "stop"}],
    ]
    events = _chat(client, conv["id"], "look", attachments=ups, tools="none")
    assert not any(e["type"] == "error" for e in events)
    assert "".join(e["text"] for e in events if e["type"] == "text_delta") == "seen"
    sent = FakeProvider.seen[-1]
    assert sum(1 for m in sent if isinstance(m.get("content"), list) for p in m["content"] if p.get("type") == "image_url") == 2
    prov = next(p for p in client.get("/api/providers", headers=H).json() if p["id"] == "fake")
    assert prov.get("max_images") == 2


def test_learned_provider_value_does_not_wipe_rules_written_by_another_process(tmp_path, monkeypatch):
    """A long-running process learns a provider limit and saves only that field: a rule another process added to the
    file in the meantime stays (it used to save its whole stale in-memory config and wipe such rules)."""
    import json as _json
    from missile_studio.config import Config, config_path, load_config, save_config, update_provider_fields

    monkeypatch.setenv("MISSILE_HOME", str(tmp_path))
    cfg = Config()
    cfg.ensure_defaults()
    cfg.providers.append(ProviderConfig(id="p1", kind="openai", base_url="http://x"))
    save_config(cfg)
    stale = load_config()  # the long-running process's copy
    other = load_config()  # another process adds a rule and saves
    other.tool_policy.rules["srv__tool"] = "allow"
    save_config(other)
    update_provider_fields("p1", {"max_images": 4})  # the long-running process learns a limit
    disk = _json.loads(config_path().read_text(encoding="utf-8"))
    assert disk["tool_policy"]["rules"].get("srv__tool") == "allow"
    assert next(p for p in disk["providers"] if p["id"] == "p1")["max_images"] == 4
    assert stale.tool_policy.rules.get("srv__tool") is None  # (the stale copy alone would have dropped it)
