# AG-01. Словари фраз RU / KZ / EN

**Цель:** два JSON-файла со словарями, по которым код системы находит приветствия, представление оператора, прощания, предупреждения об ожидании, рискованные фразы и системные события в чатах на русском, казахском и английском.

**Контекст (прочитай сначала):** `docs/checklist.md` (критерии 01, 05, 06, 07, 08), `docs/architecture/evaluation-pipeline.md` раздел 2 «Факты», `data/raw/DEV_readable.md` или `Freedom Datathon/research/DEV_readable.md` (только чаты `p1-*`).

**Сделать:**
1. `data/config/lexicons.json`:
```json
{
  "greeting":      {"ru": ["здравствуйте", "добрый день"], "kz": ["сәлеметсіз бе"], "en": ["hello", "hi"]},
  "intro":         {"ru": ["меня зовут\\s+\\w+", "я\\s+[А-ЯЁ]\\w+"], "kz": ["менің атым\\s+\\w+"], "en": ["i'm\\s+[A-Z]\\w+", "my name is\\s+\\w+"]},
  "farewell":      {"ru": [], "kz": [], "en": []},
  "help_offer":    {"ru": [], "kz": [], "en": []},
  "wait_warning":  {"ru": [], "kz": [], "en": []},
  "empathy":       {"ru": [], "kz": [], "en": []},
  "risk_paid_bypass": {"ru": [], "kz": [], "en": []},
  "risk_insult":      {"ru": [], "kz": [], "en": []},
  "risk_confidential":{"ru": [], "kz": [], "en": []}
}
```
   Значения — регулярные выражения Python, без учёта регистра. На каждую категорию и язык 8–20 вариантов, включая разговорные и с ошибками. `intro` должен ловить имя после фразы. Для казахского учти формы с окончаниями (`мен Айбекпін`, `мен Дана`).
2. `data/config/system_events.json`: ключ события → список точных фраз и вариантов на трёх языках. Ключи: `escalation`, `identity_verified`, `operator_closed`, `connection_lost`, `client_left`, `client_ended`, `hold_start`, `hold_end`, `consult_start`, `consult_end`, `recording_started`, `recording_paused`, `recording_resumed`, `language_changed`, `agent_joined`. Сначала все фразы, которые встречаются в DEV, потом правдоподобные варианты.
3. `tests/test_lexicons.py`: каждая регулярка компилируется; для каждой категории по 2–3 положительных и отрицательных примера на каждом языке (примеры придумай, не копируй из DEV).

**Не трогать:** всё, кроме трёх файлов выше.
**Готово, когда:** `pytest -q tests/test_lexicons.py` зелёный; JSON валиден; в каждой категории есть все три языка.
**Ветка:** `feat/data-lexicons`. Коммит: `feat(data): RU/KZ/EN lexicons and system event phrases`.
