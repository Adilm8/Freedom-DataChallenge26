"""Оценка стоимости и времени прогона до запуска (FR-UX-03).

Входные токены считаются по реальным промптам (≈ 3 символа на токен для смеси кириллицы и латиницы),
выходные — по числу критериев. Если у модели уже есть вызовы в БД, цена и задержка берутся из их
средних (так точнее и работает без сети); иначе — из прайса OpenRouter, если он доступен.
История ищется по запрошенной модели прогона (OpenRouter может вернуть в ответе другое имя версии).
Звонки, которые провайдер не принимает (бесплатный Gemini), в оценку не входят: `skipped_voice`.
"""

from __future__ import annotations

import json
import math

from sqlmodel import Session, or_, select

from ..domain import Checklist, NormalizedConversation
from ..models import ChecklistVersion, Conversation, Evaluation, EvaluationRun, LLMCall
from ..providers import ProviderError, get_provider
from . import evaluator, prompt_builder
from . import reuse as reuse_mod
from .runs import MAX_WORKERS

CHARS_PER_TOKEN = 3.0
OUT_TOKENS_PER_CRITERION = 260
OUT_TOKENS_OVERVIEW = 120
DEFAULT_LATENCY_MS = 8000
HISTORY = 200


def _history(session: Session, model: str) -> tuple[float | None, float | None, float | None]:
    """(цена за 1k входных + выходных токенов по факту, средняя задержка вызова, доля повторов)."""
    q = (select(LLMCall).join(Evaluation, Evaluation.id == LLMCall.evaluation_id)
         .join(EvaluationRun, EvaluationRun.id == Evaluation.run_id, isouter=True)
         .where(or_(LLMCall.model == model, EvaluationRun.model == model), LLMCall.error == None)  # noqa: E711
         .order_by(LLMCall.id.desc()).limit(HISTORY))
    rows = session.exec(q).all()
    if len(rows) < 5:
        return None, None, None
    toks = sum(r.tokens_in + r.tokens_out for r in rows)
    cost = sum(r.cost_usd or 0 for r in rows)
    per_k = cost / toks * 1000 if toks else None
    latency = sum(r.latency_ms for r in rows) / len(rows)
    retries = sum(1 for r in rows if r.attempt > 1) / len(rows)
    return per_k, latency, retries


def estimate(session: Session, conv_pks: list[int], version_id: int, *, provider_name: str, model: str,
             strategy: str, reuse: str = "none") -> dict:
    cl = Checklist.model_validate(session.get(ChecklistVersion, version_id).body)
    sections = {s.id: s.title for s in cl.sections}
    calls = tin = tout = dialogs_with_calls = skipped_voice = 0
    try:
        prov = get_provider(provider_name)
    except ProviderError:
        prov = None
    for pk in conv_pks:
        conv = NormalizedConversation.model_validate(session.get(Conversation, pk).normalized)
        if prov is not None and conv.is_voice and not prov.allow_voice:
            skipped_voice += 1
            continue
        facts, context = evaluator.prepare(conv, cl)
        crit = cl.enabled_criteria()
        overview_needed = True
        if reuse == "auto":
            plan = reuse_mod.plan(session, pk, crit, model=model, prompt_version=prompt_builder.prompt_version(),
                                  context=context)
            crit, overview_needed = plan.to_call(crit), plan.overview is None
        batches = evaluator.partition(crit, strategy)
        dialogs_with_calls += bool(batches)
        for i, b in enumerate(batches):
            msgs, schema = prompt_builder.build(conv, facts[1], b, cl.settings, sections,
                                                include_overview=overview_needed and i == 0)
            chars = sum(len(m["content"]) for m in msgs) + len(json.dumps(schema, ensure_ascii=False)) // 2
            tin += math.ceil(chars / CHARS_PER_TOKEN)
            tout += OUT_TOKENS_PER_CRITERION * len(b) + (OUT_TOKENS_OVERVIEW if overview_needed and i == 0 else 0)
            calls += 1

    per_k, latency, retries = _history(session, model)
    source = "history"
    if per_k is not None:
        cost = (tin + tout) / 1000 * per_k * (1 + (retries or 0))
    else:
        source = "pricing"
        try:
            cost = 0.0 if getattr(prov, "free", False) else prov.pricing.estimate(model, tin, tout)
        except (ProviderError, AttributeError):
            cost = None
        if cost is None:
            source = "unknown"
    per_call_ms = latency or DEFAULT_LATENCY_MS
    seconds = math.ceil(dialogs_with_calls / MAX_WORKERS) * per_call_ms / 1000 if dialogs_with_calls else 0
    return {"dialogs": len(conv_pks), "dialogs_with_calls": dialogs_with_calls, "calls": calls,
            "tokens_in": tin, "tokens_out": tout,
            "cost_usd": round(cost, 4) if cost is not None else None, "seconds": round(seconds),
            "cost_source": source, "skipped_voice": skipped_voice}
