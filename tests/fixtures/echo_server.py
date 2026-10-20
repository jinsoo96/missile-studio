"""Tiny stdio MCP server used by the tests and by `missile mcp test`.

Tools: echo (read-only), add (read-only), slow (sleeps), fail (returns is_error), shout_destructive.
"""

from __future__ import annotations

import asyncio
import sys

from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations

server = MCPServer("echo-test", instructions="test server")


@server.tool(annotations=ToolAnnotations(readOnlyHint=True))
def echo(text: str) -> str:
    """Return the text unchanged."""
    return text


@server.tool(annotations=ToolAnnotations(readOnlyHint=True))
def add(a: float, b: float) -> str:
    """Add two numbers."""
    return str(a + b)


@server.tool()
async def slow(seconds: float = 1.0) -> str:
    """Sleep then return."""
    await asyncio.sleep(seconds)
    return f"slept {seconds}"


@server.tool()
def fail() -> str:
    """Always raise."""
    raise RuntimeError("boom")


@server.tool(annotations=ToolAnnotations(destructiveHint=True))
def shout_destructive(text: str) -> str:
    """Pretend to do something destructive."""
    return text.upper() + "!"


if __name__ == "__main__":
    print("echo-test server starting", file=sys.stderr, flush=True)
    server.run("stdio")
