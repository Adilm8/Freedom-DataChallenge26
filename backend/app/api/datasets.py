import json

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlmodel import Session

from ..config import settings
from ..db import get_session
from ..services import ingest

router = APIRouter(prefix="/datasets", tags=["datasets"])

MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # набор DEV (65 диалогов) — около 0,5 МБ; 25 МБ — с большим запасом
CHUNK = 1024 * 1024


class ImportBody(BaseModel):
    group_id: str | None = None


@router.post("/import")
def import_dataset(body: ImportBody, session: Session = Depends(get_session)) -> dict:
    if not settings.organizer_api_url:
        raise HTTPException(400, "ORGANIZER_API_URL не задан в .env — импорт из API недоступен, загрузите файл")
    group = (body.group_id or "").strip() or settings.dataset_group_id
    try:
        return ingest.import_from_api(session, group)
    except ingest.IngestError as e:
        raise HTTPException(502, str(e))


def _too_large() -> HTTPException:
    mb = f"{MAX_UPLOAD_BYTES / (1024 * 1024):g}"
    return HTTPException(413, f"файл больше {mb} МБ — разделите набор на части или импортируйте его из API организаторов")


async def _read_limited(file: UploadFile) -> bytes:
    """Читает файл кусками и останавливается, как только размер превысил лимит (а не грузит всё в память)."""
    if file.size is not None and file.size > MAX_UPLOAD_BYTES:
        raise _too_large()
    buf = bytearray()
    while chunk := await file.read(CHUNK):
        buf += chunk
        if len(buf) > MAX_UPLOAD_BYTES:
            raise _too_large()
    return bytes(buf)


@router.post("/upload")
async def upload_dataset(file: UploadFile = File(...), session: Session = Depends(get_session)) -> dict:
    raw = await _read_limited(file)
    try:
        payload = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError):
        raise HTTPException(400, "файл не является корректным JSON")
    try:
        return ingest.import_payload(session, payload, "upload")
    except ingest.IngestError as e:
        raise HTTPException(400, str(e))
