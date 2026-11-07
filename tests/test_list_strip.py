from backend.app.api.conversations import _strip


def test_strip_pct_na_and_flag():
    score = {"criteria": {
        "01": {"answer": "yes", "applicable": True, "points": 10, "weight": 10},
        "04": {"answer": 10, "applicable": True, "points": 10, "weight": 20},
        "07": {"answer": "na", "applicable": False, "points": None, "weight": 5},
        "08": {"answer": "yes", "applicable": False, "points": None, "weight": 0},
    }}
    assert _strip(score) == [
        {"key": "01", "answer": "yes", "pct": 100},
        {"key": "04", "answer": 10, "pct": 50},
        {"key": "07", "answer": "na", "pct": None},
        {"key": "08", "answer": "yes", "pct": None},
    ]
    assert _strip(None) == [] and _strip({}) == []
