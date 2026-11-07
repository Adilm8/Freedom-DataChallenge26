"""Песочница критерия: проверить новый или изменённый критерий на нескольких диалогах до сохранения версии.

Один вызов модели на диалог (только этот критерий, стратегия `single`), тем же конвейером, что и
обычная оценка: тот же промпт, факты, проверка цитат, страховки и маскирование данных. Оценки
диалогов не меняются; результат и вызовы пишутся в `criterion_trial`. Рядом — прошлый ответ по
критерию с тем же кодом из последней оценки диалога, чтобы видеть «было → стало».
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from sqlmodel import Session

from .. import db
from ..domain import Checklist, NormalizedConversation
from ..models import Conversation, CriterionTrial
from ..providers import ProviderError, get_provider
from . import evaluator, latest

MAX_DIALOGS = 5


def _call_dump(c: evaluator.CallRecord) -> dict:
    r = c.result
    if not r:
        return {"attempt": c.attempt, "error": c.error}
    return {"attempt": c.attempt, "provider": r.provider, "model": r.model, "finish_reason": r.finish_reason,
            "tokens_in": r.tokens_in, "tokens_out": r.tokens_out, "cost_usd": r.cost_usd or 0.0,
            "latency_ms": r.latency_ms, "request": r.request, "response_raw": r.text}


def _previous(session: Session, conv_pk: int, key: str) -> dict | None:
    ev = latest.latest_map(session, [conv_pk]).get(conv_pk)
    if not ev:
        return None
    row = latest.criterion_rows(session, [ev.id])[ev.id].get(key)
    if not row:
        return None
    return {"evaluation_id": ev.id, "answer": row.final_answer or row.ai_answer, "ai_answer": row.ai_answer,
            "reasoning": row.reasoning}


def _one(conv_pk: int, checklist: Checklist, key: str, provider_name: str, model: str,
         base_version_id: int | None, compare_key: str | None = None) -> dict:
    with Session(db.engine) as session:
        row = session.get(Conversation, conv_pk)
        if not row:
            return {"conversation_pk": conv_pk, "error": "диалог не найден"}
        conv = NormalizedConversation.model_validate(row.normalized)
        crit = next(c for c in checklist.criteria if c.key == key)
        base = {"conversation_pk": conv_pk, "conversation_id": row.conversation_id, "channel": row.channel,
                "language": row.language, "previous": _previous(session, conv_pk, compare_key or key)}
        try:
            out = evaluator.evaluate_conversation(conv, checklist, get_provider(provider_name), model=model,
                                                  strategy="single", criteria=[crit], reused_overview={})
        except ProviderError as e:
            return {**base, "error": str(e)}
        res = out.results.get(key)
        result = {
            "answer": res.answer if res else None,
            "reasoning": res.reasoning if res else "",
            "confidence": res.confidence if res else None,
            "evidence": res.evidence if res else [],
            "na_reason": res.na_reason if res else None,
            "issues": [i.message for i in out.issues if i.criterion in (None, key)],
            "status": out.status,
        }
        calls = [_call_dump(c) for c in out.calls]
        trial = CriterionTrial(conversation_pk=conv_pk, base_version_id=base_version_id, criterion=crit.model_dump(),
                               provider=provider_name, model=model, result=result, calls=calls, cost_usd=out.cost_usd)
        session.add(trial)
        session.commit()
        return {**base, **result, "trial_id": trial.id, "cost_usd": out.cost_usd, "tokens": list(out.tokens),
                "latency_ms": out.latency_ms,
                "error": None if out.status != "failed" else next((c.error for c in out.calls if c.error), "нет ответа")}


def run(checklist: Checklist, key: str, conv_pks: list[int], *, provider_name: str, model: str,
        base_version_id: int | None = None, compare_key: str | None = None) -> dict:
    """`compare_key` — с чьим прошлым ответом сравнивать (заменённый критерий); по умолчанию тот же код."""
    if not any(c.key == key for c in checklist.criteria):
        raise ValueError(f"в чек-листе нет критерия «{key}»")
    pks = list(dict.fromkeys(conv_pks))[:MAX_DIALOGS]
    with ThreadPoolExecutor(max_workers=max(1, len(pks))) as pool:
        items = list(pool.map(lambda pk: _one(pk, checklist, key, provider_name, model, base_version_id, compare_key), pks))
    return {"criterion_key": key, "compare_key": compare_key or key, "provider": provider_name, "model": model, "items": items,
            "cost_usd": round(sum(i.get("cost_usd") or 0 for i in items), 6)}
