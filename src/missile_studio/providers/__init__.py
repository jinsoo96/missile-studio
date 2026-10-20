"""Provider registry: config kind -> adapter class."""

from __future__ import annotations

from typing import Type

from ..config import ProviderConfig
from .anthropic import AnthropicProvider
from .base import BaseProvider, GenerationOptions, ProviderError
from .gemini import GeminiProvider
from .openai_compat import OpenAICompatProvider
from .agentserver import AgentServerProvider

REGISTRY: dict[str, Type[BaseProvider]] = {
    "openai": OpenAICompatProvider,
    "anthropic": AnthropicProvider,
    "gemini": GeminiProvider,
    "agentserver": AgentServerProvider,
}


def build_provider(cfg: ProviderConfig) -> BaseProvider:
    cls = REGISTRY.get(cfg.kind)
    if cls is None:
        raise ProviderError(f"unknown provider kind: {cfg.kind}")
    return cls(cfg)


__all__ = ["REGISTRY", "build_provider", "BaseProvider", "GenerationOptions", "ProviderError"]
