"""Слой фактов: что код вычисляет из диалога до вызова LLM (evaluation-pipeline.md §2).

Факт — `Fact(value, msg_ids, note)`. Каждый извлекатель — функция `fn(ctx) -> dict[str, Fact]`,
зарегистрированная декоратором `@register({...имя факта: подпись...})` в модуле своей темы
(`base`, `events`, `timing`, `language`, `greeting`, `closing`, `risk_terms`, `tone`). Новый факт —
новая функция, остальной код не меняется: промпт (`render_for_prompt`), UI (`dump`) и страховки
(`boolean_facts`) берут факты из реестра. Ничего не привязано к кодам критериев.

Факты — подсказка, а не вердикт. Если оператора в диалоге нет, факты об операторе равны `None`
(«нет данных»), а не выдумываются. Ошибка одного извлекателя не роняет оценку: его факты получают
`value=None` и пометку в `note` (тесты требуют, чтобы на DEV таких пометок не было).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Callable

from pydantic import BaseModel, Field

from ...domain import ChecklistSettings, Message, NormalizedConversation

log = logging.getLogger(__name__)

EXTRACTION_ERROR = "факт не вычислен: ошибка извлечения"


class Fact(BaseModel):
    value: Any = None
    msg_ids: list[str] = Field(default_factory=list)
    note: str | None = None


@dataclass
class FactContext:
    """Диалог, настройки и уже посчитанные факты; `memo` — общий кэш производных для извлекателей."""

    conv: NormalizedConversation
    settings: ChecklistSettings
    facts: dict[str, Fact] = field(default_factory=dict)
    _cache: dict[str, Any] = field(default_factory=dict, repr=False)

    def memo(self, key: str, fn: Callable[[], Any]) -> Any:
        if key not in self._cache:
            self._cache[key] = fn()
        return self._cache[key]

    def by_role(self, role: str, *, internal: bool | None = False) -> list[Message]:
        """Реплики роли; `internal=False` — только обращённые к клиенту, `None` — все."""
        return self.memo(
            f"role:{role}:{internal}",
            lambda: [m for m in self.conv.messages if speaker(m) == role and (internal is None or m.internal == internal)],
        )

    @property
    def operator_msgs(self) -> list[Message]:
        return self.by_role("operator")

    @property
    def client_msgs(self) -> list[Message]:
        return self.by_role("client")


Extractor = Callable[[FactContext], dict[str, Fact]]

_REGISTRY: list[tuple[tuple[str, ...], Extractor]] = []
LABELS: dict[str, str] = {}
ITEM_FORMATTERS: dict[str, Callable[[dict], str]] = {}


def register(labels: dict[str, str]) -> Callable[[Extractor], Extractor]:
    """Регистрирует извлекатель; `labels` — какие факты он даёт и их подписи для промпта и UI."""

    def deco(fn: Extractor) -> Extractor:
        _REGISTRY.append((tuple(labels), fn))
        LABELS.update(labels)
        return fn

    return deco


def item_formatter(name: str) -> Callable[[Callable[[dict], str]], Callable[[dict], str]]:
    """Как показать в промпте один элемент списка-факта (например, одну долгую паузу)."""

    def deco(fn: Callable[[dict], str]) -> Callable[[dict], str]:
        ITEM_FORMATTERS[name] = fn
        return fn

    return deco


def available_facts() -> list[str]:
    """Имена всех фактов в порядке реестра (для редактора правил-страховок в UI)."""
    return [name for names, _ in _REGISTRY for name in names]


def extract(conv: NormalizedConversation, settings: ChecklistSettings | None = None) -> dict[str, Fact]:
    ctx = FactContext(conv=conv, settings=settings or ChecklistSettings())
    for names, fn in _REGISTRY:
        try:
            out = fn(ctx)
        except Exception as e:  # noqa: BLE001 — один сломанный факт не должен ронять оценку
            log.exception("facts: извлекатель %s упал на %s", fn.__name__, conv.conversation_id)
            out = {n: Fact(note=f"{EXTRACTION_ERROR} ({type(e).__name__})") for n in names}
        for n in names:
            ctx.facts[n] = out.get(n) or Fact(note=f"{EXTRACTION_ERROR} (факт не вернулся)")
    return ctx.facts


def dump(facts: dict[str, Fact]) -> dict[str, dict]:
    """JSON для БД и UI: {имя: {value, msg_ids, note}}."""
    return {k: f.model_dump() for k, f in facts.items()}


def boolean_facts(facts: dict[str, Fact]) -> dict[str, bool | None]:
    """Булевы значения для правил-страховок чек-листа (`when: ["!greeting_in_first_msg", ...]`).

    bool → как есть; `None` → `None` («нет данных», guards правило не применяют);
    список или объект → непустой ли; строка → ключ `имя=значение` (например `ended_by=client_left`).
    Числа не превращаются в булевы.
    """
    out: dict[str, bool | None] = {}
    for name, f in facts.items():
        v = f.value
        if isinstance(v, bool):
            out[name] = v
        elif v is None:
            out[name] = None
        elif isinstance(v, (list, tuple, dict)):
            out[name] = bool(v)
        elif isinstance(v, str):
            out[f"{name}={v}"] = True
    return out


# --------------------------------------------------------------------------- рендер для промпта

PROMPT_PREAMBLE = (
    "Это подсказки, которые код посчитал по транскрипту до оценки, а не вердикт. Сверяй их с репликами; "
    "если реплики говорят другое, опирайся на реплики. m<N> — номер реплики в транскрипте."
)
_MAX_TEXT = 160
_MAX_ITEMS = 12


def fmt_t(sec: float | None) -> str:
    if sec is None:
        return "?"
    s = int(round(sec))
    h, rem = divmod(s, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def _trunc(text: str, n: int = _MAX_TEXT) -> str:
    t = " ".join((text or "").split())
    return t if len(t) <= n else t[: n - 1].rstrip() + "…"


def _fmt_num(name: str, v: float) -> str:
    s = f"{v:g}"
    return f"{s} с" if name.endswith("_sec") else s


def _fmt_dict(d: dict) -> str:
    if "msg_id" in d:
        out = str(d["msg_id"])
        if d.get("t_sec") is not None:
            out += f" [{fmt_t(d['t_sec'])}]"
        if d.get("text"):
            out += f" «{_trunc(d['text'])}»"
        rest = {k: v for k, v in d.items() if k not in {"msg_id", "t_sec", "text", "timestamp"} and v not in (None, "", [])}
        if rest:
            out += " (" + ", ".join(f"{k}: {v}" for k, v in rest.items()) + ")"
        return out
    return ", ".join(f"{k}: {v}" for k, v in d.items())


def _fmt_value(name: str, v: Any) -> str:
    if isinstance(v, bool):
        return "да" if v else "нет"
    if v is None:
        return "нет данных"
    if isinstance(v, (int, float)):
        return _fmt_num(name, v)
    if isinstance(v, dict):
        return _fmt_dict(v)
    if isinstance(v, (list, tuple)):
        if not v:
            return "нет"
        fmt = ITEM_FORMATTERS.get(name)
        items = [fmt(x) if fmt and isinstance(x, dict) else (_fmt_dict(x) if isinstance(x, dict) else str(x)) for x in v]
        more = len(items) - _MAX_ITEMS
        return "; ".join(items[:_MAX_ITEMS]) + (f"; …ещё {more}" if more > 0 else "")
    return str(v)


def render_for_prompt(facts: dict[str, Fact]) -> str:
    """Компактный блок «Факты, вычисленные системой» (заголовок добавляет prompt_builder)."""
    lines = [PROMPT_PREAMBLE]
    for name, f in facts.items():
        label = LABELS.get(name, name)
        line = f"- {label} (`{name}`): {_fmt_value(name, f.value)}"
        if f.msg_ids and not isinstance(f.value, (dict, list, tuple)):
            line += " [" + ", ".join(f.msg_ids[:_MAX_ITEMS]) + "]"
        if f.note:
            line += f" — {f.note}"
        lines.append(line)
    return "\n".join(lines)


# --------------------------------------------------------------------------- общие помощники


def speaker(m: Message) -> str:
    return (m.speaker or "").strip().lower()


def msg_ref(m: Message, *, text: bool = True) -> dict:
    d: dict[str, Any] = {"msg_id": m.msg_id, "t_sec": m.t_sec, "timestamp": m.timestamp}
    if text:
        d["text"] = m.text
    return d


# Порядок импорта = порядок фактов в реестре и в промпте. Импорт в конце: модулям нужны имена выше.
from . import base, events, timing, language, greeting, closing, risk_terms, tone  # noqa: E402,F401

__all__ = [
    "Fact", "FactContext", "register", "item_formatter", "available_facts", "extract", "dump",
    "boolean_facts", "render_for_prompt", "LABELS",
]
