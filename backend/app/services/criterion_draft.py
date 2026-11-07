"""Черновик критерия с ИИ: описание в одну-две фразы и тип ответа → заполненные поля критерия.

Модель только формулирует текст (название, определение, «Да, когда…», «Нет, когда…», N/A, ступени шкалы,
подсказки). Код, секцию, вес, `export_id`, группу и страховки задаёт человек: в ответе они пустые.
Ничего не сохраняется: черновик подставляется в форму конструктора, дальше обычная проверка и версия.

Строгая JSON-схема, проверка `finish_reason`, валидация pydantic (та же модель `Criterion`, что у чек-листа)
и один ретрай с перечнем ошибок, как в judge.py. Шаблон промпта — prompts/tools/criterion_draft.md: он лежит
в подпапке, чтобы не попадать в `prompt_version()` оценки (тот хеширует только prompts/*.md).
Вызов не привязан к оценке, поэтому в `llm_call` не пишется: провайдер, модель, токены, стоимость и сырой
ответ уходят в лог и в ответ API (`calls`).
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from string import Template
from typing import Literal

from pydantic import BaseModel, ValidationError

from ..domain import Checklist, Criterion
from ..providers import LLMResult, ProviderError

log = logging.getLogger(__name__)

TEMPLATE_PATH = Path(__file__).resolve().parents[1] / "prompts" / "tools" / "criterion_draft.md"
MAX_DESCRIPTION = 2000
BASE_MAX_TOKENS = 1500
LANG_NAME = {"ru": "русский", "kz": "казахский", "en": "английский"}
EXAMPLE_FIELDS = ("title", "type", "definition", "yes_when", "no_when", "na_allowed", "na_when", "scale", "guidance",
                  "voice_guidance")

TYPE_RULES = {
    "binary": "- `yes_when` — когда ставится «Да» (оператор сделал то, что нужно); `no_when` — когда «Нет» "
              "(действие было нужно, но пропущено или выполнено неправильно). Конкретные признаки в репликах.\n"
              "- `na_allowed` — может ли критерий быть неприменим к диалогу; `na_when` — условие неприменимости "
              "(обязательно, если `na_allowed` = true, иначе null). N/A — только когда проверять нечего, а не когда "
              "оператор не справился.",
    "scale": "- `scale` — ступени шкалы от лучшей к худшей, 3–5 штук: `value` — целые баллы ≥ 0 (максимальная ступень "
             "даёт полный вес, обычно 0 у худшей), `label` — когда ставится эта ступень, одно предложение с признаками.\n"
             "- `na_allowed` — может ли критерий быть неприменим к диалогу; `na_when` — условие неприменимости "
             "(обязательно, если `na_allowed` = true, иначе null).",
    "flag": "- Это флаг грубого нарушения без баллов. `yes_when` — когда нарушение есть (что именно сделал оператор); "
            "`no_when` — когда нарушения нет. N/A у флага не бывает.",
}


class DraftError(Exception):
    """Модель не вернула пригодный черновик и после ретрая, или провайдер недоступен."""

    def __init__(self, message: str, calls: list[dict] | None = None):
        super().__init__(message)
        self.calls = calls or []


class _Step(BaseModel):
    value: int
    label: str


class DraftOut(BaseModel):
    """Ответ модели: только текстовые поля критерия."""
    title: str
    definition: str
    yes_when: str | None = None
    no_when: str | None = None
    na_allowed: bool = False
    na_when: str | None = None
    scale: list[_Step] | None = None
    guidance: str | None = None
    voice_guidance: str | None = None


# --------------------------------------------------------------------------- промпт и схема


def schema(ctype: str) -> dict:
    """Строгая схема ответа: все поля обязательны (strict), пустое — null."""
    s_or_null = {"type": ["string", "null"]}
    props: dict = {"title": {"type": "string"}, "definition": {"type": "string"}}
    if ctype == "scale":
        props["scale"] = {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["value", "label"],
            "properties": {"value": {"type": "integer"}, "label": {"type": "string"}}}}
    else:
        props["yes_when"] = {"type": "string"}
        props["no_when"] = {"type": "string"}
    if ctype != "flag":
        props["na_allowed"] = {"type": "boolean"}
        props["na_when"] = s_or_null
    props["guidance"] = s_or_null
    props["voice_guidance"] = s_or_null
    return {"type": "object", "additionalProperties": False, "required": list(props), "properties": props}


def pick_examples(checklist: Checklist | None, ctype: str, limit: int = 2) -> list[dict]:
    """1–2 критерия активного чек-листа как образец стиля: сначала того же типа, затем с подсказкой для звонков."""
    if not checklist:
        return []
    pool = checklist.enabled_criteria()
    # один того же типа (лучше с подсказкой для звонков), второй — другого типа, чтобы было видно разнообразие
    same = sorted((c for c in pool if c.type == ctype), key=lambda c: not c.voice_guidance)
    other = sorted((c for c in pool if c.type != ctype), key=lambda c: not c.voice_guidance)
    chosen = (same[:1] + other[:1] + same[1:])[:limit]
    out = []
    for c in chosen:
        d = c.model_dump(include=set(EXAMPLE_FIELDS))
        out.append({k: d[k] for k in EXAMPLE_FIELDS if d.get(k) not in (None, [], "")})
    return out


def build_messages(description: str, ctype: str, language: str, examples: list[dict]) -> list[dict]:
    lang = LANG_NAME.get(language.strip().lower(), language)
    ex = "\n".join(json.dumps(e, ensure_ascii=False, indent=1) for e in examples) or "(образцов нет)"
    system = Template(TEMPLATE_PATH.read_text(encoding="utf-8")).safe_substitute(
        type_rules=TYPE_RULES[ctype], language=lang, examples=ex).strip()
    user = f"Тип ответа: {ctype}.\nЧто проверять: {description.strip()}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


# --------------------------------------------------------------------------- проверка ответа


def to_criterion(parsed: dict | None, ctype: str) -> tuple[dict | None, list[str]]:
    """Ответ модели → частичный критерий (код, секция, вес пустые) и список ошибок для ретрая."""
    if not isinstance(parsed, dict):
        return None, ["ответ не является JSON-объектом"]
    try:
        d = DraftOut.model_validate(parsed)
    except ValidationError as e:
        return None, [f"{'.'.join(map(str, x['loc']))}: {x['msg']}" for x in e.errors()]
    clean = lambda v: (v or "").strip() or None  # noqa: E731
    na = ctype != "flag" and d.na_allowed
    crit = {
        "key": None, "export_id": None, "title": d.title.strip(), "section": None, "type": ctype, "weight": None,
        "na_allowed": na, "na_when": clean(d.na_when) if na else None, "definition": d.definition.strip(),
        "yes_when": None if ctype == "scale" else clean(d.yes_when),
        "no_when": None if ctype == "scale" else clean(d.no_when),
        "scale": sorted(({"value": s.value, "label": s.label.strip()} for s in d.scale or []), key=lambda s: -s["value"])
        if ctype == "scale" else None,
        "guidance": clean(d.guidance), "voice_guidance": clean(d.voice_guidance),
        "group": None, "context_refs": [], "guards": [], "enabled": True,
    }
    problems = []
    if not crit["title"]:
        problems.append("title: пустое название")
    if not crit["definition"]:
        problems.append("definition: пустое определение")
    if ctype != "scale":
        problems += [f"{k}: поле пустое" for k in ("yes_when", "no_when") if not crit[k]]
    if ctype == "scale" and any(not s["label"] for s in crit["scale"]):
        problems.append("scale: у каждой ступени нужно описание")
    try:  # те же правила, что у чек-листа: ступени, N/A с условием
        Criterion.model_validate({**crit, "key": "draft", "section": "draft", "weight": 0})
    except ValidationError as e:
        problems += [str(x["msg"]).removeprefix("Value error, ").replace("критерий draft: ", "") for x in e.errors()]
    return crit, problems


# --------------------------------------------------------------------------- вызов


def _dump(r: LLMResult, attempt: int) -> dict:
    return {"attempt": attempt, "provider": r.provider, "model": r.model, "finish_reason": r.finish_reason,
            "tokens_in": r.tokens_in, "tokens_out": r.tokens_out, "cost_usd": r.cost_usd or 0.0,
            "latency_ms": r.latency_ms, "request": r.request, "response_raw": r.text}


def draft(provider, description: str, ctype: str, *, checklist: Checklist | None = None, language: str = "ru",
          model: str | None = None) -> dict:
    if ctype not in TYPE_RULES:
        raise ValueError(f"неизвестный тип «{ctype}»: binary, scale или flag")
    description = (description or "").strip()
    if not description:
        raise ValueError("опишите, что проверять")
    if len(description) > MAX_DESCRIPTION:
        raise ValueError(f"описание длиннее {MAX_DESCRIPTION} символов")
    messages = build_messages(description, ctype, language, pick_examples(checklist, ctype))
    sch = schema(ctype)
    results: list[LLMResult] = []

    def call(msgs, max_tokens) -> LLMResult:
        try:
            r = provider.complete(msgs, model=model, json_schema=sch, max_tokens=max_tokens, temperature=0)
        except ProviderError as e:
            log.warning("criterion_draft: ошибка провайдера: %s", e)
            raise DraftError(str(e), [_dump(x, i + 1) for i, x in enumerate(results)]) from None
        results.append(r)
        log.info("criterion_draft: provider=%s model=%s finish=%s tokens=%s/%s cost=%s latency_ms=%s raw=%s",
                 r.provider, r.model, r.finish_reason, r.tokens_in, r.tokens_out, r.cost_usd, r.latency_ms, r.text[:4000])
        return r

    def check(r: LLMResult) -> tuple[dict | None, list[str]]:
        if r.refused:
            return None, ["модель отказалась отвечать"]
        if r.truncated:
            return None, ["ответ обрезан по длине: пиши короче и верни полный JSON"]
        return to_criterion(r.parsed, ctype)

    first = call(messages, BASE_MAX_TOKENS)
    crit, problems = check(first)
    if problems:
        retry = messages + [
            {"role": "assistant", "content": first.text or "(пустой ответ)"},
            {"role": "user", "content": "В ответе есть ошибки, исправь их и верни JSON целиком заново:\n- " + "\n- ".join(problems)},
        ]
        second = call(retry, BASE_MAX_TOKENS * (2 if first.truncated else 1))
        crit, problems = check(second)
    calls = [_dump(r, i + 1) for i, r in enumerate(results)]
    if problems:
        raise DraftError("модель не вернула корректный черновик: " + "; ".join(problems[:5]), calls)
    last = results[-1]
    return {
        "criterion": crit,
        "provider": last.provider,
        "model": last.model,
        "cost_usd": round(sum(r.cost_usd or 0 for r in results), 6),
        "tokens": {"in": sum(r.tokens_in for r in results), "out": sum(r.tokens_out for r in results)},
        "latency_ms": sum(r.latency_ms for r in results),
        "attempts": len(results),
        "calls": calls,
    }
