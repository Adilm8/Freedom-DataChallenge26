"""Системные события (классифицированы в normalize по data/config/system_events.json) и идентификация."""

from __future__ import annotations

from . import Fact, FactContext, item_formatter, register


@register({
    "system_events": "Системные события",
    "identity_verified_at": "Подтверждение личности системным сообщением",
    "identity_verified": "Личность подтверждена системным сообщением",
})
def system_events(ctx: FactContext) -> dict[str, Fact]:
    evs = ctx.conv.events
    unknown = [m.msg_id for m in ctx.conv.messages if m.speaker.strip().lower() == "system" and not m.event]
    ev_fact = Fact(
        value=[{"type": e.type, "msg_id": e.msg_id, "t_sec": e.t_sec} for e in evs],
        msg_ids=[e.msg_id for e in evs],
        note=("нераспознанные системные сообщения: " + ", ".join(unknown)) if unknown else None,
    )
    iv = next((e for e in evs if e.type == "identity_verified"), None)
    if iv:
        at = Fact(value={"msg_id": iv.msg_id, "t_sec": iv.t_sec}, msg_ids=[iv.msg_id])
        ok = Fact(value=True, msg_ids=[iv.msg_id])
    else:
        hint = "в звонке проверка может идти голосом — смотри реплики" if ctx.conv.is_voice else None
        at = Fact(value=None, note="системного подтверждения личности нет" + (f"; {hint}" if hint else ""))
        ok = Fact(value=False, note=hint)
    return {"system_events": ev_fact, "identity_verified_at": at, "identity_verified": ok}


@item_formatter("system_events")
def _fmt_event(d: dict) -> str:
    return f"{d.get('msg_id')} {d.get('type')}"
