"""Загрузка готового файла сдачи (`results/<dev|prod>/results.json`, формат 1.0) в БД — без вызовов модели.

Зачем: прогон DEV мог идти на другой машине, и в локальной БД его оценок нет. Файл в репозитории — это
ответы той же модели; здесь они превращаются в обычные оценки, чтобы список, карточка, аналитика,
апелляции и экспорт работали на них как на своих. Баллы пересчитывает `scoring` по активному
чек-листу (как и у оценок из конвейера), файл даёт только ответы, обоснования и номера реплик.

Такие оценки помечены `provider = "file"` и `prompt_version = "results.json"`: в карточке видно, что это
загруженный результат, а не новый вызов модели. Вызовов LLM у них нет, стоимость 0.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlmodel import Session, select

from ..domain import Checklist, Criterion
from ..models import ChecklistVersion, Conversation, CriterionResult, Evaluation, EvaluationRun
from . import scoring
from .checklists import get_active

PROVIDER = "file"
PROMPT_VERSION = "results.json"
QUOTE_MAX = 240


class ResultsImportError(Exception):
    pass


def answer_from_value(c: Criterion, value):
    """Обратное к `results_export.export_value`: true → yes, false → no, null → na, число → ступень шкалы."""
    if value is None:
        return "na"
    if c.type == "scale":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{c.key}: ожидалась ступень шкалы, а не {value!r}")
        return int(value)
    if not isinstance(value, bool):
        raise ValueError(f"{c.key}: ожидалось true/false, а не {value!r}")
    return "yes" if value else "no"


def _evidence(conv: Conversation, turns) -> list[dict]:
    """Номера реплик с 1 → `m<idx>` с нуля; цитата — начало реплики (в файле сдачи самих цитат нет)."""
    msgs = (conv.normalized or {}).get("messages") or []
    out = []
    for t in turns or []:
        if not isinstance(t, int) or isinstance(t, bool) or t < 1 or t > len(msgs):
            continue
        text = " ".join(str(msgs[t - 1].get("text") or "").split())
        out.append({"msg_id": f"m{t - 1}", "quote": text[:QUOTE_MAX], "quote_ok": True})
    return out


def import_results(session: Session, doc: dict, group_id: str, *, checklist_version_id: int | None = None,
                   replace: bool = False, source: str = "results.json") -> dict:
    """Пишет оценки из файла сдачи. Диалоги, у которых уже есть полная оценка по этой версии чек-листа,
    пропускаются (если не `replace`): повторный запуск ничего не дублирует."""
    if not isinstance(doc, dict) or not isinstance(doc.get("results"), list):
        raise ResultsImportError("ожидался файл сдачи формата 1.0: объект с массивом results")
    ver = session.get(ChecklistVersion, checklist_version_id) if checklist_version_id else get_active(session)
    if not ver:
        raise ResultsImportError("нет активной версии чек-листа")
    cl = Checklist.model_validate(ver.body)
    by_code = {(c.export_id or c.key): c for c in cl.enabled_criteria()}
    model = str((doc.get("model") or {}).get("name") or "")
    convs = {c.conversation_id: c for c in session.exec(
        select(Conversation).where(Conversation.group_id == group_id, Conversation.source != "manual"))}

    report = {"group_id": group_id, "checklist_version_id": ver.id, "model": model, "imported": 0,
              "skipped_existing": 0, "skipped_error": 0, "missing": [], "problems": [], "run_id": None}
    todo = []
    for r in doc["results"]:
        cid = str(r.get("conversation_id") or "")
        conv = convs.get(cid)
        if conv is None:
            report["missing"].append(cid)
            continue
        if r.get("status") != "ok":
            report["skipped_error"] += 1
            continue
        has = session.exec(select(Evaluation.id).where(Evaluation.conversation_pk == conv.id,
                                                       Evaluation.checklist_version_id == ver.id,
                                                       Evaluation.status == "done")).first()
        if has and not replace:
            report["skipped_existing"] += 1
            continue
        todo.append((conv, r))
    if not todo:
        return report

    now = datetime.now(timezone.utc)
    run = EvaluationRun(group_id=group_id, checklist_version_id=ver.id, provider=PROVIDER, model=model,
                        strategy="import", prompt_version=PROMPT_VERSION, status="done", total=len(todo),
                        done=0, started_at=now, finished_at=now)
    session.add(run)
    session.flush()
    report["run_id"] = run.id

    for conv, r in todo:
        answers, rows = {}, []
        for item in r.get("criteria") or []:
            c = by_code.get(item.get("criterion_id"))
            if c is None:
                continue
            try:
                ans = c.coerce_answer(answer_from_value(c, item.get("value")))
            except ValueError as e:
                report["problems"].append(f"{conv.conversation_id}: {e}")
                continue
            answers[c.key] = ans
            rows.append((c, ans, item))
        score = scoring.compute(cl, answers)
        missing = [c.key for c in cl.enabled_criteria() if c.key not in answers]
        dump = score.model_dump()
        ev = Evaluation(
            conversation_pk=conv.id, checklist_version_id=ver.id, run_id=run.id, provider=PROVIDER, model=model,
            strategy="import", prompt_version=PROMPT_VERSION, status="partial" if missing else "done",
            params={"source": source}, ai_score=dump, final_score=dump, ai_total=score.total,
            final_total=score.total, critical=bool(score.critical), needs_review=False,
        )
        session.add(ev)
        session.flush()
        for c, ans, item in rows:
            cs = score.criteria.get(c.key)
            pts = cs.points if cs else None
            session.add(CriterionResult(
                evaluation_id=ev.id, criterion_key=c.key, ai_answer=str(ans), ai_points=pts,
                reasoning=str(item.get("rationale") or ""), evidence=_evidence(conv, item.get("evidence_turns")),
                confidence="medium",
                final_answer=str(ans), final_points=pts,
            ))
        run.done += 1
        report["imported"] += 1
    session.commit()
    return report


# Файлы сдачи в репозитории и группы их наборов. Контрольная группа заранее неизвестна, поэтому при старте
# подхватывается только DEV; prod загружается вручную (API или scripts/import_results.py --group).
AUTOLOAD = {"dev": "DEV"}


def results_path(root, target: str):
    return root / "results" / target / "results.json"


def autoload(session: Session, root) -> list[dict]:
    """При старте сервера: если в репозитории есть `results/dev/results.json`, а у диалогов DEV нет оценок
    по активному чек-листу, — загрузить их из файла. Нет набора в БД, но есть снапшот `data/raw/DEV.json` —
    сначала импортировать его. Ничего не вызывает у модели; повторный старт ничего не дублирует."""
    import json

    from . import ingest

    out = []
    for target, group in AUTOLOAD.items():
        path = results_path(root, target)
        if not path.exists():
            continue
        has_convs = session.exec(select(Conversation.id).where(Conversation.group_id == group)).first()
        raw = root / "data" / "raw" / f"{group}.json"
        if not has_convs and raw.exists():
            ingest.import_payload(session, json.loads(raw.read_text(encoding="utf-8-sig")), "file", group_id=group)
        doc = json.loads(path.read_text(encoding="utf-8"))
        out.append(import_results(session, doc, group, source=f"results/{target}/results.json"))
    return out
