"""Пересоздать БД (FR-OPS-04): удалить, создать схему, засеять чек-лист.

    python scripts/reset_db.py
    python scripts/reset_db.py --import data/raw/DEV.json
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from sqlmodel import Session  # noqa: E402

from backend.app import db  # noqa: E402
from backend.app.config import settings  # noqa: E402
from backend.app.services import checklists, ingest  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--import", dest="import_file", type=Path, help="JSON в формате API организаторов")
    args = ap.parse_args()

    if settings.database_url.startswith("sqlite"):
        path = Path(settings.database_url.split("///", 1)[-1])
        db.engine.dispose()
        for p in (path, Path(str(path) + "-wal"), Path(str(path) + "-shm")):
            p.unlink(missing_ok=True)
    db.init_db()
    with Session(db.engine) as s:
        checklists.seed_default(s)
        print("БД создана, чек-лист default засеян")
        if args.import_file:
            payload = json.loads(args.import_file.read_text(encoding="utf-8"))
            res = ingest.import_payload(s, payload, "upload")
            print(f"импорт {res['group_id']}: новых {res['imported']}, обновлено {res['updated']}, предупреждений {len(res['warnings'])}")


if __name__ == "__main__":
    main()
