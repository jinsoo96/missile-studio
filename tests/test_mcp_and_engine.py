"""MCP manager against the fixture stdio server, engine turn with a fake provider, hub proxy."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

from missile_studio.config import AssistantConfig, Config, McpServerConfig, ProviderConfig
from missile_studio.engine import Engine, TurnRequest
from missile_studio.mcp.manager import McpManager
from missile_studio.providers import REGISTRY
from missile_studio.providers.base import BaseProvider
from missile_studio.store import Store

FIXTURE = Path(__file__).parent / "fixtures" / "echo_server.py"


def echo_cfg() -> McpServerConfig:
    return McpServerConfig(transport="stdio", command=sys.executable, args=[str(FIXTURE)])


@pytest.mark.asyncio
async def test_mcp_manager_connect_call_and_errors(tmp_path, monkeypatch):
    monkeypatch.setenv("MISSILE_HOME", str(tmp_path))
    mgr = McpManager({"echo": echo_cfg(), "broken": McpServerConfig(transport="stdio", command=sys.executable, args=["-c", "import sys; sys.exit(3)"])})
    await mgr.start()
    await mgr.wait_ready(timeout=60)
    st = mgr.servers["echo"]
    assert st.status == "connected", st.error
    names = sorted(t.full_name for t in mgr.list_tools())
    assert "echo__echo" in names and "echo__shout_destructive" in names
    t = mgr.find_tool("echo__shout_destructive")
    assert t.destructive is True and t.read_only is False
    assert mgr.find_tool("echo__echo").read_only is True
    r = await mgr.call_tool("echo__add", {"a": 1, "b": 2})
    assert r["text"] == "3.0" and not r["is_error"]
    r = await mgr.call_tool("echo__fail", {})
    assert r["is_error"]  # mcp 2.x masks the exception text ("Error executing tool fail")
    r = await mgr.call_tool("echo__slow", {"seconds": 2}, timeout=0.5)
    assert r["is_error"] and "TIMEOUT" in r["text"]
    r = await mgr.call_tool("nope__x", {})
    assert r["is_error"]
    # the broken server fails without taking echo down
    assert mgr.servers["broken"].status in ("failed", "connecting")
    assert mgr.servers["echo"].status == "connected"
    # reconfigure: remove broken, keep echo (unchanged -> stays connected)
    await mgr.configure({"echo": echo_cfg()})
    assert "broken" not in mgr.servers and mgr.servers["echo"].status == "connected"
    await mgr.stop_all()
    assert mgr.servers["echo"].status == "stopped"


class FakeProvider(BaseProvider):
    """Scripted provider: first turn asks for two tools, second turn answers."""

    kind = "fake"
    script: list[list[dict]] = []
    seen: list[list[dict]] = []
    tools_seen: list[list[str]] = []  # tool names offered on each request (None -> [])
    options_seen: list = []  # generation options of each request

    async def list_models(self):
        return ["fake-1"]

    async def stream(self, model, messages, tools=None, options=None):
        FakeProvider.seen.append([dict(m) for m in messages])  # copy: the engine keeps appending to its list
        FakeProvider.tools_seen.append([t["name"] for t in (tools or [])])
        FakeProvider.options_seen.append(options)
        step = FakeProvider.script.pop(0)
        for ev in step:
            yield ev


@pytest.fixture
def engine(tmp_path, monkeypatch):
    monkeypatch.setenv("MISSILE_HOME", str(tmp_path))
    REGISTRY["fake"] = FakeProvider
    cfg = Config()
    cfg.providers.append(ProviderConfig.model_construct(id="fake", kind="fake", models=["fake-1"], default_model="fake-1"))
    cfg.mcp_servers["echo"] = echo_cfg()
    cfg.tool_policy.default = "ask"
    cfg.ensure_defaults()
    cfg.default.provider = "fake"
    cfg.default.model = "fake-1"
    eng = Engine(cfg, Store(tmp_path / "t.db"))
    yield eng
    REGISTRY.pop("fake", None)


@pytest.mark.asyncio
async def test_engine_turn_with_tools_and_approval(engine: Engine):
    await engine.start()
    await engine.mcp.wait_ready(timeout=60)
    FakeProvider.script = [
        [
            {"type": "text_delta", "text": "Let me check. "},
            {"type": "tool_call", "id": "c1", "name": "echo__add", "arguments": {"a": 2, "b": 3}},
            {"type": "tool_call", "id": "c2", "name": "echo__shout_destructive", "arguments": {"text": "x"}},
            {"type": "done", "finish_reason": "tool_calls"},
        ],
        [{"type": "text_delta", "text": "2+3=5"}, {"type": "done", "finish_reason": "stop"}],
    ]
    FakeProvider.seen = []
    conv = engine.store.create_conversation()

    async def approve(req):
        assert req.name == "echo__shout_destructive"
        return "allow_session"

    engine.approvals.prompt = approve
    events = []
    async for ev in engine.run_turn(TurnRequest(conversation_id=conv["id"], user_text="add 2 and 3")):
        events.append(ev)
    types_ = [e["type"] for e in events]
    assert "approval_required" in types_
    results = [e for e in events if e["type"] == "tool_result"]
    assert results[0]["name"] == "echo__add" and results[0]["text"] == "5.0" and results[0]["decision"] == "allow"
    assert results[1]["name"] == "echo__shout_destructive" and results[1]["text"] == "X!" and results[1]["decision"] == "allow"
    assert events[-1] == {"type": "done", "finish_reason": "stop", "iterations": 2}
    # persisted: user, assistant(tool_calls), tool, tool, assistant
    roles = [m["role"] for m in engine.store.get_messages(conv["id"])]
    assert roles == ["user", "assistant", "tool", "tool", "assistant"]
    # second provider call saw the tool results in canonical form
    second = FakeProvider.seen[1]
    assert second[0]["role"] == "system" and "Tools available" in second[0]["content"]
    assert [m["role"] for m in second[1:]] == ["user", "assistant", "tool", "tool"]
    assert second[-1]["tool_call_id"] == "c2"
    # session allow persisted for this conversation
    assert "echo__shout_destructive" in engine.session_allow[conv["id"]]
    audit = engine.store.list_audit(conversation_id=conv["id"])
    assert {a["tool"] for a in audit} == {"echo__add", "echo__shout_destructive"}
    await engine.stop()


@pytest.mark.asyncio
async def test_engine_denied_and_unknown_tool(engine: Engine):
    await engine.start()
    await engine.mcp.wait_ready(timeout=60)
    FakeProvider.script = [
        [{"type": "tool_call", "id": "c1", "name": "echo__shout_destructive", "arguments": {"text": "x"}}, {"type": "tool_call", "id": "c2", "name": "ghost__tool", "arguments": {}}, {"type": "done", "finish_reason": "tool_calls"}],
        [{"type": "text_delta", "text": "ok"}, {"type": "done", "finish_reason": "stop"}],
    ]

    async def deny(req):
        return "deny"

    engine.approvals.prompt = deny
    conv = engine.store.create_conversation()
    events = [ev async for ev in engine.run_turn(TurnRequest(conversation_id=conv["id"], user_text="go"))]
    results = {e["name"]: e for e in events if e["type"] == "tool_result"}
    assert results["echo__shout_destructive"]["decision"] == "deny" and results["echo__shout_destructive"]["is_error"]
    assert results["ghost__tool"]["decision"] == "block"
    await engine.stop()


@pytest.mark.asyncio
async def test_engine_provider_error_and_no_provider(tmp_path, monkeypatch):
    monkeypatch.setenv("MISSILE_HOME", str(tmp_path))
    cfg = Config()
    cfg.ensure_defaults()
    eng = Engine(cfg, Store(tmp_path / "t.db"))
    conv = eng.store.create_conversation()
    events = [ev async for ev in eng.run_turn(TurnRequest(conversation_id=conv["id"], user_text="hi"))]
    assert events[0]["type"] == "error" and "no provider" in events[0]["message"]
    events = [ev async for ev in eng.run_turn(TurnRequest(conversation_id="missing", user_text="hi"))]
    assert events[0]["type"] == "error"


@pytest.mark.asyncio
async def test_hub_proxies_tools(engine: Engine):
    from mcp import Client

    from missile_studio.hub import build_server

    await engine.start()
    await engine.mcp.wait_ready(timeout=60)
    engine.cfg.tool_policy.rules["echo__shout_destructive"] = "allow"
    server = build_server(engine)
    async with Client(server) as c:
        tools = await c.list_tools()
        names = {t.name for t in tools.tools}
        assert {"echo__add", "local__now", "echo__shout_destructive"} <= names
        r = await c.call_tool("echo__add", {"a": 40, "b": 2})
        assert r.content[0].text == "42.0" and not r.is_error
        r = await c.call_tool("echo__shout_destructive", {"text": "hi"})
        assert r.content[0].text == "HI!"
        r = await c.call_tool("local__write_file", {"path": "x.txt", "content": "y"})
        assert r.is_error and "requires approval" in r.content[0].text
    await engine.stop()


async def test_call_waits_for_a_reconnecting_server(tmp_path, monkeypatch):
    """A tool called while its server is reconnecting (a restarted MCP server) waits for it instead of answering
    'unknown tool'; a server that stays down gets a clear try-again message after the wait."""
    import asyncio

    monkeypatch.setenv("MISSILE_HOME", str(tmp_path))
    mgr = McpManager({"echo": echo_cfg()})
    await mgr.start()
    await mgr.wait_ready(timeout=60)
    st = mgr.servers["echo"]
    session = st.session
    st.status, st.session, st.error = "failed", None, "ping failed"
    assert mgr.find_tool("echo__echo") is None  # the catalog hides tools of a server that is not connected

    async def back():
        await asyncio.sleep(0.6)
        st.status, st.session, st.error = "connected", session, ""

    task = asyncio.create_task(back())
    r = await mgr.call_tool("echo__echo", {"text": "hi"}, reconnect_wait=5)
    await task
    assert not r["is_error"] and r["text"] == "hi"
    st.status, st.session, st.error = "failed", None, "ping failed"
    r = await mgr.call_tool("echo__echo", {"text": "hi"}, reconnect_wait=0.5)
    assert r["is_error"] and "try again" in r["text"] and "ping failed" in r["text"] and "unknown" not in r["text"]
    st.status, st.session, st.error = "connected", session, ""
    await mgr.configure({})


@pytest.mark.asyncio
async def test_poll_loop_nudged_and_forced_answer_at_max_iterations(engine: Engine):
    """A model that repeats the same tool call gets nudged, and when it still hits the tool-call limit the turn
    ends with a real answer (one forced completion) instead of a bare tool call."""
    await engine.start()
    await engine.mcp.wait_ready(timeout=60)
    engine.cfg.tool_policy.default = "allow"
    engine.cfg.assistants[0].max_iterations = 4
    poll = [{"type": "tool_call", "id": "p", "name": "echo__add", "arguments": {"a": 1, "b": 1}}, {"type": "done", "finish_reason": "tool_calls"}]
    FakeProvider.script = [list(poll) for _ in range(4)] + [[{"type": "text_delta", "text": "The job is still running; ask again in a moment."}, {"type": "done", "finish_reason": "stop"}]]
    FakeProvider.seen = []
    conv = engine.store.create_conversation()
    events = [ev async for ev in engine.run_turn(TurnRequest(conversation_id=conv["id"], user_text="is it done yet?"))]
    assert any(e["type"] == "status" and e.get("event") == "max_iterations" for e in events)
    results = [e for e in events if e["type"] == "tool_result"]
    assert len(results) == 4
    # the nudge reaches the model (in what the 4th request carried), while the stored thread stays clean
    sent4 = [m["content"] for m in FakeProvider.seen[3] if m.get("role") == "tool"]
    assert any("same arguments 3 times" in c and "job_wait" in c for c in sent4)
    tool_msgs = [m for m in engine.store.get_messages(conv["id"]) if m["role"] == "tool"]
    assert all("same arguments" not in m["content"] for m in tool_msgs)
    # the turn ends with a real assistant answer, flagged as the forced one
    msgs = engine.store.get_messages(conv["id"])
    assert msgs[-1]["role"] == "assistant" and "still running" in msgs[-1]["content"] and msgs[-1]["meta"].get("max_iterations") is True
    assert events[-1]["type"] == "done" and events[-1]["finish_reason"] == "max_iterations"
    assert "".join(e["text"] for e in events if e["type"] == "text_delta") == "The job is still running; ask again in a moment."
    await engine.stop()
