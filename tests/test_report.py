"""Таблицы для README и слайдов из сохранённых прогонов (FR-PRES-03)."""
import json

from eval import report


def run(tmp_path, name, agreement, mae, split="dev", stability=None):
    m = {"dialogs": 16, "mean_agreement": agreement, "gold_source": ["gold"],
         "criteria": {"04": {"n": 16, "exact": 0.75, "within_1_step": 1.0},
                      "08": {"n": 16, "exact": 1.0, "recall": 1.0, "precision": 0.5}},
         "total": {"n": 16, "mae": mae, "within_5": 0.5, "within_10": 0.9},
         "by_language": {"RU": {"n": 8, "agreement": 0.9, "mae": 3.0}}, "by_channel": {},
         "cost": {"per_dialog_usd": 0.0031, "mean_seconds": 7.2}}
    if stability is not None:
        m["stability"] = {"answers": 128, "changed_share": stability}
    p = tmp_path / f"{name}.json"
    p.write_text(json.dumps({"created_at": name, "model": f"m/{name}", "strategy": "grouped", "split": split,
                             "prompt_version": "p1-x", "metrics": m}), encoding="utf-8")
    return p


def test_report_tables_and_best_run(tmp_path):
    run(tmp_path, "a", 0.80, 6.0)
    run(tmp_path, "b", 0.85, 4.0, stability=0.05)
    run(tmp_path, "c", 0.99, 1.0, split="holdout")
    (tmp_path / "d.partial.json").write_text("{}", encoding="utf-8")
    text = report.render(report.load(sorted(tmp_path.glob("*.json")), "dev"))
    assert "| m/a | grouped | dev | 16 | 80% | 6.00 | 50% | 90% | 100% / 50% | — | $0.0031 | 7.2 |" in text
    assert "| m/b | grouped | dev | 16 | 85% | 4.00 |" in text and "| 95% |" in text      # стабильность = 1 − доля смен
    assert "## По критериям — m/b / grouped / dev" in text and "m/c" not in text
    assert "| 04 | Консультация | 16 | 75% | 100% |" in text
    assert report.render([]).startswith("Нет завершённых прогонов")


def test_report_shows_confidence_interval(tmp_path):
    p = run(tmp_path, "a", 0.83, 8.3)
    d = json.loads(p.read_text(encoding="utf-8"))
    d["metrics"]["ci95"] = {"n_resamples": 2000, "dialogs": 16, "mean_agreement": [0.75, 0.9], "mae": [5.1, 11.6]}
    p.write_text(json.dumps(d), encoding="utf-8")
    text = report.render(report.load([p], None))
    assert "| 83% [75%–90%] | 8.30 [5.10–11.60] |" in text
