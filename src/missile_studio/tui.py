"""Terminal chat (for SSH sessions and quick use). Same engine as the web UI."""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any, Optional

from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel
from rich.table import Table

from .engine import ApprovalRequest, Engine, TurnRequest

console = Console(highlight=False)


async def _prompt_approval(req: ApprovalRequest) -> str:
    args = json.dumps(req.arguments, ensure_ascii=False)
    if len(args) > 600:
        args = args[:600] + "…"
    console.print(Panel(f"[bold]{req.name}[/bold]\n{args}\n[dim]{req.reason}[/dim]", title="tool approval", border_style="yellow"))
    loop = asyncio.get_running_loop()
    while True:
        try:
            ans = (await loop.run_in_executor(None, lambda: input("  [a]llow once  [s]ession  [A]lways  [d]eny > "))).strip()
        except EOFError:
            console.print("  [dim]no terminal to answer: denied[/dim]")
            return "deny"
        if ans in ("a", "y", "allow", ""):
            return "allow"
        if ans == "s":
            return "allow_session"
        if ans == "A":
            return "allow_always"
        if ans in ("d", "n", "deny"):
            return "deny"


async def stream_turn(engine: Engine, req: TurnRequest, render_markdown: bool = True, show_thinking: bool = False) -> dict:
    """Print a turn to the console. Returns summary dict."""
    text_buf: list[str] = []
    printed_any = False
    summary: dict[str, Any] = {"finish_reason": "stop", "tool_calls": 0}
    async for ev in engine.run_turn(req):
        t = ev["type"]
        if t == "text_delta":
            text_buf.append(ev["text"])
            if not render_markdown:
                sys.stdout.write(ev["text"])
                sys.stdout.flush()
            printed_any = True
        elif t == "thinking_delta" and show_thinking:
            console.print(f"[dim]{ev['text']}[/dim]", end="")
        elif t == "tool_call":
            summary["tool_calls"] += 1
            if text_buf and render_markdown:
                console.print(Markdown("".join(text_buf)))
                text_buf.clear()
            a = json.dumps(ev.get("arguments") or {}, ensure_ascii=False)
            console.print(f"[cyan]⚙ {ev['name']}[/cyan] [dim]{a[:300]}[/dim]")
        elif t == "tool_result":
            mark = "[red]✗[/red]" if ev.get("is_error") else "[green]✓[/green]"
            first = (ev.get("text") or "").strip().splitlines()
            preview = first[0][:160] if first else ""
            console.print(f"  {mark} {ev['name']} [dim]{ev.get('duration_ms', 0)}ms {ev.get('decision', '')}[/dim] {preview}")
        elif t == "remote_tool":
            console.print(f"[magenta]☁ {ev.get('event')} {ev.get('name')}[/magenta]")
        elif t == "approval_required":
            pass  # handled by the approvals prompt hook
        elif t == "error":
            console.print(f"[red]error:[/red] {ev['message']}")
            summary["error"] = ev["message"]
        elif t == "usage":
            summary["usage"] = ev
        elif t == "done":
            summary["finish_reason"] = ev.get("finish_reason")
            summary["iterations"] = ev.get("iterations")
    if text_buf:
        if render_markdown:
            console.print(Markdown("".join(text_buf)))
        else:
            sys.stdout.write("\n")
    elif not printed_any and "error" not in summary:
        console.print("[dim](no text)[/dim]")
    summary["text"] = "".join(text_buf)
    return summary


async def chat_loop(engine: Engine, provider_id: str = "", model: str = "", assistant_id: str = "", tools: Any = None, allow_dangerous: bool = False, render_markdown: bool = True) -> None:
    from prompt_toolkit import PromptSession
    from prompt_toolkit.history import FileHistory
    from prompt_toolkit.patch_stdout import patch_stdout

    from .config import home_dir

    await engine.start()
    engine.approvals.prompt = _prompt_approval
    await engine.mcp.wait_ready(timeout=15.0)
    try:
        pid, m = engine.resolve_target(provider_id, model, engine.cfg.assistant(assistant_id or engine.cfg.default.assistant))
    except Exception as e:
        console.print(f"[red]{e}[/red]")
        return
    conv = engine.store.create_conversation(assistant_id=assistant_id or engine.cfg.default.assistant, provider_id=pid, model=m)
    tools_n = len(engine.tools_for(engine.cfg.assistant(assistant_id or "default"), tools))
    mcp_ok = sum(1 for s in engine.mcp.status() if s["status"] == "connected")
    console.print(Panel(f"[bold]missile-studio[/bold]  provider [cyan]{pid}[/cyan]  model [cyan]{m}[/cyan]\n{tools_n} tools  ·  {mcp_ok}/{len(engine.mcp.servers)} MCP servers connected\n[dim]/help for commands, Ctrl-D to quit[/dim]", border_style="blue"))
    session: PromptSession = PromptSession(history=FileHistory(str(home_dir() / "chat_history.txt")))
    while True:
        try:
            with patch_stdout():
                line = await session.prompt_async("you > ")
        except (EOFError, KeyboardInterrupt):
            console.print("bye")
            break
        line = line.strip()
        if not line:
            continue
        if line.startswith("/"):
            if line in ("/q", "/quit", "/exit"):
                break
            if line == "/help":
                console.print("/new  /tools  /mcp  /model <provider> [model]  /status  /q")
                continue
            if line == "/new":
                conv = engine.store.create_conversation(assistant_id=assistant_id or "default", provider_id=pid, model=m)
                console.print("[dim]new conversation[/dim]")
                continue
            if line == "/tools":
                tb = Table("tool", "server", "ro", "destr")
                for t in engine.all_tools():
                    tb.add_row(t.full_name, t.server, "✓" if t.read_only else "", "✓" if t.destructive else "")
                console.print(tb)
                continue
            if line in ("/mcp", "/status"):
                tb = Table("server", "status", "tools", "error")
                for s in engine.mcp.status():
                    tb.add_row(s["name"], s["status"], str(s["tool_count"]), (s.get("error") or "")[:80])
                console.print(tb)
                continue
            if line.startswith("/model"):
                parts = line.split()
                if len(parts) >= 2:
                    pid = parts[1]
                    m = parts[2] if len(parts) > 2 else ""
                    try:
                        pid, m = engine.resolve_target(pid, m, None)
                        engine.store.update_conversation(conv["id"], provider_id=pid, model=m)
                        console.print(f"[dim]now {pid} / {m}[/dim]")
                    except Exception as e:
                        console.print(f"[red]{e}[/red]")
                continue
            console.print("[dim]unknown command[/dim]")
            continue
        req = TurnRequest(conversation_id=conv["id"], user_text=line, provider_id=pid, model=m, assistant_id=assistant_id, tools_override=tools, allow_dangerous=allow_dangerous)
        try:
            await stream_turn(engine, req, render_markdown=render_markdown)
        except KeyboardInterrupt:
            console.print("[dim]interrupted[/dim]")


async def ask_once(engine: Engine, text: str, provider_id: str = "", model: str = "", assistant_id: str = "", tools: Any = None, as_json: bool = False, allow_dangerous: bool = False) -> int:
    await engine.start()
    engine.approvals.prompt = _prompt_approval if sys.stdin.isatty() else None
    if engine.approvals.prompt is None:
        # non-interactive: deny anything that needs approval, fast
        async def _deny(req):
            return "deny"

        engine.approvals.prompt = _deny
    await engine.mcp.wait_ready(timeout=15.0)
    conv = engine.store.create_conversation(title=text[:60], assistant_id=assistant_id or "default")
    req = TurnRequest(conversation_id=conv["id"], user_text=text, provider_id=provider_id, model=model, assistant_id=assistant_id, tools_override=tools, allow_dangerous=allow_dangerous)
    if as_json:
        events = []
        async for ev in engine.run_turn(req):
            if ev["type"] in ("text_delta", "thinking_delta"):
                continue
            events.append(ev)
        msgs = engine.store.get_messages(conv["id"])
        final = next((m.get("content", "") for m in reversed(msgs) if m.get("role") == "assistant" and m.get("content")), "")
        print(json.dumps({"conversation_id": conv["id"], "text": final, "events": events}, ensure_ascii=False, indent=2))
        return 0
    summary = await stream_turn(engine, req, render_markdown=sys.stdout.isatty())
    return 1 if summary.get("error") else 0
