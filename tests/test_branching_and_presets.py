"""Message branching, model presets, styles, thinking mapping, workspace file history."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from missile_studio.config import Config, ModelPreset, ProviderConfig, StyleConfig
from missile_studio.engine import Engine, thinking_body
from missile_studio.providers import REGISTRY
from missile_studio.server.app import create_app
from missile_studio.store import Store

from .test_mcp_and_engine import FakeProvider

OWNER = {"Authorization": "Bearer owner-tok"}


def test_store_branching(tmp_path):
    st = Store(tmp_path / "b.db")
    c = st.create_conversation(title="t")["id"]
    u1 = st.append_message(c, {"role": "user", "content": "q1"})
    a1 = st.append_message(c, {"role": "assistant", "content": "a1"})
    u2 = st.append_message(c, {"role": "user", "content": "q2"})
    a2 = st.append_message(c, {"role": "assistant", "content": "a2"})
    assert [m["content"] for m in st.get_messages(c)] == ["q1", "a1", "q2", "a2"]
    # edit q2 -> rewind head to its parent (a1), append a sibling
    st.set_head(c, st.parent_of(c, u2))
    u2b = st.append_message(c, {"role": "user", "content": "q2 edited"})
    a2b = st.append_message(c, {"role": "assistant", "content": "a2b"})
    path = st.get_messages(c)
    assert [m["content"] for m in path] == ["q1", "a1", "q2 edited", "a2b"]
    info = st.branch_info(c, path)
    assert info[u2b]["siblings"] == [u2, u2b] and info[u2b]["index"] == 1
    assert u1 not in info  # no siblings at the root
    # switch back to the first branch: head goes to its leaf
    st.set_head(c, st.leaf_of(c, u2))
    assert [m["content"] for m in st.get_messages(c)] == ["q1", "a1", "q2", "a2"]
    assert st.leaf_of(c, u2) == a2
    # the legacy migration keeps linear order when head_id is missing
    st._conn().execute("UPDATE conversations SET head_id=NULL WHERE id=?", (c,))
    st._conn().execute("UPDATE messages SET parent_id=NULL WHERE conversation_id=?", (c,))
    st._migrate(st._conn())
    assert [m["content"] for m in st.get_messages(c)] == ["q1", "a1", "q2", "a2", "q2 edited", "a2b"]


def test_thinking_body_per_provider():
    anth = ProviderConfig(id="a", kind="anthropic")
    assert thinking_body(anth, "claude-sonnet-5-5", "on") == {"thinking": {"type": "enabled", "budget_tokens": 6000}}
    assert thinking_body(anth, "claude-sonnet-5-5", "max")["thinking"]["budget_tokens"] == 16000
    assert thinking_body(anth, "claude-sonnet-5-5", "off") == {}
    assert thinking_body(anth, "claude-sonnet-5-5", "") == {}
    ds = ProviderConfig(id="d", kind="openai", base_url="https://dashscope-intl.aliyuncs.com/compatible-mode/v1")
    assert thinking_body(ds, "qwen3.8-flash", "off") == {"enable_thinking": False}
    vllm = ProviderConfig(id="v", kind="openai", base_url="http://127.0.0.1:8000/v1")
    assert thinking_body(vllm, "Qwen3-32B", "on") == {"chat_template_kwargs": {"enable_thinking": True}}
    oai = ProviderConfig(id="o", kind="openai", base_url="https://api.openai.com/v1")
    assert thinking_body(oai, "gpt-5.4-mini", "max") == {"reasoning_effort": "high"}
    assert thinking_body(oai, "gpt-4.1-mini", "on") == {}
    gem = ProviderConfig(id="g", kind="gemini")
    assert thinking_body(gem, "gemini-2.5-flash", "off") == {"generationConfig": {"thinkingConfig": {"thinkingBudget": 0}}}


def test_effective_presets_derived_and_configured():
    cfg = Config()
    cfg.providers.append(ProviderConfig(id="q", kind="openai", models=["qwen"], default_model="qwen"))
    cfg.providers.append(ProviderConfig(id="c", kind="anthropic", models=["claude-x"], default_model="claude-x"))
    cfg.ensure_defaults()
    ps = {p.id: p for p in cfg.effective_presets()}
    assert ps["fast"].provider == "q" and ps["fast"].thinking == "off"
    assert ps["think"].thinking == "on"
    assert ps["best"].provider == "c" and ps["best"].model == "claude-x" and ps["best"].thinking == "max"
    cfg.presets = [ModelPreset(id="mine", label="Mine", provider="q", model="qwen")]
    assert [p.id for p in cfg.effective_presets()] == ["mine"]
    assert {s.id for s in cfg.styles} >= {"normal", "concise", "formal"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("MISSILE_HOME", str(tmp_path))
    REGISTRY["fake"] = FakeProvider
    cfg = Config()
    cfg.providers.append(ProviderConfig.model_construct(id="fake", kind="fake", models=["fake-1"], default_model="fake-1", enabled=True))
    cfg.ensure_defaults()
    cfg.default.provider = "fake"
    cfg.default.model = "fake-1"
    cfg.server.token = "owner-tok"
    eng = Engine(cfg, Store(tmp_path / "t.db"))
    app = create_app(eng, token="owner-tok")
    with TestClient(app) as c:
        yield c
    REGISTRY.pop("fake", None)


def read_sse(resp):
    import json

    return [json.loads(l[5:].strip()) for l in resp.iter_lines() if l.startswith("data:")]


def test_api_branch_edit_and_switch_and_style(client):
    conv = client.post("/api/conversations", json={}, headers=OWNER).json()
    FakeProvider.script = [[{"type": "text_delta", "text": "first answer"}, {"type": "done", "finish_reason": "stop"}]]
    with client.stream("POST", "/api/chat", json={"conversation_id": conv["id"], "text": "hello", "style_id": "concise"}, headers=OWNER) as r:
        read_sse(r)
    c = client.get(f"/api/conversations/{conv['id']}", headers=OWNER).json()
    assert [m["role"] for m in c["messages"]] == ["user", "assistant"] and c["branches"] == {} and c["style_id"] == "concise"
    first_user = c["messages"][0]["id"]
    # the style prompt reached the provider
    assert "Writing style:" in FakeProvider.seen[-1][0]["content"]
    # edit the first user message -> a sibling branch
    FakeProvider.script = [[{"type": "text_delta", "text": "second answer"}, {"type": "done", "finish_reason": "stop"}]]
    with client.stream("POST", "/api/chat", json={"conversation_id": conv["id"], "text": "hello again", "branch_from": first_user, "thinking": "off"}, headers=OWNER) as r:
        read_sse(r)
    c = client.get(f"/api/conversations/{conv['id']}", headers=OWNER).json()
    assert [m["content"] for m in c["messages"]] == ["hello again", "second answer"]
    nu = c["messages"][0]["id"]
    assert c["branches"][nu]["siblings"] == [first_user, nu] and c["branches"][nu]["index"] == 1
    # the provider only saw the new branch's history
    assert [m["role"] for m in FakeProvider.seen[-1]] == ["system", "user"]
    # switch back
    c = client.post(f"/api/conversations/{conv['id']}/head", json={"message_id": first_user}, headers=OWNER).json()
    assert [m["content"] for m in c["messages"]] == ["hello", "first answer"]
    assert c["branches"][first_user]["index"] == 0


def test_presets_and_styles_api(client):
    st = client.get("/api/state", headers=OWNER).json()
    assert [p["id"] for p in st["model_presets"]] == ["fast", "think", "best"] and st["presets_configured"] is False
    r = client.put("/api/presets", json=[{"id": "x", "label": "X", "provider": "fake", "model": "fake-1", "thinking": "on"}], headers=OWNER)
    assert r.json()[0]["id"] == "x"
    assert client.get("/api/state", headers=OWNER).json()["presets_configured"] is True
    r = client.post("/api/styles", json={"id": "pirate", "name": "Pirate", "prompt": "Talk like a pirate."}, headers=OWNER)
    assert any(s["id"] == "pirate" for s in r.json())
    assert client.delete("/api/styles/pirate", headers=OWNER).json()["ok"]
    assert not any(s["id"] == "pirate" for s in client.get("/api/state", headers=OWNER).json()["styles"])


def test_workspace_history(client):
    client.put("/api/workspace/file", json={"path": "docs/a.md", "content": "v1"}, headers=OWNER)
    r = client.put("/api/workspace/file", json={"path": "docs/a.md", "content": "v2"}, headers=OWNER).json()
    assert r["versioned"] is True
    h = client.get("/api/workspace/history?path=docs/a.md", headers=OWNER).json()
    assert len(h["versions"]) == 1
    old = client.get(f"/api/workspace/history/file?name={h['versions'][0]['name']}", headers=OWNER).json()
    assert old["content"] == "v1"
    assert client.get("/api/workspace/history/file?name=../config.json", headers=OWNER).status_code == 404
    tree = client.get("/api/workspace/tree", headers=OWNER).json()
    assert all(e["name"] != ".history" for e in tree["entries"])


def test_repair_history_answers_orphan_tool_calls():
    from missile_studio.engine import _repair_history

    hist = [
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "a", "name": "t1"}, {"id": "b", "name": "t2"}]},
        {"role": "tool", "tool_call_id": "a", "name": "t1", "content": "ok"},
        {"role": "assistant", "content": "done"},
    ]
    out = _repair_history(hist)
    assert [m["role"] for m in out] == ["user", "assistant", "tool", "tool", "assistant"]
    assert out[3]["tool_call_id"] == "b" and out[3]["is_error"] is True
    # a healthy history is returned unchanged
    good = hist[:3] + [{"role": "tool", "tool_call_id": "b", "name": "t2", "content": "ok"}, hist[3]]
    assert _repair_history(good) == good
