"""Файл результатов для организаторов (docs/task/results-format.md).

    python scripts/export_results.py --group DEV --out results/dev/results.json
    python scripts/export_results.py --group <контроль> --out results/prod/results.json --expect-count 10
    python scripts/export_results.py --check results/prod/results.json --expect-count 10   # только проверка

Берёт последнюю полную оценку каждого диалога группы по активной версии чек-листа (или --version).
Диалог без оценки попадает со status=error. Выход с кодом 1, если проверка нашла ошибки.
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from sqlmodel import Session, select  # noqa: E402

from backend.app import db  # noqa: E402
from backend.app.config import settings  # noqa: E402
from backend.app.domain import Checklist  # noqa: E402
from backend.app.models import ChecklistVersion, Conversation  # noqa: E402
from backend.app.services import results_export  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--group", help="group_id набора в БД (DEV или контрольный)")
    ap.add_argument("--out", type=Path)
    ap.add_argument("--check", type=Path, help="только проверить готовый файл")
    ap.add_argument("--team", default=settings.team_name)
    ap.add_argument("--mode", default=settings.model_mode, choices=results_export.MODES)
    ap.add_argument("--version", type=int, help="id версии чек-листа (по умолчанию активная)")
    ap.add_argument("--expect-count", type=int)
    args = ap.parse_args()

    with Session(db.engine) as s:
        q = select(ChecklistVersion).where(ChecklistVersion.id == args.version) if args.version else \
            select(ChecklistVersion).where(ChecklistVersion.is_active == True)  # noqa: E712
        ver = s.exec(q).first()
        if not ver:
            sys.exit("нет версии чек-листа")
        cl = Checklist.model_validate(ver.body)
        if args.check:
            doc = json.loads(args.check.read_text(encoding="utf-8"))
            group = args.group
        else:
            if not (args.group and args.out):
                sys.exit("нужны --group и --out (или --check)")
            if not args.team:
                sys.exit("укажите --team или TEAM_NAME в .env")
            doc = results_export.build(s, args.group, team_name=args.team, mode=args.mode, checklist_version_id=ver.id)
            group = args.group
        expected = list(s.exec(select(Conversation.conversation_id).where(Conversation.group_id == group))) if group else None

    errs = results_export.validate(doc, cl, expected_ids=expected, expected_count=args.expect_count)
    if not args.check:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    ok = sum(r["status"] == "ok" for r in doc.get("results", []))
    print(f"записей: {len(doc.get('results', []))} · ok: {ok} · error: {len(doc.get('results', [])) - ok} · "
          f"модель: {doc.get('model', {}).get('name')}")
    for r in doc.get("results", []):
        if r["status"] == "error":
            print(f"  {r['conversation_id']}: {r['error']}")
    if errs:
        print("ОШИБКИ ПРОВЕРКИ:\n  " + "\n  ".join(errs))
        sys.exit(1)
    print("проверка пройдена" + (f" · сохранено: {args.out}" if args.out and not args.check else ""))


if __name__ == "__main__":
    main()
