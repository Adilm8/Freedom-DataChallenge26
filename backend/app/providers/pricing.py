"""Цены и поддерживаемые параметры моделей OpenRouter (`GET /models`), с кешем в памяти.

Стоимость вызова берём из `usage.cost` ответа OpenRouter; эта таблица — запасной путь,
если провайдер стоимость не вернул.
"""

from __future__ import annotations

import threading
import time
from typing import Any

CACHE_TTL_S = 3600
RETRY_AFTER_FAIL_S = 120  # без сети не ходим за таблицей на каждый запрос


class Pricing:
    def __init__(self, client: Any | None) -> None:
        self._client = client
        self._lock = threading.Lock()
        self._models: dict[str, dict] = {}
        self._loaded_at = 0.0
        self._failed_at: float | None = None

    def _load(self) -> None:
        if self._client is None:
            return
        with self._lock:
            now = time.monotonic()
            if self._models and now - self._loaded_at < CACHE_TTL_S:
                return
            if self._failed_at is not None and now - self._failed_at < RETRY_AFTER_FAIL_S:
                return
            try:
                data = self._client.models.list()
                items = [m.model_dump() for m in data.data]
            except Exception:  # сеть или прокси недоступны: работаем без таблицы
                self._failed_at = now
                return
            self._failed_at = None
            self._models = {m["id"]: m for m in items if m.get("id")}
            self._loaded_at = time.monotonic()

    def model_info(self, model: str) -> dict | None:
        self._load()
        return self._models.get(model)

    def supported_parameters(self, model: str) -> set[str] | None:
        info = self.model_info(model)
        if not info or "supported_parameters" not in info:
            return None
        return set(info.get("supported_parameters") or [])

    def estimate(self, model: str, tokens_in: int, tokens_out: int) -> float | None:
        info = self.model_info(model)
        if not info:
            return None
        p = info.get("pricing") or {}
        try:
            return float(p.get("prompt") or 0) * tokens_in + float(p.get("completion") or 0) * tokens_out
        except (TypeError, ValueError):
            return None
