"""Метрики близости к gold (eval/metrics.py): чистые функции без сети."""

from eval.metrics import bootstrap_ci, calibration, compare, stability

CRIT = {"01": {"type": "binary", "scale": None}, "04": {"type": "scale", "scale": [20, 15, 10, 5, 0]},
        "08": {"type": "flag", "scale": None}}
GOLD = {"a": {"answers": {"01": "yes", "04": 20, "08": "no"}, "total": 100.0},
        "b": {"answers": {"01": "no", "04": 10, "08": "yes"}, "total": 50.0}}
PRED = {"a": {"answers": {"01": "yes", "04": 15, "08": "yes"}, "total": 96.0, "confidence": {"01": "high", "04": "low"}},
        "b": {"answers": {"01": "yes", "04": 0, "08": "yes"}, "total": 62.0, "confidence": {"01": "high", "04": "low"}}}
META = {"a": {"language": "ru", "channel": "chat"}, "b": {"language": "kz", "channel": "chat"}}


def test_compare_exact_steps_flag_and_totals():
    m = compare(PRED, GOLD, META, CRIT)
    assert m["dialogs"] == 2
    assert m["criteria"]["01"]["exact"] == 0.5
    assert m["criteria"]["04"]["exact"] == 0.0 and m["criteria"]["04"]["within_1_step"] == 0.5
    assert m["criteria"]["08"]["recall"] == 1.0 and m["criteria"]["08"]["precision"] == 0.5
    assert m["mean_agreement"] == 0.25          # флаг 08 в среднее не входит
    assert m["total"]["mae"] == 8.0 and m["total"]["within_5"] == 0.5 and m["total"]["within_10"] == 0.5
    assert set(m["by_language"]) == {"ru", "kz"} and m["by_channel"]["chat"]["n"] == 2


def test_missing_prediction_is_not_counted():
    pred = {"a": {"answers": {"01": "yes"}, "total": None}}
    m = compare(pred, GOLD, META, CRIT)
    assert m["dialogs"] == 1 and m["criteria"]["01"]["n"] == 1 and "04" not in m["criteria"]
    assert m["total"]["mae"] is None


def test_calibration_and_stability():
    cal = calibration(PRED, GOLD)
    assert cal["low"]["error_rate"] == 1.0 and cal["high"]["error_rate"] == 0.5
    other = {"a": {"answers": {"01": "yes", "04": 20, "08": "yes"}, "total": 100.0},
             "b": PRED["b"]}
    st = stability(PRED, other)
    assert st["answers"] == 6 and st["changed_share"] == round(1 / 6, 4) and st["mean_total_delta"] == 2.0


def test_bootstrap_ci_brackets_point_estimate_and_is_reproducible():
    ci = bootstrap_ci(PRED, GOLD, META, CRIT, n=500)
    point = compare(PRED, GOLD, META, CRIT)
    lo, hi = ci["mean_agreement"]
    assert lo <= point["mean_agreement"] <= hi and 0.0 <= lo <= hi <= 1.0
    assert ci["mae"][0] <= point["total"]["mae"] <= ci["mae"][1]
    assert ci == bootstrap_ci(PRED, GOLD, META, CRIT, n=500)        # seed фиксирован
    assert bootstrap_ci({"a": PRED["a"]}, GOLD, META, CRIT) == {}   # один диалог — интервал не считаем
