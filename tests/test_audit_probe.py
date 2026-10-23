"""The audit log is paged and filtered on the server; a pasted endpoint is turned into the API kind and base URL."""

from __future__ import annotations

from missile_studio.providers.probe import candidates, guess_kind

from .test_api import H, client  # noqa: F401  (fixture)


def _fill_audit(store, n=7):
    for i in range(n):
        store.audit(conversation_id="c1" if i % 2 else "c2", tool=f"srv__tool{i % 3}", arguments={"path": f"notes/{i}.md"}, decision="deny" if i == 3 else "allow", is_error=i == 5, duration_ms=10 + i, result_excerpt=f"result {i}")


def test_audit_pages_filters_and_counts(client):
    _fill_audit(client.app.state.engine.store)
    first = client.get("/api/audit/page?limit=3&offset=0", headers=H).json()
    assert first["total"] == 7 and len(first["items"]) == 3 and first["items"][0]["result_excerpt"] == "result 6"  # newest first
    last = client.get("/api/audit/page?limit=3&offset=6", headers=H).json()
    assert [r["result_excerpt"] for r in last["items"]] == ["result 0"]
    assert client.get("/api/audit/page?q=notes/4.md", headers=H).json()["total"] == 1
    assert client.get("/api/audit/page?q=tool1", headers=H).json()["total"] == 2
    assert [r["decision"] for r in client.get("/api/audit/page?decision=deny", headers=H).json()["items"]] == ["deny"]
    assert client.get("/api/audit/page?errors=1", headers=H).json()["total"] == 1
    assert client.get("/api/audit/page?conversation_id=c1", headers=H).json()["total"] == 3
    # a LIKE wildcard in the search is taken literally
    assert client.get("/api/audit/page?q=%25", headers=H).json()["total"] == 0


def test_audit_export_is_csv_of_the_matching_rows(client):
    _fill_audit(client.app.state.engine.store)
    r = client.get("/api/audit/export?decision=allow", headers=H)
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    assert "attachment" in r.headers["content-disposition"]
    lines = r.text.lstrip("﻿").strip().splitlines()
    assert lines[0].startswith("time,conversation_id,tool,decision") and len(lines) == 1 + 6


def test_endpoint_candidates():
    assert candidates("http://localhost:11434") == [("openai", "http://localhost:11434/v1"), ("openai", "http://localhost:11434")]
    assert candidates("localhost:1234/") == [("openai", "http://localhost:1234/v1"), ("openai", "http://localhost:1234")]
    assert candidates("https://api.openai.com/v1/chat/completions") == [("openai", "https://api.openai.com/v1")]
    assert candidates("https://api.groq.com/openai/v1/models?x=1") == [("openai", "https://api.groq.com/openai/v1")]
    assert candidates("https://api.anthropic.com/v1/messages") == [("anthropic", "https://api.anthropic.com")]
    assert candidates("https://generativelanguage.googleapis.com/v1beta/models") == [("gemini", "https://generativelanguage.googleapis.com")]
    assert candidates("https://gw.example.com/llm", "anthropic") == [("anthropic", "https://gw.example.com/llm")]
    assert guess_kind("example.com") == "openai" and candidates("") == []


def test_probe_returns_the_first_base_that_lists_models(client, monkeypatch):
    seen = []

    async def fake_test(pc, limit=200):
        seen.append((pc.kind, pc.base_url, pc.api_key))
        if pc.base_url.endswith("/v1") and "plain" not in pc.base_url:
            return {"ok": True, "models": ["m-a", "m-b"], "count": 2, "ms": 5}
        return {"ok": False, "error": "404 not found"}

    monkeypatch.setattr(client.app.state.engine, "test_provider", fake_test)
    r = client.post("/api/providers/probe", json={"url": "http://10.0.0.5:8000/", "kind": "auto", "api_key": "k"}, headers=H).json()
    assert r["ok"] and r["kind"] == "openai" and r["base_url"] == "http://10.0.0.5:8000/v1" and r["models"] == ["m-a", "m-b"]
    assert seen == [("openai", "http://10.0.0.5:8000/v1", "k")]

    seen.clear()
    r = client.post("/api/providers/probe", json={"url": "https://host.example/plain"}, headers=H).json()
    assert not r["ok"] and r["error"] == "404 not found" and [t["base_url"] for t in r["tried"]] == ["https://host.example/plain/v1", "https://host.example/plain"]
    assert r["base_url"] == "https://host.example/plain/v1"
