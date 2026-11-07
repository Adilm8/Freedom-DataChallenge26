"""Интерфейс провайдера LLM (docs/architecture/llm-and-models.md §1)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


class ProviderError(RuntimeError):
    """Сетевая или протокольная ошибка вызова после всех повторов."""


class ProviderPolicyError(ProviderError):
    """Вызов запрещён политикой (например, реальный звонок в бесплатный Gemini, FR-EVAL-10)."""


@dataclass
class LLMResult:
    text: str
    parsed: dict | None
    finish_reason: str | None
    provider: str
    model: str                       # фактическая модель из ответа
    tokens_in: int = 0
    tokens_out: int = 0
    cached_tokens: int = 0
    cost_usd: float | None = None
    latency_ms: int = 0
    request: dict = field(default_factory=dict)   # фактические параметры запроса (без сообщений)
    raw: dict = field(default_factory=dict)
    attempts: int = 1

    @property
    def truncated(self) -> bool:
        return (self.finish_reason or "").lower() in {"length", "max_tokens"}

    @property
    def refused(self) -> bool:
        return (self.finish_reason or "").lower() in {"content_filter", "refusal"}


class LLMProvider(Protocol):
    name: str

    def complete(
        self,
        messages: list[dict[str, Any]],
        *,
        model: str | None = None,
        json_schema: dict | None = None,
        max_tokens: int = 2000,
        temperature: float | None = 0,
        seed: int | None = None,
        timeout_s: float = 120,
        channel: str | None = None,
    ) -> LLMResult: ...
