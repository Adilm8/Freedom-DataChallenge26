"""Оценка диалога с записью в БД и сборка объекта `Evaluation` для API (CONTRACTS §3)."""
from __future__ import annotations

from sqlmodel import Session, select

from .. import db  # noqa: F401  (engine берётся в runs.py)
from ..domain import Checklist, NormalizedConversation
from ..models import ChecklistVersion, Conversation, CriterionResult, Evaluation, LLMCall
from ..providers import ProviderError, get_provider
from . import evaluator

PARAMS = {"temperature": 0, "seed": 7, "reuse": "none"}


def _ans_str(a) -> str:
    return "" if a is None else str(a)


def _ans_api(s):
    if s is None or s == "":
        return None
    return int(s) if str(s).lstrip("-").isdigit() else s


def persist(
    session: Session,
    conversation_pk: int,
    checklist_version_id: int,
    outcome: evaluator.EvalOutcome,
    *,
    provider_name: str,
    model: str,
    strategy: str,
    run_id: int | None = None,
) -> int:
    actual = next((c.result.model for c in outcome.calls if c.result and c.result.model), None)
    tin, tout = outcome.tokens
    score = outcome.score.model_dump()
    ev = Evaluation(
        conversation_pk=conversation_pk,
        checklist_version_id=checklist_version_id,
        run_id=run_id,
        provider=provider_name,
        model=actual or model,
        strategy=strategy,
        prompt_version=outcome.prompt_version,
        status=outcome.status,
        facts=outcome.facts or {},
        overview=outcome.overview,
        params=dict(PARAMS),
        ai_score=score,
        final_score=score,
        ai_total=outcome.score.total,
        final_total=outcome.score.total,
        critical=bool(outcome.score.critical),
        needs_review=outcome.needs_review,
        tokens_in=tin,
        tokens_out=tout,
        cost_usd=outcome.cost_usd,
        latency_ms=outcome.latency_ms,
    )
    session.add(ev)
    session.flush()
    for key, r in outcome.results.items():
        cs = outcome.score.criteria.get(key)
        pts = cs.points if cs else None
        session.add(CriterionResult(
            evaluation_id=ev.id, criterion_key=key, ai_answer=_ans_str(r.answer), ai_points=pts,
            reasoning=r.reasoning, na_reason=r.na_reason, evidence=list(r.evidence), checked_range=r.checked_range,
            issues=list(r.issues), confidence=r.confidence, advice=r.advice,
            criterion_hash=outcome.hashes.get(key, ""),
            final_answer=_ans_str(r.answer), final_points=pts,
        ))
    for c in outcome.calls:
        res = c.result
        session.add(LLMCall(
            evaluation_id=ev.id, criteria_keys=list(c.criteria_keys), attempt=c.attempt,
            provider=res.provider if res else provider_name, model=(res.model if res else None) or model,
            request=dict(res.request) if res else {}, response_raw=res.text if res else "",
            finish_reason=res.finish_reason if res else None, error=c.error,
            tokens_in=res.tokens_in if res else 0, tokens_out=res.tokens_out if res else 0,
            cached_tokens=res.cached_tokens if res else 0, cost_usd=(res.cost_usd or 0) if res else 0,
            latency_ms=res.latency_ms if res else 0,
        ))
    session.commit()
    return ev.id


def _failed_outcome(checklist: Checklist, error: str) -> evaluator.EvalOutcome:
    from . import scoring

    keys = [c.key for c in checklist.enabled_criteria()]
    return evaluator.EvalOutcome(
        results={}, score=scoring.compute(checklist, {}), facts={}, overview=None,
        calls=[evaluator.CallRecord(keys, None, 1, error)], status="failed",
    )


def evaluate_one(
    session: Session,
    conversation_pk: int,
    checklist_version_id: int,
    *,
    provider_name: str,
    model: str,
    strategy: str,
    run_id: int | None = None,
) -> int:
    conv_row = session.get(Conversation, conversation_pk)
    ver = session.get(ChecklistVersion, checklist_version_id)
    if not conv_row or not ver:
        raise ValueError("диалог или версия чек-листа не найдены")
    conv = NormalizedConversation.model_validate(conv_row.normalized)
    checklist = Checklist.model_validate(ver.body)
    try:
        provider = get_provider(provider_name)
        outcome = evaluator.evaluate_conversation(conv, checklist, provider, model=model, strategy=strategy)
    except ProviderError as e:
        outcome = _failed_outcome(checklist, str(e))
    return persist(session, conversation_pk, checklist_version_id, outcome,
                   provider_name=provider_name, model=model, strategy=strategy, run_id=run_id)


def to_api(session: Session, ev: Evaluation) -> dict:
    ver = session.get(ChecklistVersion, ev.checklist_version_id)
    cl = Checklist.model_validate(ver.body) if ver else None
    rows = {r.criterion_key: r for r in session.exec(select(CriterionResult).where(CriterionResult.evaluation_id == ev.id))}
    criteria = []
    order = [c for c in cl.criteria if c.key in rows] if cl else []
    seen = {c.key for c in order}
    items = [(c, rows[c.key]) for c in order] + [(None, r) for k, r in rows.items() if k not in seen]
    for c, r in items:
        scale_max = (max(s.value for s in c.scale) if c.scale else c.weight) if c else None
        criteria.append({
            "key": r.criterion_key,
            "title": c.title if c else r.criterion_key,
            "section": c.section if c else None,
            "type": c.type if c else None,
            "weight": c.weight if c else None,
            "scale_max": scale_max,
            "ai_answer": _ans_api(r.ai_answer), "ai_points": r.ai_points,
            "final_answer": _ans_api(r.final_answer), "final_points": r.final_points,
            "overridden": r.overridden,
            "reasoning": r.reasoning, "confidence": r.confidence, "advice": r.advice,
            "evidence": r.evidence or [], "checked_range": r.checked_range, "na_reason": r.na_reason,
            "issues": r.issues or [], "reused_from_evaluation_id": r.reused_from_evaluation_id,
            "appeal": None,
        })
    return {
        "id": ev.id, "conversation_id": ev.conversation_pk, "checklist_version_id": ev.checklist_version_id,
        "provider": ev.provider, "model": ev.model, "strategy": ev.strategy, "prompt_version": ev.prompt_version,
        "status": ev.status, "needs_review": ev.needs_review, "facts": ev.facts, "overview": ev.overview,
        "params": ev.params, "ai_score": ev.ai_score, "final_score": ev.final_score, "criteria": criteria,
        "tokens_in": ev.tokens_in, "tokens_out": ev.tokens_out, "cost_usd": ev.cost_usd,
        "latency_ms": ev.latency_ms, "created_at": ev.created_at.isoformat(),
    }
