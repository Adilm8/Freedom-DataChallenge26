from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import get_session
from ..models import ChecklistVersion
from ..config import settings
from ..providers import configured_models
from ..services import checklists as svc
from ..services import trial as trial_svc

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


class TrialBody(BaseModel):
    body: dict                       # черновик чек-листа целиком (несохранённые правки тоже)
    criterion_key: str
    conversation_ids: list[int]      # id диалогов в БД, не больше 5
    base_version_id: int | None = None
    compare_key: str | None = None   # заменённый критерий: «было» берётся по его коду
    provider: str | None = None
    model: str | None = None


@router.post("/trial")
def trial(b: TrialBody):
    """Песочница: один критерий из черновика на 1–5 диалогах, без изменения их оценок (services/trial.py)."""
    try:
        checklist = svc.validate(b.body)
    except svc.ChecklistInvalid as e:
        return JSONResponse(status_code=422, content={"detail": "чек-лист не прошёл проверку", "errors": e.errors})
    if not b.conversation_ids:
        raise HTTPException(400, "выберите хотя бы один диалог")
    if len(b.conversation_ids) > trial_svc.MAX_DIALOGS:
        raise HTTPException(400, f"не больше {trial_svc.MAX_DIALOGS} диалогов за раз")
    provider = (b.provider or settings.llm_provider).strip().lower()
    known = {m["provider"]: m["model"] for m in configured_models()}
    if provider not in known:
        raise HTTPException(400, f"неизвестный провайдер «{provider}»")
    model = b.model or known[provider]
    if not model:
        raise HTTPException(400, f"у провайдера «{provider}» не задана модель")
    try:
        return trial_svc.run(checklist, b.criterion_key, b.conversation_ids, provider_name=provider, model=model,
                             base_version_id=b.base_version_id, compare_key=b.compare_key)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
