"""Сделать читаемую версию набора: data/raw/<GROUP>_readable.md (реплики с номерами m<idx>).

    python scripts/render_dataset.py            # DEV
    python scripts/render_dataset.py --group CTRL
"""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--group", default="DEV")
    args = ap.parse_args()
    src = ROOT / "data" / "raw" / f"{args.group}.json"
    recs = json.loads(src.read_text(encoding="utf-8"))["data"]["records"]
    out = [f"# {args.group}: {len(recs)} диалогов\n"]
    for x in recs:
        out.append(f"\n## {x['conversation_id']} · {x['channel']} · {x['language']}\n")
        if x.get("audio_url"):
            out.append("Есть аудиозапись (audio_url в JSON).\n")
        for i, t in enumerate(x["transcript"]):
            text = t["text"].replace("\n", " ")
            out.append(f"- `m{i}` {t['timestamp']} **{t['speaker']}**: {text}")
    dst = src.with_name(f"{args.group}_readable.md")
    dst.write_text("\n".join(out) + "\n", encoding="utf-8")
    print(dst.relative_to(ROOT))


if __name__ == "__main__":
    main()
