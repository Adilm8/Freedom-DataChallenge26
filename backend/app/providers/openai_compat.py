"""Один провайдер на OpenAI-совместимом API для OpenRouter, Gemini (AI Studio) и Ollama.

- Строгий JSON: `response_format=json_schema` (strict), на OpenRouter ещё `provider.require_parameters`,
  чтобы запрос не ушёл к провайдеру без поддержки схемы. Нет поддержки — `json_object`.
- `temperature` и `seed` передаются, только если модель их принимает (`supported_parameters`).
- 429 и 5xx → повторы с паузой 2 / 4 / 8 с (максимум 3 попытки); это отдельно от ретрая валидации.
- Семафор на провайдера ограничивает параллельность.
- Бесплатный Gemini не принимает звонки (`voice call`) — FR-EVAL-10.
"""

from __future__ import annotations

import json
import threading
import time
from typing import Any, Callable

import httpx
from openai import APIConnectionError, APIStatusError, APITimeoutError, OpenAI

from .base import LLMResult, ProviderError, ProviderPolicyError
from .pricing import Pricing

RETRY_STATUS = {408, 409, 429, 500, 502, 503, 504}
BACKOFF_S = (2, 4, 8)


class OpenAICompatProvider:
    def __init__(
        self,
        name: str,
        *,
        base_url: str,
        api_key: str = "",
        default_model: str = "",
        concurrency: int = 4,
        allow_voice: bool = True,
        is_openrouter: bool = False,
        free: bool = False,
        http_client: httpx.Client | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.name = name
        self.default_model = default_model
        self.allow_voice = allow_voice
        self.is_openrouter = is_openrouter
        self.free = free
        self._sleep = sleep
        self._sem = threading.BoundedSemaphore(max(1, concurrency))
        # Ключ может быть пустым: в облачной среде его подставляет прокси. SDK требует непустую строку.
        self.client = OpenAI(base_url=base_url, api_key=api_key or "unset", max_retries=0, http_client=http_client)
        self.pricing = Pricing(self.client if is_openrouter else None)

    # ------------------------------------------------------------------ public

    def supported_parameters(self, model: str) -> set[str] | None:
        """Что модель принимает; None — неизвестно (тогда шлём параметры и смотрим на ответ)."""
        return self.pricing.supported_parameters(model) if self.is_openrouter else None

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
    ) -> LLMResult:
        if not self.allow_voice and (channel or "").strip().lower() == "voice call":
            raise ProviderPolicyError(f"{self.name}: звонки сюда не отправляются (бесплатный тариф может использовать данные)")
        model = model or self.default_model
        if not model:
            raise ProviderError(f"{self.name}: модель не задана (переменная *_MODEL в .env)")

        kwargs = self._build_request(model, json_schema, max_tokens, temperature, seed)
        if json_schema is not None and kwargs.get("response_format", {}).get("type") == "json_object":
            messages = _with_schema_hint(messages, json_schema)  # без strict-схемы модель иначе не знает форму JSON

        with self._sem:
            started = time.monotonic()
            try:
                resp, attempts = self._call_with_retries(messages, kwargs, timeout_s)
            except ProviderError as e:
                # supported_parameters у OpenRouter — объединение по всем провайдерам модели; часть моделей
                # (новые Anthropic) отвечает 400 на sampling-параметры. Один повтор без них.
                if e.status not in (400, 404, 422) or not ({"temperature", "seed"} & kwargs.keys()):
                    raise
                kwargs = {k: v for k, v in kwargs.items() if k not in ("temperature", "seed")}
                resp, attempts = self._call_with_retries(messages, kwargs, timeout_s)
                attempts += 1
            latency_ms = int((time.monotonic() - started) * 1000)
        request_meta = {k: v for k, v in kwargs.items() if k != "messages"}
        if "response_format" in request_meta:
            request_meta["response_format"] = {"type": request_meta["response_format"]["type"]}
        request_meta["messages"] = [dict(m) for m in messages]  # фактический промпт (с подсказкой схемы, если она добавлялась)

        raw = resp.model_dump()
        choice = resp.choices[0] if resp.choices else None
        text = (choice.message.content or "") if choice else ""
        finish = choice.finish_reason if choice else None
        usage = raw.get("usage") or {}
        tokens_in = int(usage.get("prompt_tokens") or 0)
        tokens_out = int(usage.get("completion_tokens") or 0)
        cached = int(((usage.get("prompt_tokens_details") or {}).get("cached_tokens")) or 0)
        actual_model = raw.get("model") or model

        cost = usage.get("cost")
        if cost is None:
            cost = 0.0 if self.free else self.pricing.estimate(actual_model, tokens_in, tokens_out)

        return LLMResult(
            text=text,
            parsed=_parse_json(text),
            finish_reason=finish,
            provider=self.name,
            model=actual_model,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            cached_tokens=cached,
            cost_usd=float(cost) if cost is not None else None,
            latency_ms=latency_ms,
            request=request_meta,
            raw=raw,
            attempts=attempts,
        )

    # ------------------------------------------------------------------ internals

    def _build_request(self, model, json_schema, max_tokens, temperature, seed) -> dict:
        supported = self.supported_parameters(model)
        kw: dict[str, Any] = {"model": model, "max_tokens": max_tokens}
        if temperature is not None and (supported is None or "temperature" in supported):
            kw["temperature"] = temperature
        if seed is not None and (supported is None or "seed" in supported):
            kw["seed"] = seed
        extra: dict[str, Any] = {}
        if json_schema is not None:
            strict_ok = supported is None or {"response_format", "structured_outputs"} & supported
            if strict_ok:
                kw["response_format"] = {
                    "type": "json_schema",
                    "json_schema": {"name": "cqa_evaluation", "strict": True, "schema": json_schema},
                }
                if self.is_openrouter:
                    extra["provider"] = {"require_parameters": True}
            else:
                kw["response_format"] = {"type": "json_object"}
        if self.is_openrouter:
            extra["usage"] = {"include": True}
        if extra:
            kw["extra_body"] = extra
        return kw

    def _call_with_retries(self, messages, kwargs, timeout_s):
        last_err: Exception | None = None
        for attempt in range(len(BACKOFF_S) + 1):
            try:
                resp = self.client.chat.completions.create(messages=messages, timeout=timeout_s, **kwargs)
                return resp, attempt + 1
            except APIStatusError as e:
                last_err = e
                if e.status_code not in RETRY_STATUS:
                    raise ProviderError(f"{self.name}: HTTP {e.status_code}: {_short(e)}", e.status_code) from e
            except (APIConnectionError, APITimeoutError) as e:
                last_err = e
            if attempt < len(BACKOFF_S):
                self._sleep(BACKOFF_S[attempt])
        raise ProviderError(f"{self.name}: не удалось после {len(BACKOFF_S) + 1} попыток: {_short(last_err)}")


def _parse_json(text: str) -> dict | None:
    t = (text or "").strip()
    if t.startswith("```"):
        t = t.strip("`")
        t = t[t.find("{"):] if "{" in t else t
    try:
        v = json.loads(t)
    except json.JSONDecodeError:
        start, end = t.find("{"), t.rfind("}")
        if start < 0 or end <= start:
            return None
        try:
            v = json.loads(t[start : end + 1])
        except json.JSONDecodeError:
            return None
    return v if isinstance(v, dict) else None


def _short(e: Exception | None) -> str:
    s = str(e) if e else "неизвестная ошибка"
    return s[:300]


def _with_schema_hint(messages: list[dict[str, Any]], schema: dict) -> list[dict[str, Any]]:
    """JSON-режим без строгой схемы: дописываем схему в последнее сообщение пользователя."""
    out = [dict(m) for m in messages]
    for m in reversed(out):
        if m.get("role") == "user" and isinstance(m.get("content"), str):
            m["content"] += ("\n\nВерни один JSON-объект строго по этой JSON-схеме (без пояснений вокруг):\n"
                             + json.dumps(schema, ensure_ascii=False))
            break
    return out
