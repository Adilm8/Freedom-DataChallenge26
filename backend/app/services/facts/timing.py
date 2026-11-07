"""Эскалация, первая реплика оператора, задержка первого ответа и долгие паузы оператора.

- Эскалация: системное событие `escalation`; если его нет — `agent_joined`; если нет и его —
  первая реплика оператора (чат без бота: клиента сразу принял оператор).
- Первая реплика оператора — первая реплика оператора клиенту (не `internal`) после эскалации.
  В звонке подряд идущие короткие реплики оператора (ASR режет фразу) склеиваются в один первый ответ;
  в чате первый ответ — ровно первое сообщение (представиться вторым сообщением — уже не «в первом ответе»).
- Задержка первого ответа: от эскалации (или `agent_joined`); в чате без бота и без события эскалации —
  от первой реплики клиента. Порог — `settings.first_response_threshold_sec` (по умолчанию 180 с).
- Долгая пауза: клиент ждёт ответа оператора дольше порога (`settings.long_gap_threshold_sec`, если такое поле
  есть, иначе LONG_GAP_SEC). Ожидание считается от первой из подряд идущих реплик клиента до следующей реплики
  оператора; пауза оператор → оператор учитывается, только если перед ней оператор предупредил об ожидании.
  «Предупредил» — в последней реплике оператора перед паузой есть фраза из словаря `wait_warning`.
"""

from __future__ import annotations

from ...domain import Message
from . import Fact, FactContext, item_formatter, msg_ref, register, speaker
from .lexicon import first as lex_first

LONG_GAP_SEC = 120
VOICE_MERGE_SEC = 20     # звонок: следующая реплика оператора не позже чем через 20 с — тот же ответ
VOICE_MERGE_MAX = 4


def escalation(ctx: FactContext) -> tuple[Message | None, str]:
    def calc() -> tuple[Message | None, str]:
        for kind, source in (("escalation", "escalation_event"), ("agent_joined", "agent_joined")):
            e = next((e for e in ctx.conv.events if e.type == kind), None)
            if e is not None:
                return ctx.conv.messages[e.idx], source
        ops = ctx.operator_msgs
        return (ops[0], "first_operator_msg") if ops else (None, "none")

    return ctx.memo("escalation", calc)


def first_response(ctx: FactContext) -> list[Message]:
    """Сообщения первого ответа оператора (в чате — одно)."""

    def calc() -> list[Message]:
        ops = ctx.operator_msgs
        if not ops:
            return []
        esc, _ = escalation(ctx)
        after = [m for m in ops if esc is None or m.idx >= esc.idx]
        first = after[0] if after else ops[0]
        group = [first]
        if ctx.conv.is_voice:
            for m in ctx.conv.messages[first.idx + 1:]:
                prev = group[-1]
                if (speaker(m) != "operator" or m.internal or len(group) >= VOICE_MERGE_MAX
                        or m.t_sec is None or prev.t_sec is None or m.t_sec - prev.t_sec > VOICE_MERGE_SEC):
                    break
                group.append(m)
        return group

    return ctx.memo("first_response", calc)


def first_response_text(ctx: FactContext) -> str:
    return " ".join(m.text for m in first_response(ctx))


def long_gap_threshold(ctx: FactContext) -> float:
    return float(getattr(ctx.settings, "long_gap_threshold_sec", None) or LONG_GAP_SEC)


_SOURCE_NOTE = {
    "escalation_event": "по системному событию эскалации",
    "agent_joined": "события эскалации нет; по событию «оператор подключился»",
    "first_operator_msg": "события эскалации нет; переходом к оператору считаем его первую реплику",
}


@register({
    "escalation_at": "Переход к оператору",
    "first_operator_msg": "Первая реплика оператора клиенту",
    "first_response_delay_sec": "Задержка первого ответа оператора",
    "first_response_slow": "Первый ответ позже порога",
})
def opening(ctx: FactContext) -> dict[str, Fact]:
    esc, source = escalation(ctx)
    fr = first_response(ctx)
    thr = ctx.settings.first_response_threshold_sec

    if esc is None:
        esc_fact = Fact(value=None, note="нет ни события эскалации, ни реплик оператора")
    else:
        esc_fact = Fact(value={"msg_id": esc.msg_id, "t_sec": esc.t_sec, "timestamp": esc.timestamp, "source": source},
                        msg_ids=[esc.msg_id], note=_SOURCE_NOTE.get(source))

    if not fr:
        none = "оператор клиенту не отвечал"
        return {
            "escalation_at": esc_fact,
            "first_operator_msg": Fact(value=None, note=none),
            "first_response_delay_sec": Fact(value=None, note=none),
            "first_response_slow": Fact(value=None, note=none),
        }

    head = fr[0]
    first_fact = Fact(
        value={**msg_ref(head, text=False), "text": " ".join(m.text for m in fr)},
        msg_ids=[m.msg_id for m in fr],
        note=f"звонок: первый ответ склеен из {len(fr)} реплик подряд" if len(fr) > 1 else None,
    )

    # от какой реплики считать задержку
    ref, ref_note = None, None
    if source in ("escalation_event", "agent_joined"):
        ref, ref_note = esc, f"от {esc.msg_id}"
    elif not ctx.by_role("bot", internal=None):
        ref = next((m for m in ctx.client_msgs if m.idx < head.idx), None)
        ref_note = f"бота и события эскалации нет; от первой реплики клиента {ref.msg_id}" if ref else None
    delay = None
    if ref is not None and ref.t_sec is not None and head.t_sec is not None and head.t_sec >= ref.t_sec:
        delay = round(head.t_sec - ref.t_sec, 1)
    if delay is None:
        if ref is not None:
            why = "время реплик не разобрано или идёт не по порядку"
        elif ctx.by_role("bot", internal=None):
            why = "события эскалации нет, а до оператора был бот — момент перехода к оператору неизвестен"
        else:
            why = "оператор начал диалог первым — клиент ответа не ждал"
        delay_fact = Fact(value=None, note=why)
        slow_fact = Fact(value=None, note=f"порог {thr} с; задержка неизвестна")
    else:
        ids = [ref.msg_id, head.msg_id]
        delay_fact = Fact(value=delay, msg_ids=ids, note=f"{ref_note}; порог {thr} с")
        slow_fact = Fact(value=delay > thr, msg_ids=ids, note=f"порог {thr} с")
    return {"escalation_at": esc_fact, "first_operator_msg": first_fact,
            "first_response_delay_sec": delay_fact, "first_response_slow": slow_fact}


@register({
    "long_gaps": "Долгие паузы оператора",
    "long_gap_without_warning": "Есть долгая пауза без предупреждения об ожидании",
})
def long_gaps(ctx: FactContext) -> dict[str, Fact]:
    fr = first_response(ctx)
    thr = long_gap_threshold(ctx)
    if not fr:
        none = "оператор клиенту не отвечал"
        return {"long_gaps": Fact(value=None, note=none), "long_gap_without_warning": Fact(value=None, note=none)}

    holds = [s for s in ctx.conv.segments if s.type == "hold"]
    gaps: list[dict] = []
    last_op: Message = fr[-1]
    streak: Message | None = None  # первая реплика клиента, на которую оператор ещё не ответил
    for m in ctx.conv.messages[fr[-1].idx + 1:]:
        role = speaker(m)
        if m.internal or role not in ("client", "operator"):
            continue
        if role == "client":
            streak = streak or m
            continue
        start = streak or last_op
        warned_hit = lex_first("wait_warning", last_op.text)
        counts = streak is not None or warned_hit is not None  # оператор → оператор: только после предупреждения
        if counts and m.t_sec is not None and start.t_sec is not None and m.t_sec - start.t_sec > thr:
            on_hold = any(s.start_idx < m.idx and (s.end_idx is None or s.end_idx > start.idx) for s in holds)
            gaps.append({
                "sec": round(m.t_sec - start.t_sec),
                "from_msg_id": start.msg_id,
                "to_msg_id": m.msg_id,
                "waiting": "client" if streak is not None else "operator",
                "warned": warned_hit is not None,
                "warning_msg_id": last_op.msg_id if warned_hit else None,
                "warning": warned_hit.text if warned_hit else None,
                "on_hold": on_hold,
            })
        last_op, streak = m, None

    ids: list[str] = []
    for g in gaps:
        for k in ("warning_msg_id", "from_msg_id", "to_msg_id"):
            if g[k] and g[k] not in ids:
                ids.append(g[k])
    unwarned = [g for g in gaps if not g["warned"]]
    note = f"порог {thr:g} с"
    return {
        "long_gaps": Fact(value=gaps, msg_ids=ids, note=note),
        "long_gap_without_warning": Fact(value=bool(unwarned), msg_ids=[g["to_msg_id"] for g in unwarned],
                                         note=f"порог {thr:g} с"),
    }


@item_formatter("long_gaps")
def _fmt_gap(g: dict) -> str:
    s = f"{g['from_msg_id']}→{g['to_msg_id']}: {g['sec']} с"
    s += f", перед паузой предупреждение в {g['warning_msg_id']} («{g['warning']}»)" if g.get("warned") else ", без предупреждения"
    if g.get("on_hold"):
        s += ", клиент на удержании"
    return s
