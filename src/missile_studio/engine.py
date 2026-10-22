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
import re
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable, Optional

from .config import AssistantConfig, Config, ProviderConfig, load_config, save_config
from .mcp.manager import SEP, McpManager, ToolInfo
from .providers import BaseProvider, GenerationOptions, ProviderError, build_provider
from .providers.base import _json_loads_lenient
from .knowledge import Knowledge
from .store import Store, _message_text
from .tools.builtin import LOCAL, LocalTools, is_dangerous_command, match_rule

log = logging.getLogger("missile.engine")

APPROVAL_TIMEOUT = 600.0
MAX_RETRIES = 3  # provider request attempts while nothing has been streamed yet (429, 5xx, connection errors)
PARALLEL_TOOLS = 4  # tool calls of one assistant turn that may run at the same time
COMPACT_KEEP_TAIL = 8  # messages kept verbatim when the rest of a long thread is summarised
_RETRYABLE = re.compile(r"(\b429\b|\b5\d\d\b|rate.?limit|overloaded|timeout|timed out|connection|ConnectError|ReadError|RemoteProtocolError|temporarily|ECONNRESET)", re.I)
_FATAL = re.compile(r"\b(400|401|402|403|404|413|422)\b")


def _retryable(msg: str) -> bool:
    return bool(_RETRYABLE.search(msg)) and not _FATAL.search(msg)


# ---------------------------------------------------------------- tools through the prompt (servers without a tool parser)
TOOL_CALL_OPEN, TOOL_CALL_CLOSE = "<tool_call>", "</tool_call>"


def _tools_prompt(tools: list) -> str:
    lines = []
    for t in tools[:80]:
        schema = json.dumps(t.input_schema or {"type": "object", "properties": {}}, ensure_ascii=False)
        lines.append(f"- {t.full_name}: {(t.description or '').strip()[:300]} | arguments: {schema[:900]}")
    return (
        "This model server cannot take tool definitions, so tools are called through text. Available tools:\n"
        + "\n".join(lines)
        + "\n\nTo call a tool, output exactly this block and nothing after it:\n"
        + TOOL_CALL_OPEN + '\n{"name": "<tool name>", "arguments": {<arguments as JSON>}}\n' + TOOL_CALL_CLOSE
        + "\nThe result comes back inside a <tool_response> block; then continue. One block per call, several blocks for several calls. "
        "Call tools only when they help; otherwise answer directly."
    )


def _promptify(messages: list[dict]) -> list[dict]:
    """History as plain text for a server that knows no tool roles: calls become <tool_call> blocks in the assistant
    text, results become user messages wrapped in <tool_response>."""
    out: list[dict] = []
    for m in messages:
        r = m.get("role")
        if r == "assistant" and m.get("tool_calls"):
            text = m.get("content") if isinstance(m.get("content"), str) else _message_text(m)
            tags = "\n".join(TOOL_CALL_OPEN + "\n" + json.dumps({"name": c["name"], "arguments": c.get("arguments") or {}}, ensure_ascii=False) + "\n" + TOOL_CALL_CLOSE for c in m["tool_calls"])
            out.append({"role": "assistant", "content": (text + "\n" if text else "") + tags})
        elif r == "tool":
            out.append({"role": "user", "content": "<tool_response>\n" + json.dumps({"name": m.get("name"), "result": m.get("content"), "is_error": bool(m.get("is_error"))}, ensure_ascii=False) + "\n</tool_response>"})
        else:
            out.append({k: v for k, v in m.items() if k != "thinking_blocks"})
    return out


class ToolCallScanner:
    """Splits a streamed answer into visible text and <tool_call> blocks (Hermes / Qwen style), delta by delta."""

    def __init__(self) -> None:
        self.buf = ""
        self.calls: list[dict] = []

    def feed(self, delta: str) -> str:
        self.buf += delta
        out = ""
        while True:
            i = self.buf.find(TOOL_CALL_OPEN)
            if i < 0:
                keep = self._partial_tail(self.buf, TOOL_CALL_OPEN)
                out += self.buf[: len(self.buf) - keep]
                self.buf = self.buf[len(self.buf) - keep :]
                return out
            out += self.buf[:i]
            j = self.buf.find(TOOL_CALL_CLOSE, i)
            if j < 0:
                self.buf = self.buf[i:]  # the block is still arriving
                return out
            inner = self.buf[i + len(TOOL_CALL_OPEN) : j]
            self.buf = self.buf[j + len(TOOL_CALL_CLOSE) :]
            if not self._add(inner):
                out += inner  # not a call after all: show it

    def flush(self) -> str:
        if self.buf.startswith(TOOL_CALL_OPEN) and self._add(self.buf[len(TOOL_CALL_OPEN) :]):
            self.buf = ""
        out, self.buf = self.buf, ""
        return out

    def _add(self, inner: str) -> bool:
        obj = _json_loads_lenient(inner.strip())
        if isinstance(obj, dict) and obj.get("name"):
            args = obj.get("arguments")
            if isinstance(args, str):
                parsed = _json_loads_lenient(args)
                args = parsed if isinstance(parsed, dict) else {}
            self.calls.append({"type": "tool_call", "id": f"call_p{len(self.calls) + 1}_{uuid.uuid4().hex[:6]}", "name": str(obj["name"]), "arguments": args if isinstance(args, dict) else {}})
            return True
        return False

    @staticmethod
    def _partial_tail(s: str, tag: str) -> int:
        for k in range(min(len(s), len(tag) - 1), 0, -1):
            if tag.startswith(s[-k:]):
                return k
        return 0


def _estimate_tokens(messages: list[dict]) -> int:
    """Rough token count for budgeting (Korean and code run denser than English; 3 chars per token is a safe middle)."""
    n = 0
    for m in messages:
        c = m.get("content")
        n += len(c if isinstance(c, str) else json.dumps(c, ensure_ascii=False)) // 3 + 8
        if m.get("tool_calls"):
            n += len(json.dumps(m["tool_calls"], ensure_ascii=False)) // 3
    return n


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
    thinking: str = ""  # "" | off | on | max
    style_id: str = ""
    mode: str = ""  # "" | research (plan searches, read sources, write a cited report; more iterations)
    knowledge: bool = False  # retrieve knowledge-base excerpts for this message and put them in context


RESEARCH_PROMPT = (
    "Research mode. Work like a careful analyst: first break the question into 2-5 searchable sub-questions, "
    "run web_search for each (vary the wording, prefer recent and primary sources), open the most promising "
    "pages with fetch_url, and keep notes of what each source actually says. Then write the answer as a report: "
    "a short conclusion first, then findings with inline citations like [1], [2] pointing to a numbered "
    "Sources list at the end (title and URL). Say plainly where sources disagree or evidence is thin. "
    "Do not stop after one search."
)
SUMMARY_PROMPT = (
    "You compress conversation history for an assistant that will continue the chat. Write a dense summary that "
    "keeps: the user's goals and constraints, decisions made, facts and numbers that were established, file paths, "
    "names, open questions, and the tone the user prefers. Drop pleasantries and repeated content. Plain text, "
    "under 600 words, in the language the conversation uses."
)


def thinking_body(pcfg, model: str, level: str) -> dict:
    """Provider-specific request additions for a thinking level ("" = leave the provider default)."""
    if not level:
        return {}
    on = level != "off"
    m = (model or "").lower()
    if pcfg.kind == "anthropic":
        return {"thinking": {"type": "enabled", "budget_tokens": 16000 if level == "max" else 6000}} if on else {}
    if pcfg.kind == "gemini":
        return {"generationConfig": {"thinkingConfig": {"thinkingBudget": -1 if on else 0}}}
    if pcfg.kind == "openai":
        base = (pcfg.base_url or "").lower()
        if "dashscope" in base:
            return {"enable_thinking": on}
        if any(m.startswith(p) for p in ("o1", "o3", "o4", "gpt-5")):
            return {"reasoning_effort": "high" if level == "max" else ("medium" if on else "low")}
        if any(k in m for k in ("qwen", "glm", "deepseek", "minimax", "kimi")):
            return {"chat_template_kwargs": {"enable_thinking": on}}
    return {}


class Engine:
    def __init__(self, cfg: Optional[Config] = None, store: Optional[Store] = None):
        self.cfg = cfg or load_config()
        self.store = store or Store()
        self._providers: dict[str, BaseProvider] = {}
        self.mcp = McpManager(self.cfg.mcp_servers)
        bt = self.cfg.builtin_tools
        self.local = LocalTools(bt.workspace_path(), enable_shell=bt.shell, enable_fs=bt.filesystem, enable_web=bt.web)
        self.knowledge: Optional[Knowledge] = None
        self._register_extra_tools()
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
        self._register_extra_tools()

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

    # ------------------------------------------------------------ compaction (long threads)
    def _apply_summary(self, conv: dict, history: list[dict]) -> tuple[list[dict], str]:
        """Drop the messages a stored summary already covers, when that point lies on the current branch."""
        upto = conv.get("summary_upto")
        summary = conv.get("summary") or ""
        if summary and upto:
            idx = next((i for i, m in enumerate(history) if m.get("id") == upto), -1)
            if idx >= 0:
                return history[idx + 1 :], summary
        return history, ""

    async def _compact(self, cid: str, history: list[dict], summary: str, provider: BaseProvider, model: str) -> tuple[list[dict], str]:
        """Fold everything but the last few messages into a summary written by the same model; keep the tail verbatim."""
        if len(history) <= COMPACT_KEEP_TAIL + 2:
            return history, summary
        cut = len(history) - COMPACT_KEEP_TAIL
        while cut > 0 and history[cut].get("role") != "user":
            cut -= 1
        if cut <= 0:
            return history, summary
        old, tail = history[:cut], history[cut:]
        lines = []
        for m in old:
            body = _message_text(m) or (json.dumps(m.get("tool_calls"), ensure_ascii=False) if m.get("tool_calls") else "")
            lines.append(f"{m.get('role')}: {body[:2000]}")
        transcript = "\n".join(lines)[-60000:]
        prompt = [{"role": "system", "content": SUMMARY_PROMPT}, {"role": "user", "content": (f"Previous summary:\n{summary}\n\n" if summary else "") + "Transcript to fold in:\n" + transcript}]
        text = ""
        try:
            async for ev in provider.stream(model, prompt, None, GenerationOptions(max_tokens=1200, temperature=0.2)):
                if ev.get("type") == "text_delta":
                    text += ev["text"]
                elif ev.get("type") == "error":
                    log.warning("compaction skipped: %s", ev.get("message"))
                    return history, summary
        except Exception as e:  # keep going uncompacted rather than fail the turn
            log.warning("compaction failed: %s", e)
            return history, summary
        text = text.strip()
        if not text:
            return history, summary
        self.store.update_conversation(cid, summary=text, summary_upto=old[-1]["id"])
        return tail, text

    # ------------------------------------------------------------ extra local tools (memory, knowledge, web search config)
    def _register_extra_tools(self) -> None:
        self.local.web_search_cfg = self.cfg.builtin_tools.web_search
        self.knowledge = Knowledge(self.store, lambda: self.cfg.knowledge, self.cfg.provider)
        if self.cfg.memory.enabled:
            self.local._add("memory_save", "Remember a durable fact about the user or their work for future chats (preferences, names, decisions, ongoing projects). Writes only to the memory list, never to files.", {"type": "object", "properties": {"text": {"type": "string"}, "tags": {"type": "string", "default": ""}}, "required": ["text"]}, self._tool_memory_save, read_only=True)
            self.local._add("memory_search", "Search what has been remembered about the user in earlier chats.", {"type": "object", "properties": {"query": {"type": "string"}, "limit": {"type": "integer", "default": 8}}, "required": ["query"]}, self._tool_memory_search, read_only=True)
        self.local._add("knowledge_search", "Search the user's knowledge base (indexed folders and files). Returns the best matching excerpts with their file paths.", {"type": "object", "properties": {"query": {"type": "string"}, "k": {"type": "integer", "default": 6}}, "required": ["query"]}, self._tool_knowledge_search, read_only=True)

    def _tool_memory_save(self, text: str, tags: str = "") -> str:
        m = self.store.add_memory(text, source="tool", tags=tags)
        return f"remembered ({m['id']}): {m['text']}"

    def _tool_memory_search(self, query: str, limit: int = 8) -> str:
        rows = self.store.search_memories(query, limit) or self.store.list_memories(limit)
        return "\n".join(f"- ({r['id']}) {r['text']}" for r in rows) or "nothing remembered yet"

    async def _tool_knowledge_search(self, query: str, k: int = 6) -> str:
        if self.knowledge is None:
            return "knowledge base not available"
        hits = await self.knowledge.search(query, int(k or 6))
        if not hits:
            return f"no matches in the knowledge base for: {query}"
        return "\n\n".join(f"[{i + 1}] {h['path']} (chunk {h['idx']}, score {h['score']:.2f})\n{h['text']}" for i, h in enumerate(hits))

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
        history, summary = self._apply_summary(conv, history)
        budget = int((pcfg.context_tokens() if pcfg else 128_000) * 0.6)
        if _estimate_tokens(history) > budget:
            yield {"type": "status", "event": "compacting", "data": {"messages": len(history)}}
            history, summary = await self._compact(req.conversation_id, history, summary, provider, model)
            yield {"type": "status", "event": "compacted", "data": {"kept": len(history)}}
        user_msg = self._build_user_message(req)
        self.store.append_message(req.conversation_id, user_msg)
        yield {"type": "message", "message": user_msg}
        if not conv.get("title"):
            self.store.update_conversation(req.conversation_id, title=req.user_text.strip().splitlines()[0][:60] if req.user_text.strip() else "New chat")

        system = self._system_prompt(assistant, tools)
        style = self.cfg.style(req.style_id or conv.get("style_id") or "")
        if style and style.prompt:
            system += "\n\nWriting style: " + style.prompt
        if summary:
            system += "\n\nEarlier part of this conversation, compacted into a summary:\n" + summary
        if self.cfg.memory.enabled:
            mems = self.store.search_memories(req.user_text, self.cfg.memory.recall_k)
            if mems:
                system += "\n\nThings remembered about the user from earlier chats (use when relevant, do not recite them):\n" + "\n".join(f"- {m['text']}" for m in mems)
        if req.knowledge and self.knowledge is not None:
            hits = await self.knowledge.search(req.user_text, self.cfg.knowledge.top_k)
            if hits:
                system += "\n\nExcerpts from the user's knowledge base (cite the path when you rely on one):\n" + "\n".join(f"[{i + 1}] {h['path']} (chunk {h['idx']}):\n{h['text'][:1500]}" for i, h in enumerate(hits))
                yield {"type": "status", "event": "knowledge", "data": {"hits": [{"path": h["path"], "idx": h["idx"]} for h in hits]}}
        if req.mode == "research":
            system += "\n\n" + RESEARCH_PROMPT
        prompt_tools = bool(tools) and bool(getattr(pcfg, "tools_via_prompt", False))
        if prompt_tools:
            system += "\n\n" + _tools_prompt(tools)
            llm_tools = None
        history_msgs = [_strip(m) for m in _repair_history(history)]
        messages: list[dict] = [{"role": "system", "content": system}] + (_promptify(history_msgs) if prompt_tools else history_msgs) + [user_msg]
        options = GenerationOptions(
            temperature=assistant.temperature if assistant else None,
            max_tokens=assistant.max_tokens if assistant else None,
            context={"conversation_id": req.conversation_id},
        )
        if pcfg and pcfg.kind == "openai" and ":11434" in (pcfg.base_url or "") and not options.max_tokens:
            options.max_tokens = 8192  # Ollama otherwise caps output at num_predict=128
        if pcfg and req.thinking:
            extra = thinking_body(pcfg, model, req.thinking)
            options.extra_body.update(extra)
            if pcfg.kind == "anthropic" and "thinking" in extra:
                budget = extra["thinking"]["budget_tokens"]
                options.max_tokens = max(options.max_tokens or 0, budget + 4000)
                options.temperature = None  # the API requires the default temperature with thinking on
        max_iter = assistant.max_iterations if assistant else 25
        if req.mode == "research":
            max_iter = max(max_iter, 40)
        finish = "stop"
        iterations = 0
        pending: dict[str, dict] = {}  # tool calls of the current assistant message that have no result yet
        try:
            for iterations in range(1, max_iter + 1):
                text_parts: list[str] = []
                think_parts: list[str] = []
                think_blocks: list[dict] = []
                calls: list[dict] = []
                had_error = False
                error_text = ""
                usage: Optional[dict] = None
                t_iter = time.time()
                attempt = 0
                while True:  # the request is retried while nothing has been produced yet (429, 5xx, connection errors)
                    attempt += 1
                    produced = False
                    retry_wait = 0.0
                    switch_prompt = False
                    scanner = ToolCallScanner() if prompt_tools else None
                    async for ev in provider.stream(model, messages, llm_tools, options):
                        et = ev.get("type")
                        if et == "text_delta":
                            produced = True
                            if scanner is not None:
                                shown = scanner.feed(ev["text"])
                                if shown:
                                    text_parts.append(shown)
                                    yield {"type": "text_delta", "text": shown}
                                while len(scanner.calls) > len(calls):
                                    c = scanner.calls[len(calls)]
                                    calls.append(c)
                                    yield c
                                continue
                            text_parts.append(ev["text"])
                            yield ev
                        elif et == "status" and ev.get("event") == "tools_unsupported" and tools and not prompt_tools:
                            switch_prompt = True  # the server refused tool definitions: describe them in the prompt instead
                            break
                        elif et == "thinking_delta":
                            produced = True
                            think_parts.append(ev["text"])
                            yield ev
                        elif et == "thinking_block":
                            think_blocks.append(ev.get("block") or {})
                        elif et == "tool_call":
                            produced = True
                            calls.append(ev)
                            yield ev
                        elif et == "error":
                            msg = str(ev.get("message", ""))[:600]
                            if not produced and attempt < MAX_RETRIES and _retryable(msg):
                                retry_wait = min(8.0, 1.5 ** attempt)
                                error_text = msg
                                break
                            had_error = True
                            error_text = msg
                            yield ev
                        elif et == "done":
                            finish = ev.get("finish_reason", "stop")
                        elif et == "usage":
                            usage = {k: v for k, v in ev.items() if k != "type"}
                            yield ev
                        else:
                            yield ev
                    if switch_prompt:
                        prompt_tools = True
                        if pcfg is not None:
                            pcfg.tools_via_prompt = True  # remembered: next turns go straight to prompt mode
                            save_config(self.cfg)
                        llm_tools = None
                        messages = [{"role": "system", "content": messages[0]["content"] + "\n\n" + _tools_prompt(tools)}] + _promptify(messages[1:])
                        yield {"type": "status", "event": "tools_via_prompt", "data": {"provider": pid}}
                        attempt -= 1
                        continue
                    if scanner is not None:
                        tail = scanner.flush()
                        if tail:
                            text_parts.append(tail)
                            yield {"type": "text_delta", "text": tail}
                        while len(scanner.calls) > len(calls):
                            c = scanner.calls[len(calls)]
                            calls.append(c)
                            yield c
                        if calls and not had_error:
                            finish = "tool_calls"
                    if retry_wait:
                        yield {"type": "status", "event": "retry", "data": {"attempt": attempt, "wait": retry_wait, "reason": error_text[:200]}}
                        await asyncio.sleep(retry_wait)
                        continue
                    break
                assistant_msg: dict[str, Any] = {"role": "assistant", "content": "".join(text_parts)}
                if think_parts:
                    assistant_msg["thinking"] = "".join(think_parts)
                if think_blocks:
                    assistant_msg["thinking_blocks"] = think_blocks
                if calls:
                    assistant_msg["tool_calls"] = [{"id": c["id"], "name": c["name"], "arguments": c.get("arguments") or {}} for c in calls]
                assistant_msg["meta"] = {"provider": pid, "model": model, "duration_ms": int((time.time() - t_iter) * 1000)}
                if usage:
                    assistant_msg["meta"]["usage"] = usage
                if had_error:
                    assistant_msg["meta"]["error"] = True
                    assistant_msg["meta"]["error_text"] = error_text or "the model returned an error"
                if assistant_msg["content"] or calls or think_parts or had_error:
                    # a turn that failed before any text is stored too, so the error stays visible after a reload
                    # (an empty assistant message is dropped from provider history by _repair_history)
                    self.store.append_message(req.conversation_id, assistant_msg)
                    yield {"type": "message", "message": assistant_msg}
                messages.append(_promptify([_strip(assistant_msg)])[0] if prompt_tools else _strip(assistant_msg))
                pending = {c["id"]: c for c in calls}
                if had_error or not calls:
                    # a stream that failed after announcing tool calls: close them, or the next turn's history is invalid
                    for tm in self._close_pending(req.conversation_id, pending, "skipped: the model stream ended with an error before this tool ran"):
                        yield {"type": "tool_result", "id": tm["tool_call_id"], "name": tm["name"], "is_error": True, "text": tm["content"], "duration_ms": 0, "decision": "cancelled", "images": []}
                        yield {"type": "message", "message": tm}
                    break
                # decide every call first (approvals are interactive, so they stay sequential), then run the allowed
                # ones concurrently and hand results back as they finish
                plan: list[tuple[dict, Any, str]] = []
                for c in calls:
                    tool = tool_index.get(c["name"]) or self.mcp.find_tool(c["name"])
                    args = c.get("arguments") or {}
                    if tool is None:
                        plan.append((c, None, "block"))
                        continue
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
                    plan.append((c, tool, decision))

                async def run_one(c: dict, tool: Any, decision: str) -> tuple[dict, str, dict, int]:
                    t0 = time.time()
                    if tool is None:
                        result = {"text": f"unknown tool {c['name']}", "is_error": True, "content": []}
                    elif decision == "allow":
                        try:
                            result = await self.call_tool(tool, c.get("arguments") or {})
                        except asyncio.CancelledError:
                            raise
                        except Exception as e:
                            result = {"text": f"{type(e).__name__}: {e}", "is_error": True, "content": []}
                    elif decision == "block":
                        result = {"text": f"tool {c['name']} is blocked by policy", "is_error": True, "content": []}
                    else:
                        result = {"text": f"tool {c['name']} was denied by the user", "is_error": True, "content": []}
                    return c, decision, result, int((time.time() - t0) * 1000)

                sem = asyncio.Semaphore(PARALLEL_TOOLS)

                async def guarded(c: dict, tool: Any, decision: str) -> tuple[dict, str, dict, int]:
                    async with sem:
                        return await run_one(c, tool, decision)

                tool_tasks: list[asyncio.Task] = [asyncio.create_task(guarded(*p)) for p in plan] if len(plan) > 1 else []
                try:
                    completed: Any = asyncio.as_completed(tool_tasks) if tool_tasks else [await run_one(*plan[0])] if plan else []
                    for item in completed:
                        c, decision, result, dur = item if isinstance(item, tuple) else await item
                        args = c.get("arguments") or {}
                        self.store.audit(conversation_id=req.conversation_id, tool=c["name"], arguments=args, decision=decision, is_error=bool(result.get("is_error")), duration_ms=dur, result_excerpt=str(result.get("text", ""))[:2000])
                        text = str(result.get("text", ""))
                        if len(text) > 60000:
                            text = text[:50000] + f"\n... [truncated {len(text) - 50000} chars]"
                        tool_msg = {"role": "tool", "tool_call_id": c["id"], "name": c["name"], "content": text, "is_error": bool(result.get("is_error")), "decision": decision, "duration_ms": dur}
                        images = [p for p in result.get("content", []) if p.get("type") == "image"]
                        if images:
                            tool_msg["images"] = images[:4]
                        self.store.append_message(req.conversation_id, tool_msg)
                        pending.pop(c["id"], None)
                        yield {"type": "tool_result", "id": c["id"], "name": c["name"], "is_error": tool_msg["is_error"], "text": text[:4000], "duration_ms": dur, "decision": decision, "images": tool_msg.get("images", [])}
                        yield {"type": "message", "message": tool_msg}
                        messages.append(_promptify([_strip(tool_msg)])[0] if prompt_tools else _strip(tool_msg))
                        # Gemini/Anthropic can take image tool results as a follow-up user message
                        if images:
                            messages.append({"role": "user", "content": [{"type": "text", "text": f"(image returned by {c['name']})"}] + [{"type": "image_url", "image_url": {"url": f"data:{im.get('mime_type', 'image/png')};base64,{im.get('data', '')}"}} for im in images[:2]]})
                except asyncio.CancelledError:
                    for t in tool_tasks:
                        t.cancel()
                    raise
            else:
                yield {"type": "status", "event": "max_iterations", "data": {"max": max_iter}}
                finish = "max_iterations"
        except asyncio.CancelledError:
            # Stop pressed (or the client went away) while tools were still running: every call without a result
            # gets a terminal "cancelled" one, so the UI stops showing it as running and the thread stays valid.
            for tm in self._close_pending(req.conversation_id, pending, "stopped: the turn was cancelled before this tool finished"):
                yield {"type": "tool_result", "id": tm["tool_call_id"], "name": tm["name"], "is_error": True, "text": tm["content"], "duration_ms": 0, "decision": "cancelled", "images": []}
            yield {"type": "done", "finish_reason": "cancelled", "iterations": iterations}
            raise
        finally:
            # also covers a generator closed from outside (GeneratorExit) and unexpected exceptions; no-op when nothing is pending
            self._close_pending(req.conversation_id, pending, "stopped: the turn ended before this tool finished")
        yield {"type": "done", "finish_reason": finish, "iterations": iterations}

    def _close_pending(self, cid: str, pending: dict[str, dict], reason: str) -> list[dict]:
        """Persist a terminal tool message for each call that never got a result (and audit it). Clears ``pending``."""
        out: list[dict] = []
        for call_id, c in list(pending.items()):
            tool_msg = {"role": "tool", "tool_call_id": call_id, "name": c["name"], "content": reason, "is_error": True, "decision": "cancelled", "duration_ms": 0}
            self.store.append_message(cid, tool_msg)
            self.store.audit(conversation_id=cid, tool=c["name"], arguments=c.get("arguments") or {}, decision="cancelled", is_error=True, duration_ms=0, result_excerpt=reason)
            out.append(tool_msg)
        pending.clear()
        return out

    async def one_shot(self, text: str, provider_id: str = "", model: str = "", assistant_id: str = "", tools: Any = None) -> AsyncIterator[dict]:
        conv = self.store.create_conversation(title=text[:60], assistant_id=assistant_id or "default")
        async for ev in self.run_turn(TurnRequest(conversation_id=conv["id"], user_text=text, provider_id=provider_id, model=model, assistant_id=assistant_id, tools_override=tools)):
            yield ev


def _repair_history(history: list[dict]) -> list[dict]:
    """Threads written before 0.4.4 may hold assistant tool_calls that never got a tool message (a stopped turn).
    Providers reject such a history, so each orphan call gets a terminal result right after its assistant message."""
    out: list[dict] = []
    i = 0
    while i < len(history):
        m = history[i]
        i += 1
        if m.get("role") == "assistant" and not m.get("content") and not m.get("tool_calls"):
            continue  # a failed turn with no text: providers reject empty assistant content
        out.append(m)
        if m.get("role") == "assistant" and m.get("tool_calls"):
            answered: set = set()
            while i < len(history) and history[i].get("role") == "tool":
                answered.add(history[i].get("tool_call_id"))
                out.append(history[i])
                i += 1
            for c in m["tool_calls"]:
                if c.get("id") not in answered:
                    out.append({"role": "tool", "tool_call_id": c.get("id"), "name": c.get("name", "tool"), "content": "no result: the turn was stopped before this tool finished", "is_error": True})
    return out


def _strip(m: dict) -> dict:
    """Message as sent to providers (drop ids/meta/decision/images that providers do not accept)."""
    keep = {"role", "content", "tool_calls", "tool_call_id", "name", "is_error", "thinking_blocks"}
    out = {k: v for k, v in m.items() if k in keep}
    if out.get("role") == "tool" and not isinstance(out.get("content"), str):
        out["content"] = json.dumps(out.get("content"), ensure_ascii=False)
    return out
