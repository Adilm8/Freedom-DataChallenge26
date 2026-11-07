"""Вызов модели-судьи с проверкой и одним ретраем (FR-EVAL-04, evaluation-pipeline.md §6).

Ретрай один: те же сообщения + ответ модели + список ошибок. Обрезка по длине (V9) — повтор
с большим `max_tokens`. Если и повтор не прошёл, берём лучший вариант с пометками, прогон не падает.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from ..domain import ChecklistSettings, Criterion, NormalizedConversation
from ..providers import LLMResult, ProviderError
from . import validator

BASE_MAX_TOKENS = 700      # на критерий; на вызов — не меньше 1500
RETRY_MAX_TOKENS_FACTOR = 2


@dataclass
class JudgeOutput:
    results: dict[str, validator.CriterionOutput]
    issues: list[validator.Issue]
    overview: dict | None
    calls: list[LLMResult] = field(default_factory=list)
    error: str | None = None


def _max_tokens(n_criteria: int) -> int:
    return max(1500, BASE_MAX_TOKENS * n_criteria + 300)


def run(
    provider,
    messages: list[dict],
    schema: dict,
    criteria: list[Criterion],
    conv: NormalizedConversation,
    settings: ChecklistSettings,
    *,
    model: str | None = None,
    seed: int | None = 7,
) -> JudgeOutput:
    calls: list[LLMResult] = []
    max_tokens = _max_tokens(len(criteria))

    def call(msgs, mt) -> LLMResult:
        res = provider.complete(msgs, model=model, json_schema=schema, max_tokens=mt, temperature=0, seed=seed,
                                channel=conv.channel)
        calls.append(res)
        return res

    try:
        first = call(messages, max_tokens)
    except ProviderError as e:
        return JudgeOutput({}, [validator.Issue("V0", str(e))], None, calls, error=str(e))

    results, issues = validator.validate(first.parsed, criteria, conv, settings)
    problems = [i.message for i in issues if i.retry]
    if first.truncated:
        problems.insert(0, "ответ обрезан по длине: сократи обоснования и верни полный JSON")
    if first.refused:
        problems.insert(0, "модель отказалась отвечать")

    if not problems:
        return JudgeOutput(results, issues, _overview(first.parsed), calls)

    retry_msgs = messages + [
        {"role": "assistant", "content": first.text or "(пустой ответ)"},
        {"role": "user", "content": "В ответе есть ошибки, исправь их и верни JSON целиком заново:\n- "
                                     + "\n- ".join(problems)},
    ]
    try:
        second = call(retry_msgs, max_tokens * (RETRY_MAX_TOKENS_FACTOR if first.truncated else 1))
    except ProviderError as e:
        results, issues = validator.validate(first.parsed, criteria, conv, settings, final=True)
        return JudgeOutput(results, issues + [validator.Issue("V0", str(e))], _overview(first.parsed), calls)

    results2, issues2 = validator.validate(second.parsed, criteria, conv, settings, final=True)
    if not results2 and results:  # повтор хуже первого — берём первый
        results, issues = validator.validate(first.parsed, criteria, conv, settings, final=True)
        return JudgeOutput(results, issues, _overview(first.parsed), calls)
    return JudgeOutput(results2, issues2, _overview(second.parsed) or _overview(first.parsed), calls)


def _overview(parsed: dict | None) -> dict | None:
    ov = (parsed or {}).get("overview")
    if not isinstance(ov, dict):
        return None
    resolved = ov.get("resolved") if ov.get("resolved") in ("yes", "no", "unclear") else "unclear"
    return {"summary": str(ov.get("summary") or "").strip(), "topic": str(ov.get("topic") or "").strip(), "resolved": resolved}


def dump_messages(messages: list[dict]) -> str:
    """Для логов и экрана «Сырой ответ»."""
    return json.dumps(messages, ensure_ascii=False, indent=2)
