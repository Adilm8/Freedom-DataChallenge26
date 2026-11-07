from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from sqlmodel import Session, select

from ..config import settings
from ..db import get_session
from ..domain import Checklist
from ..models import ChecklistVersion, Conversation
from ..services import results_export

router = APIRouter(tags=["export"])


@router.get("/export/results")
def export_results(group_id: str = Query(default=None), team: str | None = None, mode: str | None = None,
                   session: Session = Depends(get_session)) -> JSONResponse:
    """results.json в формате организаторов (1.0) и итог проверки в заголовке `X-Validation-Errors`."""
    group = group_id or settings.dataset_group_id
    doc = results_export.build(session, group, team_name=team or settings.team_name or "—",
                               mode=mode if mode in results_export.MODES else settings.model_mode)
    ver = session.exec(select(ChecklistVersion).where(ChecklistVersion.is_active == True)).first()  # noqa: E712
    ids = list(session.exec(select(Conversation.conversation_id).where(Conversation.group_id == group)))
    errs = results_export.validate(doc, Checklist.model_validate(ver.body), expected_ids=ids) if ver else []
    return JSONResponse(doc, headers={"Content-Disposition": f'attachment; filename="results-{group}.json"',
                                      "X-Validation-Errors": str(len(errs))})
