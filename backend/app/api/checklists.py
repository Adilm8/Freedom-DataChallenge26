from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import get_session
from ..models import ChecklistVersion
from ..services import checklists as svc

router = APIRouter(prefix="/checklists", tags=["checklists"])


def _short(v: ChecklistVersion) -> dict:
    return {
        "id": v.id,
        "key": v.checklist_key,
        "version": v.version,
        "name": v.name,
        "note": v.note,
        "is_active": v.is_active,
        "parent_id": v.parent_id,
        "created_at": v.created_at.isoformat(),
    }


def _full(v: ChecklistVersion) -> dict:
    return {**_short(v), "body": v.body}


class CreateBody(BaseModel):
    body: dict
    note: str = ""
    parent_id: int | None = None
    activate: bool = False


@router.get("")
def list_versions(session: Session = Depends(get_session)) -> list[dict]:
    q = select(ChecklistVersion).order_by(ChecklistVersion.checklist_key, ChecklistVersion.version.desc())
    return [_short(v) for v in session.exec(q)]


@router.get("/{version_id}")
def get_version(version_id: int, session: Session = Depends(get_session)) -> dict:
    v = session.get(ChecklistVersion, version_id)
    if not v:
        raise HTTPException(404, "версия чек-листа не найдена")
    return _full(v)


@router.post("")
def create(body: CreateBody, session: Session = Depends(get_session)):
    if body.parent_id is not None and not session.get(ChecklistVersion, body.parent_id):
        raise HTTPException(404, "родительская версия не найдена")
    try:
        v, warnings = svc.create_version(session, body.body, body.note, body.parent_id, body.activate)
    except svc.ChecklistInvalid as e:
        return JSONResponse(status_code=422, content={"detail": "чек-лист не прошёл проверку", "errors": e.errors})
    return {**_full(v), "warnings": warnings}


@router.post("/{version_id}/activate")
def activate(version_id: int, session: Session = Depends(get_session)) -> dict:
    try:
        return _full(svc.activate_version(session, version_id))
    except LookupError:
        raise HTTPException(404, "версия чек-листа не найдена")
