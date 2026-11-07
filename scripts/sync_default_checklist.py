"""Обновить чек-лист в существующей БД из `data/checklists/default.json`.

    python scripts/sync_default_checklist.py            # новая версия от активной и её активация
    python scripts/sync_default_checklist.py --dry-run  # только показать, что изменится

Чек-лист по умолчанию попадает в БД только при первом запуске. Если файл поменялся (правила по ответам
организаторов, подсказки для звонков), этот скрипт создаёт из него новую версию — как сохранение
в конструкторе: старые оценки остаются на своей версии. Одинаковое тело новую версию не создаёт.
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from sqlmodel import Session  # noqa: E402

from backend.app import db  # noqa: E402
from backend.app.services import checklists  # noqa: E402


def changed_keys(old: dict, new: dict) -> list[str]:
    o = {c["key"]: c for c in old.get("criteria", [])}
    n = {c["key"]: c for c in new.get("criteria", [])}
    out = [k for k in n if o.get(k) != n[k]] + [f"{k} (удалён)" for k in o if k not in n]
    if old.get("settings") != new.get("settings"):
        out.append("settings")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    body = json.loads(checklists.DEFAULT_PATH.read_text(encoding="utf-8"))
    db.init_db()
    with Session(db.engine) as s:
        if checklists.seed_default(s):
            print("БД была пустой: чек-лист по умолчанию создан и активен")
            return
        active = checklists.get_active(s)
        if active and checklists.body_hash(active.body) == checklists.body_hash(body):
            print(f"активная версия v{active.version} уже совпадает с файлом")
            return
        diff = changed_keys(active.body if active else {}, body)
        print("отличается: " + (", ".join(diff) or "порядок или оформление"))
        if args.dry_run:
            return
        ver, warnings = checklists.create_version(s, body, note="Обновлён из data/checklists/default.json",
                                                  parent_id=active.id if active else None, activate=True)
        print(f"создана и активна версия v{ver.version} (id {ver.id})")
        for w in warnings:
            print(f"  предупреждение: {w}")


if __name__ == "__main__":
    main()
