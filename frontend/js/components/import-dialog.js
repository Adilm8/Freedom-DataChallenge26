// Импорт набора диалогов (FR-DATA-01…04): по group_id из API организаторов или из JSON-файла того же формата.
// openImportDialog(host, opts) — модальное окно поверх host (корень .cqa-root); mount(el, params) — то же внутри el
// (страница pages/import-dialog.html / web resource). opts: {group?: group_id для поля, method?: 'api' | 'file', onImported?(result)}.
// Доступность API — GET /health (organizer_api); импорт — POST /datasets/import, файл — POST /datasets/upload;
// после успеха — GET /conversations?group_id, чтобы показать состав группы и число диалогов для оценки.
// Наружу: «Открыть группу» — cqa:groups-changed {select, to: '#/conversations'};
// «Оценить группу» — то же с run: {ids: [], group, rows} (форма detail cqa:run-request, как у списка и дашборда).
import { h, clear, emit, toast, skeletonRows } from '../ui.js';
import { getHealth, importDataset, uploadDataset, listConversations, isMock } from '../api.js';
import { plural } from './run-dialog.js';

const MAX_BYTES = 25 * 1024 * 1024; // как MAX_UPLOAD_BYTES в backend/app/api/datasets.py
const MAX_WARNINGS = 200;
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]):not([tabindex="-1"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

const nDialogs = (n) => `${n} ${plural(n, 'диалог', 'диалога', 'диалогов')}`;
const nRecords = (n) => `${n} ${plural(n, 'запись', 'записи', 'записей')}`;
const fmtSize = (b) => (b < 1024 ? `${b} Б` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1).replace('.', ',')} КБ` : `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`);
const errText = (e) => e?.detail || e?.message || String(e);

/** Быстрый взгляд на файл до загрузки: группа и число записей. Окончательная проверка — на сервере. */
async function peekFile(file) {
  if (file.size > MAX_BYTES) return { tooBig: true };
  try {
    const obj = JSON.parse(String(await file.text()).replace(/^﻿/, ''));
    const data = obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj.data && typeof obj.data === 'object' ? obj.data : obj) : null;
    if (!Array.isArray(data?.records)) return { shape: true };
    return { records: data.records.length, group: data.dataset_group_id ? String(data.dataset_group_id) : null };
  } catch {
    return { broken: true };
  }
}

/** Фокус не выходит из окна: Tab с последнего элемента — на первый, Shift+Tab с первого — на последний. */
function trapTab(e, box) {
  const els = [...box.querySelectorAll(FOCUSABLE)].filter((x) => x.getClientRects().length);
  if (!els.length) { e.preventDefault(); box.focus(); return; }
  const first = els[0], last = els[els.length - 1], act = document.activeElement;
  const inside = box.contains(act);
  if (e.shiftKey && (act === first || !inside)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (act === last || !inside)) { e.preventDefault(); first.focus(); }
}

/** Форма импорта и результат внутри box. actions: {openGroup(g), evaluate(g, rows)}; notify(text) — если окно уже закрыто. */
function importPanel(box, opts, { onClose, inline, notify, actions }) {
  const st = {
    api: null, method: null, group: String(opts.group || '').trim(),
    file: null, peek: null, busy: false, error: null, result: null, rows: null, source: '',
  };
  let alive = true, seq = 0, submitBtn = null;
  let acted = !inline; // встроенный вариант не забирает фокус при загрузке страницы — только после действий пользователя

  async function init() {
    clear(box).append(head(), skeletonRows(4));
    let hl = null, err = null;
    try { hl = await getHealth(); } catch (e) { err = e; }
    if (!alive) return;
    st.api = isMock() ? { ok: false, reason: 'в демо-данных нет адреса API — загрузите файл.' }
      : hl ? (hl.organizer_api ? { ok: true } : { ok: false, reason: 'адрес API не задан в .env (ORGANIZER_API_URL) — загрузите файл.' })
        : { ok: false, reason: `нет связи с сервером. ${errText(err)}` };
    st.method = opts.method === 'file' || !st.api.ok ? 'file' : 'api';
    render();
  }

  function head() {
    return h('div', { class: 'cqa-modal__head' },
      h('h2', { class: 'cqa-h2', id: 'cqa-imp-title' }, 'Импорт набора'),
      inline ? null : h('button', { type: 'button', class: 'cqa-modal__x', 'aria-label': 'Закрыть', onclick: onClose }, '×'));
  }

  function focus(sel) {
    if (!acted) return;
    const el = sel && box.querySelector(sel);
    if (el && !el.disabled) el.focus({ preventScroll: true });
  }

  function render(focusSel) {
    clear(box);
    if (st.result) { renderDone(); return; }
    const api = st.method === 'api';

    const seg = h('div', { class: 'cqa-seg cqa-seg--wide', role: 'radiogroup', 'aria-label': 'Способ импорта' },
      [['api', 'Из API организаторов'], ['file', 'Из файла']].map(([m, t]) => h('button', {
        type: 'button', class: 'cqa-seg__btn', id: `cqa-imp-m-${m}`, role: 'radio', dataset: { method: m },
        'aria-checked': String(st.method === m), 'aria-pressed': String(st.method === m),
        disabled: st.busy || (m === 'api' && !st.api.ok), title: m === 'api' && !st.api.ok ? `Недоступно: ${st.api.reason}` : null,
        onclick: () => { acted = true; if (st.method !== m) { st.method = m; st.error = null; render(m === 'api' ? '#cqa-imp-group' : '#cqa-imp-choose'); } },
      }, t)));
    const apiNote = st.api.ok ? null : h('div', { class: 'cqa-imp__note', id: 'cqa-imp-api-note' },
      h('span', { class: 'cqa-imp__noteicon', 'aria-hidden': 'true' }, 'i'),
      h('span', null, h('b', null, 'Из API недоступно: '), st.api.reason));

    submitBtn = h('button', { type: 'submit', class: 'cqa-btn cqa-btn--primary', id: 'cqa-imp-submit' });
    const form = h('form', { class: 'cqa-runform cqa-imp__form', novalidate: true, 'aria-busy': String(st.busy),
      onsubmit: (e) => { e.preventDefault(); submit(); } },
    h('div', { class: 'cqa-field' }, h('div', { class: 'cqa-field__label', id: 'cqa-imp-method-label' }, 'Способ'), seg, apiNote),
    api ? apiFields() : fileFields(),
    st.busy ? busyRow() : null,
    st.error ? errorBanner() : null,
    h('div', { class: 'cqa-modal__foot' },
      inline ? null : h('button', { type: 'button', class: 'cqa-btn', id: 'cqa-imp-cancel', disabled: st.busy, onclick: onClose }, 'Отмена'),
      submitBtn));
    box.append(head(),
      h('p', { class: 'cqa-imp__intro' }, 'Диалоги в формате API организаторов. Повторный импорт группы обновляет диалоги с теми же conversation_id, прошлые оценки остаются.'),
      form);
    syncSubmit();
    focus(focusSel || (st.error ? '#cqa-imp-submit' : api ? '#cqa-imp-group' : st.file ? '#cqa-imp-submit' : '#cqa-imp-choose'));
  }

  function apiFields() {
    const input = h('input', { class: 'cqa-input cqa-mono', id: 'cqa-imp-group', value: st.group, placeholder: 'например DEV', maxlength: 64,
      autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters', disabled: st.busy, 'aria-describedby': 'cqa-imp-group-hint',
      oninput: (e) => { st.group = e.target.value.trim(); if (st.error) { st.error = null; box.querySelector('#cqa-imp-error')?.remove(); } syncSubmit(); } });
    return h('label', { class: 'cqa-field', for: 'cqa-imp-group' },
      h('span', { class: 'cqa-field__label' }, 'Группа · group_id'), input,
      h('span', { class: 'cqa-field__hint', id: 'cqa-imp-group-hint' },
        'Тот же адрес API, что для DEV, — меняется только group_id. Адрес и подпись хранятся на сервере и в браузер не попадают.'));
  }

  function fileFields() {
    const fileIn = h('input', { type: 'file', id: 'cqa-imp-file', accept: '.json,application/json', class: 'cqa-sr', tabindex: '-1', 'aria-hidden': 'true',
      onchange: (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) pickFile(f); } });
    const choose = h('button', { type: 'button', class: `cqa-btn${st.file ? ' cqa-btn--sm' : ''}`, id: 'cqa-imp-choose', disabled: st.busy,
      onclick: () => fileIn.click() }, st.file ? 'Другой файл' : 'Выбрать файл');
    const drop = h('div', {
      class: `cqa-imp__drop${st.file ? ' cqa-imp__drop--has' : ''}`, id: 'cqa-imp-drop',
      ondragenter: (e) => { e.preventDefault(); if (!st.busy) drop.classList.add('cqa-imp__drop--over'); },
      ondragover: (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = st.busy ? 'none' : 'copy'; },
      ondragleave: (e) => { if (!drop.contains(e.relatedTarget)) drop.classList.remove('cqa-imp__drop--over'); },
      ondrop: (e) => { e.preventDefault(); drop.classList.remove('cqa-imp__drop--over'); const f = e.dataTransfer?.files?.[0]; if (f && !st.busy) pickFile(f); },
    }, fileIn, st.file ? fileCard(choose) : [
      h('div', { class: 'cqa-imp__dropicon', 'aria-hidden': 'true' }, '⇧'),
      h('div', { class: 'cqa-imp__droptitle' }, 'Перетащите JSON-файл сюда'),
      h('div', { class: 'cqa-imp__dropsub' }, 'или'),
      choose,
    ]);
    return h('div', { class: 'cqa-field' },
      h('div', { class: 'cqa-field__label' }, 'Файл набора'), drop,
      h('div', { class: 'cqa-field__hint' }, 'JSON как ответ API организаторов: ', h('code', { class: 'cqa-imp__code' }, '{"data": {"dataset_group_id", "records": […]}}'),
        '. Группа берётся из файла. До 25 МБ.'));
  }

  function fileCard(choose) {
    const p = st.peek || {};
    const [text, tone] = p.loading ? ['читаем файл…', '']
      : p.tooBig ? ['больше 25 МБ — разделите набор на части или импортируйте из API', 'bad']
        : p.broken ? ['не читается как JSON — сервер проверит и покажет причину', 'warn']
          : p.shape ? ['нет списка records — сервер проверит и покажет причину', 'warn']
            : [`группа ${p.group || 'из .env'} · ${nRecords(p.records ?? 0)}`, ''];
    return h('div', { class: 'cqa-imp__file' },
      h('span', { class: 'cqa-imp__fileicon', 'aria-hidden': 'true' }, '{ }'),
      h('div', { class: 'cqa-imp__filemain' },
        h('div', { class: 'cqa-imp__filename', id: 'cqa-imp-filename' }, st.file.name),
        h('div', { class: `cqa-imp__filemeta${tone ? ` cqa-imp__filemeta--${tone}` : ''}`, id: 'cqa-imp-peek' }, `${fmtSize(st.file.size)} · ${text}`)),
      choose);
  }

  function busyRow() {
    return h('div', { class: 'cqa-imp__busy', role: 'status', id: 'cqa-imp-busy' },
      h('span', null, st.method === 'api' ? `Получаем группу ${st.group} из API организаторов…` : `Загружаем ${st.file?.name || 'файл'} и разбираем диалоги…`),
      h('div', { class: 'cqa-imp__bar', 'aria-hidden': 'true' }));
  }

  function errorBanner() {
    const e = st.error;
    const hint = e.status === 0 ? null
      : e.status === 502 ? 'Проверьте group_id и доступность API организаторов. Тот же набор можно загрузить файлом.'
        : e.status === 400 && st.method === 'file' ? 'Нужен JSON-объект в формате API организаторов со списком data.records.'
          : null;
    return h('div', { class: 'cqa-banner cqa-banner--flag', role: 'alert', id: 'cqa-imp-error' }, h('span', { class: 'cqa-banner__icon' }, '!'),
      h('div', { class: 'cqa-imp__errbody' },
        h('div', { class: 'cqa-banner__title' }, 'Импорт не выполнен'),
        h('div', { id: 'cqa-imp-error-text' }, errText(e)),
        e.errors?.length && !e.detail ? h('ul', { class: 'cqa-errlist' }, e.errors.map((x) => h('li', null, x.path ? h('code', null, x.path) : null, x.path ? ' — ' : '', x.message))) : null,
        hint ? h('div', { class: 'cqa-imp__errhint' }, hint) : null));
  }

  function syncSubmit() {
    if (!submitBtn) return;
    const p = st.peek || {};
    const api = st.method === 'api';
    submitBtn.disabled = st.busy || (api ? !st.group : !st.file || p.loading || p.tooBig);
    submitBtn.textContent = st.busy ? 'Импортируем…' : st.error ? 'Повторить'
      : api ? (st.group ? `Импортировать ${st.group}` : 'Импортировать')
        : p.records != null ? `Загрузить · ${nDialogs(p.records)}` : 'Загрузить';
  }

  async function pickFile(f) {
    acted = true;
    st.file = f; st.error = null; st.peek = { loading: true };
    const my = ++seq;
    render('#cqa-imp-choose');
    const peek = await peekFile(f);
    if (!alive || my !== seq) return;
    st.peek = peek;
    render(peek.tooBig ? '#cqa-imp-choose' : '#cqa-imp-submit');
  }

  async function submit() {
    if (!submitBtn || submitBtn.disabled) return;
    acted = true;
    const method = st.method, group = st.group, file = st.file;
    st.busy = true; st.error = null;
    const my = ++seq;
    render('#cqa-imp-submit');
    let res;
    try {
      res = method === 'api' ? await importDataset(group) : await uploadDataset(file);
    } catch (e) {
      if (my !== seq) return;
      st.busy = false; st.error = e;
      if (alive) render(); else notify(`Импорт не выполнен: ${errText(e)}`);
      return;
    }
    const rows = await listConversations({ group_id: res.group_id }).catch(() => null);
    if (my !== seq) return;
    Object.assign(st, { busy: false, result: res, rows, source: method === 'api' ? `API организаторов, group_id ${group}` : `файл ${file.name}` });
    opts.onImported?.(res);
    if (alive) render(); else notify(summary(res));
  }

  const summary = (r) => `Группа ${r.group_id}: добавлено ${r.imported}, обновлено ${r.updated}`;

  function stat(label, value, cls = '') {
    return h('div', { class: `cqa-run__stat ${cls}` }, h('div', { class: 'cqa-run__label' }, label), h('div', { class: 'cqa-run__val' }, value));
  }

  function composition(rows) {
    const calls = rows.filter((r) => r.channel === 'voice call').length;
    const chats = rows.length - calls;
    const langs = new Map();
    for (const r of rows) { const l = String(r.language || '?').toUpperCase(); langs.set(l, (langs.get(l) || 0) + 1); }
    return [chats ? `${chats} ${plural(chats, 'чат', 'чата', 'чатов')}` : null, calls ? `${calls} ${plural(calls, 'звонок', 'звонка', 'звонков')}` : null,
      [...langs].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} ${n}`).join(', ')].filter(Boolean).join(' · ');
  }

  function renderDone() {
    const r = st.result, rows = st.rows;
    const n = rows ? rows.length : r.imported + r.updated;
    const warns = r.warnings || [];
    const skipped = Object.keys(r.skipped || {}).length;
    box.append(head(),
      h('div', { class: 'cqa-imp__done' },
        h('div', { class: 'cqa-banner cqa-imp__ok', role: 'status', id: 'cqa-imp-result' },
          h('span', { class: 'cqa-banner__icon', 'aria-hidden': 'true' }, '✓'),
          h('div', null,
            h('div', { class: 'cqa-banner__title', id: 'cqa-imp-summary' }, summary(r)),
            h('div', { class: 'cqa-imp__oksub' }, `Источник — ${st.source}.`, skipped ? ` Пропущено записей: ${skipped}, причины — в предупреждениях.` : ''))),
        h('div', { class: 'cqa-run__stats' },
          stat('Добавлено', String(r.imported)),
          stat('Обновлено', String(r.updated)),
          stat('Всего в группе', rows ? nDialogs(n) : '—'),
          rows?.length ? stat('Состав', composition(rows), 'cqa-run__stat--wide') : null),
        warns.length ? h('details', { class: 'cqa-imp__warns', id: 'cqa-imp-warns' },
          h('summary', null, `Предупреждения: ${warns.length}`),
          h('ul', null, warns.slice(0, MAX_WARNINGS).map((w) => h('li', null, w))),
          warns.length > MAX_WARNINGS ? h('div', { class: 'cqa-faint' }, `и ещё ${warns.length - MAX_WARNINGS}`) : null) : null,
        !n ? h('div', { class: 'cqa-banner cqa-banner--warn' }, h('span', { class: 'cqa-banner__icon' }, '!'),
          h('div', null, 'В группе нет диалогов: ни одна запись не импортирована. Причины — в предупреждениях.')) : null),
      h('div', { class: 'cqa-modal__foot' },
        h('button', { type: 'button', class: 'cqa-btn cqa-btn--ghost', id: 'cqa-imp-again',
          onclick: () => { Object.assign(st, { result: null, rows: null, error: null, file: null, peek: null }); render(); } }, 'Импортировать ещё'),
        h('button', { type: 'button', class: 'cqa-btn', id: 'cqa-imp-open', disabled: !n, onclick: () => actions.openGroup(r.group_id) }, `Открыть группу ${r.group_id}`),
        h('button', { type: 'button', class: 'cqa-btn cqa-btn--primary', id: 'cqa-imp-run', disabled: !n,
          title: inline ? null : `Перейти к списку группы ${r.group_id} и запустить оценку`, onclick: () => actions.evaluate(r.group_id, rows) }, `Оценить группу (${n})`)));
    focus(n ? '#cqa-imp-run' : '#cqa-imp-again');
  }

  init();
  return {
    busy: () => st.busy,
    destroy() { alive = false; },
  };
}

/** Модальное окно импорта поверх host. Esc и клик по фону закрывают; если импорт уже идёт, он завершится на сервере и покажет тост. */
export function openImportDialog(host, opts = {}) {
  const box = h('div', { class: 'cqa-modal__box cqa-imp', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cqa-imp-title', tabindex: '-1' });
  // Файл, брошенный мимо зоны, браузер не должен открывать вместо приложения.
  const overlay = h('div', { class: 'cqa-modal', onmousedown: (e) => { if (e.target === overlay) close(); },
    ondragover: (e) => e.preventDefault(), ondrop: (e) => e.preventDefault() }, box);
  const prevFocus = document.activeElement;
  let closed = false;
  const toGroup = (g) => emit(host, 'cqa:groups-changed', { select: g, to: '#/conversations' });
  const panel = importPanel(box, opts, {
    inline: false, onClose: close, notify: (t) => toast(host, t),
    actions: {
      openGroup: (g) => { close(); toGroup(g); },
      // Окно запуска открывает оболочка уже после перехода к списку: смена экрана закрыла бы его.
      evaluate: (g, rows) => { close(); emit(host, 'cqa:groups-changed', { select: g, to: '#/conversations', run: { ids: [], group: g, rows: rows || undefined } }); },
    },
  });

  function onKey(e) {
    if (!overlay.isConnected) return;
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); }
    else if (e.key === 'Tab') trapTab(e, box);
  }
  function close() {
    if (closed) return;
    closed = true;
    panel.destroy();
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    if (prevFocus && prevFocus.isConnected) prevFocus.focus?.({ preventScroll: true });
  }

  document.addEventListener('keydown', onKey, true);
  host.append(overlay);
  return { close, isOpen: () => !closed };
}

/** Встроенный вариант (страница pages/import-dialog.html или web resource): params.group — group_id для поля, params.method — api | file. */
export function mount(el, params = {}) {
  const box = h('div', { class: 'cqa-panel cqa-modal__box cqa-modal__box--inline cqa-imp' });
  el.append(box);
  const panel = importPanel(box, { group: params.group || '', method: params.method, onImported: params.onImported }, {
    inline: true, onClose() {}, notify: (t) => toast(el, t),
    actions: {
      openGroup: (g) => emit(el, 'cqa:groups-changed', { select: g, to: '#/conversations' }),
      evaluate: (g, rows) => emit(el, 'cqa:run-request', { ids: [], group: g, rows: rows || undefined }),
    },
  });
  return { update() {}, unmount() { panel.destroy(); box.remove(); } };
}
