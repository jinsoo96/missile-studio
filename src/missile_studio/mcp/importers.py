"""Import MCP server definitions from other clients' config files.

Supported sources
-----------------
claude-code     ~/.claude.json            {"mcpServers": {...}, "projects": {path: {"mcpServers": {...}}}}
claude-desktop  claude_desktop_config.json {"mcpServers": {...}}
cursor          ~/.cursor/mcp.json        {"mcpServers": {...}}
vscode          .vscode/mcp.json / settings {"servers": {...}}
cherry          Cherry Studio exported JSON {"mcpServers": {...}}
list form       {"mcpServers": [{name, transport, command, args, env, url, headers, enabled}, ...]}
windsurf        ~/.codeium/windsurf/mcp_config.json
file            any JSON with one of the shapes above

The standard shape is {"name": {"command", "args", "env"}} or {"name": {"url", "headers", "type"}}.
"""

from __future__ import annotations

import json
import os
import platform
from pathlib import Path
from typing import Any, Optional

from ..config import McpServerConfig


def _appdata() -> Path:
    if os.name == "nt":
        return Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    if platform.system() == "Darwin":
        return Path.home() / "Library" / "Application Support"
    return Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))


def known_sources() -> dict[str, list[Path]]:
    home = Path.home()
    appdata = _appdata()
    return {
        "claude-code": [home / ".claude.json"],
        "claude-desktop": [appdata / "Claude" / "claude_desktop_config.json"],
        "cursor": [home / ".cursor" / "mcp.json"],
        "windsurf": [home / ".codeium" / "windsurf" / "mcp_config.json"],
        "vscode": [appdata / "Code" / "User" / "mcp.json", Path.cwd() / ".vscode" / "mcp.json"],
        "cherry": [appdata / "CherryStudio" / "mcp.json"],
    }


def _entry_to_config(entry: dict[str, Any]) -> Optional[McpServerConfig]:
    if not isinstance(entry, dict):
        return None
    typ = str(entry.get("type") or entry.get("transport") or "").lower()
    url = entry.get("url") or entry.get("baseUrl") or ""
    command = entry.get("command") or ""
    args = entry.get("args") or []
    if isinstance(command, str) and command and not args and " " in command and not Path(command).exists():
        # some clients store "npx -y pkg" in command with no args
        parts = command.split()
        command, args = parts[0], parts[1:]
    env = entry.get("env") or {}
    headers = entry.get("headers") or {}
    enabled = not bool(entry.get("disabled")) and entry.get("enabled", True) is not False and entry.get("isActive", True) is not False
    if url and (not command or "http" in typ or typ == "sse"):
        transport = "sse" if typ == "sse" else "http"
        return McpServerConfig(transport=transport, url=str(url), headers={k: str(v) for k, v in headers.items()}, enabled=enabled, description=str(entry.get("description") or ""))
    if command:
        return McpServerConfig(
            transport="stdio",
            command=str(command),
            args=[str(a) for a in args],
            env={k: str(v) for k, v in env.items()},
            cwd=str(entry.get("cwd") or ""),
            enabled=enabled,
            description=str(entry.get("description") or ""),
        )
    return None


def parse_servers(data: Any) -> dict[str, McpServerConfig]:
    """Accept any of the known container shapes and return name -> config."""
    out: dict[str, McpServerConfig] = {}
    if isinstance(data, dict):
        container = None
        for key in ("mcpServers", "servers", "mcp_servers"):
            if key in data:
                container = data[key]
                break
        if isinstance(data.get("projects"), dict) and (container is None or isinstance(container, dict)):
            # claude-code ~/.claude.json: global mcpServers + per-project mcpServers
            merged: dict[str, Any] = dict(container or {})
            for proj, pdata in data["projects"].items():
                if not isinstance(pdata, dict):
                    continue
                for name, entry in (pdata.get("mcpServers") or {}).items():
                    key = name if name not in merged else f"{name}@{Path(proj).name}"
                    merged.setdefault(key, entry)
            container = merged
        if container is None:
            # bare map {name: entry} or single entry
            if all(isinstance(v, dict) for v in data.values()) and not ("command" in data or "url" in data):
                container = data
            elif "command" in data or "url" in data:
                container = {data.get("name", "imported"): data}
        if isinstance(container, dict):
            for name, entry in container.items():
                cfg = _entry_to_config(entry)
                if cfg:
                    out[str(name)] = cfg
        elif isinstance(container, list):  # list form
            for entry in container:
                cfg = _entry_to_config(entry)
                if cfg and entry.get("name"):
                    out[str(entry["name"])] = cfg
    elif isinstance(data, list):
        for entry in data:
            cfg = _entry_to_config(entry)
            if cfg and isinstance(entry, dict) and entry.get("name"):
                out[str(entry["name"])] = cfg
    return out


def import_from(source: str) -> tuple[dict[str, McpServerConfig], list[str]]:
    """Return (servers, files_read). ``source`` is a known name or a file path."""
    paths: list[Path]
    if source in known_sources():
        paths = known_sources()[source]
    else:
        paths = [Path(source).expanduser()]
    found: dict[str, McpServerConfig] = {}
    read: list[str] = []
    for p in paths:
        if not p.exists():
            continue
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        read.append(str(p))
        for k, v in parse_servers(data).items():
            found.setdefault(k, v)
    return found, read


def export_standard(servers: dict[str, McpServerConfig]) -> dict:
    """Export in the common {"mcpServers": {...}} shape (Claude Desktop / Cursor / Cherry compatible)."""
    out: dict[str, Any] = {}
    for name, c in servers.items():
        if c.transport == "stdio":
            e: dict[str, Any] = {"command": c.command, "args": c.args}
            if c.env:
                e["env"] = c.env
        else:
            e = {"type": "sse" if c.transport == "sse" else "http", "url": c.url}
            if c.headers:
                e["headers"] = c.headers
        if not c.enabled:
            e["disabled"] = True
        out[name] = e
    return {"mcpServers": out}
