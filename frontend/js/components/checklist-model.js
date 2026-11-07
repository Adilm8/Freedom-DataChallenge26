// Модель чек-листа для конструктора: проверки (повторяют domain.py::Checklist, FR-CHK-05), предупреждения,
// отличия двух версий (FR-CHK-08) и что из них потребует вызова модели при переоценке с прошлыми ответами (FR-CHK-10).
// Чистые функции без DOM: формат тела — docs/CONTRACTS.md §1.

export const TYPES = ['binary', 'scale', 'flag'];
export const TYPE_LABEL = { binary: 'Да / Нет', scale: 'Шкала', flag: 'Флаг' };
export const TYPE_HINT = {
  binary: '«Да» даёт полный вес, «Нет» — 0; N/A исключает вес из итога.',
  scale: 'Баллы = ступень ÷ максимальная ступень × вес.',
  flag: 'Да / Нет без баллов: отмечает грубое нарушение, вес не учитывается.',
};
// Коды критериев в файле сдачи организаторов (docs/task/results-format.md).
export const ORGANIZER_CODES = [
  ['contact', 'Установление контакта'], ['discovery', 'Выявление потребности'], ['identification', 'Идентификация'],
  ['consultation', 'Корректность и полнота'], ['empathy', 'Эмпатия'], ['dialogue', 'Ведение, скорость, грамотность'],
  ['closure', 'Завершение'], ['critical', 'Грубые ошибки'],
];
export const FIELD_LABEL = {
  key: 'Код', title: 'Название', section: 'Секция', type: 'Тип ответа', weight: 'Вес', na_allowed: 'N/A разрешён',
  na_when: 'Когда N/A', definition: 'Определение', yes_when: '«Да», когда', no_when: '«Нет», когда', scale: 'Ступени шкалы',
  guidance: 'Подсказка оценщику', voice_guidance: 'Подсказка для звонков', group: 'Группа вызова', context_refs: 'Справки', guards: 'Страховки', enabled: 'Включён',
  export_id: 'Код в файле сдачи',
};
// Поля промпта и хеша критерия (services/evaluator._PROMPT_FIELDS): их правка требует нового вызова модели.
export const PROMPT_FIELDS = new Set(['key', 'title', 'type', 'definition', 'yes_when', 'no_when', 'na_allowed', 'na_when', 'scale', 'guidance', 'voice_guidance', 'context_refs']);
// Настройки, которые не попадают в промпт (prompt_builder._SCORING_ONLY_SETTINGS): только пересчёт баллов.
export const SCORING_ONLY_SETTINGS = new Set(['rounding', 'critical_policy']);
export const DEFAULT_SETTINGS = {
  output_language: 'ru', rounding: 2, critical_policy: 'flag', first_response_threshold_sec: 180,
  long_gap_threshold_sec: 120, advice: true, overview: true, quote_threshold: { chat: 0.85, voice: 0.75 },
};
export const SETTINGS = [
  { key: 'output_language', label: 'Язык обоснований', kind: 'select', options: [['ru', 'Русский'], ['kz', 'Казахский'], ['en', 'Английский']],
    hint: 'На этом языке модель пишет обоснования, советы и обзор.' },
  { key: 'first_response_threshold_sec', label: 'Порог первого ответа, с', kind: 'int',
    hint: 'Первый ответ оператора позже порога — сбой в ведении диалога (факт first_response_slow).' },
  { key: 'long_gap_threshold_sec', label: 'Порог долгой паузы, с', kind: 'int',
    hint: 'Пауза оператора дольше порога попадает в факты long_gaps.' },
  { key: 'critical_policy', label: 'Грубая ошибка', kind: 'select', options: [['flag', 'Только флаг: итог не меняется'], ['zero_total', 'Обнулять итог']],
    hint: 'По формату сдачи флаг не обнуляет итог.' },
  { key: 'advice', label: 'Советы оператору', kind: 'bool', hint: 'Подсказка «что можно было сделать», если балл неполный.' },
  { key: 'overview', label: 'Обзор диалога', kind: 'bool', hint: 'Резюме, тема и «вопрос решён» в первом вызове оценки.' },
  { key: 'rounding', label: 'Знаков после запятой в итоге', kind: 'int', hint: '' },
];
export const settingLabel = (k) => (k === 'quote_threshold' ? 'Порог сверки цитат' : SETTINGS.find((s) => s.key === k)?.label || k);

const KEY_RE = /^[A-Za-z0-9_-]+$/;
export const blank = (v) => v == null || String(v).trim() === '';
export const txt = (v) => (blank(v) ? null : String(v).trim());
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Ответы, которые допускает критерий (как Criterion.allowed_answers), строками — как в guards[].expect. */
export function allowedAnswers(c) {
  const out = c.type === 'scale'
    ? (c.scale || []).map((s) => s.value).filter(isNum).sort((a, b) => b - a).map(String)
    : ['yes', 'no'];
  if (c.na_allowed && c.type !== 'flag') out.push('na');
  return out;
}
export const ANSWER_LABEL = { yes: 'Да', no: 'Нет', na: 'N/A' };

/** Каноничный вид критерия для сравнения: пустые строки = null, значения по умолчанию заполнены. */
export function normCriterion(c) {
  return {
    key: String(c.key ?? ''), title: String(c.title ?? '').trim(), section: c.section ?? '', type: c.type ?? 'binary',
    weight: Number(c.weight ?? 0), na_allowed: !!c.na_allowed, na_when: txt(c.na_when), definition: String(c.definition ?? '').trim(),
    yes_when: txt(c.yes_when), no_when: txt(c.no_when),
    scale: Array.isArray(c.scale) && c.scale.length ? c.scale.map((s) => ({ value: Number(s.value), label: String(s.label ?? '').trim() })) : null,
    guidance: txt(c.guidance), voice_guidance: txt(c.voice_guidance), group: txt(c.group), context_refs: (c.context_refs || []).map(String),
    guards: (c.guards || []).map((g) => ({ when: (g.when || []).map(String), expect: (g.expect || []).map(String), action: g.action || 'flag',
      set: g.action === 'override' ? txt(g.set) : null })),
    enabled: c.enabled !== false, export_id: txt(c.export_id),
  };
}
export const sameCriterion = (a, b) => eq(normCriterion(a), normCriterion(b));

/** Сумма весов включённых критериев с баллами (флаги не в счёт). */
export function weightSum(body) {
  return (body?.criteria || []).filter((c) => c.enabled !== false && c.type !== 'flag').reduce((s, c) => s + (Number(c.weight) || 0), 0);
}
export const fmtNum = (v) => (isNum(v) ? String(+v.toFixed(4)) : String(v ?? '—'));

/** Проверка тела: {errors: [{path, message}], warnings: [str]}. Пути — как у 422 бэкенда (criteria.3.weight). */
export function validateBody(body) {
  const errors = [], warnings = [];
  const err = (path, message) => errors.push({ path, message });
  if (!body || typeof body !== 'object') return { errors: [{ path: '', message: 'пустой чек-лист' }], warnings };
  if (blank(body.key)) err('key', 'укажите ключ чек-листа');
  if (blank(body.name)) err('name', 'укажите название чек-листа');
  const sections = Array.isArray(body.sections) ? body.sections : [];
  const ids = new Set();
  sections.forEach((s, i) => {
    if (blank(s.id)) err(`sections.${i}.id`, 'укажите id секции');
    else if (ids.has(s.id)) err(`sections.${i}.id`, `id секции «${s.id}» повторяется`);
    ids.add(s.id);
    if (blank(s.title)) err(`sections.${i}.title`, 'укажите название секции');
  });
  if (!sections.length) err('sections', 'добавьте хотя бы одну секцию');
  const crit = Array.isArray(body.criteria) ? body.criteria : [];
  const keys = crit.map((c) => String(c.key ?? '').trim());
  crit.forEach((c, i) => {
    const p = `criteria.${i}`;
    const key = keys[i];
    if (!key) err(`${p}.key`, 'укажите код');
    else if (!KEY_RE.test(key)) err(`${p}.key`, 'код критерия: только латиница, цифры, «_» и «-»');
    else if (keys.indexOf(key) !== i) err(`${p}.key`, `код «${key}» уже есть у другого критерия`);
    if (blank(c.title)) err(`${p}.title`, 'укажите название');
    if (blank(c.section) || !ids.has(c.section)) err(`${p}.section`, blank(c.section) ? 'выберите секцию' : `секции «${c.section}» нет в чек-листе`);
    if (!TYPES.includes(c.type)) err(`${p}.type`, 'выберите тип ответа');
    if (!isNum(c.weight)) err(`${p}.weight`, 'вес — число');
    else if (c.weight < 0) err(`${p}.weight`, 'вес не может быть отрицательным');
    if (blank(c.definition)) err(`${p}.definition`, 'опишите, что проверяет критерий');
    if (c.na_allowed && blank(c.na_when)) err(`${p}.na_when`, 'для N/A нужно условие: когда критерий неприменим');
    if (c.type === 'scale') {
      const steps = Array.isArray(c.scale) ? c.scale : [];
      steps.forEach((s, j) => {
        if (!Number.isInteger(s.value)) err(`${p}.scale.${j}.value`, 'ступень — целое число');
        else if (s.value < 0) err(`${p}.scale.${j}.value`, 'ступень не может быть отрицательной');
        if (blank(s.label)) err(`${p}.scale.${j}.label`, 'опишите ступень');
      });
      const vals = steps.map((s) => s.value).filter(Number.isInteger);
      if (steps.length < 2) err(`${p}.scale`, 'у шкалы должно быть не меньше 2 ступеней');
      else if (new Set(vals).size !== vals.length) err(`${p}.scale`, 'ступени шкалы повторяются');
      else if (vals.length && Math.max(...vals) <= 0) err(`${p}.scale`, 'максимальная ступень шкалы должна быть больше 0');
    }
    (c.guards || []).forEach((g, j) => {
      if (!(g.when || []).length) err(`${p}.guards.${j}.when`, 'укажите хотя бы один факт');
      if (!(g.expect || []).length) err(`${p}.guards.${j}.expect`, 'отметьте допустимые ответы');
      if (g.action === 'override' && blank(g.set)) err(`${p}.guards.${j}.set`, 'выберите, на какой ответ заменить');
    });
  });
  if (!crit.length) err('criteria', 'добавьте хотя бы один критерий');
  else if (!crit.some((c) => c.enabled !== false)) err('criteria', 'в чек-листе нет ни одного включённого критерия');
  const st = body.settings || {};
  for (const s of SETTINGS) {
    if (s.kind !== 'int' || st[s.key] === undefined) continue;
    if (!Number.isInteger(st[s.key]) || st[s.key] < 0) err(`settings.${s.key}`, 'нужно целое число ≥ 0');
  }
  if (st.rounding !== undefined && Number.isInteger(st.rounding) && st.rounding > 6) err('settings.rounding', 'не больше 6 знаков');
  for (const ch of ['chat', 'voice']) {
    const v = st.quote_threshold?.[ch];
    if (v !== undefined && (!isNum(v) || v < 0 || v > 1)) err(`settings.quote_threshold.${ch}`, 'порог — число от 0 до 1');
  }

  // предупреждения: не мешают сохранить
  const on = crit.filter((c) => c.enabled !== false);
  const total = weightSum(body);
  if (crit.length && Math.abs(total - 100) > 1e-9) warnings.push(`Сумма весов ${fmtNum(total)}, а не 100: итог всё равно нормируется к 100.`);
  for (const c of on) {
    if (c.type === 'flag' && Number(c.weight) > 0) warnings.push(`${c.key}: вес флага не учитывается в итоге.`);
    if (c.type === 'binary' && blank(c.yes_when) && blank(c.no_when)) warnings.push(`${c.key}: нет «Да, когда» и «Нет, когда» — модель будет опираться только на определение.`);
  }
  const withExport = on.filter((c) => !blank(c.export_id));
  if (withExport.length) {
    const by = new Map();
    for (const c of withExport) { const code = String(c.export_id).trim(); by.set(code, [...(by.get(code) || []), c.key]); }
    for (const [code, ks] of by) if (ks.length > 1) warnings.push(`Код в файле сдачи «${code}» у нескольких включённых критериев: ${ks.join(', ')}.`);
    const known = new Set(ORGANIZER_CODES.map(([c]) => c));
    const missing = ORGANIZER_CODES.map(([c]) => c).filter((c) => !by.has(c));
    if (missing.length) warnings.push(`В файле сдачи не будет кодов: ${missing.join(', ')} — их нет у включённых критериев.`);
    for (const c of on) {
      if (blank(c.export_id)) warnings.push(`${c.key}: нет кода в файле сдачи — запишется как «${c.key}».`);
      else if (!known.has(String(c.export_id).trim())) warnings.push(`${c.key}: код «${c.export_id}» не из формата сдачи организаторов.`);
    }
  }
  return { errors, warnings };
}

/** Отличия версии b от версии a (FR-CHK-08) и что из них потребует вызова модели (FR-CHK-10). */
export function diffBodies(a, b) {
  const out = { added: [], removed: [], changed: [], reordered: false, settings: [], sections: [], name: null, llmKeys: [], allLlm: false, empty: true };
  if (!a || !b) return out;
  const A = new Map((a.criteria || []).map((c) => [c.key, normCriterion(c)]));
  const B = new Map((b.criteria || []).map((c) => [c.key, normCriterion(c)]));
  for (const [k, c] of B) {
    if (!A.has(k)) { out.added.push(c); if (c.enabled) out.llmKeys.push(k); continue; }
    const o = A.get(k);
    const fields = Object.keys(FIELD_LABEL).filter((f) => !eq(o[f], c[f]));
    if (!fields.length) continue;
    const llm = c.enabled && (fields.some((f) => PROMPT_FIELDS.has(f)) || fields.includes('enabled'));
    out.changed.push({ key: k, title: c.title, before: o, after: c, llm, fields: fields.map((f) => ({ field: f, from: o[f], to: c[f] })) });
    if (llm) out.llmKeys.push(k);
  }
  for (const [k, c] of A) if (!B.has(k)) out.removed.push(c);
  const common = [...A.keys()].filter((k) => B.has(k));
  out.reordered = !eq(common, [...B.keys()].filter((k) => A.has(k)));
  const sa = { ...DEFAULT_SETTINGS, ...(a.settings || {}) }, sb = { ...DEFAULT_SETTINGS, ...(b.settings || {}) };
  for (const k of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
    if (eq(sa[k], sb[k])) continue;
    const llm = !SCORING_ONLY_SETTINGS.has(k);
    out.settings.push({ key: k, label: settingLabel(k), from: sa[k], to: sb[k], llm });
    if (llm) out.allLlm = true;
  }
  const SA = new Map((a.sections || []).map((s) => [s.id, s.title])), SB = new Map((b.sections || []).map((s) => [s.id, s.title]));
  for (const [id, t] of SB) {
    if (!SA.has(id)) out.sections.push({ type: 'added', id, to: t });
    else if (SA.get(id) !== t) out.sections.push({ type: 'renamed', id, from: SA.get(id), to: t });
  }
  for (const [id, t] of SA) if (!SB.has(id)) out.sections.push({ type: 'removed', id, from: t });
  if (out.sections.length) out.allLlm = true; // названия секций входят в контекст промпта
  if ((a.name || '') !== (b.name || '')) out.name = { from: a.name, to: b.name };
  out.empty = !out.added.length && !out.removed.length && !out.changed.length && !out.reordered && !out.settings.length && !out.sections.length && !out.name;
  return out;
}

/** Пары «старый выключен → новый с тем же export_id добавлен»: так в отличиях видна замена критерия. */
export function replacements(d) {
  const off = d.changed.filter((x) => x.fields.some((f) => f.field === 'enabled') && !x.after.enabled);
  const out = [];
  for (const n of d.added) {
    const o = n.export_id && (off.find((x) => x.after.export_id === n.export_id) || d.removed.find((x) => x.export_id === n.export_id));
    if (o) out.push({ from: o.key, to: n.key, export_id: n.export_id });
  }
  return out;
}

/** Заметка к версии по умолчанию — из отличий. */
export function autoNote(d) {
  if (d.empty) return '';
  const parts = [];
  const rep = replacements(d);
  const repTo = new Set(rep.map((r) => r.to)), repFrom = new Set(rep.map((r) => r.from));
  if (rep.length) parts.push(rep.map((r) => `замена ${r.from} на ${r.to}`).join(', '));
  const add = d.added.filter((c) => !repTo.has(c.key));
  if (add.length) parts.push(`добавлен ${add.map((c) => c.key).join(', ')}`);
  const rem = d.removed.filter((c) => !repFrom.has(c.key));
  if (rem.length) parts.push(`удалён ${rem.map((c) => c.key).join(', ')}`);
  const ch = d.changed.filter((x) => !repFrom.has(x.key));
  // «Включён» — подпись поля, а не значение: при выключении в заметке должно стоять «выключен».
  const fieldNote = (x, f) => (f.field === 'enabled' ? (x.after?.enabled === false ? 'выключен' : 'включён') : FIELD_LABEL[f.field].toLowerCase().replace(/[«»]/g, ''));
  if (ch.length) parts.push(ch.slice(0, 4).map((x) => `${x.key}: ${x.fields.map((f) => fieldNote(x, f)).join(', ')}`).join('; '));
  if (d.reordered) parts.push('порядок');
  if (d.settings.length) parts.push(`настройки: ${d.settings.map((s) => s.label.toLowerCase()).join(', ')}`);
  if (d.sections.length) parts.push('секции');
  if (d.name) parts.push('название');
  const s = parts.filter(Boolean).join('; ');
  const t = s.charAt(0).toUpperCase() + s.slice(1);
  return t.length > 140 ? t.slice(0, 139) + '…' : t;
}

/** Следующий свободный код: «09» для числовых кодов, иначе «<base>-2», «<base>-3», … */
export function nextKey(body, base) {
  const keys = new Set((body.criteria || []).map((c) => String(c.key)));
  const all = [...keys];
  if (all.length && all.every((k) => /^\d+$/.test(k))) {
    const width = Math.max(...all.map((k) => k.length));
    let n = Math.max(...all.map(Number)) + 1;
    while (keys.has(String(n).padStart(width, '0'))) n += 1;
    return String(n).padStart(width, '0');
  }
  const stem = base || 'c';
  for (let i = 2; ; i += 1) if (!keys.has(`${stem}-${i}`)) return `${stem}-${i}`;
}

/** Разбор пути ошибки 422: к какому месту редактора она относится. */
export function locate(path, message = '') {
  const m = /^criteria\.(\d+)(?:\.(.+))?$/.exec(path || '');
  if (m) {
    let field = m[2] || null;
    if (!field) {
      if (/na_when|N\/A/i.test(message)) field = 'na_when';
      else if (/шкал|ступен/i.test(message)) field = 'scale';
      else if (/override|set|guard|страховк/i.test(message)) field = 'guards';
    }
    return { kind: 'criterion', idx: Number(m[1]), field };
  }
  const s = /^settings\.(.+)$/.exec(path || '');
  if (s) return { kind: 'settings', field: s[1] };
  const sec = /^sections(?:\.(\d+)(?:\.(.+))?)?$/.exec(path || '');
  if (sec) return { kind: 'sections', idx: sec[1] != null ? Number(sec[1]) : null, field: sec[2] || null };
  return { kind: 'global', field: path || null };
}
