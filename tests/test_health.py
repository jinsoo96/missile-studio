"""Provider health: which models can answer right now (ok / down / nokey), so the UI can dim the rest."""

from __future__ import annotations

import time

from missile_studio.config import ProviderConfig

from .test_api import H, client, read_sse  # noqa: F401  (fixture)
from .test_mcp_and_engine import FakeProvider


def _health(client, refresh=True):
    return client.get("/api/providers/health" + ("?refresh=1" if refresh else ""), headers=H).json()


def test_health_probe_classifies_providers(client):
    """A reachable server is ok, a dead port is down, a hosted API without a key is nokey; /api/state carries it all."""
    client.post("/api/providers", json=ProviderConfig(id="dead", kind="openai", label="Dead", base_url="http://127.0.0.1:1/v1", models=["x"], default_model="x").model_dump(), headers=H)
    client.post("/api/providers", json=ProviderConfig(id="claude", kind="anthropic", label="Claude", models=["claude-x"], default_model="claude-x").model_dump(), headers=H)
    h = _health(client)
    assert h["fake"]["state"] == "ok" and h["fake"]["models"] == 1 and h["fake"]["checked_at"] > time.time() - 60
    assert h["dead"]["state"] == "down" and h["dead"]["error"]
    assert h["claude"]["state"] == "nokey" and "key" in h["claude"]["error"]
    st = client.get("/api/state", headers=H).json()
    by_id = {p["id"]: p["health"]["state"] for p in st["providers"]}
    assert by_id == {"fake": "ok", "dead": "down", "claude": "nokey"}
    assert all("health" in p for p in client.get("/api/providers", headers=H).json())


def test_health_without_refresh_reports_unknown_until_probed(client):
    """Before the periodic probe has run, a provider is 'unknown' (never dimmed); a disabled one is skipped by the probe."""
    client.post("/api/providers", json=ProviderConfig(id="off", kind="openai", label="Off", base_url="http://127.0.0.1:1/v1", enabled=False, models=["x"], default_model="x").model_dump(), headers=H)
    h = _health(client, refresh=False)
    assert h["off"]["state"] == "unknown"
    h = _health(client)
    assert h["off"]["state"] == "unknown" and h["fake"]["state"] == "ok"


def test_turns_update_health(client):
    """A turn that produced an answer marks its provider ok; one that died on a transport error marks it down."""
    conv = client.post("/api/conversations", json={}, headers=H).json()
    FakeProvider.script = [[{"type": "text_delta", "text": "hello"}, {"type": "done", "finish_reason": "stop"}]]
    with client.stream("POST", "/api/chat", json={"conversation_id": conv["id"], "text": "hi"}, headers=H) as r:
        read_sse(r)
    assert _health(client, refresh=False)["fake"]["state"] == "ok"
    FakeProvider.script = [[{"type": "error", "message": "ConnectError: All connection attempts failed"}]] * 4
    with client.stream("POST", "/api/chat", json={"conversation_id": conv["id"], "text": "again"}, headers=H) as r:
        events = read_sse(r)
    assert any(e["type"] == "error" for e in events)
    h = _health(client, refresh=False)["fake"]
    assert h["state"] == "down" and "ConnectError" in h["error"]
    # the next good answer clears it again
    FakeProvider.script = [[{"type": "text_delta", "text": "back"}, {"type": "done", "finish_reason": "stop"}]]
    with client.stream("POST", "/api/chat", json={"conversation_id": conv["id"], "text": "once more"}, headers=H) as r:
        read_sse(r)
    assert _health(client, refresh=False)["fake"]["state"] == "ok"
