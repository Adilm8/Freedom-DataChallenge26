"""Скачать записи звонков набора в локальную папку `data/audio/` (не в git).

    python scripts/fetch_audio.py                      # из data/raw/DEV.json
    python scripts/fetch_audio.py --file data/raw/CTRL.json
    python scripts/fetch_audio.py --from-dir "E:/Freedom Datathon/Голосовые"   # уже скачанные 001.mp3 … → p4-ru-001.mp3

Ссылка организаторов отдаёт HTML-страницу плеера с короткоживущей ссылкой на файл: скрипт берёт файл по ней.
Подписанные ссылки в вывод не попадают. Сервер (`/api/conversations/{id}/audio`) сначала ищет запись в этой папке.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.app.api.audio import AUDIO_EXT, _safe_name, extract_media_url, local_file, sniff  # noqa: E402
from backend.app.config import settings  # noqa: E402

EXT_OF = {v: k for k, v in AUDIO_EXT.items()}


def records(path: Path) -> list[dict]:
    d = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(d, dict):
        d = (d.get("data") or {}).get("records") or d.get("records") or []
    return [r for r in d if r.get("audio_url")]


def download(client: httpx.Client, url: str) -> bytes:
    r = client.get(url)
    r.raise_for_status()
    if "html" in r.headers.get("content-type", "").lower():
        media = extract_media_url(r.text)
        if not media:
            raise RuntimeError("страница без ссылки на аудио")
        r = client.get(media)
        r.raise_for_status()
    return r.content


def from_dir(src: Path, out: Path) -> int:
    """Файлы вида 001.mp3 / call-2.mp3 → p4-ru-001.mp3 по номеру в имени (как их называет набор DEV)."""
    n = 0
    for f in sorted(src.iterdir()):
        if f.suffix.lower() not in AUDIO_EXT:
            continue
        m = re.search(r"(\d+)", f.stem)
        cid = f.stem if f.stem.startswith("p") or not m else f"p4-ru-{int(m.group(1)):03d}"
        shutil.copyfile(f, out / f"{_safe_name(cid)}{f.suffix.lower()}")
        print(f"{f.name} → {cid}{f.suffix.lower()}")
        n += 1
    return n


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--file", default=str(ROOT / "data" / "raw" / f"{settings.dataset_group_id}.json"))
    ap.add_argument("--from-dir", help="папка с уже скачанными записями (001.mp3 …)")
    ap.add_argument("--force", action="store_true", help="перекачать, даже если файл уже есть")
    a = ap.parse_args()
    out = Path(settings.audio_dir)
    out.mkdir(parents=True, exist_ok=True)
    if a.from_dir:
        print(f"скопировано: {from_dir(Path(a.from_dir), out)} → {out}")
        return 0
    ok = fail = 0
    with httpx.Client(timeout=httpx.Timeout(120.0, connect=15.0), follow_redirects=True) as client:
        for r in records(Path(a.file)):
            cid = r["conversation_id"]
            if local_file(cid) and not a.force:
                print(f"{cid}: уже есть")
                ok += 1
                continue
            try:
                data = download(client, r["audio_url"])
                ext = EXT_OF.get(sniff(data[:16]) or "")
                if not ext:
                    raise RuntimeError("по ссылке не аудио")
                (out / f"{_safe_name(cid)}{ext}").write_bytes(data)
                print(f"{cid}: {len(data) // 1024} КБ")
                ok += 1
            except Exception as e:  # noqa: BLE001 — без текста исключения: в нём может быть URL с подписью
                print(f"{cid}: не скачано ({type(e).__name__})")
                fail += 1
    print(f"готово: {ok}, ошибок: {fail}; папка {out}")
    return 1 if fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
