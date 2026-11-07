"""Фоновые прогоны оценки (ADR-008): поток + пул по диалогам, у каждой задачи своя сессия."""
from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor

from sqlmodel import Session, select

from .. import db
from ..models import ChecklistVersion, Evaluation, EvaluationRun, utcnow
from . import evaluations

MAX_WORKERS = 4


def active_version_id(session: Session) -> int | None:
    v = session.exec(select(ChecklistVersion).where(ChecklistVersion.is_active == True)).first()  # noqa: E712
    return v.id if v else None


def _execute(run_id: int, conv_pks: list[int], version_id: int, provider: str, model: str, strategy: str,
             reuse: str = "none") -> None:
    lock = threading.Lock()
    with Session(db.engine) as s:
        run = s.get(EvaluationRun, run_id)
        run.status, run.started_at = "running", utcnow()
        s.add(run)
        s.commit()

    def task(pk: int) -> None:
        ok, cost = False, 0.0
        try:
            with Session(db.engine) as s:
                eid = evaluations.evaluate_one(s, pk, version_id, provider_name=provider, model=model,
                                               strategy=strategy, run_id=run_id, reuse=reuse)
                ev = s.get(Evaluation, eid)
                ok, cost = ev.status != "failed", ev.cost_usd or 0.0
        except Exception:  # noqa: BLE001  один диалог не валит прогон
            ok = False
        with lock, Session(db.engine) as s:
            run = s.get(EvaluationRun, run_id)
            run.done += 1 if ok else 0
            run.failed += 0 if ok else 1
            run.cost_usd += cost
            s.add(run)
            s.commit()

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        list(pool.map(task, conv_pks))

    with Session(db.engine) as s:
        run = s.get(EvaluationRun, run_id)
        run.status = "done" if run.failed == 0 else ("failed" if run.done == 0 else "partial")
        run.finished_at = utcnow()
        s.add(run)
        s.commit()


def start_run(
    session: Session,
    conv_pks: list[int],
    *,
    group_id: str = "",
    checklist_version_id: int | None = None,
    provider: str,
    model: str,
    strategy: str,
    reuse: str = "none",
) -> int:
    version_id = checklist_version_id or active_version_id(session)
    run = EvaluationRun(group_id=group_id, checklist_version_id=version_id, provider=provider, model=model,
                        strategy=strategy, status="queued", total=len(conv_pks))
    session.add(run)
    session.commit()
    run_id = run.id
    threading.Thread(target=_execute, args=(run_id, list(conv_pks), version_id, provider, model, strategy, reuse),
                     daemon=True).start()
    return run_id
