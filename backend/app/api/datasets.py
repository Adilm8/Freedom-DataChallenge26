import json

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlmodel import Session

from ..config import settings
from ..db import get_session
from ..services import ingest

router = APIRouter(prefix="/datasets", tags=["datasets"])


class ImportBody(BaseModel):
    group_id: str | None = None


@router.post("/import")
def import_dataset(body: ImportBody, session: Session = Depends(get_session)) -> dict:
    if not settings.organizer_api_url:
        raise HTTPException(400, "ORGANIZER_API_URL не задан в .env — импорт из API недоступен, загрузите файл")
    try:
        return ingest.import_from_api(session, body.group_id or settings.dataset_group_id)
    except ingest.IngestError as e:
        raise HTTPException(502, str(e))


@router.post("/upload")
async def upload_dataset(file: UploadFile = File(...), session: Session = Depends(get_session)) -> dict:
    raw = await file.read()
    try:
        payload = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError):
        raise HTTPException(400, "файл не является корректным JSON")
    try:
        return ingest.import_payload(session, payload, "upload")
    except ingest.IngestError as e:
        raise HTTPException(400, str(e))
