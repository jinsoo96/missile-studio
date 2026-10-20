"""Hub: expose every tool missile-studio knows (local + all MCP servers) as ONE MCP server.

Why: Claude Code, Cursor, Claude Desktop or any other MCP client can then attach a single server
(`missile hub`) and get the whole catalog, with missile's policy, audit log and reconnects
in the middle. Runs over stdio (default) or Streamable HTTP (``--http --port``).

Implementation: subclass of mcp 2.x ``MCPServer`` whose ``list_tools``/``call_tool`` proxy to
the engine instead of the decorator-registered tool manager.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from .engine import Engine
from .mcp.manager import ToolInfo

log = logging.getLogger("missile.hub")


def _blocks(result: dict) -> list:
    from mcp import types

    out: list[Any] = []
    for c in result.get("content", []):
        if c.get("type") == "text":
            out.append(types.TextContent(type="text", text=c.get("text", "")))
        elif c.get("type") == "image":
            out.append(types.ImageContent(type="image", data=c.get("data", ""), mimeType=c.get("mime_type") or "image/png"))
    if not out:
        out.append(types.TextContent(type="text", text=result.get("text", "")))
    return out


def build_server(engine: Engine, include_local: bool = True, name: str = "missile-hub"):
    from mcp import types
    from mcp.server.mcpserver import MCPServer

    class HubServer(MCPServer):
        async def list_tools(self) -> list[types.Tool]:  # type: ignore[override]
            tools: list[ToolInfo] = engine.all_tools() if include_local else engine.mcp.list_tools()
            out = []
            for t in tools:
                ann = types.ToolAnnotations(readOnlyHint=t.read_only, destructiveHint=t.destructive, openWorldHint=t.open_world)
                out.append(types.Tool(name=t.full_name, description=t.description or t.full_name, inputSchema=t.input_schema or {"type": "object", "properties": {}}, annotations=ann))
            return out

        async def call_tool(self, name: str, arguments: dict, context=None):  # type: ignore[override]
            tool = next((t for t in engine.all_tools() if t.full_name == name), None)
            if tool is None:
                return types.CallToolResult(content=[types.TextContent(type="text", text=f"unknown tool {name}")], isError=True)
            decision, reason = engine.decide(tool, arguments or {}, conversation_id="hub")
            if decision == "block":
                return types.CallToolResult(content=[types.TextContent(type="text", text=f"tool {name} is blocked by missile policy")], isError=True)
            if decision == "ask" and not getattr(engine, "hub_trust", False):
                # No human sits behind the hub: 'ask' tools run only with an explicit allow rule or --trust.
                return types.CallToolResult(content=[types.TextContent(type="text", text=f"tool {name} requires approval in missile-studio ({reason}); add an allow rule or start the hub with --trust")], isError=True)
            res = await engine.call_tool(tool, arguments or {})
            engine.store.audit(conversation_id="hub", tool=name, arguments=arguments or {}, decision=decision, is_error=bool(res.get("is_error")), duration_ms=0, result_excerpt=str(res.get("text", ""))[:2000])
            return types.CallToolResult(content=_blocks(res), isError=bool(res.get("is_error")))

    return HubServer(name, instructions="All tools of a missile-studio instance (local tools + every connected MCP server).")


async def run_stdio(engine: Engine, include_local: bool = True) -> None:
    await engine.start()
    await engine.mcp.wait_ready(timeout=30.0)
    server = build_server(engine, include_local)
    try:
        await server.run_stdio_async()
    finally:
        await engine.stop()


async def run_http(engine: Engine, host: str, port: int, include_local: bool = True) -> None:
    await engine.start()
    await engine.mcp.wait_ready(timeout=30.0)
    server = build_server(engine, include_local)
    try:
        await server.run_streamable_http_async(host=host, port=port, streamable_http_path="/mcp", stateless_http=True)
    finally:
        await engine.stop()
