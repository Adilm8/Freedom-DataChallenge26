"""Провайдеры LLM по имени: openrouter | gemini | ollama (настройки — .env)."""

from __future__ import annotations

from functools import lru_cache

from ..config import settings
from .base import LLMProvider, LLMResult, ProviderError, ProviderPolicyError
from .openai_compat import OpenAICompatProvider

__all__ = ["LLMProvider", "LLMResult", "ProviderError", "ProviderPolicyError", "get_provider", "configured_models"]


@lru_cache(maxsize=None)
def get_provider(name: str | None = None) -> OpenAICompatProvider:
    name = (name or settings.llm_provider).strip().lower()
    if name == "openrouter":
        return OpenAICompatProvider(
            "openrouter",
            base_url=settings.openrouter_base_url,
            api_key=settings.openrouter_api_key,
            default_model=settings.openrouter_model,
            concurrency=settings.openrouter_concurrency,
            is_openrouter=True,
        )
    if name == "gemini":
        return OpenAICompatProvider(
            "gemini",
            base_url=settings.gemini_base_url,
            api_key=settings.gemini_api_key,
            default_model=settings.gemini_model,
            concurrency=settings.gemini_concurrency,
            allow_voice=False,  # FR-EVAL-10: реальные звонки не уходят в бесплатный тариф
            free=True,
        )
    if name == "ollama":
        return OpenAICompatProvider(
            "ollama",
            base_url=settings.ollama_base_url,
            api_key="ollama",
            default_model=settings.ollama_model,
            concurrency=1,
            free=True,
        )
    raise ProviderError(f"неизвестный провайдер «{name}»")


def configured_models() -> list[dict]:
    """Для `GET /meta/models`: какие провайдеры настроены и какая модель у каждого."""
    return [
        {"provider": "openrouter", "model": settings.openrouter_model, "paid": True},
        {"provider": "gemini", "model": settings.gemini_model, "paid": False, "voice_allowed": False},
        {"provider": "ollama", "model": settings.ollama_model, "paid": False},
    ]
