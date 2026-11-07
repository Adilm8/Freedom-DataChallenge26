"""Скачать набор диалогов у организаторов и сохранить снапшот в data/raw/<GROUP>.json.

    python scripts/fetch_dataset.py              # group_id из .env (DEV)
    python scripts/fetch_dataset.py --group CTRL # контрольный набор
    python scripts/fetch_dataset.py --from-file <файл.json>  # без сети, файл в формате ответа API

Снапшот нужен, чтобы eval и разработка не зависели от доступности API.
"""
import argparse
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.app.config import settings  # noqa: E402
from backend.app.services import ingest  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--group", default=settings.dataset_group_id)
    ap.add_argument("--from-file", type=Path)
    args = ap.parse_args()

    # Ошибки — без трейсбека: в тексте исключения httpx полный адрес запроса с подписью sig (секрет).
    try:
        payload = (json.loads(args.from_file.read_text(encoding="utf-8-sig")) if args.from_file
                   else ingest.fetch_payload(args.group))
    except (ingest.IngestError, OSError, ValueError) as e:
        sys.exit(f"набор не получен: {ingest.scrub(str(e))}")

    if not isinstance(payload, dict) or not payload.get("isSuccess"):
        sys.exit(f"API вернул ошибку: {ingest.scrub(str(payload.get('error') if isinstance(payload, dict) else payload))}")
    data = payload["data"]
    out = ROOT / "data" / "raw" / f"{data['dataset_group_id']}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    recs = data["records"]
    print(f"{out.relative_to(ROOT)}: {len(recs)} записей")
    print(Counter((r["channel"], r["language"]) for r in recs))


if __name__ == "__main__":
    main()
