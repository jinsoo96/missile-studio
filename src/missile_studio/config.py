"""Configuration: one JSON file under MISSILE_HOME (default ~/.missile-studio).

Layout of config.json
---------------------
server        host / port / token (token is required when host is not loopback)
providers     list of ProviderConfig (kind decides the wire protocol)
default       {"provider": <id>, "model": <name>}
mcp_servers   {name: McpServerConfig}
tool_policy   {"default": allow|ask|block, "rules": {tool_name: decision}}
assistants    list of AssistantConfig (system prompt + preferred model + tool filter)
builtin_tools {"shell": bool, "filesystem": bool, "web": bool, "workspace": path}

Secrets (API keys) live in this file too; on POSIX the file is chmod 600. Any
provider may instead name an environment variable through ``api_key_env``.
"""

from __future__ import annotations

import json
import os
import secrets
import stat
import threading
from pathlib import Path
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

ENV_HOME = "MISSILE_HOME"
DEFAULT_PORT = 7700


def home_dir() -> Path:
    raw = os.environ.get(ENV_HOME)
    p = Path(raw).expanduser() if raw else Path.home() / ".missile-studio"
    p.mkdir(parents=True, exist_ok=True)
    return p


def config_path() -> Path:
    return home_dir() / "config.json"


def db_path() -> Path:
    return home_dir() / "studio.db"


def log_dir() -> Path:
    p = home_dir() / "logs"
    p.mkdir(parents=True, exist_ok=True)
    return p


# ---------------------------------------------------------------- models

ProviderKind = Literal["openai", "anthropic", "gemini", "agentserver"]


class ProviderConfig(BaseModel):
    id: str
    kind: str = "openai"  # openai | anthropic | gemini | agentserver (REGISTRY decides; plugins may add kinds)
    label: str = ""
    base_url: str = ""
    api_key: str = ""
    api_key_env: str = ""
    models: list[str] = Field(default_factory=list)
    default_model: str = ""
    headers: dict[str, str] = Field(default_factory=dict)
    # Provider-specific request body extras, merged into every request
    # (e.g. {"chat_template_kwargs": {"enable_thinking": false}} for self-hosted Qwen on vLLM,
    #  {"enable_thinking": false} for DashScope).
    extra_body: dict[str, Any] = Field(default_factory=dict)
    enabled: bool = True
    # agentserver only: email/password login; the agent id is chosen per chat as the "model"
    email: str = ""
    password: str = ""
    allow_insecure_tls: bool = False
    context_window: int = 0  # tokens the model accepts; 0 = a sensible guess per kind (used for compaction)
    # tools described in the prompt and called with <tool_call> text blocks: for servers that reject tool
    # definitions (vLLM without a tool-call parser). Switched on automatically the first time such a server answers 400.
    tools_via_prompt: bool = False

    def context_tokens(self) -> int:
        if self.context_window:
            return self.context_window
        return {"anthropic": 200_000, "gemini": 1_000_000}.get(self.kind, 128_000)

    def resolved_api_key(self) -> str:
        if self.api_key:
            return self.api_key
        if self.api_key_env:
            return os.environ.get(self.api_key_env, "")
        return ""


class McpServerConfig(BaseModel):
    transport: Literal["stdio", "sse", "http"] = "stdio"
    command: str = ""
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    cwd: str = ""
    url: str = ""
    headers: dict[str, str] = Field(default_factory=dict)
    enabled: bool = True
    timeout: float = 60.0
    description: str = ""


Decision = Literal["allow", "ask", "block"]


class ToolPolicy(BaseModel):
    default: Decision = "ask"
    # read-only tools (annotations.readOnlyHint or builtin read tools) use this when no rule matches
    read_only_default: Decision = "allow"
    rules: dict[str, Decision] = Field(default_factory=dict)


class AssistantConfig(BaseModel):
    id: str
    name: str
    emoji: str = "🤖"
    system_prompt: str = ""
    provider: str = ""
    model: str = ""
    # "all", "none", or explicit list of tool names (namespaced: server__tool, builtin: shell__run ...)
    tools: Any = "all"
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    max_iterations: int = 25


class WebSearchConfig(BaseModel):
    """The web_search tool. duckduckgo needs no key; tavily / brave / serper need one; searxng needs a URL."""

    provider: str = "duckduckgo"  # duckduckgo | tavily | brave | serper | searxng
    api_key: str = ""
    api_key_env: str = ""
    url: str = ""  # searxng base URL

    def resolved_api_key(self) -> str:
        return self.api_key or (os.environ.get(self.api_key_env, "") if self.api_key_env else "")


class KnowledgeConfig(BaseModel):
    """Knowledge base: folders/files indexed into FTS, plus optional embeddings through an OpenAI-compatible provider."""

    sources: list[str] = Field(default_factory=list)  # absolute folders or files
    embeddings_provider: str = ""  # a provider id (openai-compatible /embeddings); empty = keyword search only
    embeddings_model: str = ""
    chunk_chars: int = 900
    top_k: int = 6
    extensions: list[str] = Field(default_factory=lambda: [".md", ".txt", ".markdown", ".rst", ".py", ".js", ".ts", ".json", ".yaml", ".yml", ".toml", ".csv", ".html", ".pdf"])


class MemoryConfig(BaseModel):
    enabled: bool = True
    recall_k: int = 5


class ToolCatalogConfig(BaseModel):
    """With many tools connected, the model is sent a one-line catalog instead of every schema and loads the
    tools it needs (local__load_tools). Keeps small-context servers usable with dozens of tools."""

    mode: str = "auto"  # auto (above the threshold) | on | off
    threshold: int = 24
    always: list[str] = Field(default_factory=list)  # tool names, server names or server__* that are always fully defined


class BuiltinTools(BaseModel):
    shell: bool = True
    filesystem: bool = True
    web: bool = True
    workspace: str = ""
    web_search: WebSearchConfig = Field(default_factory=WebSearchConfig)

    def workspace_path(self) -> Path:
        if self.workspace:
            return Path(self.workspace).expanduser()
        return home_dir() / "workspace"


class ModelPreset(BaseModel):
    """Quick picks shown at the top of the model picker (fast / think / best)."""

    id: str
    label: str
    provider: str = ""
    model: str = ""
    thinking: str = ""  # "" (provider default) | off | on | max


class StyleConfig(BaseModel):
    id: str
    name: str
    prompt: str = ""


DEFAULT_STYLES: list[dict] = [
    {"id": "normal", "name": "Normal", "prompt": ""},
    {"id": "concise", "name": "Concise", "prompt": "Answer as briefly as possible. No preamble, no recap. Prefer short sentences and lists."},
    {"id": "explanatory", "name": "Explanatory", "prompt": "Explain the reasoning and the trade-offs. Add a short example when it helps. Define terms the first time."},
    {"id": "formal", "name": "Formal", "prompt": "Use a formal, precise register suitable for documentation or a report. No jokes, no emoji."},
    {"id": "friendly", "name": "Friendly", "prompt": "Warm, conversational tone, like a helpful colleague. Keep it light but accurate."},
]


class ServerConfig(BaseModel):
    host: str = "127.0.0.1"
    port: int = DEFAULT_PORT
    token: str = ""


class DefaultSelection(BaseModel):
    provider: str = ""
    model: str = ""
    assistant: str = "default"


class Config(BaseModel):
    version: int = 1
    server: ServerConfig = Field(default_factory=ServerConfig)
    providers: list[ProviderConfig] = Field(default_factory=list)
    default: DefaultSelection = Field(default_factory=DefaultSelection)
    mcp_servers: dict[str, McpServerConfig] = Field(default_factory=dict)
    tool_policy: ToolPolicy = Field(default_factory=ToolPolicy)
    assistants: list[AssistantConfig] = Field(default_factory=list)
    builtin_tools: BuiltinTools = Field(default_factory=BuiltinTools)
    knowledge: KnowledgeConfig = Field(default_factory=KnowledgeConfig)
    memory: MemoryConfig = Field(default_factory=MemoryConfig)
    tool_catalog: ToolCatalogConfig = Field(default_factory=ToolCatalogConfig)
    presets: list[ModelPreset] = Field(default_factory=list)
    styles: list[StyleConfig] = Field(default_factory=list)

    # ---- helpers
    def provider(self, pid: str) -> Optional[ProviderConfig]:
        for p in self.providers:
            if p.id == pid:
                return p
        return None

    def assistant(self, aid: str) -> Optional[AssistantConfig]:
        for a in self.assistants:
            if a.id == aid:
                return a
        return None

    def style(self, sid: str) -> Optional[StyleConfig]:
        for st in self.styles:
            if st.id == sid:
                return st
        return None

    def effective_presets(self) -> list[ModelPreset]:
        """Configured presets, or sensible ones derived from the providers."""
        if self.presets:
            return self.presets
        if not self.providers:
            return []
        dp = self.provider(self.default.provider) or self.providers[0]
        dm = self.default.model if self.default.provider == dp.id else (dp.default_model or (dp.models[0] if dp.models else ""))
        best = next((p for p in self.providers if p.kind == "anthropic" and p.enabled), None) or dp
        bm = best.default_model or (best.models[0] if best.models else dm)
        return [
            ModelPreset(id="fast", label="Fast", provider=dp.id, model=dm, thinking="off"),
            ModelPreset(id="think", label="Think", provider=dp.id, model=dm, thinking="on"),
            ModelPreset(id="best", label="Best", provider=best.id, model=bm, thinking="max"),
        ]

    def ensure_defaults(self) -> None:
        if not self.styles:
            self.styles = [StyleConfig(**d) for d in DEFAULT_STYLES]
        if not self.assistants:
            self.assistants.append(
                AssistantConfig(
                    id="default",
                    name="General",
                    system_prompt=(
                        "You are a capable assistant inside missile-studio. Use tools when they help, "
                        "explain briefly what you did, and answer in the user's language."
                    ),
                )
            )
        if not self.default.provider and self.providers:
            self.default.provider = self.providers[0].id
            self.default.model = self.providers[0].default_model or (
                self.providers[0].models[0] if self.providers[0].models else ""
            )


# ---------------------------------------------------------------- presets

PROVIDER_PRESETS: list[dict[str, Any]] = [
    {"id": "openai", "kind": "openai", "label": "OpenAI", "base_url": "https://api.openai.com/v1", "needs_key": True, "hint": "gpt-4.1-mini"},
    {"id": "anthropic", "kind": "anthropic", "label": "Anthropic Claude", "base_url": "https://api.anthropic.com", "needs_key": True, "hint": "claude-sonnet-5-5"},
    {"id": "gemini", "kind": "gemini", "label": "Google Gemini", "base_url": "https://generativelanguage.googleapis.com", "needs_key": True, "hint": "gemini-2.5-flash"},
    {"id": "dashscope", "kind": "openai", "label": "DashScope (Qwen, intl)", "base_url": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "needs_key": True, "hint": "qwen3.8-flash", "extra_body": {"enable_thinking": False}},
    {"id": "openrouter", "kind": "openai", "label": "OpenRouter", "base_url": "https://openrouter.ai/api/v1", "needs_key": True, "hint": "openai/gpt-4.1-mini"},
    {"id": "groq", "kind": "openai", "label": "Groq", "base_url": "https://api.groq.com/openai/v1", "needs_key": True, "hint": "llama-3.3-70b-versatile"},
    {"id": "deepseek", "kind": "openai", "label": "DeepSeek", "base_url": "https://api.deepseek.com/v1", "needs_key": True, "hint": "deepseek-chat"},
    {"id": "mistral", "kind": "openai", "label": "Mistral", "base_url": "https://api.mistral.ai/v1", "needs_key": True, "hint": "mistral-large-latest"},
    {"id": "xai", "kind": "openai", "label": "xAI Grok", "base_url": "https://api.x.ai/v1", "needs_key": True, "hint": "grok-4"},
    {"id": "ollama", "kind": "openai", "label": "Ollama (local)", "base_url": "http://127.0.0.1:11434/v1", "needs_key": False, "hint": "qwen3:8b"},
    {"id": "lmstudio", "kind": "openai", "label": "LM Studio (local)", "base_url": "http://127.0.0.1:1234/v1", "needs_key": False, "hint": "(loaded model id)"},
    {"id": "vllm", "kind": "openai", "label": "vLLM (self-hosted)", "base_url": "http://127.0.0.1:8000/v1", "needs_key": False, "hint": "(served model id)", "extra_body": {"chat_template_kwargs": {"enable_thinking": False}}},
    {"id": "llamacpp", "kind": "openai", "label": "llama.cpp server", "base_url": "http://127.0.0.1:8080/v1", "needs_key": False, "hint": "(served model)"},
    {"id": "litellm", "kind": "openai", "label": "LiteLLM proxy", "base_url": "http://127.0.0.1:4000/v1", "needs_key": True, "hint": "(proxy model alias)"},
    {"id": "agentserver", "kind": "agentserver", "label": "Agent server (remote agents)", "base_url": "https://agents.example.com", "needs_key": False, "hint": "(agent id)"},
    {"id": "custom", "kind": "openai", "label": "OpenAI-compatible (custom)", "base_url": "", "needs_key": False, "hint": ""},
]


# ---------------------------------------------------------------- load / save

_lock = threading.Lock()


def load_config(path: Optional[Path] = None) -> Config:
    p = path or config_path()
    if not p.exists():
        cfg = Config()
        cfg.ensure_defaults()
        return cfg
    with p.open("r", encoding="utf-8") as f:
        data = json.load(f)
    cfg = Config.model_validate(data)
    cfg.ensure_defaults()
    return cfg


def save_config(cfg: Config, path: Optional[Path] = None) -> Path:
    p = path or config_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    with _lock:
        with tmp.open("w", encoding="utf-8", newline="\n") as f:
            json.dump(cfg.model_dump(mode="json"), f, ensure_ascii=False, indent=2)
        os.replace(tmp, p)
        try:
            if os.name != "nt":
                os.chmod(p, stat.S_IRUSR | stat.S_IWUSR)
        except OSError:
            pass
    return p


def ensure_token(cfg: Config, persist: bool = True) -> str:
    """Return the API token, generating one when the server is reachable from outside."""
    env_tok = os.environ.get("MISSILE_TOKEN")
    if env_tok:
        return env_tok
    if cfg.server.token:
        return cfg.server.token
    if cfg.server.host in ("127.0.0.1", "localhost", "::1"):
        return ""
    cfg.server.token = secrets.token_urlsafe(24)
    if persist:
        save_config(cfg)
    return cfg.server.token
