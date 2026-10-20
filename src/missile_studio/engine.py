"""The engine: config + store + providers + MCP + local tools + policy + agent loop.

Both the web server and the terminal UI drive this one object, so behaviour is identical
whether you click in a browser or type over SSH.

Turn events (yielded by ``run_turn``)
-------------------------------------
{"type": "text_delta", "text"}            assistant text
{"type": "thinking_delta", "text"}        model reasoning (when the provider exposes it)
{"type": "tool_call", "id", "name", "arguments"}
{"type": "approval_required", "id", "name", "arguments", "reason"}
{"type": "tool_result", "id", "name", "is_error", "text", "duration_ms", "decision"}
{"type": "remote_tool", ...}              agent-server-side tool activity
{"type": "status", ...}
{"type": "message", "message": {...}}     a message that was appended (persist it)
{"type": "usage", "input_tokens", "output_tokens"}
{"type": "done", "finish_reason", "iterations"}
{"type": "error", "message"}
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable, Optional

from .config import AssistantConfig, Config, ProviderConfig, load_config, save_config
from .mcp.manager import SEP, McpManager, ToolInfo
from .providers import BaseProvider, GenerationOptions, ProviderError, build_provider
from .store import Store
from .tools.builtin import LOCAL, LocalTools, is_dangerous_command, match_rule

log = logging.getLogger("missile.engine")

APPROVAL_TIMEOUT = 600.0


@dataclass
class ApprovalRequest:
    id: str
    conversation_id: str
    name: str
    arguments: dict
    reason: str
    future: asyncio.Future = field(repr=False)
    created_at: float = field(default_factory=time.time)

    def as_dict(self) -> dict:
        return {"id": self.id, "conversation_id": self.conversation_id, "name": self.name, "arguments": self.arguments, "reason": self.reason, "created_at": self.created_at}


class Approvals:
    """Pending human decisions for tool calls. UI resolves them; TUI resolves inline."""

    def __init__(self):
        self.pending: dict[str, ApprovalRequest] = {}
        self.prompt: Optional[Callable[[ApprovalRequest], Awaitable[str]]] = None  # TUI hook

    async def ask(self, conversation_id: str, call_id: str, name: str, arguments: dict, reason: str) -> str:
        loop = asyncio.get_running_loop()
        req = ApprovalRequest(call_id, conversation_id, name, arguments, reason, loop.create_future())
        if self.prompt is not None:
            try:
                return await self.prompt(req)
            except Exception as e:  # pragma: no cover
                log.warning("approval prompt failed: %s", e)
                return "deny"
        self.pending[call_id] = req
        try:
            return await asyncio.wait_for(req.future, timeout=APPROVAL_TIMEOUT)
        except asyncio.TimeoutError:
            return "deny"
        finally:
            self.pending.pop(call_id, None)

    def resolve(self, call_id: str, decision: str) -> bool:
        req = self.pending.get(call_id)
        if req is None or req.future.done():
            return False
        req.future.set_result(decision)
        return True


@dataclass
class TurnRequest:
    conversation_id: str
    user_text: str
    attachments: list[dict] = field(default_factory=list)  # [{"name","text"}] or image data urls
    provider_id: str = ""
    model: str = ""
    assistant_id: str = ""
    tools_override: Any = None  # None = assistant decides; "none" | list[str]
    allow_dangerous: bool = False


class Engine:
    def __init__(self, cfg: Optional[Config] = None, store: Optional[Store] = None):
        self.cfg = cfg or load_config()
        self.store = store or Store()
        self._providers: dict[str, BaseProvider] = {}
        self.mcp = McpManager(self.cfg.mcp_servers)
        bt = self.cfg.builtin_tools
        self.local = LocalTools(bt.workspace_path(), enable_shell=bt.shell, enable_fs=bt.filesystem, enable_web=bt.web)
        self.approvals = Approvals()
        self.session_allow: dict[str, set[str]] = {}  # conversation -> tool names allowed for the session
        self.active_turns: dict[str, asyncio.Task] = {}
        self._started = False

    # ------------------------------------------------------------ lifecycle
    async def start(self) -> None:
        if not self._started:
            await self.mcp.start()
            self._started = True

    async def stop(self) -> None:
        for t in list(self.active_turns.values()):
            t.cancel()
        await self.mcp.stop_all()
        for p in self._providers.values():
            await p.aclose()
        self._providers.clear()

    def reload(self) -> None:
        self.cfg = load_config()

    def save(self) -> None:
        save_config(self.cfg)

    async def apply_config(self, cfg: Config) -> None:
        self.cfg = cfg
        save_config(cfg)
        self._providers.clear()
        await self.mcp.configure(cfg.mcp_servers)
        bt = cfg.builtin_tools
        self.local = LocalTools(bt.workspace_path(), enable_shell=bt.shell, enable_fs=bt.filesystem, enable_web=bt.web)

    # ------------------------------------------------------------ providers
    def provider(self, pid: str) -> BaseProvider:
        p = self._providers.get(pid)
        if p is None:
            pc = self.cfg.provider(pid)
            if pc is None:
                raise ProviderError(f"provider '{pid}' not configured")
            p = build_provider(pc)
            self._providers[pid] = p
        return p

    def resolve_target(self, provider_id: str = "", model: str = "", assistant: Optional[AssistantConfig] = None) -> tuple[str, str]:
        pid = provider_id or (assistant.provider if assistant and assistant.provider else "") or self.cfg.default.provider
        if not pid and self.cfg.providers:
            pid = self.cfg.providers[0].id
        if not pid:
            raise ProviderError("no provider configured. Run `missile provider add` or open Settings.")
        pc = self.cfg.provider(pid)
        if pc is None:
            raise ProviderError(f"provider '{pid}' not configured")
        m = model or (assistant.model if assistant and assistant.model and (not assistant.provider or assistant.provider == pid) else "")
        if not m:
            m = self.cfg.default.model if self.cfg.default.provider == pid else ""
        if not m:
            m = pc.default_model or (pc.models[0] if pc.models else "")
        if not m:
            raise ProviderError(f"no model selected for provider '{pid}'")
        return pid, m

    async def discover_models(self, pid: str) -> list[str]:
        p = self.provider(pid)
        models = await p.list_models()
        pc = self.cfg.provider(pid)
        if pc is not None:
            pc.models = models
            if not pc.default_model and models:
                pc.default_model = models[0]
            save_config(self.cfg)
        return models

    async def test_provider(self, pc: ProviderConfig) -> dict:
        p = build_provider(pc)
        try:
            t0 = time.time()
            models = await p.list_models()
            return {"ok": True, "models": models[:200], "count": len(models), "ms": int((time.time() - t0) * 1000)}
        except Exception as e:
            return {"ok": False, "error": str(e)}
        finally:
            await p.aclose()

    # ------------------------------------------------------------ tools
    def all_tools(self) -> list[ToolInfo]:
        return self.local.infos() + self.mcp.list_tools()

    def tools_for(self, assistant: Optional[AssistantConfig], override: Any = None) -> list[ToolInfo]:
        sel = override if override is not None else (assistant.tools if assistant else "all")
        allt = self.all_tools()
        if sel == "none" or sel is False:
            return []
        if sel == "all" or sel is True or sel is None:
            return allt
        if isinstance(sel, list):
            wanted = set(sel)
            out = []
            for t in allt:
                if t.full_name in wanted or t.server in wanted or f"{t.server}{SEP}*" in wanted:
                    out.append(t)
            return out
        return allt

    def decide(self, tool: ToolInfo, arguments: dict, conversation_id: str, allow_dangerous: bool = False) -> tuple[str, str]:
        """Return (decision, reason). decision in allow|ask|block."""
        pol = self.cfg.tool_policy
        if tool.full_name in self.session_allow.get(conversation_id, set()):
            return "allow", "allowed for this conversation"
        if tool.server == LOCAL and tool.name == "run_shell":
            cmd = str(arguments.get("command", ""))
            if is_dangerous_command(cmd) and not allow_dangerous:
                return "ask", "command matches a dangerous pattern"
        rule = match_rule(tool.full_name, pol.rules) or match_rule(f"{tool.server}{SEP}*", pol.rules)
        if rule:
            return rule, f"policy rule for {tool.full_name}"
        if tool.read_only and not tool.destructive:
            return pol.read_only_default, "read-only tool"
        return pol.default, "default policy"

    async def call_tool(self, tool: ToolInfo, arguments: dict) -> dict:
        if tool.server == LOCAL:
            return await self.local.call(tool.full_name, arguments)
        return await self.mcp.call_tool(tool.full_name, arguments)

    # ------------------------------------------------------------ turn
    def _system_prompt(self, assistant: Optional[AssistantConfig], tools: list[ToolInfo]) -> str:
        parts = []
        if assistant and assistant.system_prompt:
            parts.append(assistant.system_prompt)
        env = (
            f"Environment: missile-studio on {self.local.now().split('|')[1].strip()}. "
            f"Workspace folder for local tools: {self.local.workspace}. "
            f"Current time: {self.local.now().split('|')[0].strip()}."
        )
        parts.append(env)
        if tools:
            names = ", ".join(t.full_name for t in tools[:80])
            parts.append(
                f"Tools available ({len(tools)}): {names}. Some tools require human approval before they run; "
                "if a tool result says it was denied, do not retry it, explain instead."
            )
        return "\n\n".join(parts)

    def _build_user_message(self, req: TurnRequest) -> dict:
        if not req.attachments:
            return {"role": "user", "content": req.user_text}
        parts: list[dict] = []
        text = req.user_text
        for a in req.attachments:
            if a.get("data_url"):
                parts.append({"type": "image_url", "image_url": {"url": a["data_url"]}})
            elif a.get("text") is not None:
                text += f"\n\n--- attached file: {a.get('name', 'file')} ---\n{a['text']}\n--- end of {a.get('name', 'file')} ---"
        parts.insert(0, {"type": "text", "text": text})
        return {"role": "user", "content": parts if len(parts) > 1 else text}

    async def run_turn(self, req: TurnRequest) -> AsyncIterator[dict]:
        conv = self.store.get_conversation(req.conversation_id)
        if conv is None:
            yield {"type": "error", "message": "conversation not found"}
            return
        assistant = self.cfg.assistant(req.assistant_id or conv.get("assistant_id") or self.cfg.default.assistant)
        try:
            pid, model = self.resolve_target(req.provider_id or conv.get("provider_id", ""), req.model or conv.get("model", ""), assistant)
            provider = self.provider(pid)
        except ProviderError as e:
            yield {"type": "error", "message": str(e)}
            return
        pcfg = self.cfg.provider(pid)
        self.store.update_conversation(req.conversation_id, provider_id=pid, model=model, assistant_id=assistant.id if assistant else "default")

        tools = self.tools_for(assistant, req.tools_override) if pcfg and pcfg.kind != "agentserver" else []
        llm_tools = [t.as_llm_tool() for t in tools] or None
        tool_index = {t.full_name: t for t in tools}

        history = self.store.get_messages(req.conversation_id)
        user_msg = self._build_user_message(req)
        self.store.append_message(req.conversation_id, user_msg)
        yield {"type": "message", "message": user_msg}
        if not conv.get("title"):
            self.store.update_conversation(req.conversation_id, title=req.user_text.strip().splitlines()[0][:60] if req.user_text.strip() else "New chat")

        system = self._system_prompt(assistant, tools)
        messages: list[dict] = [{"role": "system", "content": system}] + [_strip(m) for m in history] + [user_msg]
        options = GenerationOptions(
            temperature=assistant.temperature if assistant else None,
            max_tokens=assistant.max_tokens if assistant else None,
            context={"conversation_id": req.conversation_id},
        )
        if pcfg and pcfg.kind == "openai" and ":11434" in (pcfg.base_url or "") and not options.max_tokens:
            options.max_tokens = 8192  # Ollama otherwise caps output at num_predict=128
        max_iter = assistant.max_iterations if assistant else 25
        finish = "stop"
        iterations = 0
        try:
            for iterations in range(1, max_iter + 1):
                text_parts: list[str] = []
                think_parts: list[str] = []
                calls: list[dict] = []
                had_error = False
                async for ev in provider.stream(model, messages, llm_tools, options):
                    et = ev.get("type")
                    if et == "text_delta":
                        text_parts.append(ev["text"])
                        yield ev
                    elif et == "thinking_delta":
                        think_parts.append(ev["text"])
                        yield ev
                    elif et == "tool_call":
                        calls.append(ev)
                        yield ev
                    elif et == "error":
                        had_error = True
                        yield ev
                    elif et == "done":
                        finish = ev.get("finish_reason", "stop")
                    else:
                        yield ev
                assistant_msg: dict[str, Any] = {"role": "assistant", "content": "".join(text_parts)}
                if think_parts:
                    assistant_msg["thinking"] = "".join(think_parts)
                if calls:
                    assistant_msg["tool_calls"] = [{"id": c["id"], "name": c["name"], "arguments": c.get("arguments") or {}} for c in calls]
                assistant_msg["meta"] = {"provider": pid, "model": model}
                if assistant_msg["content"] or calls or think_parts:
                    self.store.append_message(req.conversation_id, assistant_msg)
                    yield {"type": "message", "message": assistant_msg}
                messages.append(_strip(assistant_msg))
                if had_error or not calls:
                    break
                # execute tool calls sequentially (deterministic, approval-friendly)
                for c in calls:
                    tool = tool_index.get(c["name"]) or self.mcp.find_tool(c["name"])
                    args = c.get("arguments") or {}
                    t0 = time.time()
                    if tool is None:
                        result = {"text": f"unknown tool {c['name']}", "is_error": True, "content": []}
                        decision = "block"
                    else:
                        decision, reason = self.decide(tool, args, req.conversation_id, req.allow_dangerous)
                        if decision == "ask":
                            yield {"type": "approval_required", "id": c["id"], "name": c["name"], "arguments": args, "reason": reason}
                            answer = await self.approvals.ask(req.conversation_id, c["id"], c["name"], args, reason)
                            if answer == "allow_session":
                                self.session_allow.setdefault(req.conversation_id, set()).add(tool.full_name)
                                decision = "allow"
                            elif answer == "allow_always":
                                self.cfg.tool_policy.rules[tool.full_name] = "allow"
                                save_config(self.cfg)
                                decision = "allow"
                            elif answer in ("allow", "once"):
                                decision = "allow"
                            else:
                                decision = "deny"
                        if decision == "allow":
                            result = await self.call_tool(tool, args)
                        elif decision == "block":
                            result = {"text": f"tool {c['name']} is blocked by policy", "is_error": True, "content": []}
                        else:
                            result = {"text": f"tool {c['name']} was denied by the user", "is_error": True, "content": []}
                    dur = int((time.time() - t0) * 1000)
                    self.store.audit(conversation_id=req.conversation_id, tool=c["name"], arguments=args, decision=decision, is_error=bool(result.get("is_error")), duration_ms=dur, result_excerpt=str(result.get("text", ""))[:2000])
                    text = str(result.get("text", ""))
                    if len(text) > 60000:
                        text = text[:50000] + f"\n... [truncated {len(text) - 50000} chars]"
                    tool_msg = {"role": "tool", "tool_call_id": c["id"], "name": c["name"], "content": text, "is_error": bool(result.get("is_error"))}
                    images = [p for p in result.get("content", []) if p.get("type") == "image"]
                    if images:
                        tool_msg["images"] = images[:4]
                    self.store.append_message(req.conversation_id, tool_msg)
                    yield {"type": "tool_result", "id": c["id"], "name": c["name"], "is_error": tool_msg["is_error"], "text": text[:4000], "duration_ms": dur, "decision": decision, "images": tool_msg.get("images", [])}
                    yield {"type": "message", "message": tool_msg}
                    messages.append(_strip(tool_msg))
                    # Gemini/Anthropic can take image tool results as a follow-up user message
                    if images:
                        messages.append({"role": "user", "content": [{"type": "text", "text": f"(image returned by {c['name']})"}] + [{"type": "image_url", "image_url": {"url": f"data:{im.get('mime_type', 'image/png')};base64,{im.get('data', '')}"}} for im in images[:2]]})
            else:
                yield {"type": "status", "event": "max_iterations", "data": {"max": max_iter}}
                finish = "max_iterations"
        except asyncio.CancelledError:
            yield {"type": "done", "finish_reason": "cancelled", "iterations": iterations}
            raise
        yield {"type": "done", "finish_reason": finish, "iterations": iterations}

    async def one_shot(self, text: str, provider_id: str = "", model: str = "", assistant_id: str = "", tools: Any = None) -> AsyncIterator[dict]:
        conv = self.store.create_conversation(title=text[:60], assistant_id=assistant_id or "default")
        async for ev in self.run_turn(TurnRequest(conversation_id=conv["id"], user_text=text, provider_id=provider_id, model=model, assistant_id=assistant_id, tools_override=tools)):
            yield ev


def _strip(m: dict) -> dict:
    """Message as sent to providers (drop ids/meta/images that providers do not accept)."""
    keep = {"role", "content", "tool_calls", "tool_call_id", "name", "is_error"}
    out = {k: v for k, v in m.items() if k in keep}
    if out.get("role") == "tool" and not isinstance(out.get("content"), str):
        out["content"] = json.dumps(out.get("content"), ensure_ascii=False)
    return out
