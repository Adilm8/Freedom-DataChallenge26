"""Расчёт баллов — построчно по docs/checklist.md (FR-SCORE-01…08, ADR-006)."""

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from backend.app.domain import Checklist
from backend.app.services.scoring import compute, round_half_up

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def default_checklist() -> Checklist:
    return Checklist.model_validate(json.loads((ROOT / "data/checklists/default.json").read_text(encoding="utf-8")))


def all_yes() -> dict:
    return {"01": "yes", "02": "yes", "03": "yes", "04": 20, "05": "yes", "06": 10, "07": "yes", "08": "no"}


def test_default_checklist_shape(default_checklist):
    # FR-CHK-01: 8 критериев, веса 10/15/20/20/15/15/5, 08 — флаг
    weights = {c.key: c.weight for c in default_checklist.criteria}
    assert weights == {"01": 10, "02": 15, "03": 20, "04": 20, "05": 15, "06": 15, "07": 5, "08": 0}
    assert default_checklist.criterion("08").type == "flag"
    assert default_checklist.warnings() == []


def test_example_from_checklist_94_38(default_checklist):
    # FR-SCORE-04: 04 = N/A, остальные «Да», 06 = 7 → 75.5 из 80 → 94.38
    answers = all_yes() | {"04": "na", "06": 7}
    r = compute(default_checklist, answers)
    assert r.applicable_weight == 80
    assert r.points_sum == 75.5
    assert r.total == 94.38
    assert r.criteria["06"].points == 10.5          # FR-SCORE-02: 15 × 7 / 10
    assert r.criteria["04"].applicable is False and r.criteria["04"].points is None


def test_all_yes_is_100(default_checklist):
    r = compute(default_checklist, all_yes())
    assert r.total == 100.0
    assert r.critical == []


def test_no_gives_zero_points(default_checklist):
    # FR-SCORE-01
    r = compute(default_checklist, all_yes() | {"01": "no"})
    assert r.criteria["01"].points == 0
    assert r.total == 90.0


def test_scale_points(default_checklist):
    r = compute(default_checklist, all_yes() | {"04": 5})
    assert r.criteria["04"].points == 5.0             # 20 × 5 / 20
    assert r.total == 85.0


def test_flag_has_no_points_and_is_reported(default_checklist):
    # FR-SCORE-03: флаг вне весов, отмечается отдельно; по умолчанию итог не обнуляется
    r = compute(default_checklist, all_yes() | {"08": "yes"})
    assert r.critical == ["08"]
    assert r.total == 100.0
    assert r.applicable_weight == 100
    assert r.criteria["08"].points is None


def test_zero_total_policy(default_checklist):
    # FR-SCORE-08
    cl = default_checklist.model_copy(deep=True)
    cl.settings.critical_policy = "zero_total"
    assert compute(cl, all_yes() | {"08": "yes"}).total == 0.0
    assert compute(cl, all_yes()).total == 100.0


def test_no_applicable_criteria_gives_null(default_checklist):
    # FR-SCORE-06: N/A везде, где разрешено, а остальные критерии выключены
    cl = default_checklist.model_copy(deep=True)
    for c in cl.criteria:
        if not c.na_allowed and c.type != "flag":
            c.enabled = False
    answers = {"02": "na", "03": "na", "04": "na", "07": "na", "08": "no"}
    r = compute(cl, answers)
    assert r.total is None
    assert r.applicable_weight == 0


def test_round_half_up_not_bankers():
    # FR-SCORE-05: round(0.125, 2) в Python даёт 0.12, нам нужно 0.13
    assert round(0.125, 2) == 0.12
    assert round_half_up(0.125) == 0.13
    assert round_half_up(2.675) == 2.68


def test_total_rounds_half_up():
    cl = Checklist.model_validate({
        "key": "t", "name": "t",
        "sections": [{"id": "s", "title": "S"}],
        "criteria": [
            {"key": "a", "title": "A", "section": "s", "type": "scale", "weight": 4, "definition": "d",
             "scale": [{"value": 8, "label": "max"}, {"value": 1, "label": "low"}]},
            {"key": "b", "title": "B", "section": "s", "type": "binary", "weight": 396, "definition": "d"},
        ],
    })
    r = compute(cl, {"a": 1, "b": "no"})          # 0.5 / 400 × 100 = 0.125
    assert r.total == 0.13


def test_weights_not_summing_to_100_are_normalised():
    # ADR-006: итог корректен и при сумме весов ≠ 100 (новый чек-лист с защиты)
    cl = Checklist.model_validate({
        "key": "t", "name": "t",
        "sections": [{"id": "s", "title": "S"}],
        "criteria": [
            {"key": "a", "title": "A", "section": "s", "type": "binary", "weight": 30, "definition": "d"},
            {"key": "b", "title": "B", "section": "s", "type": "binary", "weight": 10, "definition": "d"},
        ],
    })
    assert cl.warnings()
    assert compute(cl, {"a": "yes", "b": "no"}).total == 75.0


def test_sections(default_checklist):
    # FR-SCORE-07
    r = compute(default_checklist, all_yes() | {"04": "na", "06": 7})
    s = {x.id: x for x in r.sections}
    assert s["start"].points == 25 and s["start"].applicable_weight == 25 and s["start"].pct == 100.0
    assert s["safety"].applicable_weight == 20                     # 04 = N/A
    assert s["dialog"].points == 30.5 and s["dialog"].applicable_weight == 35 and s["dialog"].pct == 87.14


def test_missing_answer_excluded_and_reported(default_checklist):
    answers = all_yes()
    del answers["05"]
    r = compute(default_checklist, answers)
    assert r.missing == ["05"]
    assert r.applicable_weight == 85


def test_invalid_answers_rejected(default_checklist):
    with pytest.raises(ValueError):
        compute(default_checklist, all_yes() | {"01": "na"})      # N/A не разрешён для 01
    with pytest.raises(ValueError):
        compute(default_checklist, all_yes() | {"06": 5})         # такой ступени нет
    # строки и регистр приводятся
    assert compute(default_checklist, all_yes() | {"04": "15", "02": "N/A"}).criteria["04"].points == 15


def test_checklist_validation_errors():
    # FR-CHK-05
    base = {"key": "t", "name": "t", "sections": [{"id": "s", "title": "S"}]}
    bad = [
        [{"key": "a", "title": "A", "section": "s", "type": "binary", "weight": 1, "definition": "d"},
         {"key": "a", "title": "A2", "section": "s", "type": "binary", "weight": 1, "definition": "d"}],  # дубль
        [{"key": "a", "title": "A", "section": "s", "type": "binary", "weight": -1, "definition": "d"}],   # вес < 0
        [{"key": "a", "title": "A", "section": "s", "type": "scale", "weight": 1, "definition": "d",
          "scale": [{"value": 5, "label": "x"}]}],                                                         # 1 ступень
        [{"key": "a", "title": "A", "section": "s", "type": "binary", "weight": 1, "definition": "d",
          "na_allowed": True}],                                                                             # N/A без условия
        [{"key": "a", "title": "A", "section": "nope", "type": "binary", "weight": 1, "definition": "d"}], # нет секции
        [{"key": "а б", "title": "A", "section": "s", "type": "binary", "weight": 1, "definition": "d"}],  # плохой код
    ]
    for criteria in bad:
        with pytest.raises(ValidationError):
            Checklist.model_validate(base | {"criteria": criteria})
