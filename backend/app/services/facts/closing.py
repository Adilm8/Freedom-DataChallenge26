"""Завершение диалога: последняя реплика оператора, прощание, предложение помощи, кто закончил.

`ended_by`: первое системное событие завершения (`operator_closed`, `client_left`, `connection_lost`,
`client_ended`, `session_timeout`); без него — `normal` (последняя реплика за оператором) или `unknown`
(последняя реплика за клиентом или оператора нет). `ended_abruptly`: клиент ушёл, связь прервалась или
клиент завершил звонок раньше, чем оператор попрощался. Закрытие оператором и таймаут — не обрыв.

Окно завершения: в чате прощание ищется в последнем сообщении оператора, предложение помощи — в двух
последних; в звонке (ASR режет фразы) — в трёх и четырёх последних репликах оператора.
"""

from __future__ import annotations

import re

from ...domain import Message
from . import Fact, FactContext, msg_ref, register, speaker
from .lexicon import first as lex_first
from .timing import first_response

TERMINAL = ("operator_closed", "client_left", "connection_lost", "client_ended", "session_timeout")
ABRUPT = {"client_left", "connection_lost", "client_ended"}
ENDED_BY_NOTE = {
    "operator_closed": "оператор закрыл чат",
    "client_left": "клиент покинул чат",
    "connection_lost": "соединение с клиентом прервано",
    "client_ended": "клиент завершил разговор",
    "session_timeout": "сессия закрыта по таймауту",
}
# Благодарность или прощание клиента перед уходом — подсказка, что клиент сам закончил разговор.
CLIENT_THANKS = re.compile(r"\b(?:спасибо|благодарю|рахмет|рақмет|thanks|thank\s+you|thx)\b", re.IGNORECASE)


def _windows(ctx: FactContext) -> tuple[int, int]:
    return (3, 4) if ctx.conv.is_voice else (1, 2)


def _find_in(category: str, msgs: list[Message]):
    for m in reversed(msgs):
        hit = lex_first(category, m.text)
        if hit:
            return m, hit
    return None, None


@register({
    "last_operator_msg": "Последняя реплика оператора",
    "farewell_in_last_msg": "Прощание в последней реплике оператора",
    "help_offer_in_closing": "Предложение дальнейшей помощи в конце",
    "ended_by": "Как закончился диалог",
    "ended_abruptly": "Диалог оборвался до прощания оператора",
})
def closing(ctx: FactContext) -> dict[str, Fact]:
    conv = ctx.conv
    ops = ctx.operator_msgs
    k_bye, k_help = _windows(ctx)
    out: dict[str, Fact] = {}

    # --- последняя реплика, прощание, предложение помощи
    if not ops:
        none = "оператор клиенту не отвечал"
        out["last_operator_msg"] = Fact(value=None, note=none)
        out["farewell_in_last_msg"] = Fact(value=None, note=none)
        out["help_offer_in_closing"] = Fact(value=None, note=none)
    else:
        last = ops[-1]
        out["last_operator_msg"] = Fact(value=msg_ref(last), msg_ids=[last.msg_id])
        m, hit = _find_in("farewell", ops[-k_bye:])
        window_note = f"последние {k_bye} реплики оператора (звонок)" if k_bye > 1 else None
        out["farewell_in_last_msg"] = (
            Fact(value=True, msg_ids=[m.msg_id], note="; ".join(x for x in (f"«{hit.text}»", window_note) if x))
            if hit else Fact(value=False, msg_ids=[last.msg_id], note=window_note)
        )
        first_ids = {x.msg_id for x in first_response(ctx)}
        window = [x for x in ops[-k_help:] if x.msg_id not in first_ids] if len(ops) > len(first_ids) else ops[-k_help:]
        m, hit = _find_in("help_offer", window)
        out["help_offer_in_closing"] = (
            Fact(value=True, msg_ids=[m.msg_id], note=f"«{hit.text}»")
            if hit else Fact(value=False, msg_ids=[x.msg_id for x in window],
                             note=f"в последних {k_help} репликах оператора (без первого ответа) не найдено")
        )

    # --- кто и как закончил
    term = next((e for e in conv.events if e.type in TERMINAL), None)
    if term is not None:
        out["ended_by"] = Fact(value=term.type, msg_ids=[term.msg_id], note=ENDED_BY_NOTE.get(term.type))
    else:
        talk = [m for m in conv.messages if speaker(m) in ("client", "operator") and not m.internal]
        if not ops:
            out["ended_by"] = Fact(value="unknown", note="события завершения нет; оператор клиенту не отвечал")
        elif talk and speaker(talk[-1]) == "operator":
            out["ended_by"] = Fact(value="normal", msg_ids=[talk[-1].msg_id], note="события завершения нет; последняя реплика за оператором")
        else:
            out["ended_by"] = Fact(value="unknown", msg_ids=[talk[-1].msg_id] if talk else [],
                                   note="события завершения нет; последняя реплика за клиентом, оператор на неё не ответил")

    # --- оборвался ли диалог до прощания оператора
    if term is None or term.type not in ABRUPT:
        reason = "оператор закрыл чат сам" if term is not None and term.type == "operator_closed" else "диалог не оборван клиентом или связью"
        out["ended_abruptly"] = Fact(value=False, msg_ids=[term.msg_id] if term else [], note=reason)
    else:
        before = [m for m in ops if m.idx < term.idx or (m.t_sec is not None and term.t_sec is not None and m.t_sec <= term.t_sec)]
        bye_msg, bye = _find_in("farewell", before[-k_bye:])
        if bye:
            out["ended_abruptly"] = Fact(value=False, msg_ids=[bye_msg.msg_id, term.msg_id],
                                         note=f"оператор попрощался в {bye_msg.msg_id} до события «{ENDED_BY_NOTE[term.type]}»")
        else:
            last_client = next((m for m in reversed(ctx.client_msgs) if m.idx < term.idx), None)
            notes = [f"{ENDED_BY_NOTE[term.type]} ({term.msg_id}) до прощания оператора"]
            if not before:
                notes.append("оператор к этому моменту клиенту не отвечал")
            if last_client is not None and (CLIENT_THANKS.search(last_client.text) or lex_first("farewell", last_client.text)):
                notes.append(f"перед уходом клиент поблагодарил или попрощался ({last_client.msg_id})")
            out["ended_abruptly"] = Fact(value=True, msg_ids=[term.msg_id], note="; ".join(notes))
    return out
