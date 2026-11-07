"""Импорт наборов диалогов: API организаторов или загруженный JSON (FR-DATA-01…04)."""
from __future__ import annotations

from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx
from sqlmodel import Session, select

from ..config import settings
from ..models import Conversation, DatasetImport, utcnow
from .normalize import normalize


class IngestError(Exception):
    """Понятная пользователю ошибка импорта (без секретных URL)."""


def with_group(url: str, group: str) -> str:
    parts = urlsplit(url)
    q = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k != "group_id"]
    q.append(("group_id", group))
    return urlunsplit(parts._replace(query=urlencode(q)))


def fetch_payload(group_id: str) -> dict:
    if not settings.organizer_api_url:
        raise IngestError("ORGANIZER_API_URL не задан в .env")
    try:
        r = httpx.get(with_group(settings.organizer_api_url, group_id), timeout=60)
        r.raise_for_status()
        return r.json()
    except httpx.HTTPStatusError as e:
        raise IngestError(f"API организаторов ответил кодом {e.response.status_code}") from None
    except (httpx.HTTPError, ValueError) as e:
        raise IngestError(f"не удалось получить набор: {type(e).__name__}") from None


def import_from_api(session: Session, group_id: str) -> dict:
    return import_payload(session, fetch_payload(group_id), "api", group_id=group_id)


def import_payload(session: Session, payload: Any, source: str = "upload", group_id: str | None = None) -> dict:
    if not isinstance(payload, dict):
        raise IngestError("ожидался JSON-объект в формате API организаторов")
    if payload.get("isSuccess") is False:
        raise IngestError(f"API вернул ошибку: {payload.get('error') or 'без текста'}")
    data = payload.get("data", payload)
    if not isinstance(data, dict) or not isinstance(data.get("records"), list):
        raise IngestError("в данных нет списка records")
    group = str(group_id or data.get("dataset_group_id") or settings.dataset_group_id)  # явный group_id важнее

    warnings: list[str] = []
    skipped: dict[str, str] = {}  # conversation_id → причина: в results.json такие идут как status=error
    imported = updated = 0
    imp = DatasetImport(group_id=group, source=source)
    session.add(imp)
    session.flush()

    for i, rec in enumerate(data["records"]):
        if not isinstance(rec, dict) or not str(rec.get("conversation_id") or "").strip():
            warnings.append(f"запись #{i}: нет conversation_id, пропущена")
            continue
        cid = str(rec["conversation_id"]).strip()
        try:
            norm = normalize(rec)
        except (ValueError, TypeError, KeyError, AttributeError) as e:
            warnings.append(f"{cid}: {e}; пропущена")
            skipped[cid] = f"Запись набора не разобрана: {e}"
            continue
        warnings.extend(f"{cid}: {w}" for w in norm.warnings)
        row = session.exec(
            select(Conversation).where(Conversation.group_id == group, Conversation.conversation_id == cid)
        ).first()
        fields = dict(
            channel=norm.channel,
            language=norm.language,
            audio_url=rec.get("audio_url") or None,
            transcript=rec["transcript"],
            normalized=norm.model_dump(),
            import_id=imp.id,
            imported_at=utcnow(),
        )
        if row:
            for k, v in fields.items():
                setattr(row, k, v)
            row.source = source
            updated += 1
        else:
            row = Conversation(group_id=group, conversation_id=cid, source=source, **fields)
            imported += 1
        session.add(row)

    imp.imported, imp.updated, imp.warnings = imported, updated, warnings
    session.add(imp)
    session.commit()
    return {"group_id": group, "imported": imported, "updated": updated, "warnings": warnings, "skipped": skipped}


def payload_ids(payload: Any) -> list[str]:
    """Все conversation_id набора как в API (для проверки файла сдачи: ни одна запись не должна пропасть)."""
    data = payload.get("data", payload) if isinstance(payload, dict) else {}
    recs = data.get("records") if isinstance(data, dict) else None
    return [str(r["conversation_id"]).strip() for r in recs or []
            if isinstance(r, dict) and str(r.get("conversation_id") or "").strip()]
