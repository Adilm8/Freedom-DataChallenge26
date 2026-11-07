"""Сборка сообщений и JSON-схемы ответа из чек-листа (evaluation-pipeline.md §3–4).

Порядок частей даёт общий префикс для всех вызовов одного диалога (кеш у провайдера):
system (+ правила канала) → факты → транскрипт → критерии этого вызова → формат ответа.
Ничего не зависит от кода критерия: всё берётся из данных чек-листа.
"""

from __future__ import annotations

import hashlib
import json
from functools import lru_cache
from pathlib import Path
from string import Template

from ..config import ROOT
from ..domain import ChecklistSettings, Criterion, NormalizedConversation

PROMPTS_DIR = Path(__file__).resolve().parents[1] / "prompts"
DATA_DIR = ROOT / "data"

LANGUAGE_NAMES = {"ru": "русский", "kz": "казахский", "en": "английский"}
TYPE_NAMES = {"binary": "Да / Нет", "scale": "шкала", "flag": "флаг (Да / Нет, без баллов)"}
ANSWER_NAMES = {"yes": "Да", "no": "Нет", "na": "N/A"}


@lru_cache(maxsize=None)
def _template(name: str) -> str:
    return (PROMPTS_DIR / name).read_text(encoding="utf-8").strip()


@lru_cache(maxsize=1)
def prompt_version() -> str:
    """Ручная метка из VERSION + отпечаток всех шаблонов: правка шаблона без подъёма метки тоже меняет версию."""
    h = hashlib.sha256()
    for f in sorted(PROMPTS_DIR.glob("*.md")):
        h.update(f.name.encode() + b"\0" + f.read_bytes())
    return f"{_template('VERSION')}-{h.hexdigest()[:6]}"


# Настройки, которые не попадают в промпт и не влияют на ответы модели (только на расчёт баллов).
_SCORING_ONLY_SETTINGS = {"rounding", "critical_policy"}


def context_digest(conv: NormalizedConversation, facts_block: str, settings: ChecklistSettings,
                   section_titles: dict[str, str]) -> str:
    """Отпечаток всего, кроме критерия, от чего зависит ответ: транскрипт, факты, настройки, секции.
    Входит в `criterion_hash`, чтобы `reuse: auto` не вернул ответ, посчитанный на других входных данных."""
    payload = json.dumps({
        "transcript": render_transcript(conv), "facts": facts_block,
        "settings": settings.model_dump(mode="json", exclude=_SCORING_ONLY_SETTINGS), "sections": section_titles,
    }, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def context_refs_digest(c: Criterion) -> str:
    return hashlib.sha256("\0".join(f"{r}\0{_context_ref(r) or ''}" for r in c.context_refs).encode()).hexdigest()[:12]


@lru_cache(maxsize=None)
def _context_ref(ref: str) -> str | None:
    path = (DATA_DIR / ref).resolve()
    if DATA_DIR.resolve() not in path.parents or not path.exists():
        return None
    return path.read_text(encoding="utf-8").strip()


def _clock(t: float | None) -> str:
    if t is None:
        return "--:--"
    t = int(round(t))
    h, rem = divmod(t, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def render_transcript(conv: NormalizedConversation) -> str:
    lines = []
    for m in conv.messages:
        role = m.speaker or "unknown"
        if m.internal:
            role += "·internal"
        if m.event:
            role += f":{m.event}"
        text = " ".join(m.text.split())
        lines.append(f"[{m.msg_id} | {_clock(m.t_sec)} | {role}] {text}")
    return "\n".join(lines)


def answer_strings(c: Criterion) -> list[str]:
    return [str(a) for a in c.allowed_answers()]


def render_criterion(c: Criterion, section_title: str) -> str:
    out = [f"### Критерий {c.key} — {c.title}", f"Секция: {section_title}. Тип ответа: {TYPE_NAMES[c.type]}."]
    out.append(f"Что оценивается: {c.definition}")
    if c.yes_when:
        out.append(f"«Да», когда: {c.yes_when}")
    if c.no_when:
        out.append(f"«Нет», когда: {c.no_when}")
    if c.type == "scale" and c.scale:
        out.append("Ступени шкалы (выбери одну):")
        for step in sorted(c.scale, key=lambda s: -s.value):
            out.append(f"- {step.value}: {step.label}")
    if c.na_allowed and c.type != "flag":
        out.append(f"N/A разрешён, только если: {c.na_when}")
    else:
        out.append("N/A для этого критерия не разрешён.")
    if c.guidance:
        out.append(f"Подсказка оценщику: {c.guidance}")
    allowed = ", ".join(f'"{a}"' for a in answer_strings(c))
    out.append(f"Разрешённые значения answer: {allowed}.")
    for ref in c.context_refs:
        body = _context_ref(ref)
        if body:
            out.append(f"Справка ({ref}) — подсказка о продуктах, а не эталон; при расхождении с диалогом не считай оператора ошибающимся без явных оснований:\n{body}")
    return "\n".join(out)


def build_schema(criteria: list[Criterion], settings: ChecklistSettings, *, include_overview: bool) -> dict:
    props: dict = {}
    for c in criteria:
        p: dict = {
            "reasoning": {"type": "string"},
            "answer": {"type": "string", "enum": answer_strings(c)},
            "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
            "evidence": {
                "type": "array",
                "items": {
                    "type": "object", "additionalProperties": False, "required": ["msg_id", "quote"],
                    "properties": {"msg_id": {"type": "string"}, "quote": {"type": "string"}},
                },
            },
            "checked_range": {"anyOf": [{"type": "null"}, {
                "type": "object", "additionalProperties": False, "required": ["from", "to"],
                "properties": {"from": {"type": "string"}, "to": {"type": "string"}},
            }]},
            "na_reason": {"anyOf": [{"type": "null"}, {"type": "string"}]},
        }
        if settings.advice:
            p["advice"] = {"anyOf": [{"type": "null"}, {"type": "string"}]}
        props[c.key] = {"type": "object", "additionalProperties": False, "required": list(p), "properties": p}

    schema: dict = {
        "type": "object", "additionalProperties": False, "required": ["results"],
        "properties": {"results": {
            "type": "object", "additionalProperties": False, "required": [c.key for c in criteria], "properties": props,
        }},
    }
    if include_overview and settings.overview:
        schema["required"].append("overview")
        schema["properties"]["overview"] = {
            "type": "object", "additionalProperties": False, "required": ["summary", "topic", "resolved"],
            "properties": {
                "summary": {"type": "string"},
                "topic": {"type": "string"},
                "resolved": {"type": "string", "enum": ["yes", "no", "unclear"]},
            },
        }
    return schema


def build(
    conv: NormalizedConversation,
    facts_block: str,
    criteria: list[Criterion],
    settings: ChecklistSettings,
    section_titles: dict[str, str],
    *,
    include_overview: bool = False,
) -> tuple[list[dict], dict]:
    """→ (messages, json_schema). `facts_block` — готовый текст фактов (facts.render_for_prompt)."""
    lang = LANGUAGE_NAMES.get(settings.output_language, settings.output_language)
    system = Template(_template("system.md")).safe_substitute(output_language=lang)
    if conv.is_voice:
        system += "\n\n" + _template("channel_voice.md")

    header = f"Диалог {conv.conversation_id}. Канал: {conv.channel}. Язык клиента по данным: {conv.language}."
    criteria_block = "\n\n".join(render_criterion(c, section_titles.get(c.section, c.section)) for c in criteria)

    advice_rule = ", `advice`" if settings.advice else ""
    overview_rule = ""
    if include_overview and settings.overview:
        overview_rule = (
            "\n- `overview`: `summary` — 1–2 предложения, о чём диалог и чем закончился; `topic` — тема обращения "
            "в 2–4 словах; `resolved` — решён ли вопрос клиента: \"yes\", \"no\" или \"unclear\"."
        )
    if settings.advice:
        overview_rule = (
            "\n- `advice`: если ответ не даёт полного балла (\"no\" или ступень ниже максимальной), одна короткая подсказка "
            "оператору, что можно было сделать иначе; иначе null." + overview_rule
        )
    rules = Template(_template("output_rules.md")).safe_substitute(advice_rule=advice_rule, overview_rule=overview_rule)

    user = "\n\n".join([
        header,
        "## Факты, вычисленные системой (подсказки, а не вердикт)\n" + (facts_block.strip() or "нет"),
        "## Транскрипт\nФормат строки: [id | время от начала | роль] текст\n" + render_transcript(conv),
        "## Критерии для оценки\n" + criteria_block,
        rules,
    ])
    return [{"role": "system", "content": system}, {"role": "user", "content": user}], build_schema(
        criteria, settings, include_overview=include_overview
    )
