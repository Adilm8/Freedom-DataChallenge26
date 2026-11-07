"""Слова-подсказки о грубых нарушениях в репликах оператора (словари `risk_*`).

Это подсказка для полноты (recall), а не вердикт: решает модель по смыслу реплики. Внутренние реплики
(разговор с коллегой на удержании) тоже проверяются, но помечены `internal` — клиент их не слышит.
"""

from __future__ import annotations

from . import Fact, FactContext, item_formatter, register
from .lexicon import categories, find

RISK_PREFIX = "risk_"


@register({"risk_terms": "Слова-подсказки о грубых нарушениях (оскорбление, платная услуга в обход компании, раскрытие данных)"})
def risk_terms(ctx: FactContext) -> dict[str, Fact]:
    ops = ctx.by_role("operator", internal=None)
    if not ops:
        return {"risk_terms": Fact(value=None, note="оператор в диалоге не писал")}
    cats = [c for c in categories() if c.startswith(RISK_PREFIX)]
    hits: list[dict] = []
    for m in ops:
        for cat in cats:
            for h in find(cat, m.text):
                hits.append({"category": cat, "phrase": h.text, "msg_id": m.msg_id, "lang": h.lang, "internal": m.internal})
    ids = list(dict.fromkeys(h["msg_id"] for h in hits))
    note = "подсказка по словарю; решай по смыслу реплики" if hits else "по словарю ничего не найдено (это не доказывает отсутствие нарушения)"
    return {"risk_terms": Fact(value=hits, msg_ids=ids, note=note)}


@item_formatter("risk_terms")
def _fmt_term(d: dict) -> str:
    return f"{d['msg_id']} «{d['phrase']}» ({d['category']}{', внутренняя реплика' if d.get('internal') else ''})"
