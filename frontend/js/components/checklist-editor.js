// Конструктор чек-листа (FR-CHK-02…10, PLAN шаг 13). Экран #/checklist?version=<id>.
// mount(el, {version?, group}) — активная (или выбранная) версия, критерии по секциям, редактор критерия,
// «Заменить критерий» (новый на месте старого: та же секция, вес и export_id, старый выключается), настройки и секции,
// сохранение новой версией (POST /checklists с parent_id), «Переоценить диалоги…» (событие cqa:run-request
// с версией и reuse auto), история версий с отличиями, импорт и экспорт JSON.
// Проверки — checklist-model.js (повторяют domain.py), 422 бэкенда подсвечивает поле по path.
import { h, clear, emit, toast, fmtDate, skeletonRows, errorState, emptyState, channelBadge, langChip, score } from '../ui.js';
import { listChecklists, getChecklist, createChecklist, activateChecklist, checkChecklist, listConversations, getFactLabels, isMock } from '../api.js';
import { plural } from './run-dialog.js';
import { openTrial } from './criterion-trial.js';
import {
  TYPES, TYPE_LABEL, TYPE_HINT, ORGANIZER_CODES, FIELD_LABEL, SETTINGS, DEFAULT_SETTINGS, SCORING_ONLY_SETTINGS, ANSWER_LABEL,
  allowedAnswers, normCriterion, sameCriterion, weightSum, fmtNum, validateBody, diffBodies, replacements, autoNote, nextKey, locate, blank, txt,
} from './checklist-model.js';

const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
const trunc = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const nCrit = (n) => `${n} ${plural(n, 'критерий', 'критерия', 'критериев')}`;
const nDialogs = (n) => `${n} ${plural(n, 'диалог', 'диалога', 'диалогов')}`;
const LONG_FIELDS = new Set(['title', 'definition', 'yes_when', 'no_when', 'na_when', 'guidance', 'voice_guidance']);

// Несохранённые правки переживают уход с экрана внутри вкладки (переход в карточку и обратно).
let kept = null;

function fmtVal(field, v) {
  if (v == null || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'да' : 'нет';
  if (field === 'type') return TYPE_LABEL[v] || v;
  if (field === 'scale') return v.map((s) => s.value).join(' / ');
  if (field === 'guards') return v.length ? `${v.length} шт.` : '—';
  if (Array.isArray(v)) return v.length ? v.join(', ') : '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function typeBadge(c) {
  if (c.type === 'flag') return h('span', { class: 'cqa-badge cqa-badge--flag' }, 'Флаг');
  if (c.type === 'scale') {
    const vals = (c.scale || []).map((s) => Number(s.value)).filter(Number.isFinite);
    return h('span', { class: 'cqa-badge cqa-badge--step' }, vals.length ? `Шкала ${Math.min(...vals)}–${Math.max(...vals)}` : 'Шкала');
  }
  return h('span', { class: 'cqa-badge cqa-badge--muted' }, 'Да / Нет');
}

/** Список отличий (FR-CHK-08) с пометкой, что потребует вызова модели (FR-CHK-10). */
export function diffView(d, { compact = false } = {}) {
  if (d.empty) return h('div', { class: 'cqa-chk-diff cqa-chk-diff--empty' }, 'Отличий нет.');
  const rep = replacements(d);
  const effect = d.allLlm
    ? h('div', { class: 'cqa-chk-effect cqa-chk-effect--all' }, h('b', null, 'Переоценка: все критерии заново'), ' — изменены настройки или секции, которые входят в промпт.')
    : d.llmKeys.length
      ? h('div', { class: 'cqa-chk-effect cqa-chk-effect--some' }, h('b', null, `Переоценка: вызовы модели только по ${d.llmKeys.join(', ')}`), ' — остальные ответы возьмём из прошлых оценок (reuse auto).')
      : h('div', { class: 'cqa-chk-effect cqa-chk-effect--none' }, h('b', null, 'Только пересчёт баллов'), ' — вызовы модели не нужны.');
  if (compact) return effect;
  const line = (mark, cls, ...kids) => h('li', { class: `cqa-chk-diff__item cqa-chk-diff__item--${cls}` }, h('span', { class: 'cqa-chk-diff__mark', 'aria-hidden': 'true' }, mark), h('div', null, ...kids));
  const items = [];
  for (const r of rep) items.push(line('⇄', 'rep', h('b', null, `Замена ${r.from} → ${r.to}`), ` · код в файле сдачи ${r.export_id}`));
  for (const c of d.added) items.push(line('+', 'add', h('b', { class: 'cqa-mono' }, c.key), ` «${c.title}» — новый критерий · ${TYPE_LABEL[c.type] || c.type}, вес ${fmtNum(c.weight)}${c.export_id ? `, ${c.export_id}` : ''}${c.enabled ? '' : ' (выключен)'}`));
  for (const c of d.removed) items.push(line('−', 'del', h('b', { class: 'cqa-mono' }, c.key), ` «${c.title}» — удалён`));
  for (const x of d.changed) {
    items.push(line('~', x.llm ? 'llm' : 'chg', h('b', { class: 'cqa-mono' }, x.key), ` «${x.title}»`,
      x.llm ? h('span', { class: 'cqa-badge cqa-badge--accent cqa-chk-diff__tag' }, 'вызов модели') : h('span', { class: 'cqa-badge cqa-badge--muted cqa-chk-diff__tag' }, 'без вызова'),
      h('ul', { class: 'cqa-chk-diff__fields' }, x.fields.map((f) => h('li', null, h('span', { class: 'cqa-chk-diff__fname' }, FIELD_LABEL[f.field] || f.field), ': ',
        LONG_FIELDS.has(f.field)
          ? h('span', { class: 'cqa-chk-diff__long', title: `было: ${f.from ?? '—'}\nстало: ${f.to ?? '—'}` }, f.to ? `«${trunc(f.to, 90)}»` : 'очищено')
          : h('span', null, h('s', { class: 'cqa-faint' }, fmtVal(f.field, f.from)), ' → ', h('b', null, fmtVal(f.field, f.to))))))));
  }
  if (d.reordered) items.push(line('↕', 'chg', 'Порядок критериев изменён'));
  for (const s of d.settings) items.push(line('⚙', s.llm ? 'llm' : 'chg', `Настройка «${s.label}»: `, h('s', { class: 'cqa-faint' }, fmtVal('', s.from)), ' → ', h('b', null, fmtVal('', s.to))));
  for (const s of d.sections) {
    items.push(line('§', 'llm', s.type === 'added' ? `Секция «${s.to}» добавлена` : s.type === 'removed' ? `Секция «${s.from}» удалена` : `Секция «${s.from}» переименована в «${s.to}»`));
  }
  if (d.name) items.push(line('✎', 'chg', `Название чек-листа: «${d.name.from || '—'}» → «${d.name.to || '—'}»`));
  return h('div', { class: 'cqa-chk-diff' }, effect, h('ul', { class: 'cqa-chk-diff__list' }, items));
}

export function mount(el, params = {}) {
  let p = { ...params };
  const root = h('div', { class: 'cqa-page cqa-chk' });
  el.append(root);
  const host = () => el.closest('.cqa-root') || el;
  const st = {
    loading: true, error: null, versions: [], cur: null, draft: null, note: '', importedFrom: null, importError: null,
    serverErrors: [], saveError: null, saving: false, saved: null, tab: 'criteria', flash: null, cmpId: null, tech: false,
    bodies: new Map(), rows: null,
  };
  let alive = true, editor = null, factNames = [];
  getFactLabels().then((r) => { factNames = Object.entries(r?.labels || {}); }).catch(() => { /* без подсказок */ });

  const headEl = h('div'), statsEl = h('div', { class: 'cqa-chk-stats' }), bannersEl = h('div', { class: 'cqa-chk-banners' });
  const tabsEl = h('div', { class: 'cqa-chk-tabs' }), bodyEl = h('div', { class: 'cqa-chk-body' }), saveEl = h('div', { class: 'cqa-chk-savewrap' });
  const fileIn = h('input', { type: 'file', accept: '.json,application/json', hidden: true, 'aria-hidden': 'true', id: 'cqa-chk-file', onchange: onFile });
  root.append(headEl, statsEl, bannersEl, tabsEl, bodyEl, saveEl, fileIn);

  const group = () => p.group || 'DEV';
  const meta = (id) => st.versions.find((v) => v.id === id) || null;
  const curMeta = () => (st.cur ? meta(st.cur.id) || st.cur : null);
  const dirty = () => !!(st.cur && st.draft && JSON.stringify(st.draft) !== JSON.stringify(st.cur.body));
  const check = () => validateBody(st.draft);
  const latestId = () => st.versions.filter((v) => v.key === st.cur?.key).sort((a, b) => b.version - a.version)[0]?.id;

  // ---------------------------------------------------------------- загрузка
  async function load(versionId, keepDraft = null) {
    st.loading = true; st.error = null;
    renderAll();
    try {
      st.versions = await listChecklists();
      const pick = versionId != null ? meta(Number(versionId)) : null;
      const target = pick || st.versions.find((v) => v.is_active) || st.versions[0];
      if (!target) { st.cur = null; st.loading = false; renderAll(); return; }
      const full = await getBody(target.id);
      if (!alive) return;
      setCurrent(full, keepDraft);
      if (versionId != null && !pick) toast(host(), `Версии #${versionId} нет — открыта ${target.is_active ? 'активная' : 'последняя'}.`);
    } catch (e) { st.error = e; }
    st.loading = false;
    if (alive) renderAll();
  }
  async function getBody(id) {
    if (st.bodies.has(id)) return st.bodies.get(id);
    const full = await getChecklist(id);
    st.bodies.set(id, full);
    return full;
  }
  function setCurrent(full, keepDraft = null) {
    st.cur = { ...full, body: full.body };
    st.draft = keepDraft ? keepDraft.draft : clone(full.body);
    st.note = keepDraft?.note || '';
    st.importedFrom = keepDraft?.importedFrom || null;
    st.importError = null; st.serverErrors = []; st.saveError = null;
    st.cmpId = defaultCompare(full);
    if (st.cmpId != null) getBody(st.cmpId).then(() => { if (alive && st.tab === 'history') renderBody(); }).catch(() => {});
    // адрес без перехода: версия в hash, остальные параметры экрана (group и т. п.) сохраняются
    const q = new URLSearchParams(location.hash.startsWith('#/checklist') ? location.hash.split('?')[1] || '' : '');
    q.set('version', full.id);
    emit(root, 'cqa:location', { to: `#/checklist?${q}` });
  }
  function defaultCompare(v) {
    if (v.parent_id != null && meta(v.parent_id)) return v.parent_id;
    const prev = st.versions.filter((x) => x.key === v.key && x.version < v.version).sort((a, b) => b.version - a.version)[0];
    return prev ? prev.id : null;
  }

  // ---------------------------------------------------------------- правки
  /** Любая правка черновика: сбрасывает ответ сервера и перерисовывает экран. */
  function commit(fn, { body = true } = {}) {
    fn(st.draft);
    st.serverErrors = []; st.saveError = null; st.saved = null; st.importError = null;
    body ? renderAll() : renderChrome();
  }
  function discard() {
    st.draft = clone(st.cur.body); st.note = ''; st.importedFrom = null; st.serverErrors = []; st.saveError = null; kept = null;
    renderAll();
  }
  function moveCrit(idx, dir) {
    const list = st.draft.criteria;
    const sec = list[idx].section;
    let j = idx + dir;
    while (j >= 0 && j < list.length && list[j].section !== sec) j += dir;
    if (j < 0 || j >= list.length) return;
    commit((d) => { [d.criteria[idx], d.criteria[j]] = [d.criteria[j], d.criteria[idx]]; });
    flash(list[j].key);
  }
  function flash(key) {
    st.flash = key;
    requestAnimationFrame(() => {
      const row = root.querySelector(`.cqa-chk-row[data-key="${CSS.escape(key)}"]`);
      row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    setTimeout(() => { if (st.flash === key) { st.flash = null; root.querySelector(`.cqa-chk-row[data-key="${CSS.escape(key)}"]`)?.classList.remove('cqa-chk-row--flash'); } }, 2400);
  }

  // ---------------------------------------------------------------- сохранение и активация
  async function save() {
    const v = check();
    if (v.errors.length) { renderChrome(); bannersEl.querySelector('.cqa-banner--flag')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return; }
    const d = diffBodies(st.cur.body, st.draft);
    const before = new Set(st.versions.map((x) => x.id));
    const refs = st.draft.criteria.slice();
    const body = clone(st.draft);
    const parent = st.cur.key === body.key ? st.cur.id : null;
    st.saving = true; st.saveError = null; st.serverErrors = [];
    renderChrome();
    try {
      const res = await createChecklist({ body, note: st.note.trim() || autoNote(d), parent_id: parent });
      if (!alive) return;
      st.versions = await listChecklists();
      st.bodies.set(res.id, res);
      st.saved = { id: res.id, version: res.version, note: res.note, warnings: res.warnings || [], existed: before.has(res.id) };
      kept = null;
      setCurrent(res);
      st.tab = 'criteria';
    } catch (e) {
      if (e.status === 422 && e.errors?.length) st.serverErrors = e.errors.map((x) => ({ ...x, at: locate(x.path, x.message), refs }));
      else st.saveError = e;
    }
    st.saving = false;
    if (alive) renderAll();
    if (st.saved) { st.flash = null; root.querySelector('.cqa-chk-saved')?.scrollIntoView({ block: 'center' }); }
  }
  async function activate(id) {
    try {
      await activateChecklist(id);
      await markActive(id);
      toast(host(), `Версия v${meta(id)?.version ?? ''} активна: по ней идут прогоны и файл сдачи.`);
    } catch (e) { toast(host(), e.message || String(e)); }
    if (alive) renderAll();
  }
  /** Версию уже активировали (здесь или в окне запуска): обновить список версий и флаги без повторного запроса активации. */
  async function markActive(id) {
    try { st.versions = await listChecklists(); } catch { st.versions = st.versions.map((v) => ({ ...v, is_active: v.id === id })); }
    if (st.cur?.id === id) st.cur.is_active = true;
    for (const b of st.bodies.values()) b.is_active = b.id === id;
  }

  // ---------------------------------------------------------------- применить к диалогам
  async function ensureRows() {
    if (!st.rows) st.rows = await listConversations({ group_id: group() });
    return st.rows;
  }
  // Одна кнопка «Переоценить диалоги…»: окно запуска по всей группе (выбор отдельных диалогов — ссылкой в окне),
  // с галочкой «Сделать версию активной» (включена по умолчанию; активация — до запуска прогона).
  function runRequest(versionId, ids, rows) {
    const v = meta(versionId);
    emit(root, 'cqa:run-request', { ids, rows, group: group(), checklistVersionId: versionId, preset: { reuse: 'auto' },
      title: `Переоценить по чек-листу v${v?.version ?? ''}`,
      intro: `${v?.note ? `«${v.note}». ` : ''}С прошлыми ответами модель оценит только новые и изменённые критерии, остальное возьмём из прошлых оценок.`,
      offerActivate: true,
      onActivated: (id) => { markActive(id).then(() => { if (alive) renderAll(); }); },
      onPick: () => pickThenRun(versionId, rows, ids) });
  }
  async function rerun(versionId) {
    try { runRequest(versionId, [], await ensureRows()); } catch (e) { toast(host(), e.message || String(e)); }
  }
  function pickThenRun(versionId, rows, preselected) {
    openPicker(rows, (ids) => runRequest(versionId, ids, rows), preselected);
  }

  // ---------------------------------------------------------------- импорт и экспорт
  function exportJson(body, v) {
    const blob = new Blob([JSON.stringify(body, null, 2) + '\n'], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `checklist-${body.key || 'cqa'}-v${v?.version ?? 0}${dirty() && body === st.draft ? '-draft' : ''}.json`, hidden: true });
    root.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function importClick() {
    if (dirty()) { toast(host(), 'Сначала сохраните или отмените текущие изменения.'); return; }
    fileIn.click();
  }
  async function onFile(e) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    let obj;
    try { obj = JSON.parse(await f.text()); } catch (err) { st.importError = `Файл «${f.name}» — не JSON: ${err.message}`; renderChrome(); return; }
    const body = obj && typeof obj === 'object' && obj.body && Array.isArray(obj.body.criteria) ? obj.body : obj;
    if (!body || typeof body !== 'object' || !Array.isArray(body.criteria) || !Array.isArray(body.sections)) {
      st.importError = `В файле «${f.name}» нет чек-листа: нужны поля sections и criteria (формат data/checklists/default.json).`;
      renderChrome(); return;
    }
    if (!st.cur) { // чек-листов ещё нет: файл сразу становится первой версией
      try { const res = await createChecklist({ body, note: `Импорт из ${f.name}` }); await load(res.id); } catch (err) { toast(host(), err.message || String(err)); }
      return;
    }
    if (JSON.stringify(body) === JSON.stringify(st.cur.body)) { toast(host(), 'Файл совпадает с открытой версией — сохранять нечего.'); return; }
    st.draft = clone(body); st.importedFrom = f.name; st.note = `Импорт из ${f.name}`;
    st.serverErrors = []; st.saveError = null; st.saved = null; st.importError = null; st.tab = 'criteria';
    renderAll();
  }

  // ---------------------------------------------------------------- отрисовка
  function renderAll() {
    renderHead(); renderChrome(); renderTabs(); renderBody();
  }
  function renderChrome() { renderStats(); renderBanners(); renderSave(); renderHeadActions(); }

  function renderHead() {
    clear(headEl);
    const c = curMeta();
    headEl.append(h('div', { class: 'cqa-pagehead' },
      h('div', { class: 'cqa-chk-title' },
        h('h1', { class: 'cqa-h1' }, 'Чек-листы'),
        h('div', { class: 'cqa-pagehead__sub' }, c
          ? [h('span', null, `${st.cur.body?.name || c.name} · `), h('b', null, `версия ${c.version}`), ' ',
            c.is_active ? h('span', { class: 'cqa-badge cqa-badge--yes', id: 'cqa-chk-active-badge' }, 'активная') : h('span', { class: 'cqa-badge cqa-badge--muted' }, 'не активная'),
            h('span', null, ` · ${fmtDate(c.created_at)}`), c.note ? h('span', { class: 'cqa-chk-title__note' }, ` · «${c.note}»`) : null]
          : 'Версии, критерии и применение к диалогам')),
      h('div', { class: 'cqa-pagehead__actions cqa-chk-actions' })));
    renderHeadActions();
  }
  function renderHeadActions() {
    const box = headEl.querySelector('.cqa-chk-actions');
    if (!box) return;
    clear(box);
    const c = curMeta();
    if (!c || st.loading) return;
    const isDirty = dirty();
    box.append(...[
      h('button', { type: 'button', class: 'cqa-btn', onclick: importClick, title: 'Загрузить чек-лист из JSON и сохранить как новую версию' }, 'Импорт JSON'),
      h('button', { type: 'button', class: 'cqa-btn', onclick: () => exportJson(isDirty ? st.draft : st.cur.body, c), title: isDirty ? 'Скачать черновик с несохранёнными правками' : 'Скачать тело этой версии' }, 'Экспорт JSON'),
      // Пока открыта панель «Сохранена версия», её кнопка — единственное основное действие: в шапке не дублируем.
      st.saved ? null : h('button', { type: 'button', class: 'cqa-btn cqa-btn--primary', id: 'cqa-chk-apply', disabled: isDirty,
        title: isDirty ? 'Сначала сохраните изменения как новую версию' : `Оценить диалоги группы ${group()} по версии v${c.version}${c.is_active ? '' : ' (в окне запуска её можно сразу сделать активной)'}`,
        onclick: () => rerun(c.id) }, 'Переоценить диалоги…')].filter(Boolean));
  }

  function renderStats() {
    clear(statsEl);
    if (!st.draft || st.loading) return;
    const v = check();
    const all = st.draft.criteria || [];
    const on = all.filter((c) => c.enabled !== false);
    const total = weightSum(st.draft);
    const ok100 = Math.abs(total - 100) < 1e-9;
    const flags = on.filter((c) => c.type === 'flag');
    const stat = (cls, label, value, extra) => h('div', { class: `cqa-chk-stat ${cls ? 'cqa-chk-stat--' + cls : ''}` }, h('span', { class: 'cqa-chk-stat__label' }, label), h('b', { class: 'cqa-chk-stat__val' }, value), extra ? h('span', { class: 'cqa-chk-stat__extra' }, extra) : null);
    statsEl.append(
      stat('', 'Критерии', `${on.length} включено`, all.length > on.length ? `${all.length - on.length} выкл.` : null),
      h('div', { class: `cqa-chk-stat cqa-chk-stat--${ok100 ? 'ok' : 'warn'}`, id: 'cqa-chk-weight-sum' },
        h('span', { class: 'cqa-chk-stat__label' }, 'Сумма весов'), h('b', { class: 'cqa-chk-stat__val' }, fmtNum(total)),
        h('span', { class: 'cqa-chk-stat__extra' }, ok100 ? 'ровно 100' : 'итог нормируется к 100')),
      stat('', 'Флаги', String(flags.length), flags.map((c) => c.key).join(', ') || null),
      stat(v.errors.length ? 'bad' : 'ok', 'Ошибки', String(v.errors.length), v.errors.length ? 'сохранить нельзя' : 'нет'),
      stat(v.warnings.length ? 'warn' : '', 'Предупреждения', String(v.warnings.length)));
  }

  function errLine(e, kind) {
    const at = e.at || locate(e.path, e.message);
    const crit = at.kind === 'criterion' ? (kind === 'server' ? e.refs?.[at.idx] : st.draft.criteria[at.idx]) : null;
    const idx = crit ? st.draft.criteria.indexOf(crit) : -1;
    const where = crit ? `${crit.key || '(без кода)'}${at.field ? ` · ${FIELD_LABEL[at.field.split('.')[0]] || at.field}` : ''}`
      : at.kind === 'settings' ? `Настройки · ${at.field}` : at.kind === 'sections' ? 'Секции' : e.path || 'Чек-лист';
    const fix = idx >= 0 ? () => openEditor('edit', idx, { focus: at.field })
      : at.kind === 'settings' || at.kind === 'sections' || e.path === 'name' ? () => { st.tab = 'settings'; renderTabs(); renderBody(); } : null;
    return h('li', null, h('b', null, where), ' — ', e.message, fix ? [' ', h('button', { type: 'button', class: 'cqa-linkbtn', onclick: fix }, 'исправить')] : null);
  }

  function renderBanners() {
    clear(bannersEl);
    if (st.loading || !st.draft) return;
    const v = check();
    const c = curMeta();
    const banner = (cls, icon, title, ...kids) => h('div', { class: `cqa-banner cqa-banner--${cls}` }, h('span', { class: 'cqa-banner__icon' }, icon), h('div', { class: 'cqa-chk-banner__body' }, title ? h('div', { class: 'cqa-banner__title' }, title) : null, ...kids));
    if (st.saved) {
      const sv = st.saved;
      const m = meta(sv.id);
      bannersEl.append(h('div', { class: 'cqa-banner cqa-banner--info cqa-chk-saved', role: 'status' },
        h('span', { class: 'cqa-banner__icon' }, '✓'),
        h('div', { class: 'cqa-chk-banner__body' },
          h('div', { class: 'cqa-banner__title', id: 'cqa-chk-saved-title' }, sv.existed ? `Такая версия уже есть — v${sv.version}, новая не создана.` : `Сохранена версия v${sv.version}${sv.note ? ` «${sv.note}»` : ''}.`),
          m?.is_active ? h('div', null, 'Она активная: по ней идут прогоны, дашборд и файл сдачи.')
            : h('div', null, 'Переоцените диалоги по ней — в окне запуска версия сразу станет активной. Прошлые оценки останутся на своей версии.'),
          sv.warnings.length ? h('ul', { class: 'cqa-errlist' }, sv.warnings.map((w) => h('li', null, w))) : null,
          isMock() ? h('div', { class: 'cqa-faint' }, 'Демо-режим: версия хранится только в этой вкладке.') : null,
          h('div', { class: 'cqa-chk-saved__acts' },
            h('button', { type: 'button', class: 'cqa-btn cqa-btn--primary', id: 'cqa-chk-rerun', onclick: () => rerun(sv.id),
              title: `Окно запуска по группе ${group()}${st.rows ? ` (${nDialogs(st.rows.length)})` : ''}; отдельные диалоги — ссылкой в окне` }, 'Переоценить диалоги…'),
            m && !m.is_active ? h('button', { type: 'button', class: 'cqa-linkbtn', id: 'cqa-chk-activate', onclick: () => activate(sv.id) }, 'Только сделать активной') : null,
            h('button', { type: 'button', class: 'cqa-btn cqa-btn--ghost', onclick: () => { st.saved = null; renderChrome(); } }, 'Скрыть')),
          h('div', { class: 'cqa-field__hint' }, 'По умолчанию переоценка с прошлыми ответами: вызовы модели только по изменённым критериям.'))));
      if (!st.rows) ensureRows().then(() => { if (alive && st.saved) renderBanners(); }).catch(() => {});
    }
    if (st.serverErrors.length) {
      bannersEl.append(h('div', { class: 'cqa-banner cqa-banner--flag', role: 'alert', id: 'cqa-chk-server-errors' }, h('span', { class: 'cqa-banner__icon' }, '!'),
        h('div', { class: 'cqa-chk-banner__body' }, h('div', { class: 'cqa-banner__title' }, 'Сервер не принял версию — исправьте и сохраните ещё раз'),
          h('ul', { class: 'cqa-errlist' }, st.serverErrors.map((e) => errLine(e, 'server'))))));
    }
    if (st.saveError) bannersEl.append(banner('flag', '!', 'Версия не сохранена', h('div', null, st.saveError.message || String(st.saveError))));
    if (st.importError) bannersEl.append(banner('flag', '!', 'Файл не загружен', h('div', null, st.importError)));
    if (st.importedFrom) {
      const otherKey = st.draft.key !== st.cur.body.key;
      bannersEl.append(banner('info', '⇩', `Загружено из файла «${st.importedFrom}»`,
        h('div', null, 'Проверьте отличия и сохраните как новую версию.', otherKey ? ` Ключ «${st.draft.key}» отличается от открытого «${st.cur.body.key}»: сохранится как отдельный чек-лист.` : '')));
    }
    if (v.errors.length) {
      bannersEl.append(h('div', { class: 'cqa-banner cqa-banner--flag', id: 'cqa-chk-errors' }, h('span', { class: 'cqa-banner__icon' }, '!'),
        h('div', { class: 'cqa-chk-banner__body' }, h('div', { class: 'cqa-banner__title' }, `Ошибки: ${v.errors.length} — версию нельзя сохранить`),
          h('ul', { class: 'cqa-errlist' }, v.errors.slice(0, 8).map((e) => errLine(e, 'client')), v.errors.length > 8 ? h('li', null, `…ещё ${v.errors.length - 8}`) : null))));
    }
    if (v.warnings.length) {
      bannersEl.append(h('div', { class: 'cqa-banner cqa-banner--warn', id: 'cqa-chk-warnings' }, h('span', { class: 'cqa-banner__icon' }, '!'),
        h('div', { class: 'cqa-chk-banner__body' }, h('div', { class: 'cqa-banner__title' }, 'Предупреждения — сохранить можно'),
          h('ul', { class: 'cqa-errlist' }, v.warnings.map((w) => h('li', null, w))))));
    }
    if (c && st.cur.id !== latestId() && !st.saved) {
      const last = meta(latestId());
      bannersEl.append(banner('info', 'i', null, `Открыта версия v${c.version}, последняя — v${last?.version}. Правки сохранятся новой версией на основе v${c.version}. `,
        h('button', { type: 'button', class: 'cqa-linkbtn', onclick: () => openVersion(last.id) }, `Открыть v${last?.version}`)));
    }
  }

  function renderTabs() {
    clear(tabsEl);
    if (st.loading || !st.draft) return;
    const n = (st.draft.criteria || []).length;
    const tabs = [['criteria', `Критерии · ${n}`], ['settings', 'Настройки'], ['history', `История · ${st.versions.length}`]];
    tabsEl.append(h('div', { class: 'cqa-seg cqa-chk-seg', role: 'tablist', 'aria-label': 'Разделы чек-листа' },
      tabs.map(([id, label]) => h('button', { type: 'button', class: 'cqa-seg__btn', role: 'tab', id: `cqa-chk-tab-${id}`, 'aria-selected': String(st.tab === id), 'aria-pressed': String(st.tab === id),
        onclick: () => { st.tab = id; renderTabs(); renderBody(); } }, label))));
  }

  function renderBody() {
    clear(bodyEl);
    if (st.loading) { bodyEl.append(h('div', { class: 'cqa-panel', style: 'padding:16px' }, skeletonRows(8))); return; }
    if (st.error) { bodyEl.append(h('div', { class: 'cqa-panel' }, errorState(st.error, () => load(p.version)))); return; }
    if (!st.cur) {
      bodyEl.append(h('div', { class: 'cqa-panel' }, emptyState({ title: 'Чек-листов пока нет', text: 'Чек-лист по умолчанию создаётся при первом запуске бэкенда. Можно загрузить свой из JSON.', icon: '☰',
        actionLabel: 'Импорт JSON', onAction: () => fileIn.click() })));
      return;
    }
    if (st.tab === 'settings') bodyEl.append(settingsView());
    else if (st.tab === 'history') bodyEl.append(historyView());
    else bodyEl.append(criteriaView());
  }

  // ---------------------------------------------------------------- критерии
  function criteriaView() {
    const d = st.draft;
    const v = check();
    const base = new Map((st.cur.body.criteria || []).map((c) => [c.key, c]));
    const clientErr = new Map();
    for (const e of v.errors) {
      const at = locate(e.path, e.message);
      if (at.kind === 'criterion') clientErr.set(at.idx, [...(clientErr.get(at.idx) || []), e.message]);
    }
    const serverErr = (c) => st.serverErrors.filter((e) => e.at?.kind === 'criterion' && e.refs?.[e.at.idx] === c).map((e) => e.message);
    const sections = d.sections || [];
    const known = new Set(sections.map((s) => s.id));
    const orphans = d.criteria.filter((c) => !known.has(c.section));
    // «Технические поля» (код в файле сдачи, группа вызова, id секций) нужны команде, а не тому, кто правит критерии: по умолчанию скрыты.
    const panel = h('div', { class: `cqa-panel cqa-chk-list ${st.tech ? 'cqa-chk-list--tech' : ''}` },
      h('div', { class: 'cqa-panel__head cqa-chk-list__head' },
        h('div', null, h('h2', { class: 'cqa-h2' }, 'Критерии по секциям'),
          h('div', { class: 'cqa-chk-hint' }, h('b', null, 'Заменить'), ' — новый критерий на месте старого: та же секция, вес и код в файле сдачи; старый выключится и останется в истории.')),
        h('label', { class: 'cqa-toggle cqa-chk-techtoggle', title: 'Код в файле сдачи, группа вызова модели, id секций' },
          h('input', { type: 'checkbox', id: 'cqa-chk-tech', checked: st.tech, onchange: (e) => { st.tech = e.target.checked; panel.classList.toggle('cqa-chk-list--tech', st.tech); } }), 'Технические поля'),
        h('button', { type: 'button', class: 'cqa-btn', id: 'cqa-chk-add', onclick: () => openEditor('new', -1, { section: sections[0]?.id }) }, '+ Критерий')),
      h('div', { class: 'cqa-chk-row cqa-chk-row--head', 'aria-hidden': 'true' },
        h('span', null), h('span', null, 'Код'), h('span', null, 'Критерий'), h('span', null, 'Тип'), h('span', { class: 'cqa-chk-num' }, 'Вес'),
        h('span', null, 'N/A'), h('span', { class: 'cqa-chk-tech' }, 'В файле сдачи'), h('span', { class: 'cqa-chk-tech' }, 'Группа'), h('span', null, 'Вкл.'), h('span', null)));
    const secBlock = (title, id, list) => {
      const sum = list.filter((c) => c.enabled !== false && c.type !== 'flag').reduce((s, c) => s + (Number(c.weight) || 0), 0);
      return h('section', { class: 'cqa-chk-sec', dataset: { section: id } },
        h('div', { class: 'cqa-chk-sec__head' }, h('span', { class: 'cqa-chk-sec__title' }, title), h('span', { class: 'cqa-chk-sec__id cqa-chk-tech cqa-mono' }, id),
          h('span', { class: 'cqa-chk-sec__sum' }, list.length ? `Σ вес ${fmtNum(sum)}` : 'пусто')),
        list.map((c) => critRow(c, d.criteria.indexOf(c), base, [...(clientErr.get(d.criteria.indexOf(c)) || []), ...serverErr(c)])),
        known.has(id) ? h('button', { type: 'button', class: 'cqa-linkbtn cqa-chk-sec__add', onclick: () => openEditor('new', -1, { section: id }) }, `+ Добавить критерий в «${title}»`) : null);
    };
    for (const s of sections) panel.append(secBlock(s.title || s.id, s.id, d.criteria.filter((c) => c.section === s.id)));
    if (orphans.length) panel.append(secBlock('Без секции', '—', orphans));
    return panel;
  }

  function critRow(c, idx, base, errs) {
    const n = normCriterion(c);
    const was = base.get(c.key);
    const status = !was ? 'new' : !sameCriterion(was, c) ? 'changed' : null;
    const replacedBy = !n.enabled && n.export_id ? st.draft.criteria.find((x) => x !== c && x.enabled !== false && txt(x.export_id) === n.export_id) : null;
    const sameSec = st.draft.criteria.map((x, i) => [x, i]).filter(([x]) => x.section === c.section).map(([, i]) => i);
    const pos = sameSec.indexOf(idx);
    const cell = (cls, label, ...kids) => h('div', { class: `cqa-chk-cell cqa-chk-cell--${cls}`, dataset: label ? { label } : undefined }, ...kids);
    return h('div', { class: `cqa-chk-row${n.enabled ? '' : ' cqa-chk-row--off'}${errs.length ? ' cqa-chk-row--err' : ''}${st.flash === c.key ? ' cqa-chk-row--flash' : ''}`,
      dataset: { key: c.key }, id: `chk-${c.key}` },
    cell('ord', null,
      h('button', { type: 'button', class: 'cqa-chk-ord', 'aria-label': `Поднять ${c.key}`, title: 'Выше', disabled: pos <= 0, onclick: () => moveCrit(idx, -1) }, '▲'),
      h('button', { type: 'button', class: 'cqa-chk-ord', 'aria-label': `Опустить ${c.key}`, title: 'Ниже', disabled: pos === sameSec.length - 1, onclick: () => moveCrit(idx, 1) }, '▼')),
    cell('code', null, h('span', { class: `cqa-code${c.type === 'flag' ? ' cqa-code--flag' : ''}` }, c.key || '?')),
    cell('title', null,
      h('div', { class: 'cqa-chk-row__title' },
        h('button', { type: 'button', class: 'cqa-chk-row__name', onclick: () => openEditor('edit', idx) }, c.title || '(без названия)'),
        status === 'new' ? h('span', { class: 'cqa-badge cqa-badge--accent' }, 'новый') : null,
        status === 'changed' ? h('span', { class: 'cqa-badge cqa-badge--warn' }, 'изменён') : null,
        !n.enabled ? h('span', { class: 'cqa-badge cqa-badge--muted' }, replacedBy ? `выключен · заменён на ${replacedBy.key}` : 'выключен') : null),
      h('div', { class: 'cqa-chk-row__def' }, trunc(c.definition, 150) || h('span', { class: 'cqa-faint' }, 'нет определения')),
      errs.map((m) => h('div', { class: 'cqa-chk-row__err', role: 'alert' }, m))),
    cell('type', 'Тип', typeBadge(c)),
    cell('weight', 'Вес', c.type === 'flag' ? h('span', { class: 'cqa-faint', title: 'Флаг без баллов' }, '—') : h('b', { class: 'cqa-chk-num' }, fmtNum(Number(c.weight)))),
    cell('na', 'N/A', n.na_allowed && c.type !== 'flag' ? h('span', { class: 'cqa-chk-na', title: n.na_when || '' }, 'да') : h('span', { class: 'cqa-faint' }, '—')),
    cell('export cqa-chk-tech', 'В файле', n.export_id ? h('span', { class: 'cqa-chip cqa-mono' }, n.export_id) : h('span', { class: 'cqa-faint' }, '—')),
    cell('group cqa-chk-tech', 'Группа', n.group ? h('span', { class: 'cqa-chip cqa-mono', title: 'Критерии одной группы оцениваются одним вызовом' }, n.group) : h('span', { class: 'cqa-faint', title: 'Свой вызов' }, '—')),
    cell('on', null, h('label', { class: 'cqa-chk-switch', title: n.enabled ? 'Включён: участвует в оценке' : 'Выключен: не оценивается' },
      h('input', { type: 'checkbox', checked: n.enabled, 'aria-label': `Включён ${c.key}`,
        onchange: (e) => { const on = e.target.checked; commit((d) => { d.criteria[idx] = { ...d.criteria[idx], enabled: on }; }); } }),
      h('span', { class: 'cqa-chk-switch__ui', 'aria-hidden': 'true' }))),
    cell('acts', null,
      h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm', onclick: () => openEditor('edit', idx) }, 'Изменить'),
      n.enabled ? h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm cqa-chk-trial', id: `cqa-chk-trial-${c.key}`,
        title: 'Проверить критерий из черновика на 1–5 диалогах до сохранения: было → стало, без изменения оценок',
        onclick: () => {
          // заменённый критерий: выключенный с тем же кодом в файле сдачи — с его ответами сравниваем «было»
          const old = n.export_id ? st.draft.criteria.find((x) => x !== c && x.enabled === false && txt(x.export_id) === n.export_id) : null;
          openTrial(host(), { body: clone(st.draft), criterionKey: c.key, compareKey: old?.key || null, group: group(), versionId: st.cur?.id ?? null });
        } }, 'Проверить') : null,
      n.enabled ? h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm cqa-chk-replace', id: `cqa-chk-replace-${c.key}`, onclick: () => openEditor('replace', idx),
        title: `Новый критерий на месте ${c.key}: та же секция, вес ${fmtNum(Number(c.weight))}${n.export_id ? ` и код ${n.export_id}` : ''}` }, 'Заменить') : null));
  }

  // ---------------------------------------------------------------- настройки и секции
  function settingsView() {
    const d = st.draft;
    const s = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
    const v = check();
    const errAt = (path) => v.errors.filter((e) => e.path === path).map((e) => e.message)
      .concat(st.serverErrors.filter((e) => e.path === path).map((e) => e.message));
    const setSetting = (k, val) => commit((b) => { b.settings = { ...(b.settings || {}), [k]: val }; }, { body: false });
    const parse = (raw) => { const t = String(raw).trim().replace(',', '.'); if (t === '') return raw; const n = Number(t); return Number.isFinite(n) ? n : raw; };
    const errSlot = (path) => h('div', { class: 'cqa-ce-err', dataset: { errpath: path } }, errAt(path).join('; '));
    const refreshErrs = () => {
      const vv = check();
      bodyEl.querySelectorAll('[data-errpath]').forEach((x) => {
        const m = vv.errors.filter((e) => e.path === x.dataset.errpath).map((e) => e.message).join('; ');
        x.textContent = m;
        x.parentElement.classList.toggle('cqa-ce-f--err', !!m);
      });
    };
    const effectTag = (k) => SCORING_ONLY_SETTINGS.has(k)
      ? h('span', { class: 'cqa-badge cqa-badge--muted' }, 'только пересчёт')
      : h('span', { class: 'cqa-badge cqa-badge--accent' }, 'в промпте: переоценка всех критериев');
    const fieldOf = (def) => {
      const id = `cqa-chk-set-${def.key}`;
      let control;
      if (def.kind === 'select') {
        control = h('select', { class: 'cqa-select', id, onchange: (e) => setSetting(def.key, e.target.value) },
          def.options.map(([val, label]) => h('option', { value: val, selected: String(s[def.key]).toLowerCase() === val }, label)),
          def.options.some(([val]) => val === String(s[def.key]).toLowerCase()) ? null : h('option', { value: s[def.key], selected: true }, String(s[def.key])));
      } else if (def.kind === 'bool') {
        control = h('label', { class: 'cqa-toggle' }, h('input', { type: 'checkbox', id, checked: !!s[def.key], onchange: (e) => setSetting(def.key, e.target.checked) }), s[def.key] ? 'включено' : 'выключено');
      } else {
        control = h('input', { class: 'cqa-input', id, type: 'number', min: 0, step: 1, inputmode: 'numeric', value: s[def.key],
          oninput: (e) => { setSetting(def.key, parse(e.target.value)); refreshErrs(); } });
      }
      const f = h('div', { class: `cqa-field cqa-ce-f${errAt(`settings.${def.key}`).length ? ' cqa-ce-f--err' : ''}` },
        h('label', { class: 'cqa-field__label', for: id }, def.label), control,
        h('div', { class: 'cqa-field__hint' }, def.hint, def.hint ? ' ' : '', effectTag(def.key)), errSlot(`settings.${def.key}`));
      return f;
    };
    const qt = s.quote_threshold || {};
    const qField = (ch, label) => h('div', { class: 'cqa-field cqa-ce-f' },
      h('label', { class: 'cqa-field__label', for: `cqa-chk-qt-${ch}` }, label),
      h('input', { class: 'cqa-input', id: `cqa-chk-qt-${ch}`, type: 'number', min: 0, max: 1, step: 0.05, value: qt[ch] ?? '',
        oninput: (e) => { commit((b) => { b.settings = { ...(b.settings || {}), quote_threshold: { ...DEFAULT_SETTINGS.quote_threshold, ...(b.settings?.quote_threshold || {}), [ch]: parse(e.target.value) } }; }, { body: false }); refreshErrs(); } }),
      errSlot(`settings.quote_threshold.${ch}`));

    const general = h('div', { class: 'cqa-panel cqa-chk-pane' },
      h('div', { class: 'cqa-panel__head' }, h('h2', { class: 'cqa-h2' }, 'Чек-лист')),
      h('div', { class: 'cqa-chk-form' },
        h('div', { class: `cqa-field cqa-ce-f${errAt('name').length ? ' cqa-ce-f--err' : ''}` }, h('label', { class: 'cqa-field__label', for: 'cqa-chk-name' }, 'Название'),
          h('input', { class: 'cqa-input', id: 'cqa-chk-name', value: d.name || '', oninput: (e) => { commit((b) => { b.name = e.target.value; }, { body: false }); refreshErrs(); } }), errSlot('name')),
        h('div', { class: 'cqa-field' }, h('div', { class: 'cqa-field__label' }, 'Ключ'), h('div', { class: 'cqa-field__static cqa-mono' }, d.key),
          h('div', { class: 'cqa-field__hint' }, 'Версии одного чек-листа связаны ключом; он не меняется.'))));
    const settings = h('div', { class: 'cqa-panel cqa-chk-pane' },
      h('div', { class: 'cqa-panel__head' }, h('h2', { class: 'cqa-h2' }, 'Настройки оценки')),
      h('div', { class: 'cqa-chk-form cqa-chk-form--grid' }, SETTINGS.map(fieldOf)),
      h('details', { class: 'cqa-chk-more' }, h('summary', null, 'Дополнительно: сверка цитат'),
        h('div', { class: 'cqa-chk-form cqa-chk-form--grid' },
          qField('chat', 'Порог сверки цитат · чат'), qField('voice', 'Порог сверки цитат · звонок'),
          h('div', { class: 'cqa-field__hint', style: 'grid-column:1/-1' }, 'Доля совпадения цитаты с текстом реплики, ниже которой цитата считается выдуманной (в звонках мягче из-за расшифровки).'))));

    const used = (id) => d.criteria.filter((c) => c.section === id).length;
    const secs = h('div', { class: 'cqa-panel cqa-chk-pane' },
      h('div', { class: 'cqa-panel__head cqa-chk-pane__head' }, h('h2', { class: 'cqa-h2' }, 'Секции'),
        h('span', { class: 'cqa-badge cqa-badge--accent cqa-chk-pane__tag' }, 'названия в промпте: переоценка всех критериев')),
      h('div', { class: 'cqa-chk-secs' },
        (d.sections || []).map((sec, i) => {
          const isNew = !(st.cur.body.sections || []).some((x) => x.id === sec.id);
          return h('div', { class: 'cqa-chk-secrow' },
            isNew
              ? h('div', { class: 'cqa-field cqa-ce-f cqa-chk-secrow__idc' }, h('input', { class: 'cqa-input cqa-mono', 'aria-label': 'id секции', value: sec.id, placeholder: 'id',
                onchange: (e) => commit((b) => { const old = b.sections[i].id; const nid = e.target.value.trim(); b.sections[i] = { ...b.sections[i], id: nid }; b.criteria = b.criteria.map((c) => (c.section === old ? { ...c, section: nid } : c)); }) }), errSlot(`sections.${i}.id`))
              : h('span', { class: 'cqa-chk-secrow__idc cqa-chk-secrow__id cqa-mono' }, sec.id),
            h('div', { class: 'cqa-field cqa-ce-f cqa-chk-secrow__title' }, h('input', { class: 'cqa-input', 'aria-label': `Название секции ${sec.id}`, value: sec.title || '',
              oninput: (e) => { commit((b) => { b.sections[i] = { ...b.sections[i], title: e.target.value }; }, { body: false }); refreshErrs(); } }), errSlot(`sections.${i}.title`)),
            h('span', { class: 'cqa-faint cqa-chk-secrow__n' }, nCrit(used(sec.id))),
            h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm cqa-btn--ghost cqa-chk-secrow__del', disabled: used(sec.id) > 0, title: used(sec.id) ? 'В секции есть критерии' : 'Удалить секцию',
              onclick: () => commit((b) => { b.sections.splice(i, 1); }) }, 'Удалить'));
        }),
        h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm', onclick: () => commit((b) => {
          const ids = new Set(b.sections.map((x) => x.id));
          let n = b.sections.length + 1;
          while (ids.has(`section-${n}`)) n += 1;
          b.sections.push({ id: `section-${n}`, title: 'Новая секция' });
        }) }, '+ Секция')));
    return h('div', { class: 'cqa-chk-panes' }, h('div', { class: 'cqa-chk-panes__col' }, general, secs), settings);
  }

  // ---------------------------------------------------------------- история версий
  function openVersion(id) {
    if (dirty()) { toast(host(), 'Сначала сохраните или отмените изменения.'); saveEl.querySelector('.cqa-chk-savebar')?.classList.add('cqa-chk-savebar--pulse'); return; }
    st.saved = null;
    const tab = st.tab;
    getBody(id).then((full) => { if (!alive) return; setCurrent(full); st.tab = tab; renderAll(); }).catch((e) => toast(host(), e.message || String(e)));
  }
  function historyView() {
    const c = curMeta();
    const sorted = st.versions.slice().sort((a, b) => (a.key === b.key ? b.version - a.version : a.key.localeCompare(b.key)));
    const list = h('div', { class: 'cqa-panel cqa-chk-vers' },
      h('div', { class: 'cqa-panel__head' }, h('h2', { class: 'cqa-h2' }, 'Версии'), h('span', { class: 'cqa-chip' }, String(st.versions.length))),
      h('ol', { class: 'cqa-chk-vers__list' }, sorted.map((v) => h('li', null,
        h('button', { type: 'button', class: `cqa-chk-ver${v.id === c.id ? ' cqa-chk-ver--cur' : ''}`, 'aria-current': v.id === c.id ? 'true' : null, dataset: { version: v.id },
          onclick: () => openVersion(v.id) },
        h('span', { class: 'cqa-chk-ver__top' }, h('b', { class: 'cqa-mono' }, `v${v.version}`),
          v.is_active ? h('span', { class: 'cqa-badge cqa-badge--yes' }, 'активная') : null,
          v.id === c.id ? h('span', { class: 'cqa-badge cqa-badge--accent' }, 'открыта') : null,
          h('span', { class: 'cqa-chk-ver__date cqa-faint' }, fmtDate(v.created_at))),
        h('span', { class: 'cqa-chk-ver__note' }, v.note || h('span', { class: 'cqa-faint' }, 'без заметки')),
        v.key !== c.key ? h('span', { class: 'cqa-faint cqa-mono' }, v.key) : null,
        v.parent_id != null && meta(v.parent_id) ? h('span', { class: 'cqa-faint cqa-chk-ver__parent' }, `на основе v${meta(v.parent_id).version}`) : null)))));

    const cmp = st.cmpId != null ? st.bodies.get(st.cmpId) : null;
    const others = st.versions.filter((v) => v.id !== c.id && v.key === c.key).sort((a, b) => b.version - a.version);
    const cmpSel = others.length ? h('select', { class: 'cqa-select', id: 'cqa-chk-cmp', 'aria-label': 'Сравнить с версией',
      onchange: (e) => { st.cmpId = Number(e.target.value); getBody(st.cmpId).then(() => alive && renderBody()).catch((err) => toast(host(), err.message)); } },
    others.map((v) => h('option', { value: v.id, selected: v.id === st.cmpId }, `v${v.version}${v.id === c.parent_id ? ' (родитель)' : ''}${v.is_active ? ' · активная' : ''}`))) : null;
    const detail = h('div', { class: 'cqa-panel cqa-chk-verdetail' },
      h('div', { class: 'cqa-panel__head cqa-chk-verdetail__head' },
        h('div', null, h('h2', { class: 'cqa-h2' }, `Версия v${c.version}`),
          h('div', { class: 'cqa-pagehead__sub' }, `${fmtDate(c.created_at)}${c.note ? ` · «${c.note}»` : ''} · ${nCrit((st.cur.body.criteria || []).length)}`)),
        h('div', { class: 'cqa-chk-verdetail__acts' },
          !c.is_active ? h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm cqa-btn--primary', disabled: dirty(), onclick: () => activate(c.id) }, 'Сделать активной') : h('span', { class: 'cqa-badge cqa-badge--yes' }, 'активная'),
          h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm', onclick: () => exportJson(st.cur.body, c) }, 'Экспорт JSON'),
          h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm', onclick: () => { st.tab = 'criteria'; renderTabs(); renderBody(); } }, 'Открыть критерии'))),
      h('div', { class: 'cqa-chk-verdetail__body' },
        others.length
          ? [h('div', { class: 'cqa-chk-cmp' }, h('span', { class: 'cqa-field__label' }, `Отличия v${c.version} от`), cmpSel),
            cmp ? diffView(diffBodies(cmp.body, st.cur.body)) : h('div', { class: 'cqa-faint' }, 'Загружаем…')]
          : h('div', { class: 'cqa-faint' }, 'Это первая версия — сравнивать не с чем.'),
        dirty() ? [h('h3', { class: 'cqa-h3 cqa-chk-verdetail__h' }, 'Несохранённые правки к этой версии'), diffView(diffBodies(st.cur.body, st.draft))] : null));
    return h('div', { class: 'cqa-chk-history' }, list, detail);
  }

  // ---------------------------------------------------------------- панель сохранения
  // Предупреждения сервера по черновику (в том числе «файл сдачи: …») — до сохранения, с задержкой после правки.
  let pre = { sig: null, warnings: [] }, preTimer = null;
  function precheck() {
    const sig = JSON.stringify(st.draft);
    if (sig === pre.sig) return;
    clearTimeout(preTimer);
    preTimer = setTimeout(async () => {
      try { const r = await checkChecklist(st.draft); pre = { sig, warnings: r.warnings || [] }; } catch { pre = { sig, warnings: [] }; }
      if (alive && JSON.stringify(st.draft) === sig) renderSave();
    }, 500);
  }
  function renderSave() {
    clear(saveEl);
    if (st.loading || !dirty()) return;
    precheck();
    const fileWarn = pre.sig === JSON.stringify(st.draft) ? pre.warnings.filter((w) => w.startsWith('файл сдачи')) : [];
    const d = diffBodies(st.cur.body, st.draft);
    const v = check();
    const counts = [
      d.added.length ? `${nCrit(d.added.length)} ${plural(d.added.length, 'добавлен', 'добавлено', 'добавлено')}` : null,
      d.changed.length ? `${nCrit(d.changed.length)} ${plural(d.changed.length, 'изменён', 'изменено', 'изменено')}` : null,
      d.removed.length ? `${nCrit(d.removed.length)} ${plural(d.removed.length, 'удалён', 'удалено', 'удалено')}` : null,
      d.reordered ? 'порядок' : null, d.settings.length ? 'настройки' : null, d.sections.length ? 'секции' : null, d.name ? 'название' : null,
    ].filter(Boolean);
    const note = h('input', { class: 'cqa-input cqa-chk-savebar__note', id: 'cqa-chk-note', value: st.note, maxlength: 200, 'aria-label': 'Заметка к версии',
      placeholder: autoNote(d) || 'Заметка к версии: что и зачем изменили', oninput: (e) => { st.note = e.target.value; },
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } } });
    saveEl.append(h('div', { class: 'cqa-chk-savebar', role: 'region', 'aria-label': 'Несохранённые изменения' },
      h('div', { class: 'cqa-chk-savebar__sum' },
        h('b', null, 'Несохранённые изменения'), counts.length ? h('span', { class: 'cqa-chk-savebar__counts' }, counts.join(' · ')) : h('span', { class: 'cqa-faint' }, 'только форматирование'),
        diffView(d, { compact: true }),
        fileWarn.length ? h('div', { class: 'cqa-banner cqa-banner--warn cqa-chk-savebar__warn', id: 'cqa-chk-filewarn' }, h('span', { class: 'cqa-banner__icon' }, '!'),
          h('div', null, h('div', { class: 'cqa-banner__title' }, 'Файл сдачи по этой версии не пройдёт проверку формата'),
            h('ul', { class: 'cqa-errlist' }, fileWarn.map((w) => h('li', null, w.replace(/^файл сдачи: /, '')))))) : null),
      h('div', { class: 'cqa-chk-savebar__acts' },
        note,
        h('button', { type: 'button', class: 'cqa-btn', id: 'cqa-chk-discard', onclick: discard }, 'Отменить'),
        h('button', { type: 'button', class: 'cqa-btn cqa-btn--primary', id: 'cqa-chk-save', disabled: st.saving || v.errors.length > 0, onclick: save },
          st.saving ? 'Сохраняем…' : v.errors.length ? `Исправьте ошибки (${v.errors.length})` : 'Сохранить как новую версию'))));
  }

  // ---------------------------------------------------------------- редактор критерия
  function openEditor(mode, idx, { section, focus } = {}) {
    editor?.close();
    const body = st.draft;
    const orig = mode === 'new' ? null : body.criteria[idx];
    if (mode !== 'new' && !orig) return;
    const tpl = mode === 'edit' ? orig
      : mode === 'replace'
        ? { key: nextKey(body, orig.key), export_id: orig.export_id ?? null, title: '', section: orig.section, type: orig.type, weight: orig.weight,
          na_allowed: false, na_when: null, definition: '', yes_when: null, no_when: null, scale: orig.type === 'scale' ? clone(orig.scale) : null,
          guidance: null, voice_guidance: null, group: orig.group ?? null, context_refs: [], guards: [], enabled: true }
        : { key: nextKey(body), export_id: null, title: '', section: section || body.sections?.[0]?.id || '', type: 'binary', weight: 10,
          na_allowed: false, na_when: null, definition: '', yes_when: null, no_when: null, scale: null, guidance: null, voice_guidance: null, group: null, context_refs: [], guards: [], enabled: true };
    const serverErrs = mode === 'edit' ? st.serverErrors.filter((e) => e.at?.kind === 'criterion' && e.refs?.[e.at.idx] === orig) : [];
    editor = criterionEditor({
      mode, orig, tpl, idx, body, serverErrs, focus, factNames,
      host: host(),
      onDone(c) {
        editor = null;
        if (mode === 'edit') {
          if (sameCriterion(c, orig) && JSON.stringify(c) === JSON.stringify(orig)) return;
          commit((d) => { d.criteria[idx] = c; });
        } else if (mode === 'replace') {
          commit((d) => { d.criteria[idx] = { ...d.criteria[idx], enabled: false }; d.criteria.splice(idx + 1, 0, c); });
        } else {
          commit((d) => {
            const last = d.criteria.map((x, i) => [x, i]).filter(([x]) => x.section === c.section).pop();
            d.criteria.splice(last ? last[1] + 1 : d.criteria.length, 0, c);
          });
        }
        st.tab = 'criteria'; renderTabs(); renderBody();
        flash(c.key);
      },
      onDelete() {
        editor = null;
        commit((d) => { d.criteria.splice(idx, 1); });
        toast(host(), `Критерий ${orig.key} удалён из черновика. Сохраните, чтобы появилась новая версия.`);
      },
      onClose() { editor = null; },
    });
  }

  // ---------------------------------------------------------------- выбор диалогов
  function openPicker(rows, onNext, preselected = []) {
    const sel = new Set((preselected || []).map(Number));
    const box = h('div', { class: 'cqa-modal__box cqa-chk-picker', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cqa-chk-pick-title' });
    const overlay = h('div', { class: 'cqa-modal', onmousedown: (e) => { if (e.target === overlay) close(); } }, box);
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    function close() { overlay.remove(); document.removeEventListener('keydown', onKey, true); }
    // список перерисовывается только при поиске; отметка строки обновляет лишь «Выбрать все» и кнопку
    const listEl = h('div', { class: 'cqa-chk-picker__list' });
    const search = h('input', { class: 'cqa-input', type: 'search', placeholder: 'Поиск по id', 'aria-label': 'Поиск по id', oninput: () => renderList() });
    const visible = () => { const q = search.value.trim().toLowerCase(); return rows.filter((r) => !q || r.conversation_id.toLowerCase().includes(q)); };
    const allBox = h('input', { type: 'checkbox', onchange: (e) => { visible().forEach((r) => (e.target.checked ? sel.add(r.id) : sel.delete(r.id))); renderList(); } });
    const next = h('button', { type: 'button', class: 'cqa-btn cqa-btn--primary', id: 'cqa-chk-pick-next', onclick: () => { close(); onNext([...sel]); } });
    function sync() {
      const vis = visible();
      allBox.checked = vis.length > 0 && vis.every((r) => sel.has(r.id));
      next.disabled = !sel.size;
      next.textContent = sel.size ? `Далее: ${nDialogs(sel.size)}` : 'Выберите диалоги';
    }
    function renderList() {
      const vis = visible();
      clear(listEl).append(...(vis.length ? vis.map((r) => h('label', { class: 'cqa-chk-picker__row' },
        h('input', { type: 'checkbox', class: 'cqa-check', checked: sel.has(r.id), onchange: (e) => { e.target.checked ? sel.add(r.id) : sel.delete(r.id); sync(); } }),
        h('span', { class: 'cqa-row-id' }, r.conversation_id), channelBadge(r.channel), langChip(r.language),
        h('span', { class: 'cqa-chk-picker__score' }, r.latest ? score(r.latest.final_total) : h('span', { class: 'cqa-badge cqa-badge--muted' }, 'не оценён'))))
        : [h('div', { class: 'cqa-faint', style: 'padding:12px' }, rows.length ? 'Ничего не найдено.' : `В группе ${group()} нет диалогов.`)]));
      sync();
    }
    box.append(
      h('div', { class: 'cqa-modal__head' }, h('h2', { class: 'cqa-h2', id: 'cqa-chk-pick-title' }, 'Выбрать диалоги'),
        h('button', { type: 'button', class: 'cqa-modal__x', 'aria-label': 'Закрыть', onclick: close }, '×')),
      h('div', { class: 'cqa-chk-picker__tools' }, search, h('label', { class: 'cqa-toggle' }, allBox, 'Выбрать все')),
      listEl,
      h('div', { class: 'cqa-modal__foot' },
        h('button', { type: 'button', class: 'cqa-btn', id: 'cqa-chk-pick-group', onclick: () => { close(); onNext([]); } }, `Вся группа ${group()} (${rows.length})`),
        next));
    renderList();
    document.addEventListener('keydown', onKey, true);
    host().append(overlay);
    search.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- жизненный цикл
  const onRefresh = () => { listChecklists().then((v) => { if (!alive) return; st.versions = v; st.rows = null; renderHead(); renderChrome(); if (st.tab === 'history') renderBody(); }).catch(() => {}); };
  const onBeforeUnload = (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } };
  el.addEventListener('cqa:refresh', onRefresh);
  window.addEventListener('beforeunload', onBeforeUnload);

  const restore = kept && (p.version == null || Number(p.version) === kept.baseId) ? kept : null;
  load(restore ? restore.baseId : p.version, restore).then(() => { if (restore && alive) toast(host(), 'Вернули несохранённые изменения чек-листа.'); });

  return {
    update(np) {
      const g = np.group && np.group !== p.group;
      const v = np.version != null && Number(np.version) !== st.cur?.id;
      p = { ...p, ...np };
      if (g) { st.rows = null; renderChrome(); }
      if (v && !dirty()) load(p.version);
    },
    unmount() {
      alive = false;
      kept = dirty() ? { baseId: st.cur.id, draft: st.draft, note: st.note, importedFrom: st.importedFrom } : null;
      editor?.close();
      el.removeEventListener('cqa:refresh', onRefresh);
      window.removeEventListener('beforeunload', onBeforeUnload);
      root.remove();
    },
  };
}

// ==================================================================== форма критерия
function toForm(c) {
  return {
    key: c.key ?? '', title: c.title ?? '', section: c.section ?? '', type: TYPES.includes(c.type) ? c.type : 'binary', weight: String(c.weight ?? 0),
    na_allowed: !!c.na_allowed, na_when: c.na_when ?? '', definition: c.definition ?? '', yes_when: c.yes_when ?? '', no_when: c.no_when ?? '',
    scale: (c.scale || []).map((s) => ({ value: String(s.value ?? ''), label: s.label ?? '' })), guidance: c.guidance ?? '', voice_guidance: c.voice_guidance ?? '', group: c.group ?? '',
    context_refs: (c.context_refs || []).join('\n'),
    guards: (c.guards || []).map((g) => ({ when: (g.when || []).join(', '), expect: (g.expect || []).map(String), action: g.action || 'flag', set: g.set ?? '' })),
    enabled: c.enabled !== false, export_id: c.export_id ?? '',
  };
}
const KNOWN_FIELDS = ['key', 'export_id', 'title', 'section', 'type', 'weight', 'na_allowed', 'na_when', 'definition', 'yes_when', 'no_when', 'scale',
  'guidance', 'voice_guidance', 'group', 'context_refs', 'guards', 'enabled'];
const num = (raw) => { const t = String(raw ?? '').trim().replace(',', '.'); if (t === '') return null; const n = Number(t); return Number.isFinite(n) ? n : String(raw); };

function fromForm(f, base) {
  const na = f.type !== 'flag' && f.na_allowed;
  const c = {
    key: f.key.trim(), export_id: txt(f.export_id), title: f.title.trim(), section: f.section, type: f.type,
    weight: f.type === 'flag' ? 0 : num(f.weight) ?? 0,
    na_allowed: na, na_when: na ? txt(f.na_when) : null, definition: f.definition.trim(),
    yes_when: f.type === 'scale' ? null : txt(f.yes_when), no_when: f.type === 'scale' ? null : txt(f.no_when),
    scale: f.type === 'scale' ? f.scale.map((s) => ({ value: num(s.value), label: s.label.trim() })) : null,
    guidance: txt(f.guidance), voice_guidance: txt(f.voice_guidance), group: txt(f.group),
    context_refs: f.context_refs.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
    guards: f.guards.map((g) => {
      const o = { when: g.when.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean), expect: [...g.expect], action: g.action };
      if (g.action === 'override') o.set = g.set || null;
      return o;
    }),
    enabled: f.enabled,
  };
  const extras = Object.fromEntries(Object.entries(base || {}).filter(([k]) => !KNOWN_FIELDS.includes(k)));
  return { ...c, ...extras };
}

/** Модальная форма критерия: все поля FR-CHK-02. Проверки — те же, что у всего чек-листа (validateBody). */
function criterionEditor({ mode, orig, tpl, idx, body, serverErrs, focus, factNames, host, onDone, onDelete, onClose }) {
  const f = toForm(tpl);
  const touched = new Set();
  let tried = false, confirmDel = false, closed = false, moreOpen = null;
  const srv = new Map(); // поле → сообщение сервера (снимается при правке поля)
  for (const e of serverErrs) srv.set(e.at.field || '_', [srv.get(e.at.field || '_'), e.message].filter(Boolean).join('; '));
  const box = h('div', { class: 'cqa-modal__box cqa-ce', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cqa-ce-heading' });
  const overlay = h('div', { class: 'cqa-modal cqa-ce-modal', onmousedown: (e) => { if (e.target === overlay) close(); } }, box);
  const prevFocus = document.activeElement;
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); done(); }
  };
  const groups = [...new Set((body.criteria || []).map((c) => txt(c.group)).filter(Boolean))];

  // временное тело с этим критерием на его месте: те же проверки, что у всего чек-листа
  function trial() {
    const c = fromForm(f, orig);
    const crit = body.criteria.slice();
    let at;
    if (mode === 'edit') { crit[idx] = c; at = idx; }
    else if (mode === 'replace') { crit[idx] = { ...crit[idx], enabled: false }; crit.splice(idx + 1, 0, c); at = idx + 1; }
    else { crit.push(c); at = crit.length - 1; }
    return { c, at, body: { ...body, criteria: crit } };
  }
  function errors() {
    const { at, body: b } = trial();
    const out = new Map();
    for (const e of validateBody(b).errors) {
      const m = new RegExp(`^criteria\\.${at}(?:\\.(.+))?$`).exec(e.path);
      if (!m) continue;
      const field = m[1] || '_';
      out.set(field, [out.get(field), e.message].filter(Boolean).join('; '));
    }
    return out;
  }
  const show = (field) => tried || (field !== '_' && touched.has(field));

  function paint() {
    const errs = errors();
    box.querySelectorAll('[data-err]').forEach((slot) => {
      const field = slot.dataset.err;
      const msg = [show(field) ? errs.get(field) || '' : '', srv.get(field) || ''].filter(Boolean).join('; ');
      slot.textContent = msg;
      slot.closest('.cqa-ce-f')?.classList.toggle('cqa-ce-f--err', !!msg);
    });
    const wsum = box.querySelector('#cqa-ce-wsum');
    if (wsum) {
      const { body: b } = trial();
      const t = weightSum(b);
      wsum.textContent = `Сумма весов с этим значением: ${fmtNum(t)}${Math.abs(t - 100) < 1e-9 ? ' — ровно 100' : ' — итог нормируется к 100'}`;
      wsum.classList.toggle('cqa-ce-wsum--warn', Math.abs(t - 100) > 1e-9);
    }
    return errs;
  }
  const errSlot = (field) => h('div', { class: 'cqa-ce-err', dataset: { err: field }, 'aria-live': 'polite' });
  const touch = (field) => { touched.add(field); srv.delete(field); };

  function input(field, attrs = {}) {
    return h('input', { class: 'cqa-input', id: `cqa-ce-${field}`, value: f[field], autocomplete: 'off', ...attrs,
      oninput: (e) => { f[field] = e.target.value; touch(field); paint(); } });
  }
  function area(field, rows = 2, attrs = {}) {
    return h('textarea', { class: 'cqa-input cqa-ce-area', id: `cqa-ce-${field}`, rows, ...attrs,
      oninput: (e) => { f[field] = e.target.value; touch(field); paint(); } }, f[field]);
  }
  function fld(label, field, control, hint, extraCls = '') {
    return h('div', { class: `cqa-field cqa-ce-f ${extraCls}`, dataset: { f: field } },
      h('label', { class: 'cqa-field__label', for: `cqa-ce-${field}` }, label), control, hint ? h('div', { class: 'cqa-field__hint' }, hint) : null, errSlot(field));
  }

  function scaleEditor() {
    return h('div', { class: 'cqa-field cqa-ce-f cqa-ce-wide', dataset: { f: 'scale' } },
      h('div', { class: 'cqa-field__label' }, 'Ступени шкалы'),
      h('div', { class: 'cqa-ce-steps' }, f.scale.map((s, j) => h('div', { class: 'cqa-ce-step' },
        h('div', { class: 'cqa-ce-f cqa-ce-step__v' },
          h('input', { class: 'cqa-input cqa-mono', type: 'number', min: 0, step: 1, value: s.value, 'aria-label': `Баллы ступени ${j + 1}`, id: `cqa-ce-scale-${j}-value`,
            oninput: (e) => { s.value = e.target.value; touch(`scale.${j}.value`); touch('scale'); paint(); } }), errSlot(`scale.${j}.value`)),
        h('div', { class: 'cqa-ce-f cqa-ce-step__l' },
          h('input', { class: 'cqa-input', value: s.label, placeholder: 'Когда ставится эта ступень', 'aria-label': `Описание ступени ${j + 1}`, id: `cqa-ce-scale-${j}-label`,
            oninput: (e) => { s.label = e.target.value; touch(`scale.${j}.label`); paint(); } }), errSlot(`scale.${j}.label`)),
        h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm cqa-btn--ghost', 'aria-label': `Удалить ступень ${j + 1}`, disabled: f.scale.length <= 2,
          onclick: () => { f.scale.splice(j, 1); touch('scale'); render(); } }, '×')))),
      h('div', { class: 'cqa-ce-steps__foot' },
        h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm', onclick: () => { f.scale.push({ value: '', label: '' }); render(); box.querySelector(`#cqa-ce-scale-${f.scale.length - 1}-value`)?.focus(); } }, '+ Ступень'),
        h('span', { class: 'cqa-field__hint' }, 'Целые числа ≥ 0, порядок любой. Максимальная ступень даёт полный вес.')),
      errSlot('scale'));
  }

  function guardsEditor() {
    const answers = allowedAnswers(fromForm(f, orig));
    return h('div', { class: 'cqa-field cqa-ce-f cqa-ce-wide', dataset: { f: 'guards' } },
      h('div', { class: 'cqa-field__label' }, 'Страховки по фактам'),
      h('div', { class: 'cqa-field__hint' }, 'Если все факты из «Когда» верны («!» — отрицание), ответ должен быть из «Ожидаем». Иначе — пометка «требует проверки» или замена ответа.'),
      f.guards.length ? h('div', { class: 'cqa-ce-guards' }, f.guards.map((g, j) => h('div', { class: 'cqa-ce-guard' },
        h('div', { class: 'cqa-ce-f cqa-ce-guard__when' }, h('label', { class: 'cqa-ce-mini', for: `cqa-ce-guards-${j}-when` }, 'Когда'),
          h('input', { class: 'cqa-input cqa-mono', id: `cqa-ce-guards-${j}-when`, value: g.when, list: 'cqa-ce-facts', placeholder: '!identity_verified, !is_voice',
            oninput: (e) => { g.when = e.target.value; touch(`guards.${j}.when`); paint(); } }), errSlot(`guards.${j}.when`)),
        h('div', { class: 'cqa-ce-f cqa-ce-guard__expect' }, h('span', { class: 'cqa-ce-mini' }, 'Ожидаем'),
          h('div', { class: 'cqa-ce-checks' }, answers.map((a) => h('label', { class: 'cqa-toggle' },
            h('input', { type: 'checkbox', checked: g.expect.includes(a), onchange: (e) => { g.expect = e.target.checked ? [...new Set([...g.expect, a])] : g.expect.filter((x) => x !== a); touch(`guards.${j}.expect`); paint(); } }),
            ANSWER_LABEL[a] || a))), errSlot(`guards.${j}.expect`)),
        h('div', { class: 'cqa-ce-f cqa-ce-guard__act' }, h('span', { class: 'cqa-ce-mini' }, 'Иначе'),
          h('select', { class: 'cqa-select', 'aria-label': 'Действие страховки', onchange: (e) => { g.action = e.target.value; touch(`guards.${j}.set`); render(); } },
            h('option', { value: 'flag', selected: g.action !== 'override' }, 'Пометить «требует проверки»'),
            h('option', { value: 'override', selected: g.action === 'override' }, 'Заменить ответ')),
          g.action === 'override' ? h('select', { class: 'cqa-select', 'aria-label': 'Заменить на', onchange: (e) => { g.set = e.target.value; touch(`guards.${j}.set`); paint(); } },
            h('option', { value: '', selected: !g.set }, 'на…'), answers.map((a) => h('option', { value: a, selected: g.set === a }, ANSWER_LABEL[a] || a))) : null,
          errSlot(`guards.${j}.set`)),
        h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm cqa-btn--ghost', 'aria-label': `Удалить страховку ${j + 1}`, onclick: () => { f.guards.splice(j, 1); touch('guards'); render(); } }, '×'))))
        : null,
      h('div', null, h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm', onclick: () => { f.guards.push({ when: '', expect: [], action: 'flag', set: '' }); render(); } }, '+ Страховка')),
      errSlot('guards'),
      h('datalist', { id: 'cqa-ce-facts' }, factNames.map(([name, label]) => [h('option', { value: name }, label), h('option', { value: `!${name}` }, `не: ${label}`)])));
  }

  function render() {
    const scrollTop = box.scrollTop;
    const isFlag = f.type === 'flag';
    const title = mode === 'edit' ? `Критерий ${orig.key}` : mode === 'replace' ? `Замена критерия ${orig.key}` : 'Новый критерий';
    const sectionTitle = (id) => (body.sections || []).find((s) => s.id === id)?.title || id;
    const typeSeg = h('div', { class: 'cqa-seg cqa-seg--wide', role: 'radiogroup', 'aria-label': 'Тип ответа', id: 'cqa-ce-type' },
      TYPES.map((t) => h('button', { type: 'button', class: 'cqa-seg__btn', role: 'radio', 'aria-checked': String(f.type === t), 'aria-pressed': String(f.type === t), dataset: { type: t },
        onclick: () => {
          if (f.type === t) return;
          f.type = t;
          if (t === 'flag') { f.weight = '0'; f.na_allowed = false; }
          if (t === 'scale' && f.scale.length < 2) {
            const w = Math.round(Number(String(f.weight).replace(',', '.'))) || 10;
            f.scale = [{ value: String(w), label: '' }, { value: '0', label: '' }];
          }
          touch('type'); render();
        } }, TYPE_LABEL[t])));
    const hasMore = f.context_refs.trim() || f.guards.length || [...srv.keys()].some((k) => k.startsWith('guards') || k === 'context_refs');
    const more = h('details', { class: 'cqa-ce-more', open: moreOpen ?? (!!hasMore || /^(guards|context_refs)/.test(focus || '')), ontoggle: (e) => { moreOpen = e.target.open; } },
      h('summary', null, 'Дополнительно: справки и страховки', f.guards.length ? h('span', { class: 'cqa-chip' }, `страховок: ${f.guards.length}`) : null,
        f.context_refs.trim() ? h('span', { class: 'cqa-chip' }, 'есть справки') : null),
      h('div', { class: 'cqa-ce-grid' },
        fld('Справки (context_refs)', 'context_refs', area('context_refs', 2, { placeholder: 'knowledge/freedom_broker_kb.md', spellcheck: 'false' }),
          'Пути внутри data/, по одному в строке: текст справки подставляется в промпт этого критерия.', 'cqa-ce-wide'),
        guardsEditor()));

    clear(box).append(...[
      h('div', { class: 'cqa-modal__head' },
        h('h2', { class: 'cqa-h2', id: 'cqa-ce-heading' }, title, orig && mode !== 'new' ? h('span', { class: 'cqa-ce-sub' }, ` «${orig.title}»`) : null),
        h('button', { type: 'button', class: 'cqa-modal__x', 'aria-label': 'Закрыть', onclick: close }, '×')),
      mode === 'replace' ? h('div', { class: 'cqa-banner cqa-banner--info cqa-ce-banner' }, h('span', { class: 'cqa-banner__icon' }, '⇄'),
        h('div', null, `Новый критерий встанет на место ${orig.key}: секция «${sectionTitle(orig.section)}», вес ${fmtNum(Number(orig.weight))}`,
          orig.export_id ? [', код в файле сдачи ', h('b', { class: 'cqa-mono' }, orig.export_id)] : '',
          `. Критерий ${orig.key} выключится и останется в версии для истории. Опишите, что проверять: название, определение, когда «Да» и когда «Нет».`)) : null,
      h('div', { class: 'cqa-ce-f cqa-ce-general' }, errSlot('_')),
      h('form', { class: 'cqa-ce-grid', onsubmit: (e) => { e.preventDefault(); done(); } },
        fld('Код', 'key', input('key', { spellcheck: 'false', class: 'cqa-input cqa-mono' }), mode === 'edit' ? 'Смена кода: прошлые ответы по критерию не переиспользуются.' : 'Латиница, цифры, «_», «-».', 'cqa-ce-key'),
        fld('Название', 'title', input('title', { placeholder: 'Например: Предупреждение об ожидании' }), null, 'cqa-ce-title'),
        fld('Секция', 'section', h('select', { class: 'cqa-select', id: 'cqa-ce-section', onchange: (e) => { f.section = e.target.value; touch('section'); paint(); } },
          (body.sections || []).map((s) => h('option', { value: s.id, selected: s.id === f.section }, s.title || s.id)),
          (body.sections || []).some((s) => s.id === f.section) ? null : h('option', { value: f.section, selected: true }, f.section || '—'))),
        fld('Тип ответа', 'type', typeSeg, TYPE_HINT[f.type], 'cqa-ce-type'),
        fld('Вес', 'weight', input('weight', { type: 'number', min: 0, step: 'any', inputmode: 'decimal', disabled: isFlag }),
          isFlag ? 'У флага нет баллов.' : h('span', { id: 'cqa-ce-wsum', class: 'cqa-ce-wsum' }), 'cqa-ce-weight'),
        fld('Определение', 'definition', area('definition', 2, { placeholder: 'Что проверяет критерий, одним-двумя предложениями' }), null, 'cqa-ce-wide'),
        f.type !== 'scale' ? fld(isFlag ? '«Да» (нарушение есть), когда' : '«Да», когда', 'yes_when', area('yes_when', 3), null, 'cqa-ce-half') : null,
        f.type !== 'scale' ? fld(isFlag ? '«Нет» (нарушения нет), когда' : '«Нет», когда', 'no_when', area('no_when', 3), null, 'cqa-ce-half') : null,
        f.type === 'scale' ? scaleEditor() : null,
        h('div', { class: 'cqa-field cqa-ce-f cqa-ce-wide cqa-ce-na', dataset: { f: 'na_when' } },
          h('label', { class: 'cqa-toggle cqa-ce-na__toggle' }, h('input', { type: 'checkbox', id: 'cqa-ce-na_allowed', checked: f.na_allowed && !isFlag, disabled: isFlag,
            onchange: (e) => { f.na_allowed = e.target.checked; touch('na_allowed'); render(); if (f.na_allowed) box.querySelector('#cqa-ce-na_when')?.focus(); } }),
          h('b', null, 'N/A разрешён'), h('span', { class: 'cqa-field__hint' }, isFlag ? ' — у флага N/A нет' : ' — неприменимый критерий не входит в итог, его вес перераспределяется')),
          f.na_allowed && !isFlag ? area('na_when', 2, { placeholder: 'Когда критерий неприменим, например: ожидания не было', 'aria-label': 'Когда N/A' }) : null,
          errSlot('na_when')),
        fld('Подсказка оценщику', 'guidance', area('guidance', 2, { placeholder: 'На что смотреть: какие реплики и факты, типичные ошибки' }), 'Попадает в промпт как подсказка модели.', 'cqa-ce-wide'),
        fld('Подсказка для звонков', 'voice_guidance', area('voice_guidance', 2, { placeholder: 'Как применять критерий к устной речи: паузы, формулировки, проверка личности голосом' }), 'Попадает в промпт только для звонков.', 'cqa-ce-wide'),
        fld('Код в файле сдачи', 'export_id', input('export_id', { list: 'cqa-ce-export', spellcheck: 'false', class: 'cqa-input cqa-mono', placeholder: 'closure' }),
          mode === 'replace' ? `Взят у ${orig.key}: в results.json новый критерий пойдёт под этим кодом.` : 'criterion_id в results.json организаторов.'),
        fld('Группа вызова', 'group', input('group', { list: 'cqa-ce-groups', spellcheck: 'false', class: 'cqa-input cqa-mono', placeholder: 'свой вызов' }),
          'Критерии одной группы оцениваются одним вызовом (стратегия «По группам»).'),
        h('div', { class: 'cqa-field cqa-ce-f cqa-ce-enabled' }, h('div', { class: 'cqa-field__label' }, 'Участвует в оценке'),
          h('label', { class: 'cqa-toggle' }, h('input', { type: 'checkbox', id: 'cqa-ce-enabled', checked: f.enabled, onchange: (e) => { f.enabled = e.target.checked; touch('enabled'); paint(); } }), 'включён')),
        h('datalist', { id: 'cqa-ce-export' }, ORGANIZER_CODES.map(([code, label]) => h('option', { value: code }, label))),
        h('datalist', { id: 'cqa-ce-groups' }, groups.map((g) => h('option', { value: g }))),
        more,
        h('button', { type: 'submit', hidden: true, tabindex: -1, 'aria-hidden': 'true' })),
      h('div', { class: 'cqa-modal__foot cqa-ce-foot' },
        mode === 'edit' ? h('button', { type: 'button', class: `cqa-btn ${confirmDel ? 'cqa-ce-del--confirm' : 'cqa-btn--ghost'} cqa-ce-del`, id: 'cqa-ce-delete',
          onclick: () => { if (!confirmDel) { confirmDel = true; render(); return; } finish(); onDelete(); } }, confirmDel ? `Точно удалить ${orig.key}?` : 'Удалить критерий') : null,
        h('span', { class: 'cqa-ce-foot__hint cqa-faint' }, 'Ctrl+Enter — готово'),
        h('button', { type: 'button', class: 'cqa-btn', onclick: close }, 'Отмена'),
        h('button', { type: 'button', class: 'cqa-btn cqa-btn--primary', id: 'cqa-ce-done', onclick: done },
          mode === 'replace' ? `Заменить ${orig.key}` : mode === 'new' ? 'Добавить' : 'Готово'))].filter(Boolean));
    paint();
    box.scrollTop = scrollTop;
  }

  function done() {
    tried = true;
    const errs = paint();
    if (errs.size) {
      const first = box.querySelector('.cqa-ce-f--err');
      first?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      first?.querySelector('input:not([type=checkbox]), textarea, select')?.focus({ preventScroll: true });
      return;
    }
    const { c } = trial();
    finish();
    onDone(c);
  }
  function finish() {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    if (prevFocus && prevFocus.isConnected) prevFocus.focus?.({ preventScroll: true });
  }
  function close() { if (closed) return; finish(); onClose?.(); }

  render();
  document.addEventListener('keydown', onKey, true);
  host.append(overlay);
  const target = focus ? box.querySelector(`#cqa-ce-${CSS.escape(focus.replace(/\./g, '-'))}`) || box.querySelector(`[data-f="${CSS.escape(focus.split('.')[0])}"] input, [data-f="${CSS.escape(focus.split('.')[0])}"] textarea`) : null;
  (target || box.querySelector('#cqa-ce-title'))?.focus({ preventScroll: !!target });
  if (target) target.scrollIntoView({ block: 'center' });
  return { close };
}
