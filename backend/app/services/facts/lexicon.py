"""Поиск фраз по словарям `data/config/lexicons.json` (их можно править без кода).

Формат: `{категория: {ru: [regex...], kz: [...], en: [...]}}`. Шаблоны ищутся без учёта регистра во всех
языках сразу (язык совпадения возвращается: по нему видно, на каком языке приветствие). Перед поиском
`ё` → `е` и `’` → `'` и в тексте, и в шаблоне (замены 1:1, поэтому позиции совпадают с исходным текстом).

Категория `<категория>_exclude` (тот же формат) — исключения: совпадение отбрасывается, если с ним
пересекается совпадение исключения. Так шаблон «я + Имя» не срабатывает на «я передал вопрос», а
«пока» в значении «пока не нужно» — не прощание. Шаблон с ошибкой пропускается с предупреждением в лог.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from ..config_files import load_config

log = logging.getLogger(__name__)

_TRANS = str.maketrans({"ё": "е", "Ё": "Е", "’": "'", "‘": "'", "ʼ": "'", " ": " "})
_compiled_cache: dict[int, dict[str, dict[str, list[re.Pattern]]]] = {}


@dataclass(frozen=True)
class LexMatch:
    category: str
    lang: str
    start: int
    end: int
    text: str  # фрагмент исходного текста


def norm(text: str) -> str:
    return (text or "").translate(_TRANS)


def _compiled() -> dict[str, dict[str, list[re.Pattern]]]:
    raw = load_config("lexicons")
    key = id(raw)  # load_config кэширован; после config_files.reload() словарь новый — перекомпилируем
    if key not in _compiled_cache:
        _compiled_cache.clear()
        out: dict[str, dict[str, list[re.Pattern]]] = {}
        for cat, langs in raw.items():
            if not isinstance(langs, dict):
                continue
            out[cat] = {}
            for lang, pats in langs.items():
                lst = []
                for p in pats or []:
                    try:
                        lst.append(re.compile(norm(p), re.IGNORECASE))
                    except re.error as e:
                        log.warning("lexicons: шаблон %s.%s %r пропущен: %s", cat, lang, p, e)
                out[cat][lang] = lst
        _compiled_cache[key] = out
    return _compiled_cache[key]


def categories() -> list[str]:
    return [c for c in _compiled() if not c.endswith("_exclude")]


def find(category: str, text: str) -> list[LexMatch]:
    """Все совпадения категории в тексте (по позиции), без пересечений с исключениями."""
    comp = _compiled()
    t = norm(text)
    if not t.strip():
        return []
    excl = [(m.start(), m.end()) for pats in (comp.get(f"{category}_exclude") or {}).values() for p in pats for m in p.finditer(t)]
    found: list[LexMatch] = []
    for lang, pats in (comp.get(category) or {}).items():
        for p in pats:
            for m in p.finditer(t):
                s, e = m.start(), m.end()
                if e <= s or any(xs < e and s < xe for xs, xe in excl):
                    continue
                found.append(LexMatch(category, lang, s, e, text[s:e]))
    found.sort(key=lambda x: (x.start, -(x.end - x.start)))
    # из пересекающихся совпадений оставляем первое (самое длинное на этой позиции)
    out: list[LexMatch] = []
    for x in found:
        if out and x.start < out[-1].end:
            continue
        out.append(x)
    return out


def first(category: str, text: str) -> LexMatch | None:
    hits = find(category, text)
    return hits[0] if hits else None
