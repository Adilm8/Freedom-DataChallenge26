"""Фразы сочувствия и извинения оператора (словарь `empathy`) — подсказка, где искать реакцию на проблему."""

from __future__ import annotations

from . import Fact, FactContext, item_formatter, register
from .lexicon import find


@register({"empathy_phrases": "Фразы сочувствия или извинения оператора"})
def empathy(ctx: FactContext) -> dict[str, Fact]:
    ops = ctx.operator_msgs
    if not ops:
        return {"empathy_phrases": Fact(value=None, note="оператор клиенту не отвечал")}
    hits = [{"phrase": h.text, "msg_id": m.msg_id, "lang": h.lang} for m in ops for h in find("empathy", m.text)]
    return {"empathy_phrases": Fact(
        value=hits, msg_ids=list(dict.fromkeys(h["msg_id"] for h in hits)),
        note=None if hits else "по словарю не найдено; вежливость и реакцию на проблему оценивай по репликам",
    )}


@item_formatter("empathy_phrases")
def _fmt(d: dict) -> str:
    return f"{d['msg_id']} «{d['phrase']}»"
