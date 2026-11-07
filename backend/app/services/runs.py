"""Фоновые прогоны оценки (ADR-008): поток + пул по диалогам, у каждой задачи своя сессия."""
from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor

from sqlmodel import Session

from .. import db
from ..models import Evaluation, EvaluationRun, utcnow
from . import checklists, evaluations

MAX_WORKERS = 4
log = logging.getLogger(__name__)


def active_version_id(session: Session) -> int | None:
    v = checklists.get_active(session)
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
        except Exception as e:  # noqa: BLE001  один диалог не валит прогон, но причина остаётся в БД
            log.exception("оценка диалога %s в прогоне %s упала", pk, run_id)
            ok = False
            try:
                with Session(db.engine) as s:
                    evaluations.record_failure(s, pk, version_id, f"{type(e).__name__}: {e}", provider_name=provider,
                                               model=model, strategy=strategy, run_id=run_id)
            except Exception:  # noqa: BLE001
                log.exception("не удалось записать ошибку оценки %s", pk)
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


def create_run(session: Session, conv_pks: list[int], *, group_id: str, version_id: int | None, provider: str,
               model: str, strategy: str) -> int:
    run = EvaluationRun(group_id=group_id, checklist_version_id=version_id, provider=provider, model=model,
                        strategy=strategy, status="queued", total=len(conv_pks))
    session.add(run)
    session.commit()
    return run.id


def run_sync(session: Session, conv_pks: list[int], *, group_id: str = "", checklist_version_id: int | None = None,
             provider: str, model: str, strategy: str, reuse: str = "none") -> int:
    """То же, что фоновый прогон, но в текущем потоке (скрипт контроля, тесты)."""
    version_id = checklist_version_id or active_version_id(session)
    run_id = create_run(session, conv_pks, group_id=group_id, version_id=version_id, provider=provider, model=model,
                        strategy=strategy)
    _execute(run_id, list(conv_pks), version_id, provider, model, strategy, reuse)
    return run_id


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
    run_id = create_run(session, conv_pks, group_id=group_id, version_id=version_id, provider=provider, model=model,
                        strategy=strategy)
    threading.Thread(target=_execute, args=(run_id, list(conv_pks), version_id, provider, model, strategy, reuse),
                     daemon=True).start()
    return run_id
