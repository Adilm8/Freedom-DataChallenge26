from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from ..config import settings
from ..db import get_session
from ..models import ChecklistVersion
from ..services import analytics as analytics_svc
from ..services import latest as latest_svc
from ..services import review as review_svc

router = APIRouter(tags=["analytics"])


def _version(session: Session, version_id: int | None) -> int | None:
    if version_id and not session.get(ChecklistVersion, version_id):
        raise HTTPException(404, "версия чек-листа не найдена")
    ver = latest_svc.resolve_version(session, version_id)
    return ver.id if ver else None


@router.get("/analytics")
def analytics(group_id: str | None = None, checklist_version_id: int | None = None,
              session: Session = Depends(get_session)) -> dict:
    """Дашборд группы (FR-ANL-01): по последней оценке каждого диалога; версия по умолчанию — активная."""
    return analytics_svc.summarize(session, group_id or settings.dataset_group_id,
                                   _version(session, checklist_version_id))


@router.get("/review-queue")
def review_queue(group_id: str | None = None, checklist_version_id: int | None = None,
                 session: Session = Depends(get_session)) -> list[dict]:
    """Очередь «требует проверки» (FR-UX-02), важные сверху."""
    return review_svc.queue(session, group_id or settings.dataset_group_id, _version(session, checklist_version_id))
