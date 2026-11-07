"""Файл результатов для организаторов: `results/<dev|prod>/results.json`, формат 1.0 (docs/task/results-format.md).

В файл идут ответы AI (не решения по апелляциям): это результат работы системы. Диалог без готовой
оценки попадает со `status: "error"` и причиной, а не нулём. Коды критериев берутся из `export_id`
чек-листа, номера реплик — с 1 по исходному массиву транскрипта (у нас `m<idx>` с нуля).
"""

from __future__ import annotations

import math
import re

from sqlmodel import Session, select

from ..domain import Checklist, Criterion
from ..models import ChecklistVersion, Conversation, CriterionResult, Evaluation, LLMCall

SCHEMA_VERSION = "1.0"
MODES = ("local", "external_api", "hybrid")
# Коды и допустимые значения из приложения организаторов — фиксированы, от активного чек-листа не зависят.
_B, _BN = {True, False}, {True, False, None}
ORGANIZER_CRITERIA: dict[str, set] = {
    "contact": _B, "discovery": _BN, "identification": _BN, "consultation": {0, 5, 10, 15, 20, None},
    "empathy": _B, "dialogue": {0, 4, 7, 10}, "closure": _BN, "critical": _B,
}
# Веса из приложения организаторов: итог в файле сдачи их независимая проверка пересчитывает с этими весами.
ORGANIZER_WEIGHTS = {"contact": 10, "discovery": 15, "identification": 20, "consultation": 20, "empathy": 15,
                     "dialogue": 15, "closure": 5}
_MSG_RE = re.compile(r"^m(\d+)$")
RATIONALE_MAX = 600


def export_value(c: Criterion, answer):
    """yes → true, no → false, N/A → null, ступень шкалы → число до учёта веса."""
    if answer in (None, "", "na"):
        return None
    if c.type == "scale":
        return int(answer)
    return answer == "yes"


def _show(v) -> str:
    return "N/A" if v is None else ("true" if v is True else "false" if v is False else str(v))


def format_issues(cl: Checklist) -> list[str]:
    """Чем включённые критерии чек-листа не ложатся в формат сдачи организаторов: нет или повторяется код,
    или критерий может дать значение, которого нет у кода (N/A у `empathy`, ступень 5 у `dialogue`).
    Такой файл не пройдёт `validate`, поэтому скрипт контроля проверяет это до платного прогона."""
    out: list[str] = []
    by_code: dict[str, list[str]] = {}
    for c in cl.enabled_criteria():
        code = c.export_id or c.key
        by_code.setdefault(code, []).append(c.key)
        if code not in ORGANIZER_CRITERIA:
            out.append(f"{c.key}: код «{code}» не из формата сдачи (нужны {', '.join(ORGANIZER_CRITERIA)})")
            continue
        if code in ORGANIZER_WEIGHTS and c.type != "flag" and c.weight != ORGANIZER_WEIGHTS[code]:
            out.append(f"{c.key} → {code}: вес {c.weight:g}, в формате сдачи {ORGANIZER_WEIGHTS[code]} — "
                       f"final_score не совпадёт с пересчётом по формату")
        bad = [v for v in (export_value(c, a) for a in c.allowed_answers()) if not _value_ok(code, v)]
        if bad:
            allowed = ", ".join(sorted((_show(v) for v in ORGANIZER_CRITERIA[code]), key=str))
            out.append(f"{c.key} → {code}: значения {', '.join(_show(v) for v in bad)} недопустимы в файле сдачи "
                       f"(для {code} допустимо: {allowed})")
    for code, keys in by_code.items():
        if len(keys) > 1:
            out.append(f"код «{code}» у нескольких включённых критериев: {', '.join(keys)}")
    if cl.settings.critical_policy != "flag":
        out.append(f"critical_policy «{cl.settings.critical_policy}»: в формате сдачи грубая ошибка не обнуляет итог")
    missing = [code for code in ORGANIZER_CRITERIA if code not in by_code]
    if missing:
        out.append(f"в файле сдачи не будет кодов: {', '.join(missing)}")
    return out


def turns(evidence: list[dict]) -> list[int]:
    out = set()
    for e in evidence or []:
        if e.get("quote_ok") is False:  # цитату проверка не нашла — в сдачу не отдаём
            continue
        m = _MSG_RE.match(str(e.get("msg_id", "")))
        if m:
            out.add(int(m.group(1)) + 1)
    return sorted(out)


def _short(text: str | None) -> str:
    t = " ".join((text or "").split())
    return t if len(t) <= RATIONALE_MAX else t[: RATIONALE_MAX - 1].rstrip() + "…"


def _pick(session: Session, conv_pk: int, version_id: int | None) -> tuple[Evaluation | None, Evaluation | None]:
    """(последняя полная оценка, последняя любая) для диалога и версии чек-листа."""
    q = select(Evaluation).where(Evaluation.conversation_pk == conv_pk)
    if version_id:
        q = q.where(Evaluation.checklist_version_id == version_id)
    evs = session.exec(q.order_by(Evaluation.id.desc())).all()
    return next((e for e in evs if e.status == "done"), None), (evs[0] if evs else None)


def _error_reason(session: Session, ev: Evaluation | None, conv_pk: int | None = None,
                  version_id: int | None = None) -> str:
    if ev is None:
        other = session.exec(select(Evaluation).where(Evaluation.conversation_pk == conv_pk, Evaluation.status == "done")
                             .order_by(Evaluation.id.desc())).first() if conv_pk is not None and version_id else None
        if other:  # оценён, но по другой версии: файл собирается по одной версии чек-листа
            have, want = session.get(ChecklistVersion, other.checklist_version_id), session.get(ChecklistVersion, version_id)
            return (f"Нет оценки по версии чек-листа v{want.version if want else version_id} (id {version_id}); "
                    f"последняя полная оценка — по v{have.version if have else other.checklist_version_id} "
                    f"(id {other.checklist_version_id}).")
        return "Диалог не оценивался."
    errs = [c.error for c in session.exec(select(LLMCall).where(LLMCall.evaluation_id == ev.id)) if c.error]
    if ev.status == "partial":
        return "Модель не вернула ответ по части критериев." + (f" {errs[0]}" if errs else "")
    return errs[0] if errs else "Не удалось получить ответ модели."


def build(session: Session, group_id: str, *, team_name: str, mode: str = "external_api",
          checklist_version_id: int | None = None, expected_ids: list[str] | None = None,
          skipped: dict[str, str] | None = None) -> dict:
    """`expected_ids` — ID набора из API: те, что не попали в БД, идут как error с причиной из `skipped`."""
    from .checklists import get_active

    version_id = checklist_version_id
    if version_id is None:
        active = get_active(session)
        version_id = active.id if active else None
    convs = session.exec(select(Conversation).where(Conversation.group_id == group_id,
                                                    Conversation.source != "manual")  # ручные — не часть набора
                         .order_by(Conversation.conversation_id)).all()
    models: list[str] = []
    tried: list[str] = []  # модели неудачных попыток: model.name не пуст, даже если ни один диалог не оценён
    results = []
    for conv in convs:
        ev, last = _pick(session, conv.id, version_id)
        if ev is None:
            if last and last.model and last.model not in tried:
                tried.append(last.model)
            results.append({"conversation_id": conv.conversation_id, "status": "error", "criteria": [],
                            "score": None, "error": _error_reason(session, last, conv.id, version_id)})
            continue
        cl = Checklist.model_validate(session.get(ChecklistVersion, ev.checklist_version_id).body)
        rows = {r.criterion_key: r for r in session.exec(select(CriterionResult).where(CriterionResult.evaluation_id == ev.id))}
        crit, flag = [], False
        for c in cl.enabled_criteria():
            r = rows.get(c.key)
            value = export_value(c, r.ai_answer if r else None)
            if c.type == "flag":
                flag = flag or value is True
            crit.append({"criterion_id": c.export_id or c.key, "value": value,
                         "rationale": _short(r.reasoning if r else ""), "evidence_turns": turns(r.evidence if r else [])})
        total = (ev.ai_score or {}).get("total")
        results.append({"conversation_id": conv.conversation_id, "status": "ok", "criteria": crit,
                        "score": {"final_score": total, "critical_flag": flag}})
        if ev.model and ev.model not in models:
            models.append(ev.model)
    have = {r["conversation_id"] for r in results}
    for cid in expected_ids or []:
        if cid not in have:
            have.add(cid)
            results.append({"conversation_id": cid, "status": "error", "criteria": [], "score": None,
                            "error": (skipped or {}).get(cid) or "Запись набора не импортирована."})
    return {"schema_version": SCHEMA_VERSION, "team_name": team_name,
            "model": {"mode": mode, "name": ", ".join(models or tried)}, "results": results}


def _value_ok(code: str, v) -> bool:
    """Сравнение по типу: 1 ≠ true и 0 ≠ false (в Python они равны)."""
    return any(type(a) is type(v) and a == v for a in ORGANIZER_CRITERIA[code])


def validate(doc: dict, checklist: Checklist | None = None, *, expected_ids: list[str] | None = None,
             expected_count: int | None = None) -> list[str]:
    """Проверка перед push по формату организаторов: структура, ровно их 8 кодов и типы значений,
    одна запись на каждый диалог набора. `checklist` не используется: формат фиксирован."""
    errs: list[str] = []
    if doc.get("schema_version") != SCHEMA_VERSION:
        errs.append(f"schema_version должен быть «{SCHEMA_VERSION}»")
    if not isinstance(doc.get("team_name"), str) or not doc["team_name"].strip():
        errs.append("team_name пуст")
    m = doc.get("model") or {}
    if m.get("mode") not in MODES:
        errs.append(f"model.mode: одно из {MODES}")
    if not isinstance(m.get("name"), str) or not m["name"].strip():
        errs.append("model.name пуст")
    res = doc.get("results")
    if not isinstance(res, list):
        return errs + ["results должен быть массивом"]
    ids = [r.get("conversation_id") for r in res]
    dup = sorted({i for i in ids if ids.count(i) > 1})
    if dup:
        errs.append(f"повторяются ID: {dup}")
    if expected_ids is not None:
        miss, extra = sorted(set(expected_ids) - set(ids)), sorted(set(ids) - set(expected_ids))
        if miss:
            errs.append(f"нет записей для: {miss}")
        if extra:
            errs.append(f"лишние ID: {extra}")
    if expected_count is not None and len(res) != expected_count:
        errs.append(f"записей {len(res)}, нужно ровно {expected_count}")
    for r in res:
        cid = r.get("conversation_id")
        if r.get("status") == "error":
            if r.get("criteria") != [] or r.get("score") is not None or not str(r.get("error") or "").strip():
                errs.append(f"{cid}: у ошибки нужны criteria=[], score=null и причина в error")
            continue
        if r.get("status") != "ok":
            errs.append(f"{cid}: status — ok или error")
            continue
        got = [c.get("criterion_id") for c in r.get("criteria") or []]
        if sorted(got) != sorted(ORGANIZER_CRITERIA):
            errs.append(f"{cid}: нужны все критерии ровно по разу {sorted(ORGANIZER_CRITERIA)}, есть {got}")
        flag_value = None
        for item in r.get("criteria") or []:
            code = item.get("criterion_id")
            if code not in ORGANIZER_CRITERIA:
                continue
            if not _value_ok(code, item.get("value")):
                errs.append(f"{cid}: {item['criterion_id']} — недопустимое значение {item.get('value')!r}")
            if not isinstance(item.get("rationale"), str):
                errs.append(f"{cid}: {item['criterion_id']} — rationale должен быть строкой")
            t = item.get("evidence_turns")
            if not isinstance(t, list) or any(not isinstance(x, int) or isinstance(x, bool) or x < 1 for x in t):
                errs.append(f"{cid}: {item['criterion_id']} — evidence_turns: список номеров с 1")
            if code == "critical":
                flag_value = item.get("value")
        s = r.get("score") or {}
        fs = s.get("final_score")
        if fs is not None and (not isinstance(fs, (int, float)) or isinstance(fs, bool) or math.isnan(fs)
                               or not 0 <= fs <= 100 or round(fs, 2) != fs):
            errs.append(f"{cid}: final_score — число 0–100 с двумя знаками")
        if s.get("critical_flag") is not (flag_value is True):
            errs.append(f"{cid}: critical_flag должен совпадать со значением критерия-флага")
    return errs
