import json

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlmodel import Session

from ..config import settings
from ..db import get_session
from ..services import ingest, results_import

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


class ResultsBody(BaseModel):
    target: str = "dev"          # results/<target>/results.json в репозитории
    group_id: str | None = None  # по умолчанию: dev → DEV, иначе группа из .env
    replace: bool = False        # True — загрузить и для диалогов, у которых уже есть оценка


@router.post("/load-results")
def load_results(body: ResultsBody, session: Session = Depends(get_session)) -> dict:
    """Готовый файл сдачи → оценки в БД, без вызовов модели (services/results_import.py)."""
    from ..main import ROOT

    if body.target not in ("dev", "prod"):
        raise HTTPException(400, "target: dev или prod")
    path = results_import.results_path(ROOT, body.target)
    if not path.exists():
        raise HTTPException(404, f"нет файла results/{body.target}/results.json")
    group = (body.group_id or "").strip() or results_import.AUTOLOAD.get(body.target) or settings.dataset_group_id
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        return results_import.import_results(session, doc, group, replace=body.replace,
                                             source=f"results/{body.target}/results.json")
    except (ValueError, results_import.ResultsImportError) as e:
        raise HTTPException(400, str(e))
