"""Command line: serve / chat / ask / provider / mcp / assistant / policy / hub / bridge / doctor."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shlex
import sys
from typing import Any, Optional

from . import __version__
from .config import PROVIDER_PRESETS, AssistantConfig, McpServerConfig, ProviderConfig, config_path, home_dir, load_config, save_config


def _p(*a, **k):
    try:
        print(*a, **k, flush=True)
    except BrokenPipeError:  # `missile ... | head` closed the pipe; nothing left to say
        raise SystemExit(0)


def _engine():
    from .engine import Engine

    return Engine()


# ---------------------------------------------------------------- serve / chat / ask

def cmd_serve(args) -> int:
    from .server.app import run_server

    cfg = load_config()
    host = args.host or os.environ.get("MISSILE_HOST") or cfg.server.host
    port = args.port or int(os.environ.get("MISSILE_PORT") or cfg.server.port)
    run_server(host, port, token=args.token or "", open_browser=args.open, log_level=args.log_level)
    return 0


def cmd_chat(args) -> int:
    from .tui import chat_loop

    tools: Any = None
    if args.no_tools:
        tools = "none"
    elif args.tools:
        tools = [t.strip() for t in args.tools.split(",") if t.strip()]
    engine = _engine()
    try:
        asyncio.run(chat_loop(engine, args.provider or "", args.model or "", args.assistant or "", tools, args.allow_dangerous, render_markdown=not args.raw))
    finally:
        asyncio.run(engine.stop()) if False else None
    return 0


def cmd_ask(args) -> int:
    from .tui import ask_once

    text = " ".join(args.text) if args.text else sys.stdin.read()
    tools: Any = None
    if args.no_tools:
        tools = "none"
    elif args.tools:
        tools = [t.strip() for t in args.tools.split(",") if t.strip()]
    engine = _engine()

    async def run():
        try:
            return await ask_once(engine, text, args.provider or "", args.model or "", args.assistant or "", tools, as_json=args.json, allow_dangerous=args.allow_dangerous,
                                  conversation_id=args.conversation or "")
        finally:
            await engine.stop()

    return asyncio.run(run())


# ---------------------------------------------------------------- provider

def cmd_provider(args) -> int:
    cfg = load_config()
    sub = {"ls": "list", "rm": "remove"}.get(args.provider_cmd, args.provider_cmd)
    if sub == "list":
        if not cfg.providers:
            _p("no providers. try: missile provider add --preset openai --api-key sk-...")
            return 0
        for p in cfg.providers:
            star = "*" if cfg.default.provider == p.id else " "
            key = "key" if p.resolved_api_key() else ("env:" + p.api_key_env if p.api_key_env else "-")
            _p(f"{star} {p.id:<14} {p.kind:<9} {p.base_url:<58} {key:<10} default={p.default_model or '-'} models={len(p.models)}")
        return 0
    if sub == "presets":
        for pr in PROVIDER_PRESETS:
            _p(f"{pr['id']:<12} {pr['kind']:<9} {pr['base_url']:<60} {pr.get('hint', '')}")
        return 0
    if sub == "add":
        preset = next((x for x in PROVIDER_PRESETS if x["id"] == (args.preset or "")), None)
        pid = args.id or (preset["id"] if preset else None)
        if not pid:
            _p("need --id or --preset")
            return 2
        pc = cfg.provider(pid) or ProviderConfig(id=pid)
        if preset:
            pc.kind = preset["kind"]
            pc.label = pc.label or preset["label"]
            pc.base_url = pc.base_url or preset["base_url"]
            if preset.get("extra_body") and not pc.extra_body:
                pc.extra_body = dict(preset["extra_body"])
        if args.kind:
            pc.kind = args.kind
        if args.base_url:
            pc.base_url = args.base_url
        if args.api_key:
            pc.api_key = args.api_key
        if args.api_key_env:
            pc.api_key_env = args.api_key_env
        if args.label:
            pc.label = args.label
        if args.model:
            pc.default_model = args.model
            if args.model not in pc.models:
                pc.models.append(args.model)
        if args.email:
            pc.email = args.email
        if args.password:
            pc.password = args.password
        if args.header:
            for h in args.header:
                k, _, v = h.partition("=")
                pc.headers[k.strip()] = v.strip()
        if args.extra_body:
            pc.extra_body.update(json.loads(args.extra_body))
        if cfg.provider(pid) is None:
            cfg.providers.append(pc)
        if not cfg.default.provider or args.default:
            cfg.default.provider = pid
            cfg.default.model = pc.default_model
        save_config(cfg)
        _p(f"saved provider {pid} ({pc.kind}) -> {config_path()}")
        if args.discover or not pc.models:
            return _discover(pid)
        return 0
    if sub == "remove":
        cfg.providers = [p for p in cfg.providers if p.id != args.id]
        if cfg.default.provider == args.id:
            cfg.default.provider = cfg.providers[0].id if cfg.providers else ""
        save_config(cfg)
        _p("removed")
        return 0
    if sub == "models":
        return _discover(args.id)
    if sub == "test":
        from .engine import Engine

        engine = Engine(cfg)
        pc = cfg.provider(args.id)
        if pc is None:
            _p("no such provider")
            return 2
        res = asyncio.run(engine.test_provider(pc))
        _p(json.dumps(res, ensure_ascii=False, indent=2)[:4000])
        return 0 if res.get("ok") else 1
    if sub == "default":
        if cfg.provider(args.id) is None:
            _p("no such provider")
            return 2
        cfg.default.provider = args.id
        if args.model:
            cfg.default.model = args.model
            pc = cfg.provider(args.id)
            if pc and args.model not in pc.models:
                pc.models.append(args.model)
            if pc and not pc.default_model:
                pc.default_model = args.model
        else:
            pc = cfg.provider(args.id)
            cfg.default.model = pc.default_model if pc else ""
        save_config(cfg)
        _p(f"default -> {cfg.default.provider} / {cfg.default.model}")
        return 0
    return 2


def _discover(pid: str) -> int:
    from .engine import Engine

    engine = Engine()

    async def run():
        try:
            models = await engine.discover_models(pid)
            _p(f"{len(models)} models:")
            for m in models[:200]:
                _p("  " + m)
            if len(models) > 200:
                _p(f"  ... {len(models) - 200} more")
            return 0
        except Exception as e:
            _p(f"discover failed: {e}")
            return 1
        finally:
            await engine.stop()

    return asyncio.run(run())


# ---------------------------------------------------------------- mcp

def cmd_mcp(args) -> int:
    cfg = load_config()
    sub = {"ls": "list", "rm": "remove"}.get(args.mcp_cmd, args.mcp_cmd)
    if sub == "list":
        if not cfg.mcp_servers:
            _p("no MCP servers. try: missile mcp import claude-code   or   missile mcp add fs -- npx -y @modelcontextprotocol/server-filesystem .")
            return 0
        for name, c in cfg.mcp_servers.items():
            target = c.url if c.transport != "stdio" else " ".join([c.command] + c.args)
            _p(f"{'on ' if c.enabled else 'off'} {name:<20} {c.transport:<6} {target}")
        return 0
    if sub == "add":
        if args.url:
            c = McpServerConfig(transport=args.transport if args.transport != "stdio" else "http", url=args.url, headers=dict(h.split("=", 1) for h in (args.header or [])))
        else:
            argv = list(args.command or [])
            if not argv:
                _p("need a command after -- or --url")
                return 2
            env = dict(e.split("=", 1) for e in (args.env or []))
            c = McpServerConfig(transport="stdio", command=argv[0], args=argv[1:], env=env, cwd=args.cwd or "")
        cfg.mcp_servers[args.name] = c
        save_config(cfg)
        _p(f"saved MCP server {args.name}")
        if args.test:
            return _mcp_test(args.name)
        return 0
    if sub == "remove":
        cfg.mcp_servers.pop(args.name, None)
        save_config(cfg)
        _p("removed")
        return 0
    if sub in ("enable", "disable"):
        c = cfg.mcp_servers.get(args.name)
        if not c:
            _p("no such server")
            return 2
        c.enabled = sub == "enable"
        save_config(cfg)
        _p(f"{args.name} {'enabled' if c.enabled else 'disabled'}")
        return 0
    if sub == "import":
        from .mcp.importers import import_from, known_sources

        if args.source == "list":
            for name, paths in known_sources().items():
                found, files = import_from(name)
                _p(f"{name:<15} {'found' if files else '-':<6} {len(found)} servers  {', '.join(str(p) for p in paths)}")
            return 0
        found, files = import_from(args.source)
        if not files:
            _p(f"nothing readable for {args.source}")
            return 1
        n = 0
        for name, c in found.items():
            if args.names and name not in args.names:
                continue
            cfg.mcp_servers[name] = c
            n += 1
            _p(f"+ {name:<20} {c.transport:<6} {c.url or ' '.join([c.command] + c.args)}")
        save_config(cfg)
        _p(f"imported {n} servers from {', '.join(files)}")
        return 0
    if sub == "export":
        from .mcp.importers import export_standard

        _p(json.dumps(export_standard(cfg.mcp_servers), ensure_ascii=False, indent=2))
        return 0
    if sub == "test":
        return _mcp_test(args.name)
    if sub == "tools":
        return _mcp_tools()
    return 2


def _mcp_test(name: str) -> int:
    from .mcp.manager import McpManager

    cfg = load_config()
    c = cfg.mcp_servers.get(name)
    if c is None:
        _p("no such server")
        return 2

    async def run():
        mgr = McpManager({name: c.model_copy(update={"enabled": True})})
        await mgr.start()
        await mgr.wait_ready(timeout=60.0)
        st = mgr.servers[name]
        if st.status == "connected":
            _p(f"{name}: connected, {len(st.tools)} tools {st.server_info}")
            for t in st.tools:
                _p(f"  - {t.name}: {(t.description or '')[:90]}")
            rc = 0
        else:
            _p(f"{name}: {st.status} {st.error}")
            _p(f"  log: {home_dir() / 'logs' / ('mcp-' + name + '.log')}")
            rc = 1
        await mgr.stop_all()
        return rc

    return asyncio.run(run())


def _mcp_tools() -> int:
    engine = _engine()

    async def run():
        await engine.start()
        await engine.mcp.wait_ready(timeout=60.0)
        for t in engine.all_tools():
            flags = ("ro " if t.read_only else "   ") + ("destr" if t.destructive else "")
            _p(f"{t.full_name:<48} {flags:<9} {(t.description or '')[:70]}")
        await engine.stop()
        return 0

    return asyncio.run(run())


# ---------------------------------------------------------------- assistant / policy

def cmd_assistant(args) -> int:
    cfg = load_config()
    args.assistant_cmd = {"ls": "list", "rm": "remove"}.get(args.assistant_cmd, args.assistant_cmd)
    if args.assistant_cmd == "list":
        for a in cfg.assistants:
            star = "*" if cfg.default.assistant == a.id else " "
            _p(f"{star} {a.id:<14} {a.name:<20} {a.provider or '-'}/{a.model or '-'} tools={a.tools if isinstance(a.tools, str) else len(a.tools)}")
        return 0
    if args.assistant_cmd == "add":
        a = cfg.assistant(args.id) or AssistantConfig(id=args.id, name=args.name or args.id)
        if args.name:
            a.name = args.name
        if args.system is not None:
            a.system_prompt = args.system
        if args.system_file:
            a.system_prompt = open(args.system_file, encoding="utf-8").read()
        if args.provider:
            a.provider = args.provider
        if args.model:
            a.model = args.model
        if args.tools:
            a.tools = "all" if args.tools == "all" else ("none" if args.tools == "none" else [t.strip() for t in args.tools.split(",")])
        if cfg.assistant(args.id) is None:
            cfg.assistants.append(a)
        save_config(cfg)
        _p(f"saved assistant {a.id}")
        return 0
    if args.assistant_cmd == "remove":
        cfg.assistants = [a for a in cfg.assistants if a.id != args.id]
        save_config(cfg)
        return 0
    return 2


def cmd_policy(args) -> int:
    cfg = load_config()
    if args.policy_cmd == "show":
        _p(json.dumps(cfg.tool_policy.model_dump(), indent=2))
        return 0
    if args.policy_cmd == "set":
        if args.tool == "default":
            cfg.tool_policy.default = args.decision
        elif args.tool == "read-only":
            cfg.tool_policy.read_only_default = args.decision
        else:
            cfg.tool_policy.rules[args.tool] = args.decision
        save_config(cfg)
        _p("ok")
        return 0
    if args.policy_cmd == "unset":
        cfg.tool_policy.rules.pop(args.tool, None)
        save_config(cfg)
        return 0
    return 2


# ---------------------------------------------------------------- hub / bridge / doctor

def cmd_hub(args) -> int:
    from . import hub

    engine = _engine()
    engine.hub_trust = args.trust  # type: ignore[attr-defined]
    try:
        if args.http:
            asyncio.run(hub.run_http(engine, args.host, args.port, include_local=not args.no_local))
        else:
            asyncio.run(hub.run_stdio(engine, include_local=not args.no_local))
    except KeyboardInterrupt:
        pass
    return 0


def cmd_bridge(args) -> int:
    from .device_bridge import DeviceBridge

    engine = _engine()

    async def run():
        await engine.start()
        await engine.mcp.wait_ready(timeout=30.0)
        b = DeviceBridge(engine, args.provider, device_name=args.device_name or "", trust=args.trust)
        b.start()
        _p(f"bridge started for provider {args.provider} as device '{b.device_name}' ({len(engine.all_tools())} tools). Ctrl-C to stop.")
        last = ""
        try:
            while True:
                await asyncio.sleep(2)
                s = f"{b.status} tools={b.tool_count} calls={b.calls} {b.error}"
                if s != last:
                    _p(s)
                    last = s
        except (KeyboardInterrupt, asyncio.CancelledError):
            pass
        finally:
            await b.stop()
            await engine.stop()

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
    return 0


def cmd_doctor(args) -> int:
    from .engine import Engine

    cfg = load_config()
    _p(f"missile-studio {__version__}  python {sys.version.split()[0]}  home {home_dir()}")
    _p(f"config {config_path()} ({'exists' if config_path().exists() else 'not created yet'})")
    engine = Engine(cfg)

    async def run():
        rc = 0
        _p("\nproviders:")
        for p in cfg.providers:
            res = await engine.test_provider(p)
            if res.get("ok"):
                _p(f"  ok   {p.id:<14} {res['count']} models in {res['ms']}ms")
            else:
                rc = 1
                _p(f"  FAIL {p.id:<14} {res.get('error', '')[:160]}")
        if not cfg.providers:
            _p("  (none)")
        _p("\nmcp servers:")
        await engine.start()
        await engine.mcp.wait_ready(timeout=60.0)
        for s in engine.mcp.status():
            if s["status"] == "connected":
                _p(f"  ok   {s['name']:<20} {s['tool_count']} tools")
            elif s["status"] == "disabled":
                _p(f"  off  {s['name']}")
            else:
                rc = 1
                _p(f"  FAIL {s['name']:<20} {s['status']} {s.get('error', '')[:160]}")
        if not cfg.mcp_servers:
            _p("  (none)")
        _p(f"\nlocal tools: {len(engine.local.infos())}  workspace: {engine.local.workspace}")
        _p(f"default: {cfg.default.provider or '-'} / {cfg.default.model or '-'}  assistant: {cfg.default.assistant}")
        await engine.stop()
        return rc

    return asyncio.run(run())


def cmd_admin(args) -> int:
    import secrets as _secrets

    from .server.admin import hash_password
    from .store import Store

    store = Store()
    sub = args.admin_cmd
    if sub == "list":
        rows = store.list_admins()
        if not rows:
            _p("no admin users yet (one is created on first `ms serve`)")
        for u in rows:
            _p(f"{u['username']:<16} created={u['created_at']:.0f} last_login={u['last_login_at'] or '-'} {'(generated password, must change)' if u['must_change_password'] else ''}")
        return 0
    if sub in ("reset-password", "add"):
        pw = args.password or _secrets.token_urlsafe(12)
        store.upsert_admin(args.username, hash_password(pw), must_change=not args.password)
        store.event("info", "auth", f"admin password {'set' if args.password else 'reset'} from CLI", {"username": args.username}, actor="cli")
        _p(f"user: {args.username}")
        if not args.password:
            _p(f"password: {pw}")
            _p("sign in at /admin and change it.")
        return 0
    if sub == "remove":
        ok = store.delete_admin(args.username)
        _p("removed" if ok else "no such user")
        return 0 if ok else 1
    if sub == "tokens":
        for t in store.list_tokens():
            _p(f"{t['id']:<18} {t['name']:<20} {t['scopes']:<6} {'revoked' if t['revoked_at'] else 'active'}")
        return 0
    if sub == "token":
        plain = "msl_" + _secrets.token_urlsafe(24)
        t = store.create_token(args.name, plain, "admin" if args.admin else "chat", "cli")
        _p(f"{t['id']} ({t['scopes']}): {plain}")
        return 0
    if sub == "revoke":
        _p("revoked" if store.revoke_token(args.id) else "no such token")
        return 0
    return 2


def cmd_config(args) -> int:
    if args.config_cmd == "path":
        _p(str(config_path()))
        return 0
    if args.config_cmd == "show":
        cfg = load_config()
        d = cfg.model_dump()
        for p in d["providers"]:
            if p.get("api_key"):
                p["api_key"] = "***"
            if p.get("password"):
                p["password"] = "***"
        _p(json.dumps(d, ensure_ascii=False, indent=2))
        return 0
    if args.config_cmd == "set-workspace":
        cfg = load_config()
        cfg.builtin_tools.workspace = args.path
        save_config(cfg)
        _p(f"workspace -> {cfg.builtin_tools.workspace_path()}")
        return 0
    if args.config_cmd == "set-token":
        cfg = load_config()
        cfg.server.token = args.token
        save_config(cfg)
        _p("token saved")
        return 0
    return 2


# ---------------------------------------------------------------- parser

def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="missile", description="missile-studio: your own LLM + MCP + agent studio (alias: ms)")
    ap.add_argument("--version", action="version", version=f"missile-studio {__version__}")
    sp = ap.add_subparsers(dest="cmd")

    s = sp.add_parser("serve", aliases=["s", "up"], help="start the web UI / API server")
    s.add_argument("--host", default=None, help="bind address (default 127.0.0.1; use 0.0.0.0 for LAN/Tailscale)")
    s.add_argument("--port", type=int, default=None)
    s.add_argument("--token", default="", help="API token (auto-generated when host is not loopback)")
    s.add_argument("--open", action="store_true", help="open the browser")
    s.add_argument("--log-level", default="info")
    s.set_defaults(fn=cmd_serve)

    c = sp.add_parser("chat", aliases=["c"], help="terminal chat (works over SSH)")
    c.add_argument("--provider", "-p")
    c.add_argument("--model", "-m")
    c.add_argument("--assistant", "-a")
    c.add_argument("--tools", help="comma list of tool names / servers, or omit for assistant default")
    c.add_argument("--no-tools", action="store_true")
    c.add_argument("--allow-dangerous", action="store_true")
    c.add_argument("--raw", action="store_true", help="stream raw text instead of rendering markdown")
    c.set_defaults(fn=cmd_chat)

    a = sp.add_parser("ask", aliases=["a", "q"], help="one-shot question (stdin or args); --json for scripts")
    a.add_argument("text", nargs="*")
    a.add_argument("--provider", "-p")
    a.add_argument("--model", "-m")
    a.add_argument("--assistant", "-a")
    a.add_argument("--tools")
    a.add_argument("--no-tools", action="store_true")
    a.add_argument("--json", action="store_true")
    a.add_argument("--allow-dangerous", action="store_true")
    a.add_argument("--conversation", "-c", help="continue this conversation id (from an earlier --json answer)")
    a.set_defaults(fn=cmd_ask)

    pv = sp.add_parser("provider", aliases=["p", "providers"], help="manage model providers")
    pvs = pv.add_subparsers(dest="provider_cmd")
    pvs.add_parser("list", aliases=["ls"])
    pvs.add_parser("presets")
    add = pvs.add_parser("add")
    add.add_argument("--id")
    add.add_argument("--preset", help="one of: " + ", ".join(p["id"] for p in PROVIDER_PRESETS))
    add.add_argument("--kind", choices=["openai", "anthropic", "gemini", "agentserver"])
    add.add_argument("--base-url")
    add.add_argument("--api-key")
    add.add_argument("--api-key-env")
    add.add_argument("--label")
    add.add_argument("--model", help="default model")
    add.add_argument("--email", help="agent server login email")
    add.add_argument("--password", help="agent server login password")
    add.add_argument("--header", action="append", help="extra header K=V")
    add.add_argument("--extra-body", help="JSON merged into every request")
    add.add_argument("--default", action="store_true")
    add.add_argument("--discover", action="store_true", help="list models after saving")
    rm = pvs.add_parser("remove", aliases=["rm"])
    rm.add_argument("id")
    mo = pvs.add_parser("models")
    mo.add_argument("id")
    te = pvs.add_parser("test")
    te.add_argument("id")
    de = pvs.add_parser("default")
    de.add_argument("id")
    de.add_argument("model", nargs="?")
    pv.set_defaults(fn=cmd_provider)

    mc = sp.add_parser("mcp", aliases=["m"], help="manage MCP servers")
    mcs = mc.add_subparsers(dest="mcp_cmd")
    mcs.add_parser("list", aliases=["ls"])
    madd = mcs.add_parser("add", help="missile mcp add <name> -- <command> [args]  |  --url http://...")
    madd.add_argument("name")
    madd.add_argument("--url")
    madd.add_argument("--transport", default="stdio", choices=["stdio", "http", "sse"])
    madd.add_argument("--env", action="append", help="K=V (stdio)")
    madd.add_argument("--header", action="append", help="K=V (http/sse)")
    madd.add_argument("--cwd")
    madd.add_argument("--test", action="store_true")
    madd.add_argument("command", nargs=argparse.REMAINDER)
    mrm = mcs.add_parser("remove", aliases=["rm"])
    mrm.add_argument("name")
    men = mcs.add_parser("enable")
    men.add_argument("name")
    mdi = mcs.add_parser("disable")
    mdi.add_argument("name")
    mim = mcs.add_parser("import", help="import from claude-code|claude-desktop|cursor|vscode|windsurf|cherry|<file.json>|list")
    mim.add_argument("source")
    mim.add_argument("names", nargs="*")
    mcs.add_parser("export")
    mte = mcs.add_parser("test")
    mte.add_argument("name")
    mcs.add_parser("tools")
    mc.set_defaults(fn=cmd_mcp)

    asst = sp.add_parser("assistant", aliases=["as", "assistants"], help="manage assistants (system prompt presets)")
    assts = asst.add_subparsers(dest="assistant_cmd")
    assts.add_parser("list", aliases=["ls"])
    aadd = assts.add_parser("add")
    aadd.add_argument("id")
    aadd.add_argument("--name")
    aadd.add_argument("--system")
    aadd.add_argument("--system-file")
    aadd.add_argument("--provider")
    aadd.add_argument("--model")
    aadd.add_argument("--tools", help="all | none | comma list")
    arm = assts.add_parser("remove", aliases=["rm"])
    arm.add_argument("id")
    asst.set_defaults(fn=cmd_assistant)

    po = sp.add_parser("policy", aliases=["pol"], help="tool approval policy")
    pos = po.add_subparsers(dest="policy_cmd")
    pos.add_parser("show")
    pset = pos.add_parser("set")
    pset.add_argument("tool", help="tool name, server__*, 'default' or 'read-only'")
    pset.add_argument("decision", choices=["allow", "ask", "block"])
    puns = pos.add_parser("unset")
    puns.add_argument("tool")
    po.set_defaults(fn=cmd_policy)

    h = sp.add_parser("hub", aliases=["h"], help="expose all tools as one MCP server (stdio by default)")
    h.add_argument("--http", action="store_true")
    h.add_argument("--host", default="127.0.0.1")
    h.add_argument("--port", type=int, default=7701)
    h.add_argument("--trust", action="store_true", help="run 'ask' tools without a human")
    h.add_argument("--no-local", action="store_true", help="only proxy MCP servers, not local shell/fs tools")
    h.set_defaults(fn=cmd_hub)

    b = sp.add_parser("bridge", aliases=["b"], help="lend this machine's tools to a remote agent server")
    b.add_argument("--provider", required=True, help="agent server provider id")
    b.add_argument("--trust", action="store_true")
    b.add_argument("--device-name")
    b.set_defaults(fn=cmd_bridge)

    d = sp.add_parser("doctor", aliases=["dr", "check"], help="check providers, MCP servers and config")
    d.set_defaults(fn=cmd_doctor)

    ad = sp.add_parser("admin", help="admin console users and API tokens")
    ads = ad.add_subparsers(dest="admin_cmd")
    ads.add_parser("list")
    arp = ads.add_parser("reset-password", help="set a new (or generated) password for an admin user")
    arp.add_argument("username", nargs="?", default="admin")
    arp.add_argument("--password")
    aad = ads.add_parser("add")
    aad.add_argument("username")
    aad.add_argument("--password")
    arm2 = ads.add_parser("remove")
    arm2.add_argument("username")
    ads.add_parser("tokens")
    atk = ads.add_parser("token", help="create an API token")
    atk.add_argument("name")
    atk.add_argument("--admin", action="store_true", help="admin scope instead of chat")
    arv = ads.add_parser("revoke")
    arv.add_argument("id")
    ad.set_defaults(fn=cmd_admin)

    cf = sp.add_parser("config", aliases=["cfg"], help="config file helpers")
    cfs = cf.add_subparsers(dest="config_cmd")
    cfs.add_parser("path")
    cfs.add_parser("show")
    sw = cfs.add_parser("set-workspace")
    sw.add_argument("path")
    stt = cfs.add_parser("set-token")
    stt.add_argument("token")
    cf.set_defaults(fn=cmd_config)
    return ap


def main(argv: Optional[list[str]] = None) -> int:
    if os.name == "nt":
        try:
            sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
            sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        except Exception:
            pass
    ap = build_parser()
    args = ap.parse_args(argv)
    if not getattr(args, "cmd", None):
        ap.print_help()
        return 0
    fn = getattr(args, "fn", None)
    if fn is None:
        ap.parse_args([args.cmd, "--help"])
        return 2
    try:
        return int(fn(args) or 0)
    except KeyboardInterrupt:
        return 130
