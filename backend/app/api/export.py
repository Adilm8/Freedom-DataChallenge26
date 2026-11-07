from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse, Response
from sqlmodel import Session, select

from ..config import settings
from ..db import get_session
from ..models import ChecklistVersion, Conversation
from ..services import results_export, table_export

router = APIRouter(tags=["export"])


@router.get("/export/results")
def export_results(group_id: str = Query(default=None), team: str | None = None, mode: str | None = None,
                   session: Session = Depends(get_session)) -> JSONResponse:
    """results.json в формате организаторов (1.0) и итог проверки в заголовке `X-Validation-Errors`."""
    group = group_id or settings.dataset_group_id
    doc = results_export.build(session, group, team_name=team or settings.team_name or "—",
                               mode=mode if mode in results_export.MODES else settings.model_mode)
    ids = list(session.exec(select(Conversation.conversation_id).where(
        Conversation.group_id == group, Conversation.source != "manual")))
    errs = results_export.validate(doc, expected_ids=ids)
    return JSONResponse(doc, headers={"Content-Disposition": f'attachment; filename="results-{group}.json"',
                                      "X-Validation-Errors": str(len(errs))})


@router.get("/export")
def export_table(group_id: str | None = None, checklist_version_id: int | None = None,
                 fmt: str = Query(default="csv", alias="format"), session: Session = Depends(get_session)) -> Response:
    """Результаты группы файлом (FR-EXP-01): CSV для Excel (UTF-8 с BOM, `;`) или JSON с обоснованиями."""
    fmt = (fmt or "csv").lower()
    if fmt not in table_export.FORMATS:
        raise HTTPException(400, f"формат: {', '.join(table_export.FORMATS)}")
    if checklist_version_id and not session.get(ChecklistVersion, checklist_version_id):
        raise HTTPException(404, "версия чек-листа не найдена")
    group = group_id or settings.dataset_group_id
    ver, cols, rows = table_export.build(session, group, checklist_version_id)
    headers = {"Content-Disposition": f'attachment; filename="{table_export.filename(group, ver, fmt)}"'}
    if fmt == "json":
        return JSONResponse(rows, headers=headers)
    return Response(table_export.to_csv(cols, rows), media_type="text/csv; charset=utf-8", headers=headers)
