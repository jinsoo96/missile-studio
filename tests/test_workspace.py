"""Workspace drawer API: tree, read, write, delete, run; sandboxed and role-gated."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from missile_studio.config import Config, ProviderConfig
from missile_studio.engine import Engine
from missile_studio.providers import REGISTRY
from missile_studio.server.app import create_app
from missile_studio.store import Store

from .test_mcp_and_engine import FakeProvider

OWNER = {"Authorization": "Bearer owner-tok"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("MISSILE_HOME", str(tmp_path))
    REGISTRY["fake"] = FakeProvider
    cfg = Config()
    cfg.providers.append(ProviderConfig.model_construct(id="fake", kind="fake", models=["fake-1"], default_model="fake-1", enabled=True))
    cfg.ensure_defaults()
    cfg.server.token = "owner-tok"
    eng = Engine(cfg, Store(tmp_path / "t.db"))
    app = create_app(eng, token="owner-tok")
    with TestClient(app) as c:
        yield c
    REGISTRY.pop("fake", None)


def test_tree_read_write_delete(client):
    r = client.get("/api/workspace/tree", headers=OWNER).json()
    assert r["path"] == "." and r["entries"] == []
    r = client.put("/api/workspace/file", json={"path": "notes/a.md", "content": "# hi\nline"}, headers=OWNER)
    assert r.status_code == 200 and r.json()["size"] == 9
    tree = client.get("/api/workspace/tree", headers=OWNER).json()
    assert tree["entries"][0]["name"] == "notes" and tree["entries"][0]["dir"] is True
    sub = client.get("/api/workspace/tree?path=notes", headers=OWNER).json()
    assert sub["path"] == "notes" and sub["entries"][0]["path"] == "notes/a.md" and sub["entries"][0]["size"] == 9
    f = client.get("/api/workspace/file?path=notes/a.md", headers=OWNER).json()
    assert f["content"] == "# hi\nline"
    assert client.get("/api/workspace/file?path=notes/none.md", headers=OWNER).status_code == 404
    assert client.delete("/api/workspace/file?path=notes/a.md", headers=OWNER).json()["ok"]
    assert client.get("/api/workspace/tree?path=notes", headers=OWNER).json()["entries"] == []
    # events were written for the write and delete
    ev = [e["message"] for e in client.get("/api/admin/events", headers=OWNER).json()["items"]]
    assert "workspace file saved" in ev and "workspace path deleted" in ev


def test_sandbox_and_roles(client):
    assert client.get("/api/workspace/file?path=../../outside.txt", headers=OWNER).status_code == 403
    assert client.put("/api/workspace/file", json={"path": "../escape.txt", "content": "x"}, headers=OWNER).status_code == 403
    assert client.delete("/api/workspace/file?path=.", headers=OWNER).status_code == 400
    # a chat-scoped token is a studio user: the workspace folder is the admins', so no browsing, reading, writing or running
    tok = client.post("/api/admin/tokens", json={"name": "u", "scopes": "chat"}, headers=OWNER).json()["token"]
    H = {"Authorization": "Bearer " + tok}
    client.put("/api/workspace/file", json={"path": "r.txt", "content": "ro"}, headers=OWNER)
    assert client.get("/api/workspace/tree", headers=H).status_code == 403
    assert client.get("/api/workspace/file?path=r.txt", headers=H).status_code == 403
    assert client.get("/api/workspace/file?path=r.txt", headers=OWNER).json()["content"] == "ro"
    assert client.put("/api/workspace/file", json={"path": "r.txt", "content": "x"}, headers=H).status_code == 403
    assert client.post("/api/workspace/run", json={"command": "echo hi"}, headers=H).status_code == 403
    assert client.get("/api/workspace/tree").status_code == 401


def test_run_command_and_audit(client):
    r = client.post("/api/workspace/run", json={"command": "echo workspace-ok"}, headers=OWNER)
    assert r.status_code == 200 and "workspace-ok" in r.json()["output"] and "[exit 0]" in r.json()["output"]
    audit = client.get("/api/audit", headers=OWNER).json()
    assert audit[0]["tool"] == "workspace__run" and audit[0]["decision"] == "human"
    # shell disabled in settings -> refused
    client.put("/api/admin/settings", json={"changes": {"builtin_shell": False}}, headers=OWNER)
    assert client.post("/api/workspace/run", json={"command": "echo hi"}, headers=OWNER).status_code == 400


def test_conversations_report_running_flag(client):
    conv = client.post("/api/conversations", json={}, headers=OWNER).json()
    rows = client.get("/api/conversations", headers=OWNER).json()
    assert rows[0]["id"] == conv["id"] and rows[0]["running"] is False


def test_workspace_download(client):
    """Any workspace file comes back as an attachment; paths outside the sandbox and missing files are refused."""
    client.put("/api/workspace/file", json={"path": "out/report.md", "content": "# hi"}, headers=OWNER)
    r = client.get("/api/workspace/download?path=out/report.md", headers=OWNER)
    assert r.status_code == 200 and r.content == b"# hi"
    cd = r.headers["content-disposition"]
    assert "attachment" in cd and "report.md" in cd
    assert r.headers["content-type"].startswith("text/markdown")
    assert client.get("/api/workspace/download?path=../config.json", headers=OWNER).status_code == 403
    assert client.get("/api/workspace/download?path=out/nope.bin", headers=OWNER).status_code == 404
    # the owner token in the query string is enough for a plain <a download> link
    assert client.get("/api/workspace/download?path=out/report.md&token=owner-tok").status_code == 200
