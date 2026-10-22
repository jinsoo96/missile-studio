"""0.6 harness and knowledge: retries, parallel tools, thinking round-trip, prompt cache, compaction,
chat search, memories, knowledge base, reattachable turn streams, research mode."""

from __future__ import annotations

import json
import time

import httpx
import pytest

from missile_studio.config import Config, ProviderConfig
from missile_studio.engine import Engine, _estimate_tokens, _retryable
from missile_studio.knowledge import chunk_text
from missile_studio.providers import REGISTRY
from missile_studio.providers.anthropic import AnthropicProvider, to_anthropic_messages
from missile_studio.store import Store
from missile_studio.tools.builtin import _strip_tags

from .test_api import H, client, read_sse  # noqa: F401  (fixture)
from .test_mcp_and_engine import FakeProvider
from .test_providers import collect, make


def test_retryable_classifier():
    assert _retryable("HTTP 429 from x: rate limit") and _retryable("HTTP 503 overloaded") and _retryable("ConnectError: timed out")
    assert not _retryable("HTTP 401 unauthorized") and not _retryable("HTTP 400 bad request") and not _retryable("model not found")
    assert _estimate_tokens([{"role": "user", "content": "x" * 300}]) > 100


def test_retry_then_answer(client):
    conv = client.post("/api/conversations", json={}, headers=H).json()
    FakeProvider.script = [
        [{"type": "error", "message": "HTTP 429 from provider: rate limit exceeded"}, {"type": "done", "finish_reason": "error"}],
        [{"type": "text_delta", "text": "second try"}, {"type": "done", "finish_reason": "stop"}],
    ]
    with client.stream("POST", "/api/chat", json={"conversation_id": conv["id"], "text": "hi"}, headers=H) as r:
        events = read_sse(r)
    assert any(e["type"] == "status" and e.get("event") == "retry" for e in events)
    assert "".join(e["text"] for e in events if e["type"] == "text_delta") == "second try"
    assert not any(e["type"] == "error" for e in events)
    msgs = client.get(f"/api/conversations/{conv['id']}", headers=H).json()["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant"] and msgs[1]["content"] == "second try"


def test_parallel_tool_calls_run_at_once(client):
    client.put("/api/policy", json={"default": "allow", "read_only_default": "allow", "rules": {}}, headers=H)
    conv = client.post("/api/conversations", json={}, headers=H).json()
    FakeProvider.script = [
        [
            {"type": "tool_call", "id": "s1", "name": "echo__slow", "arguments": {"seconds": 1.0}},
            {"type": "tool_call", "id": "s2", "name": "echo__slow", "arguments": {"seconds": 1.0}},
            {"type": "tool_call", "id": "s3", "name": "echo__slow", "arguments": {"seconds": 1.0}},
            {"type": "done", "finish_reason": "tool_calls"},
        ],
        [{"type": "text_delta", "text": "all three done"}, {"type": "done", "finish_reason": "stop"}],
    ]
    t0 = time.time()
    with client.stream("POST", "/api/chat", json={"conversation_id": conv["id"], "text": "go"}, headers=H) as r:
        events = read_sse(r)
    took = time.time() - t0
    results = [e for e in events if e["type"] == "tool_result"]
    assert {e["id"] for e in results} == {"s1", "s2", "s3"} and all(not e["is_error"] for e in results)
    assert took < 2.4, f"three 1s tools took {took:.1f}s: they did not run concurrently"
    msgs = client.get(f"/api/conversations/{conv['id']}", headers=H).json()["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant", "tool", "tool", "tool", "assistant"]


def test_anthropic_thinking_blocks_are_replayed_only_with_thinking_on():
    msgs = [
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": "a", "thinking_blocks": [{"type": "thinking", "thinking": "hmm", "signature": "sig1"}, {"type": "redacted_thinking", "data": "xyz"}], "tool_calls": [{"id": "t1", "name": "x", "arguments": {}}]},
        {"role": "tool", "tool_call_id": "t1", "name": "x", "content": "ok"},
    ]
    on = to_anthropic_messages(msgs, keep_thinking=True)
    assert on[1]["content"][0] == {"type": "thinking", "thinking": "hmm", "signature": "sig1"}
    assert on[1]["content"][1] == {"type": "redacted_thinking", "data": "xyz"}
    assert on[1]["content"][2]["type"] == "text" and on[1]["content"][3]["type"] == "tool_use"
    off = to_anthropic_messages(msgs)
    assert off[1]["content"][0]["type"] == "text"


async def test_anthropic_stream_emits_thinking_block_and_caches_tools():
    seen = {}

    def handler(req: httpx.Request):
        seen["body"] = json.loads(req.content)
        frames = [
            ("message_start", {"type": "message_start", "message": {"usage": {"input_tokens": 7, "output_tokens": 1, "cache_read_input_tokens": 5}}}),
            ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}}),
            ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "let me "}}),
            ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "think"}}),
            ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "SIG"}}),
            ("content_block_stop", {"type": "content_block_stop", "index": 0}),
            ("content_block_start", {"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}}),
            ("content_block_delta", {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "Hi"}}),
            ("content_block_stop", {"type": "content_block_stop", "index": 1}),
            ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 3}}),
            ("message_stop", {"type": "message_stop"}),
        ]
        body = "".join(f"event: {e}\ndata: {json.dumps(d)}\n\n" for e, d in frames).encode()
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})

    p = make(AnthropicProvider, ProviderConfig(id="a", kind="anthropic", api_key="k", extra_body={"thinking": {"type": "enabled", "budget_tokens": 1024}}), handler)
    msgs = [{"role": "system", "content": "sys"}, {"role": "user", "content": "q"}, {"role": "assistant", "content": "prev", "thinking_blocks": [{"type": "thinking", "thinking": "old", "signature": "S0"}]}, {"role": "user", "content": "again"}]
    evs = await collect(p, messages=msgs, tools=[{"name": "t1", "description": "", "input_schema": {"type": "object", "properties": {}}}, {"name": "t2", "description": "", "input_schema": {"type": "object", "properties": {}}}])
    tb = [e for e in evs if e["type"] == "thinking_block"]
    assert tb == [{"type": "thinking_block", "block": {"type": "thinking", "thinking": "let me think", "signature": "SIG"}}]
    assert "".join(e["text"] for e in evs if e["type"] == "thinking_delta") == "let me think"
    assert any(e["type"] == "usage" and e.get("cache_read_input_tokens") == 5 for e in evs)
    # the earlier thinking block went back out with its signature; only the last tool carries cache_control
    assert seen["body"]["messages"][1]["content"][0] == {"type": "thinking", "thinking": "old", "signature": "S0"}
    assert "cache_control" not in seen["body"]["tools"][0] and seen["body"]["tools"][1]["cache_control"] == {"type": "ephemeral"}


async def test_compaction_summarises_long_threads(tmp_path, monkeypatch):
    monkeypatch.setenv("MISSILE_HOME", str(tmp_path))
    REGISTRY["fake"] = FakeProvider
    cfg = Config()
    cfg.providers.append(ProviderConfig.model_construct(id="fake", kind="fake", models=["fake-1"], default_model="fake-1", context_window=3000, extra_body={}, headers={}, enabled=True, api_key="", api_key_env="", allow_insecure_tls=False))
    cfg.ensure_defaults()
    cfg.default.provider, cfg.default.model = "fake", "fake-1"
    cfg.builtin_tools.shell = cfg.builtin_tools.filesystem = cfg.builtin_tools.web = False
    store = Store(tmp_path / "t.db")
    eng = Engine(cfg, store)
    cid = store.create_conversation(title="long")["id"]
    for i in range(12):
        store.append_message(cid, {"role": "user" if i % 2 == 0 else "assistant", "content": f"turn {i}: " + ("lorem ipsum " * 40)})
    FakeProvider.script = [
        [{"type": "text_delta", "text": "SUMMARY: the user talked about lorem ipsum twelve times."}, {"type": "done", "finish_reason": "stop"}],
        [{"type": "text_delta", "text": "answer"}, {"type": "done", "finish_reason": "stop"}],
    ]
    from missile_studio.engine import TurnRequest

    events = [ev async for ev in eng.run_turn(TurnRequest(conversation_id=cid, user_text="and now?", tools_override="none"))]
    kinds = [(e["type"], e.get("event")) for e in events if e["type"] == "status"]
    assert ("status", "compacting") in kinds and ("status", "compacted") in kinds
    conv = store.get_conversation(cid)
    assert conv["summary"].startswith("SUMMARY") and conv["summary_upto"]
    sent = FakeProvider.seen[-1]
    assert "compacted into a summary" in sent[0]["content"] and "SUMMARY" in sent[0]["content"]
    assert len(sent) < 12  # only the tail went verbatim
    # the next turn reuses the stored summary without summarising again
    FakeProvider.script = [[{"type": "text_delta", "text": "again"}, {"type": "done", "finish_reason": "stop"}]]
    events = [ev async for ev in eng.run_turn(TurnRequest(conversation_id=cid, user_text="more", tools_override="none"))]
    assert not any(e.get("event") == "compacting" for e in events)
    assert "SUMMARY" in FakeProvider.seen[-1][0]["content"]
    REGISTRY.pop("fake", None)


def test_memories_recall_and_chat_search(client):
    m = client.post("/api/memory", json={"text": "The user's webtoon is called Backstage and is drawn on the uc board."}, headers=H).json()
    assert m["id"] and "Backstage" in m["text"]
    assert client.get("/api/memory?q=Backstage", headers=H).json()["items"][0]["id"] == m["id"]
    conv = client.post("/api/conversations", json={}, headers=H).json()
    FakeProvider.script = [[{"type": "text_delta", "text": "the uc board"}, {"type": "done", "finish_reason": "stop"}]]
    with client.stream("POST", "/api/chat", json={"conversation_id": conv["id"], "text": "which board does Backstage use?", "tools": "none"}, headers=H) as r:
        read_sse(r)
    system = FakeProvider.seen[-1][0]["content"]
    assert "Things remembered" in system and "Backstage" in system
    # the chat is searchable by body, not only by title
    hits = client.get("/api/search?q=Backstage use", headers=H).json()["hits"]
    assert any(h["conversation_id"] == conv["id"] and h["role"] == "user" for h in hits)
    # edit, then switch recall off: the system prompt no longer carries memories
    assert client.put(f"/api/memory/{m['id']}", json={"text": "Backstage uses the anima board now."}, headers=H).json()["text"].endswith("now.")
    assert client.put("/api/memory-settings", json={"enabled": False, "recall_k": 5}, headers=H).json()["enabled"] is False
    FakeProvider.script = [[{"type": "text_delta", "text": "ok"}, {"type": "done", "finish_reason": "stop"}]]
    with client.stream("POST", "/api/chat", json={"conversation_id": conv["id"], "text": "Backstage again?", "tools": "none"}, headers=H) as r:
        read_sse(r)
    assert "Things remembered" not in FakeProvider.seen[-1][0]["content"]
    assert client.delete(f"/api/memory/{m['id']}", headers=H).json()["ok"] is True
    client.put("/api/memory-settings", json={"enabled": True, "recall_k": 5}, headers=H)


def test_knowledge_index_search_and_rag(client, tmp_path):
    d = tmp_path / "kb"
    d.mkdir()
    (d / "notes.md").write_text("# Launch\n\nThe launcher codename is Sparrowhawk and it ships in March.\n\nA second paragraph about fonts: SUIT carries Hangul.\n", encoding="utf-8")
    (d / "skip.bin").write_bytes(b"\x00\x01")
    assert len(chunk_text("para one\n\n" + "x" * 500 + "\n\n" + "y" * 500 + "\n\npara four", size=600)) >= 2
    src = client.post("/api/knowledge/sources", json={"path": str(d)}, headers=H).json()
    assert src["id"] and src["path"].endswith("kb")
    rep = client.post("/api/knowledge/reindex?wait=true", headers=H).json()
    assert rep["ok"] and rep["sources"][0]["files"] == 1 and rep["sources"][0]["chunks"] >= 1
    st = client.get("/api/knowledge", headers=H).json()
    assert st["chunks"] >= 1 and st["sources"][0]["chunks"] >= 1 and st["fts"] is True
    hits = client.get("/api/knowledge/search?q=Sparrowhawk", headers=H).json()["hits"]
    assert hits and "Sparrowhawk" in hits[0]["text"] and hits[0]["path"].endswith("notes.md")
    conv = client.post("/api/conversations", json={}, headers=H).json()
    FakeProvider.script = [[{"type": "text_delta", "text": "Sparrowhawk, in March"}, {"type": "done", "finish_reason": "stop"}]]
    with client.stream("POST", "/api/chat", json={"conversation_id": conv["id"], "text": "what is the launcher codename?", "tools": "none", "knowledge": True}, headers=H) as r:
        events = read_sse(r)
    assert any(e["type"] == "status" and e.get("event") == "knowledge" for e in events)
    system = FakeProvider.seen[-1][0]["content"]
    assert "knowledge base" in system and "Sparrowhawk" in system
    # the tool is there too, and the source can be removed
    assert any(t["full_name"] == "local__knowledge_search" for t in client.get("/api/tools", headers=H).json())
    assert client.delete(f"/api/knowledge/sources/{src['id']}", headers=H).json()["ok"]
    assert client.get("/api/knowledge", headers=H).json()["chunks"] == 0


def test_turn_stream_is_replayable(client):
    conv = client.post("/api/conversations", json={}, headers=H).json()
    FakeProvider.script = [[{"type": "text_delta", "text": "alpha "}, {"type": "text_delta", "text": "beta"}, {"type": "done", "finish_reason": "stop"}]]
    with client.stream("POST", "/api/chat", json={"conversation_id": conv["id"], "text": "hi", "tools": "none"}, headers=H) as r:
        live = read_sse(r)
    assert "".join(e["text"] for e in live if e["type"] == "text_delta") == "alpha beta"
    # a tab that opens later replays the same buffered events, with running indices
    with client.stream("GET", f"/api/chat/{conv['id']}/stream?after=0", headers=H) as r:
        again = read_sse(r)
    assert "".join(e["text"] for e in again if e["type"] == "text_delta") == "alpha beta"
    assert again[-1]["type"] == "done" and all("i" in e for e in again if e["type"] != "open")
    # from an index in the middle only the rest comes back
    with client.stream("GET", f"/api/chat/{conv['id']}/stream?after={again[-1]['i'] - 1}", headers=H) as r:
        tail = read_sse(r)
    assert [e["type"] for e in tail if e["type"] != "open"] == ["done"]
    assert client.get("/api/chat/nope/stream", headers=H).status_code == 404


def test_research_mode_prompt_and_web_search_tool_listed(client):
    conv = client.post("/api/conversations", json={}, headers=H).json()
    FakeProvider.script = [[{"type": "text_delta", "text": "report"}, {"type": "done", "finish_reason": "stop"}]]
    with client.stream("POST", "/api/chat", json={"conversation_id": conv["id"], "text": "compare x and y", "mode": "research"}, headers=H) as r:
        read_sse(r)
    assert "Research mode" in FakeProvider.seen[-1][0]["content"]
    names = {t["full_name"] for t in client.get("/api/tools", headers=H).json()}
    assert {"local__web_search", "local__memory_save", "local__memory_search", "local__knowledge_search"} <= names
    st = client.get("/api/state", headers=H).json()
    assert st["builtin_tools"]["web_search"]["provider"] == "duckduckgo" and st["builtin_tools"]["web_search"]["has_key"] is False
    r = client.put("/api/builtin-tools", json={**{k: v for k, v in st["builtin_tools"].items() if k != "workspace_resolved"}, "web_search": {"provider": "tavily", "api_key": "tv-key", "api_key_env": "", "url": ""}}, headers=H)
    assert r.json()["web_search"]["has_key"] is True and r.json()["web_search"]["api_key"] == "…"
    assert _strip_tags("<b>Hello</b> &amp; <i>world</i>") == "Hello & world"
