"""Скачать набор диалогов у организаторов и сохранить снапшот в data/raw/<GROUP>.json.

    python scripts/fetch_dataset.py              # group_id из .env (DEV)
    python scripts/fetch_dataset.py --group CTRL # контрольный набор
    python scripts/fetch_dataset.py --from-file "Starting files/Data.txt"  # без сети

Снапшот нужен, чтобы eval и разработка не зависели от доступности API.
"""
import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.app.config import settings  # noqa: E402


def with_group(url: str, group: str) -> str:
    parts = urlsplit(url)
    q = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k != "group_id"]
    q.append(("group_id", group))
    return urlunsplit(parts._replace(query=urlencode(q)))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--group", default=settings.dataset_group_id)
    ap.add_argument("--from-file", type=Path)
    args = ap.parse_args()

    if args.from_file:
        payload = json.loads(args.from_file.read_text(encoding="utf-8"))
    else:
        import httpx

        if not settings.organizer_api_url:
            sys.exit("ORGANIZER_API_URL не задан в .env")
        r = httpx.get(with_group(settings.organizer_api_url, args.group), timeout=60)
        r.raise_for_status()
        payload = r.json()

    if not payload.get("isSuccess"):
        sys.exit(f"API вернул ошибку: {payload.get('error')}")
    data = payload["data"]
    out = ROOT / "data" / "raw" / f"{data['dataset_group_id']}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    recs = data["records"]
    print(f"{out.relative_to(ROOT)}: {len(recs)} записей")
    print(Counter((r["channel"], r["language"]) for r in recs))


if __name__ == "__main__":
    main()
