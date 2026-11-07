"""Приветствие и представление в первой реплике оператора (словари `greeting`, `intro`).

Приветствие бота не считается. Если в первом ответе нет приветствия или имени, отдельно сказано,
в какой реплике оператор поздоровался или представился впервые (`first_greeting_msg`, `first_intro_msg`).
"""

from __future__ import annotations

from . import Fact, FactContext, register
from .lexicon import first as lex_first
from .timing import first_response


def _first_hit(ctx: FactContext, category: str):
    for m in ctx.operator_msgs:
        hit = lex_first(category, m.text)
        if hit:
            return m, hit
    return None, None


@register({
    "greeting_in_first_msg": "Приветствие в первой реплике оператора",
    "intro_in_first_msg": "Представление (имя) в первой реплике оператора",
    "first_greeting_msg": "Первое приветствие оператора",
    "first_intro_msg": "Первое представление оператора",
})
def greeting(ctx: FactContext) -> dict[str, Fact]:
    fr = first_response(ctx)
    if not fr:
        none = "оператор клиенту не отвечал"
        return {k: Fact(value=None, note=none) for k in
                ("greeting_in_first_msg", "intro_in_first_msg", "first_greeting_msg", "first_intro_msg")}
    first_ids = {m.msg_id for m in fr}
    out: dict[str, Fact] = {}
    for category, in_first, first_name, what in (
        ("greeting", "greeting_in_first_msg", "first_greeting_msg", "приветствие"),
        ("intro", "intro_in_first_msg", "first_intro_msg", "представление"),
    ):
        hit_msg, hit = next(((m, h) for m in fr if (h := lex_first(category, m.text))), (None, None))
        if hit:
            out[in_first] = Fact(value=True, msg_ids=[hit_msg.msg_id], note=f"«{hit.text}» ({hit.lang})")
            out[first_name] = Fact(value={"msg_id": hit_msg.msg_id, "t_sec": hit_msg.t_sec, "phrase": hit.text, "lang": hit.lang},
                                   msg_ids=[hit_msg.msg_id])
            continue
        later_msg, later = _first_hit(ctx, category)
        if later_msg is not None and later_msg.msg_id not in first_ids:
            out[in_first] = Fact(value=False, msg_ids=[fr[0].msg_id, later_msg.msg_id],
                                 note=f"в первой реплике нет; {what} впервые в {later_msg.msg_id}: «{later.text}»")
            out[first_name] = Fact(value={"msg_id": later_msg.msg_id, "t_sec": later_msg.t_sec, "phrase": later.text, "lang": later.lang},
                                   msg_ids=[later_msg.msg_id], note="не в первой реплике")
        else:
            out[in_first] = Fact(value=False, msg_ids=[fr[0].msg_id], note=f"{what} по словарю не найдено")
            out[first_name] = Fact(value=None, note=f"{what} по словарю не найдено ни в одной реплике оператора")
    return out
