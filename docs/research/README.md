# Исследование

Совместный разбор Лиды и Claude перед проектированием. Каждый файл — одна тема, в начале статус (черновик / обсуждено / решено). Итоги переносятся в `docs/architecture/`, `docs/spec/` и `docs/DECISIONS.md`.

| Файл | Тема | Статус |
|---|---|---|
| `01-data-overview.md` | Данные DEV, сигналы, трудные места критериев, варианты оценщика, вопросы | обсуждено → `architecture/evaluation-pipeline.md` |
| `02-external-solutions.md` | Внешние решения: продукты контакт-центров, исследования LLM-as-judge, что применимо за день | обсуждено → ADR-001 |
| `../../data/knowledge/freedom_broker_kb.md` | База знаний о продукте для критерия 04 (интернет + навигация из DEV) | черновик → ADR-011 |
| модели (сравнение) | качество на KZ, цена, structured outputs | перенесено в `architecture/llm-and-models.md` (bake-off после ключей) |
| дизайн оценщика | промпт, схема ответа, факты, проверка цитат | перенесено в `architecture/evaluation-pipeline.md` |
| UX и демо | экраны, сценарий защиты | перенесено в `architecture/frontend.md`, `spec/demo-scenario.md` |
