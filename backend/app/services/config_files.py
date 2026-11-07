"""Загрузка словарей и настроек из data/config/*.json (их можно править без кода)."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from ..config import ROOT

CONFIG_DIR = ROOT / "data" / "config"


@lru_cache(maxsize=None)
def load_config(name: str) -> dict:
    """`name` без расширения: `system_events`, `lexicons`. Ключи, начинающиеся с `_`, — комментарии."""
    path: Path = CONFIG_DIR / f"{name}.json"
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return {k: v for k, v in data.items() if not k.startswith("_")}


def reload() -> None:
    load_config.cache_clear()
