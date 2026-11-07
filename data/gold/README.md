# Gold-разметка DEV

Эталон для `eval/run_eval.py`. Черновик делает Claude в рабочей сессии (без API), Лида проверяет; файл `gold_labels.json` правит только человек.

Формат (`gold_labels.json`):

```json
{
  "checklist_version": "default-v1",
  "items": {
    "p1-ru-001": {
      "labeled_by": "Lida",
      "criteria": {
        "01": {"answer": "yes"},
        "02": {"answer": "na"},
        "03": {"answer": "na"},
        "04": {"answer": 20},
        "05": {"answer": "yes"},
        "06": {"answer": 10},
        "07": {"answer": "yes"},
        "08": {"answer": "no"}
      },
      "total": 100.0,
      "notes": "необязательно"
    }
  }
}
```

`answer`: `yes` / `no` / `na` для бинарных, номер ступени (`0/5/10/15/20`, `0/4/7/10`) или `na` для шкал. `total` считает `scoring.py`, в разметке — для контроля.
