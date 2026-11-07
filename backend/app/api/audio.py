"""Прокси записи звонка: GET /api/conversations/{id}/audio (FR-CARD-04).

Подписанная ссылка на запись (`Conversation.audio_url`, с `sig`) — секрет: в браузер, в ответы и в логи
она не попадает. Браузер получает запись только через этот прокси.

Перемотка в `<audio>` требует ответов на `Range`. Если источник сам умеет `Range` (206), ответ
передаётся потоком как есть. Если источник `Range` игнорирует (200 на весь файл), прокси:
- на запрос без `Range` или с `bytes=0-` отдаёт поток сразу и попутно кладёт файл в память;
- на запрос с другого места скачивает файл целиком и отдаёт нужный кусок (206).
Кэш в памяти небольшой (LRU).

Локальные записи: если в `settings.audio_dir` (по умолчанию `data/audio/`, в .gitignore) лежит
`<conversation_id>.<mp3|wav|ogg|m4a|webm|flac>`, она отдаётся оттуда, без сети. Так работают записи, скачанные
заранее (`scripts/fetch_audio.py`), если ссылка устарела или хост закрыт.

Ссылка организаторов (flow Power Platform) отдаёт не аудио, а HTML-страницу с `<audio><source src=…>`: короткоживущей
ссылкой на файл. Прокси достаёт эту ссылку, скачивает файл целиком и сохраняет его в `audio_dir`, чтобы перемотка и
повторные открытия работали после истечения ссылки.

Отдаём только `audio/*` и `video/*` (иначе `application/octet-stream`) с `nosniff` и `sandbox`: ответ источника
не может стать страницей в нашем origin. Ссылки берутся только из набора организаторов (ручной ввод их не задаёт).
"""
from __future__ import annotations

import logging
import re
import html as html_lib
from collections import OrderedDict
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from sqlmodel import Session

from ..config import settings
from ..db import get_session
from ..models import Conversation

router = APIRouter(prefix="/conversations", tags=["audio"])
log = logging.getLogger(__name__)
# httpx на уровне INFO пишет полный URL запроса, а в нём подпись: держим его логгер на WARNING.
logging.getLogger("httpx").setLevel(logging.WARNING)

MAX_CACHE_ITEM = 80 * 1024 * 1024
MAX_CACHE_TOTAL = 240 * 1024 * 1024
CACHE_CONTROL = "private, max-age=600"
_RANGE_RE = re.compile(r"^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*(?:,.*)?$", re.I)


def make_client() -> httpx.AsyncClient:
    """Клиент к источнику записи. Тесты подменяют эту функцию (httpx.MockTransport)."""
    return httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0), follow_redirects=True, max_redirects=5)


class _Cache:
    """LRU в памяти: ключ — (id диалога, исходная ссылка), значение — (байты, Content-Type)."""

    def __init__(self) -> None:
        self.items: OrderedDict[tuple[int, str], tuple[bytes, str]] = OrderedDict()

    def get(self, key: tuple[int, str]) -> tuple[bytes, str] | None:
        if key in self.items:
            self.items.move_to_end(key)
            return self.items[key]
        return None

    def put(self, key: tuple[int, str], data: bytes, ctype: str) -> None:
        if len(data) > MAX_CACHE_ITEM:
            return
        self.items[key] = (data, ctype)
        self.items.move_to_end(key)
        while sum(len(d) for d, _ in self.items.values()) > MAX_CACHE_TOTAL and len(self.items) > 1:
            self.items.popitem(last=False)

    def clear(self) -> None:
        self.items.clear()


cache = _Cache()
_types: dict[int, str] = {}  # тип записи, определённый по началу файла: для запросов с середины


def sniff(head: bytes) -> str | None:
    """Content-Type по сигнатуре файла."""
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "audio/wav"
    if head[:3] == b"ID3" or (len(head) > 1 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0):
        return "audio/mpeg"
    if head[:4] == b"OggS":
        return "audio/ogg"
    if head[:4] == b"fLaC":
        return "audio/flac"
    if head[4:8] == b"ftyp":
        return "audio/mp4"
    if head[:4] == b"\x1a\x45\xdf\xa3":
        return "audio/webm"
    return None


def _media_type(upstream: str | None, head: bytes, pk: int) -> str:
    found = sniff(head) if head else None
    if found:
        _types[pk] = found
        return found
    up = (upstream or "").split(";")[0].strip().lower()
    if up.startswith(("audio/", "video/")):
        return up
    return _types.get(pk) or "application/octet-stream"  # text/html и прочее источника не пропускаем


def parse_range(header: str | None, size: int | None) -> tuple[int, int | None] | None:
    """`bytes=a-b` → (start, end включительно | None). Несколько диапазонов — берём первый. Нет/мусор → None."""
    m = _RANGE_RE.match(header or "")
    if not m or (m.group(1) == "" and m.group(2) == ""):
        return None
    a, b = m.group(1), m.group(2)
    if a == "":  # суффикс: последние b байт
        if size is None:
            return None
        n = int(b)
        return (max(0, size - n), size - 1) if n else (size, size - 1)
    start, end = int(a), int(b) if b else None
    if end is not None and end < start:
        return None
    if size is not None and end is not None:
        end = min(end, size - 1)
    return start, end


_SAFE_HEADERS = {"X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox"}


def _base_headers(ctype: str) -> dict[str, str]:
    return {"Accept-Ranges": "bytes", "Cache-Control": CACHE_CONTROL, "Content-Type": ctype, **_SAFE_HEADERS}


def _from_bytes(data: bytes, ctype: str, range_header: str | None) -> Response:
    size = len(data)
    rng = parse_range(range_header, size)
    headers = _base_headers(ctype)
    if rng is None:
        return Response(content=data, status_code=200, headers=headers, media_type=ctype)
    start, end = rng
    end = size - 1 if end is None else end
    if start >= size or start > end:
        headers["Content-Range"] = f"bytes */{size}"
        return Response(status_code=416, headers=headers)
    headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return Response(content=data[start : end + 1], status_code=206, headers=headers, media_type=ctype)


def _upstream_error(status: int) -> HTTPException:
    if status in (401, 403):
        return HTTPException(502, f"Источник записи отклонил запрос ({status}): ссылка могла устареть — импортируйте набор заново")
    if status == 404:
        return HTTPException(502, "Источник записи не нашёл файл (404)")
    return HTTPException(502, f"Источник записи ответил ошибкой {status}")


AUDIO_EXT = {".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".webm": "audio/webm", ".flac": "audio/flac"}
_EXT_OF = {"audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/ogg": ".ogg", "audio/mp4": ".m4a", "audio/webm": ".webm", "audio/flac": ".flac"}
_SRC_RE = re.compile(r"<(?:source|audio)\b[^>]*?\bsrc\s*=\s*[\"']([^\"']+)[\"']", re.I)
MAX_HTML = 256 * 1024


def _safe_name(cid: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", cid or "").strip(".") or "_"


def local_file(conversation_id: str) -> Path | None:
    """Скачанная заранее запись диалога в `settings.audio_dir`, если есть."""
    d = Path(settings.audio_dir)
    name = _safe_name(conversation_id)
    for ext in AUDIO_EXT:
        f = d / f"{name}{ext}"
        if f.is_file() and f.stat().st_size > 0:
            return f
    return None


def save_local(conversation_id: str, data: bytes, ctype: str) -> None:
    """Кладёт скачанную запись в `audio_dir` (папка не в git). Ошибки записи не мешают отдаче."""
    ext = _EXT_OF.get(ctype)
    if not ext or not conversation_id:
        return
    try:
        d = Path(settings.audio_dir)
        d.mkdir(parents=True, exist_ok=True)
        tmp = d / f".{_safe_name(conversation_id)}{ext}.part"
        tmp.write_bytes(data)
        tmp.replace(d / f"{_safe_name(conversation_id)}{ext}")
    except OSError as e:
        log.warning("запись %s не сохранена локально (%s)", conversation_id, type(e).__name__)


def extract_media_url(page: str) -> str | None:
    """Ссылка на файл из HTML-страницы плеера (`<source src>` или `<audio src>`); только https."""
    m = _SRC_RE.search(page or "")
    if not m:
        return None
    url = html_lib.unescape(m.group(1)).strip()
    return url if url.lower().startswith("https://") else None


async def _download(client: httpx.AsyncClient, url: str) -> tuple[int, bytes]:
    async with client.stream("GET", url) as r:
        if r.status_code != 200:
            return r.status_code, b""
        buf = bytearray()
        async for chunk in r.aiter_bytes():
            buf.extend(chunk)
            if len(buf) > MAX_CACHE_ITEM:
                raise HTTPException(502, "Запись слишком большая")
        return 200, bytes(buf)


async def _from_html_page(up: httpx.Response, client: httpx.AsyncClient, pk: int, cid: str, key, range_header: str | None) -> Response:
    """Источник вернул страницу плеера: достаём ссылку на файл, качаем его, сохраняем локально, отдаём кусок."""
    page = bytearray()
    async for chunk in up.aiter_bytes():
        page.extend(chunk)
        if len(page) > MAX_HTML:
            break
    media = extract_media_url(page.decode("utf-8", "replace"))
    if not media:
        raise HTTPException(502, "Источник записи вернул страницу без ссылки на аудио")
    try:
        status, data = await _download(client, media)
    except httpx.HTTPError as e:
        log.warning("запись диалога %s: файл по ссылке со страницы недоступен (%s)", pk, type(e).__name__)
        raise HTTPException(502, "Файл записи недоступен: сеть не пускает к хранилищу записей. Положите скачанные записи в data/audio") from None
    if status != 200:
        log.warning("запись диалога %s: хранилище ответило %s", pk, status)
        raise _upstream_error(status)
    ctype = sniff(data[:16]) or "application/octet-stream"
    if not ctype.startswith("audio/"):
        raise HTTPException(502, "По ссылке со страницы лежит не аудио")
    _types[pk] = ctype
    cache.put(key, data, ctype)
    save_local(cid, data, ctype)
    return _from_bytes(data, ctype, range_header)


@router.get("/{pk}/audio")
async def conversation_audio(pk: int, request: Request, session: Session = Depends(get_session)) -> Response:
    c = session.get(Conversation, pk)
    if not c:
        raise HTTPException(404, "диалог не найден")
    range_header = request.headers.get("range")
    lf = local_file(c.conversation_id)
    if lf is not None:
        lkey = (pk, f"file:{lf}")
        hit = cache.get(lkey)
        if not hit:
            data = lf.read_bytes()
            hit = (data, sniff(data[:16]) or AUDIO_EXT[lf.suffix.lower()])
            cache.put(lkey, *hit)
        return _from_bytes(hit[0], hit[1], range_header)
    if not c.audio_url:
        raise HTTPException(404, "у диалога нет записи")
    src = c.audio_url
    key = (pk, src)

    hit = cache.get(key)
    if hit:
        return _from_bytes(hit[0], hit[1], range_header)

    client = make_client()
    try:
        up = await client.send(client.build_request("GET", src, headers={"Range": range_header} if range_header else {}), stream=True)
    except (httpx.HTTPError, httpx.InvalidURL, ValueError) as e:  # InvalidURL — не HTTPError
        await client.aclose()
        log.warning("запись диалога %s: источник недоступен (%s)", pk, type(e).__name__)
        raise HTTPException(502, "Источник записи недоступен: не удалось получить файл. Попробуйте позже") from None

    async def close() -> None:
        await up.aclose()
        await client.aclose()

    try:
        status = up.status_code
        if status == 416:
            await close()
            headers = {"Accept-Ranges": "bytes"}
            if up.headers.get("content-range"):
                headers["Content-Range"] = up.headers["content-range"]
            return Response(status_code=416, headers=headers)
        if status not in (200, 206):
            await close()
            log.warning("запись диалога %s: источник ответил %s", pk, status)
            raise _upstream_error(status)

        if status == 200 and "html" in up.headers.get("content-type", "").lower():
            try:
                return await _from_html_page(up, client, pk, c.conversation_id, key, range_header)
            finally:
                await close()

        encoded = up.headers.get("content-encoding", "identity").lower() not in ("", "identity")
        length = None if encoded else _int(up.headers.get("content-length"))
        rng = parse_range(range_header, length) if range_header else None

        if status == 200 and rng is not None and not (rng[0] == 0 and (rng[1] is None or (length is not None and rng[1] >= length - 1))):
            # Источник не умеет Range, а нужен кусок с середины: качаем целиком (с пределом) и режем.
            if length is not None and length > MAX_CACHE_ITEM:
                await close()
                raise HTTPException(502, "Запись слишком большая для перемотки: источник не поддерживает Range")
            buf = bytearray()
            async for chunk in up.aiter_bytes():
                buf.extend(chunk)
                if len(buf) > MAX_CACHE_ITEM:
                    await close()
                    raise HTTPException(502, "Запись слишком большая для перемотки: источник не поддерживает Range")
            await close()
            data = bytes(buf)
            ctype = _media_type(up.headers.get("content-type"), data[:16], pk)
            cache.put(key, data, ctype)
            save_local(c.conversation_id, data, ctype)
            return _from_bytes(data, ctype, range_header)

        it = up.aiter_bytes()
        try:
            first = await anext(it, b"")
        except httpx.HTTPError as e:
            await close()
            log.warning("запись диалога %s: обрыв при чтении (%s)", pk, type(e).__name__)
            raise HTTPException(502, "Источник записи оборвал передачу. Попробуйте позже") from None

        starts_at_zero = status == 200 or (up.headers.get("content-range", "").replace(" ", "").lower().startswith("bytes0-"))
        ctype = _media_type(up.headers.get("content-type"), first[:16] if starts_at_zero else b"", pk)
        headers = _base_headers(ctype)
        out_status = status
        if status == 206:
            if up.headers.get("content-range"):
                headers["Content-Range"] = up.headers["content-range"]
            if length is not None:
                headers["Content-Length"] = str(length)
        else:
            if length is not None:
                headers["Content-Length"] = str(length)
                if rng is not None and length > 0:  # bytes=0- при источнике без Range: тот же поток, но как 206
                    out_status = 206
                    headers["Content-Range"] = f"bytes 0-{length - 1}/{length}"
        tee = status == 200  # полный файл: попутно кладём в кэш, чтобы следующая перемотка шла из памяти

        async def body():
            buf: bytearray | None = bytearray() if tee else None
            complete = False
            try:
                if first:
                    if buf is not None:
                        buf.extend(first)
                    yield first
                async for chunk in it:
                    if buf is not None:
                        buf = None if len(buf) + len(chunk) > MAX_CACHE_ITEM else buf
                        if buf is not None:
                            buf.extend(chunk)
                    yield chunk
                complete = True
            except httpx.HTTPError as e:
                log.warning("запись диалога %s: обрыв при передаче (%s)", pk, type(e).__name__)
            finally:
                await close()
                if complete and buf is not None and (length is None or len(buf) == length):
                    cache.put(key, bytes(buf), ctype)
                    save_local(c.conversation_id, bytes(buf), ctype)

        return StreamingResponse(body(), status_code=out_status, headers=headers, media_type=ctype)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 — любая другая ошибка: закрыть соединение, без утечки URL
        await close()
        log.warning("запись диалога %s: ошибка прокси (%s)", pk, type(e).__name__)
        raise HTTPException(502, "Не удалось передать запись") from None


def _int(v: str | None) -> int | None:
    try:
        return int(v) if v is not None else None
    except ValueError:
        return None
