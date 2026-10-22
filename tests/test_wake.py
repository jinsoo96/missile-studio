"""Wake commands on MCP Restart (progress, remaining time, reconnect) and providers that follow an endpoint file."""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from missile_studio.config import ProviderConfig

from .test_api import H, client  # noqa: F401  (fixture)


def _wait_wake(client, name, timeout=20.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        jobs = {j["server"]: j for j in client.get("/api/wake", headers=H).json()}
        if name in jobs and jobs[name]["state"] in ("done", "failed", "cancelled"):
            return jobs[name]
        time.sleep(0.1)
    raise AssertionError("wake job did not finish")


def _set_wake(client, script: Path, extra: dict | None = None):
    cfg = client.get("/api/state", headers=H).json()
    echo = next(s for s in client.get("/api/mcp", headers=H).json() if s["name"] == "echo")
    body = {**echo["config"], "wake_command": f'"{sys.executable}" -u "{script}"', **(extra or {})}
    assert cfg  # state loads with the wake list
    r = client.post("/api/mcp", json={"name": "echo", "config": body}, headers=H)
    assert r.status_code == 200


def test_restart_runs_the_wake_command_with_progress_then_reconnects(client, tmp_path):
    script = tmp_path / "wake.py"
    script.write_text(
        "import time\n"
        "print('##progress 10 20 starting the GPU server', flush=True)\n"
        "time.sleep(0.6)\n"
        "print('a plain log line', flush=True)\n"
        "print('##progress 60 8 loading the model', flush=True)\n"
        "time.sleep(0.6)\n"
        "print('##progress 100 0 ready', flush=True)\n",
        encoding="utf-8",
    )
    _set_wake(client, script)
    r = client.post("/api/mcp/echo/restart", headers=H).json()
    assert r["ok"] and r["wake"]["state"] == "running"
    # while it runs, the reported percent / remaining seconds / stage come from the command's own progress lines
    seen = None
    for _ in range(60):
        j = next(x for x in client.get("/api/wake", headers=H).json() if x["server"] == "echo")
        if j["state"] == "running" and j["pct"] is not None:
            seen = j
            break
        time.sleep(0.05)
    assert seen and seen["eta_s"] is not None and seen["stage"]
    # pressing Restart again while it runs shows the same job instead of starting a second one
    again = client.post("/api/mcp/echo/restart", headers=H).json()["wake"]
    assert again["started_at"] == r["wake"]["started_at"]
    done = _wait_wake(client, "echo")
    assert done["state"] == "done" and done["pct"] == 100 and done["eta_s"] == 0 and done["stage"] == "ready"
    assert "a plain log line" in done["tail"]
    # the MCP server is reconnected afterwards, and the run's duration becomes the next estimate
    for _ in range(100):
        st = next(s for s in client.get("/api/mcp", headers=H).json() if s["name"] == "echo")
        if st["status"] == "connected":
            break
        time.sleep(0.1)
    assert st["status"] == "connected"
    # a command that reports its own progress keeps its own estimates: its run is not added to our history
    assert client.app.state.wake.expected("echo") is None
    assert "wake" in client.get("/api/state", headers=H).json()


def test_wake_without_progress_lines_uses_the_last_duration_and_reports_failure(client, tmp_path):
    ok = tmp_path / "ok.py"
    ok.write_text("import time\nprint('booting', flush=True)\ntime.sleep(1.3)\nprint('up', flush=True)\n", encoding="utf-8")
    _set_wake(client, ok)
    client.post("/api/mcp/echo/restart", headers=H)
    first = _wait_wake(client, "echo")
    assert first["state"] == "done" and first["tail"][-1] == "up"
    # second run: no progress lines, so remaining time and percent come from the first run's duration
    slow = tmp_path / "slow.py"
    slow.write_text("import time\nprint('working', flush=True)\ntime.sleep(1.5)\nraise SystemExit(3)\n", encoding="utf-8")
    _set_wake(client, slow)
    client.post("/api/mcp/echo/restart", headers=H)
    time.sleep(0.3)
    j = next(x for x in client.get("/api/wake", headers=H).json() if x["server"] == "echo")
    assert j["state"] == "running" and j["expected_s"] and j["eta_s"] is not None and j["pct"] is not None and j["stage"] == "working"
    failed = _wait_wake(client, "echo")
    assert failed["state"] == "failed" and failed["rc"] == 3 and failed["stage"].startswith("exit 3")


def test_wake_can_be_cancelled(client, tmp_path):
    long = tmp_path / "long.py"
    long.write_text("import time\nprint('##progress 5 600 waiting', flush=True)\ntime.sleep(60)\n", encoding="utf-8")
    _set_wake(client, long)
    client.post("/api/mcp/echo/restart", headers=H)
    time.sleep(0.5)
    assert client.post("/api/wake/echo/cancel", headers=H).json()["ok"]
    j = _wait_wake(client, "echo", timeout=30)
    assert j["state"] == "cancelled"


def test_restart_without_wake_command_just_reconnects(client):
    r = client.post("/api/mcp/echo/restart", headers=H).json()
    assert r == {"ok": True}


def test_provider_follows_its_endpoint_file(client, tmp_path):
    ep = tmp_path / "endpoint.txt"
    ep.write_text("https://pod-a-8000.example/v1|model-a|key-aaaa-1111\n", encoding="utf-8")
    client.post("/api/providers", json=ProviderConfig(id="gpu", kind="openai", label="GPU", base_url="https://old/v1", endpoint_file=str(ep), models=[], default_model="").model_dump(), headers=H)
    p = next(x for x in client.get("/api/providers", headers=H).json() if x["id"] == "gpu")
    assert p["base_url"] == "https://pod-a-8000.example/v1" and p["has_key"] and p["default_model"] == "model-a" and "model-a" in p["models"]
    eng = client.app.state.engine
    first = eng.provider("gpu")
    # the server moved (a recreated pod): the file is rewritten and the provider follows, with a fresh client
    time.sleep(0.02)
    ep.write_text("https://pod-b-8000.example/v1|model-a|key-bbbb-2222\n", encoding="utf-8")
    second = eng.provider("gpu")
    assert second is not first and eng.cfg.provider("gpu").base_url == "https://pod-b-8000.example/v1" and eng.cfg.provider("gpu").api_key == "key-bbbb-2222"
    assert eng.provider("gpu") is second  # unchanged file: same client
    st = json.dumps(client.get("/api/state", headers=H).json())
    assert "pod-b-8000" in st and "key-bbbb-2222" not in st  # the key stays masked
