"""Загрузить готовый файл сдачи в БД, чтобы увидеть его оценки в интерфейсе. Модель не вызывается.

    python scripts/import_results.py                                  # results/dev/results.json → группа DEV
    python scripts/import_results.py --file results/prod/results.json --group <контроль>
    python scripts/import_results.py --replace                        # и для уже оценённых диалогов
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from sqlmodel import Session  # noqa: E402

from backend.app import db  # noqa: E402
from backend.app.services import checklists, results_import  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", type=Path, default=ROOT / "results" / "dev" / "results.json")
    ap.add_argument("--group", default="DEV")
    ap.add_argument("--replace", action="store_true")
    args = ap.parse_args()
    db.init_db()
    with Session(db.engine) as s:
        checklists.seed_default(s)
        doc = json.loads(args.file.read_text(encoding="utf-8"))
        target = args.file.parent.name if args.file.parent.name in ("dev", "prod") else ""
        r = results_import.import_results(s, doc, args.group, replace=args.replace, source=args.file.name,
                                          overviews=results_import.load_overviews(ROOT, target) if target else None,
                                          prompt_version=results_import.source_prompt_version(ROOT, target) if target else None)
    print(f"группа {r['group_id']}: загружено {r['imported']}, уже были {r['skipped_existing']}, "
          f"ошибки в файле {r['skipped_error']}, нет в БД {len(r['missing'])}")
    if r["missing"]:
        print("нет в БД (сначала импортируйте набор):", ", ".join(r["missing"][:10]), "…" if len(r["missing"]) > 10 else "")
    for p in r["problems"]:
        print("!", p)


if __name__ == "__main__":
    main()
