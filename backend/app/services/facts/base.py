"""Счётчики реплик и канал."""

from __future__ import annotations

from . import Fact, FactContext, register


@register({
    "has_operator": "Оператор отвечал клиенту",
    "is_voice": "Звонок (расшифровка устной речи)",
    "operator_turns": "Реплик оператора клиенту",
    "client_turns": "Реплик клиента",
    "internal_turns": "Внутренних реплик оператора (клиент их не слышит: удержание, разговор с коллегой)",
    "bot_turns": "Реплик бота",
})
def counts(ctx: FactContext) -> dict[str, Fact]:
    ops = ctx.operator_msgs
    internal = ctx.by_role("operator", internal=True)
    has_op = bool(ops)
    note = None
    if not has_op:
        note = "оператор не писал клиенту" + (" (есть только внутренние реплики)" if internal else "")
    return {
        "has_operator": Fact(value=has_op, note=note),
        "is_voice": Fact(value=ctx.conv.is_voice),
        "operator_turns": Fact(value=len(ops)),
        "client_turns": Fact(value=len(ctx.client_msgs)),
        "internal_turns": Fact(value=len(internal), note="не считаются обращением к клиенту" if internal else None),
        "bot_turns": Fact(value=len(ctx.by_role("bot", internal=None))),
    }
