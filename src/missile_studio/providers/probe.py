"""Turn a pasted endpoint into the (kind, base_url) pairs worth trying.

People paste whatever their server's docs show: a bare host (http://localhost:11434), a base that already ends in
/v1, or a full request URL (…/v1/chat/completions, …/v1/messages, …/v1beta/models). The provider adapters want the
base they append their own paths to, so known request paths are cut off and, for OpenAI-compatible servers, a bare
host is tried with /v1 first. Without an explicit kind, the host decides (Anthropic and Gemini have their own APIs,
everything else is tried as OpenAI-compatible)."""

from __future__ import annotations

import re
from urllib.parse import urlsplit

KINDS = ("openai", "anthropic", "gemini")

# request paths that follow the base URL, longest first
_TAILS = (
    "/chat/completions", "/completions", "/embeddings", "/responses", "/models",
    "/v1/messages", "/messages",
)


def _clean(url: str) -> str:
    url = (url or "").strip().strip('"').strip("'")
    if url and "://" not in url:
        url = ("http://" if re.match(r"^(localhost|127\.|\[::1\]|10\.|192\.168\.|host\.docker\.internal)", url) else "https://") + url
    url = url.split("?", 1)[0].split("#", 1)[0].rstrip("/")
    changed = True
    while changed:
        changed = False
        for tail in _TAILS:
            if url.lower().endswith(tail):
                url = url[: -len(tail)].rstrip("/")
                changed = True
    return url


def guess_kind(url: str) -> str:
    host = urlsplit(_clean(url)).netloc.lower()
    if "anthropic" in host:
        return "anthropic"
    if "generativelanguage.googleapis.com" in host:
        return "gemini"
    return "openai"


def candidates(url: str, kind: str = "") -> list[tuple[str, str]]:
    """(kind, base_url) pairs to test, most likely first."""
    base = _clean(url)
    if not base:
        return []
    kind = kind if kind in KINDS else guess_kind(base)
    if kind == "anthropic":
        # the adapter appends /v1/…
        return [("anthropic", re.sub(r"/v1$", "", base))]
    if kind == "gemini":
        return [("gemini", re.sub(r"/v1(beta)?(/models.*)?$", "", base))]
    if re.search(r"/v\d+[a-z]*(/|$)", urlsplit(base).path):  # already versioned (…/v1, …/api/v1, …/openai/v1)
        return [("openai", base)]
    # a bare host or a path without a version: most servers (Ollama, LM Studio, vLLM, llama.cpp) answer under /v1
    return [("openai", base + "/v1"), ("openai", base)]
