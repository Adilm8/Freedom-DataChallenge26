"""«Второе мнение ИИ» по апелляции: слепая независимая перепроверка одного спорного критерия.

Тот же конвейер, что у обычной оценки и песочницы (services/trial.py): тот же промпт из версии чек-листа
ЭТОЙ оценки, факты, проверка цитат (с одним ретраем judge), страховки и маскирование данных. Модель получает
только диалог и критерий — ни ответа AI, ни комментария аналитика. Оценка и апелляция не меняются;
результат и вызовы пишутся в `appeal_second_opinion`. Только для открытой апелляции.
"""
from __future__ import annotations

from sqlmodel import Session, select

from ..domain import Checklist, NormalizedConversation
from ..models import Appeal, AppealSecondOpinion, ChecklistVersion, Conversation, CriterionResult, Evaluation
from ..providers import ProviderError, get_provider
from . import evaluator
from .appeals import AppealError, Conflict, NotFound
from .evaluations import _ans_api, _ans_str
from .trial import _call_dump


class ProviderFailed(AppealError):
    status = 502


def to_api(op: AppealSecondOpinion | None) -> dict | None:
    if op is None:
        return None
    r = op.result or {}
    return {
        "id": op.id, "appeal_id": op.appeal_id, "evaluation_id": op.evaluation_id, "criterion_key": op.criterion_key,
        "provider": op.provider, "model": op.model, "status": op.status, "error": op.error,
        "answer": _ans_api(_ans_str(r.get("answer"))), "reasoning": r.get("reasoning") or "",
        "confidence": r.get("confidence"), "evidence": r.get("evidence") or [], "na_reason": r.get("na_reason"),
        "checked_range": r.get("checked_range"), "issues": r.get("issues") or [],
        "ai_answer": _ans_api(op.ai_answer),
        "agrees": op.status == "done" and _ans_str(r.get("answer")) == (op.ai_answer or ""),
        "cost_usd": op.cost_usd, "tokens": [op.tokens_in, op.tokens_out], "latency_ms": op.latency_ms,
        "created_at": op.created_at.isoformat(),
    }


def latest_map(session: Session, appeal_ids) -> dict[int, AppealSecondOpinion]:
    """Последнее удавшееся второе мнение по каждой апелляции."""
    ids = list(appeal_ids)
    if not ids:
        return {}
    out: dict[int, AppealSecondOpinion] = {}
    q = select(AppealSecondOpinion).where(AppealSecondOpinion.appeal_id.in_(ids), AppealSecondOpinion.status == "done") \
        .order_by(AppealSecondOpinion.id)
    for op in session.exec(q):
        out[op.appeal_id] = op
    return out


def run(session: Session, appeal_id: int, *, provider_name: str, model: str) -> dict:
    a = session.get(Appeal, appeal_id)
    if not a:
        raise NotFound("апелляция не найдена")
    if a.status != "open":
        raise Conflict(f"апелляция №{a.id} уже рассмотрена: второе мнение — только для открытой")
    ev = session.get(Evaluation, a.evaluation_id)
    conv_row = session.get(Conversation, ev.conversation_pk) if ev else None
    ver = session.get(ChecklistVersion, ev.checklist_version_id) if ev else None
    row = session.exec(select(CriterionResult).where(CriterionResult.evaluation_id == a.evaluation_id,
                                                     CriterionResult.criterion_key == a.criterion_key)).first()
    if not ev or not conv_row or not ver or not row:
        raise NotFound("оценка, диалог или критерий апелляции не найдены")
    checklist = Checklist.model_validate(ver.body)
    crit = checklist.criterion(a.criterion_key)
    if crit is None or not crit.enabled:
        raise Conflict(f"критерия {a.criterion_key} нет среди включённых в версии чек-листа оценки")
    conv = NormalizedConversation.model_validate(conv_row.normalized)

    try:
        provider = get_provider(provider_name)
    except ProviderError as e:
        raise AppealError(str(e)) from None
    if not getattr(provider, "allow_voice", True) and (conv.channel or "").strip().lower() == "voice call":
        raise AppealError(f"провайдер «{provider_name}» не принимает звонки: выберите другой")

    # Слепо: в конвейер идут только диалог и критерий; ответ AI и комментарий аналитика модель не видит.
    try:
        out = evaluator.evaluate_conversation(conv, checklist, provider, model=model, strategy="single",
                                              criteria=[crit], reused_overview={})
        error = next((c.error for c in out.calls if c.error), None) if out.status == "failed" else None
    except ProviderError as e:
        out, error = None, str(e)

    res = out.results.get(crit.key) if out else None
    result = {
        "answer": res.answer if res else None,
        "reasoning": res.reasoning if res else "",
        "confidence": res.confidence if res else None,
        "evidence": res.evidence if res else [],
        "na_reason": res.na_reason if res else None,
        "checked_range": res.checked_range if res else None,
        "issues": [i.message for i in out.issues if i.criterion in (None, crit.key)] if out else [],
    }
    failed = res is None or res.answer is None
    tokens = out.tokens if out else (0, 0)
    op = AppealSecondOpinion(
        appeal_id=a.id, evaluation_id=ev.id, criterion_key=crit.key, provider=provider_name, model=model,
        ai_answer=row.ai_answer or "", status="failed" if failed else "done",
        error=(error or "модель не дала ответа по критерию") if failed else None,
        result=result, calls=[_call_dump(c) for c in out.calls] if out else [],
        cost_usd=out.cost_usd if out else 0.0, tokens_in=tokens[0], tokens_out=tokens[1],
        latency_ms=out.latency_ms if out else 0,
    )
    session.add(op)
    session.commit()
    session.refresh(op)
    if failed:
        raise ProviderFailed(f"второе мнение не получено: {op.error}")
    return to_api(op)
