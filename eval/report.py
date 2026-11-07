"""Таблицы для README и слайдов из сохранённых прогонов `eval/runs/` (FR-PRES-03): цифры не пишутся руками.

    python eval/report.py                          # все завершённые прогоны → Markdown в stdout
    python eval/report.py --split holdout          # только прогоны на holdout
    python eval/report.py --runs a.json b.json     # выбранные файлы
    python eval/report.py --out docs/results.md    # записать в файл

Таблицы: сравнение прогонов (модель, стратегия, согласие, MAE итога, доля в пределах ± 5 / ± 10, флаг 08,
стабильность, цена), согласие по критериям и разрез по языкам и каналам для лучшего прогона.
«Лучший» — с наибольшим средним согласием, при равенстве — с меньшим MAE.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNS_DIR = ROOT / "eval" / "runs"
CRITERIA_TITLES = {"01": "Установление контакта", "02": "Выявление потребности", "03": "Идентификация",
                   "04": "Консультация", "05": "Эмпатия", "06": "Ведение диалога", "07": "Завершение",
                   "08": "Грубые ошибки (флаг)"}


def load(paths: list[Path], split: str | None) -> list[dict]:
    runs = []
    for p in paths:
        if p.name.endswith(".partial.json"):
            continue
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            print(f"пропущен {p.name}: {e}", file=sys.stderr)
            continue
        if not isinstance(d, dict) or "metrics" not in d:
            continue
        if split and d.get("split") != split:
            continue
        d["_file"] = p.name
        runs.append(d)
    return sorted(runs, key=lambda d: d.get("created_at", ""))


def pct(x) -> str:
    return "—" if x is None else f"{x * 100:.0f}%"


def num(x, digits=2) -> str:
    return "—" if x is None else f"{x:.{digits}f}"


def money(x) -> str:
    return "—" if x is None else f"${x:.4f}"


def table(head: list[str], rows: list[list[str]]) -> str:
    out = ["| " + " | ".join(head) + " |", "|" + "|".join("---" for _ in head) + "|"]
    out += ["| " + " | ".join(r) + " |" for r in rows]
    return "\n".join(out)


def runs_table(runs: list[dict]) -> str:
    rows = []
    for d in runs:
        m = d["metrics"]
        t, flag = m.get("total", {}), m.get("criteria", {}).get("08", {})
        ch = (m.get("stability") or {}).get("changed_share")
        st = None if ch is None else 1 - ch  # доля ответов, совпавших между двумя одинаковыми прогонами
        cost = m.get("cost") or {}
        rows.append([d.get("model", "?"), d.get("strategy", "?"), d.get("split", "?"), str(m.get("dialogs", "—")),
                     pct(m.get("mean_agreement")), num(t.get("mae")), pct(t.get("within_5")), pct(t.get("within_10")),
                     f"{pct(flag.get('recall'))} / {pct(flag.get('precision'))}" if flag else "—",
                     pct(st) if st is not None else "—", money(cost.get("per_dialog_usd")),
                     num(cost.get("mean_seconds"), 1)])
    return table(["Модель", "Стратегия", "Выборка", "Диалогов", "Согласие", "MAE итога", "±5", "±10",
                  "08 recall / precision", "Стабильность", "Цена диалога", "Сек. на диалог"], rows)


def criteria_table(d: dict) -> str:
    rows = []
    for k, r in sorted(d["metrics"].get("criteria", {}).items()):
        extra = pct(r.get("within_1_step")) if "within_1_step" in r else "—"
        rows.append([k, CRITERIA_TITLES.get(k, k), str(r.get("n", "—")), pct(r.get("exact")), extra])
    return table(["Код", "Критерий", "n", "Точное совпадение", "± 1 ступень"], rows)


def slices_table(d: dict) -> str:
    rows = []
    for name, label in (("by_language", "Язык"), ("by_channel", "Канал")):
        for g, v in sorted((d["metrics"].get(name) or {}).items()):
            rows.append([label, g, str(v.get("n", "—")), pct(v.get("agreement")), num(v.get("mae"))])
    return table(["Разрез", "Группа", "Диалогов", "Согласие", "MAE итога"], rows)


def best(runs: list[dict]) -> dict:
    return max(runs, key=lambda d: (d["metrics"].get("mean_agreement") or 0,
                                    -((d["metrics"].get("total") or {}).get("mae") or 1e9)))


def render(runs: list[dict]) -> str:
    if not runs:
        return "Нет завершённых прогонов в `eval/runs/`: запустите `python eval/run_eval.py ...`."
    b = best(runs)
    gold = ", ".join(sorted({s for d in runs for s in d["metrics"].get("gold_source", [])})) or "—"
    parts = [
        "## Сравнение прогонов",
        f"Эталон: {gold}. Согласие — доля критериев с тем же ответом, что в эталоне; MAE — средняя ошибка итога в баллах.",
        runs_table(runs),
        f"## По критериям — {b.get('model')} / {b.get('strategy')} / {b.get('split')}",
        criteria_table(b),
        "## Языки и каналы",
        slices_table(b),
        f"Источник: `eval/runs/{b['_file']}`, версия промпта {b.get('prompt_version', '—')}.",
    ]
    return "\n\n".join(parts) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", nargs="*", type=Path)
    ap.add_argument("--split", choices=["dev", "holdout", "all"])
    ap.add_argument("--dir", type=Path, default=RUNS_DIR)
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()
    paths = args.runs or sorted(args.dir.glob("*.json"))
    text = render(load(paths, args.split))
    if args.out:
        args.out.write_text(text, encoding="utf-8")
        print(f"записано: {args.out}")
    else:
        print(text)


if __name__ == "__main__":
    main()
