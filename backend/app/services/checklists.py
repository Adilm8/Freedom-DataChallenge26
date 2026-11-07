"""Версии чек-листов: создание, активация, засев (FR-CHK-01, 03…05)."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from pydantic import ValidationError
from sqlmodel import Session, select

from ..domain import Checklist
from ..models import ChecklistVersion

DEFAULT_PATH = Path(__file__).resolve().parents[3] / "data" / "checklists" / "default.json"


class ChecklistInvalid(Exception):
    def __init__(self, errors: list[dict]):
        self.errors = errors
        super().__init__("чек-лист не прошёл проверку")


def body_hash(body: dict) -> str:
    return hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def validate(body: dict) -> Checklist:
    try:
        return Checklist.model_validate(body)
    except ValidationError as e:
        errs = []
        for err in e.errors():
            path = ".".join(str(p) for p in err["loc"])
            msg = str(err["msg"]).removeprefix("Value error, ")
            errs.append({"path": path, "message": msg})
        raise ChecklistInvalid(errs) from None


def seed_default(session: Session) -> ChecklistVersion | None:
    if session.exec(select(ChecklistVersion)).first():
        return None
    body = json.loads(DEFAULT_PATH.read_text(encoding="utf-8"))
    ver, _ = create_version(session, body, note="Исходный чек-лист", activate=True)
    return ver


def create_version(
    session: Session, body: dict, note: str = "", parent_id: int | None = None, activate: bool = False
) -> tuple[ChecklistVersion, list[str]]:
    """Возвращает (версия, предупреждения). Одинаковое тело с той же базой не плодит версию."""
    cl = validate(body)
    warnings = cl.warnings()
    h = body_hash(body)
    existing = session.exec(
        select(ChecklistVersion).where(
            ChecklistVersion.checklist_key == cl.key,
            ChecklistVersion.body_hash == h,
            ChecklistVersion.parent_id == parent_id,
        )
    ).first()
    if existing:
        ver = existing
    else:
        last = session.exec(
            select(ChecklistVersion).where(ChecklistVersion.checklist_key == cl.key).order_by(ChecklistVersion.version.desc())
        ).first()
        ver = ChecklistVersion(
            checklist_key=cl.key,
            version=(last.version + 1) if last else 1,
            name=cl.name,
            note=note,
            body=body,
            body_hash=h,
            parent_id=parent_id,
            is_active=False,
        )
        session.add(ver)
        session.flush()
    if activate:
        return activate_version(session, ver.id), warnings
    session.commit()
    session.refresh(ver)
    return ver, warnings


def activate_version(session: Session, version_id: int) -> ChecklistVersion:
    ver = session.get(ChecklistVersion, version_id)
    if not ver:
        raise LookupError(version_id)
    # активная версия одна на всю систему: её оценивают прогоны и по ней собирается файл сдачи
    for other in session.exec(select(ChecklistVersion).where(
            (ChecklistVersion.is_active == True) | (ChecklistVersion.id == ver.id))):  # noqa: E712
        other.is_active = other.id == ver.id
        session.add(other)
    session.commit()
    session.refresh(ver)
    return ver


# имя из брифа
activate = activate_version


def get_active(session: Session, key: str | None = None) -> ChecklistVersion | None:
    q = select(ChecklistVersion).where(ChecklistVersion.is_active == True)  # noqa: E712
    if key:
        q = q.where(ChecklistVersion.checklist_key == key)
    return session.exec(q.order_by(ChecklistVersion.id.desc())).first()
