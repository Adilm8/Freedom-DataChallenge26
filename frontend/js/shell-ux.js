// Сквозной UX оболочки: палитра команд (Ctrl+K), горячие клавиши, окно справки «?».
// Не знает об устройстве экранов: действует через hash-переходы, события cqa:* и разметку (кнопки, строки с tabindex).
import { h, fmtScore, scoreClass, channelLabel, LANG } from './ui.js';
import { listConversations, getAnalytics } from './api.js';

let ctx = null; // { appEl, getGroup, actions }
let paletteEl = null;
let helpEl = null;
let gPending = 0; // время нажатия «g» для двухклавишных переходов

const GO = { d: ['#/dashboard', 'Дашборд'], l: ['#/conversations', 'Диалоги'], r: ['#/review', 'Требует проверки'],
  a: ['#/appeals', 'Апелляции'], c: ['#/checklist', 'Чек-лист'], n: ['#/new', 'Новый диалог'] };

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');
const MOD = isMac ? '⌘' : 'Ctrl';

function typing(t) {
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}
const modalOpen = () => !!document.querySelector('.cqa-modal, .cqa-tour');

// ---------- Палитра ----------
function commands() {
  const a = ctx.actions;
  const nav = Object.entries(GO).map(([k, [to, label]]) => ({ group: 'Перейти', label, hint: `G ${k.toUpperCase()}`, icon: '→', run: () => { location.hash = to; } }));
  return [...nav,
    { group: 'Действия', label: 'Оценить группу…', icon: '▶', run: a.runGroup, kw: 'run evaluate оценка прогон' },
    { group: 'Действия', label: 'Импорт набора…', icon: '⇩', run: a.importSet, kw: 'import загрузить api' },
    { group: 'Действия', label: 'Сменить тему (светлая / тёмная)', icon: '◐', hint: 'T', run: a.toggleTheme, kw: 'dark light theme' },
    { group: 'Действия', label: 'Режим демо: крупный шрифт', icon: '⛶', run: a.toggleDemo, kw: 'demo проектор' },
    { group: 'Действия', label: 'Режим: аналитик', icon: '◔', run: () => a.setMode('analyst'), kw: 'analyst' },
    { group: 'Действия', label: 'Режим: проверяющий', icon: '◕', run: () => a.setMode('reviewer'), kw: 'reviewer' },
    { group: 'Помощь', label: 'Тур по интерфейсу', icon: '✦', run: a.startTour, kw: 'tour help обучение' },
    { group: 'Помощь', label: 'Горячие клавиши', icon: '⌨', hint: '?', run: openHelp, kw: 'keyboard shortcuts' },
  ];
}

let convCache = { group: null, rows: [], at: 0 };
async function loadConversations() {
  const group = ctx.getGroup();
  if (convCache.group === group && Date.now() - convCache.at < 30000) return convCache.rows;
  const [rows, an] = await Promise.all([listConversations({ group_id: group }).catch(() => []), getAnalytics({ group_id: group }).catch(() => null)]);
  const topics = new Map();
  for (const t of an?.topics || []) for (const id of t.ids || []) topics.set(Number(id), t.topic);
  convCache = { group, at: Date.now(), rows: rows.map((r) => ({ ...r, topic: topics.get(r.id) || '' })) };
  return convCache.rows;
}

function norm(s) { return String(s || '').toLowerCase().replace(/ё/g, 'е'); }
function matches(q, hay) { const H = norm(hay); return norm(q).split(/\s+/).filter(Boolean).every((w) => H.includes(w)); }

export function openPalette() {
  if (paletteEl) return;
  let items = [];
  let active = 0;
  const input = h('input', { class: 'cqa-pal__input', type: 'text', placeholder: 'Диалог, экран или действие…', 'aria-label': 'Поиск команд',
    autocomplete: 'off', spellcheck: 'false', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'cqa-pal-list' });
  const list = h('div', { class: 'cqa-pal__list', id: 'cqa-pal-list', role: 'listbox' });
  const foot = h('div', { class: 'cqa-pal__foot' },
    h('span', null, h('kbd', null, '↑'), h('kbd', null, '↓'), ' выбор'), h('span', null, h('kbd', null, 'Enter'), ' открыть'),
    h('span', null, h('kbd', null, 'Esc'), ' закрыть'), h('span', { class: 'cqa-pal__group' }, `группа ${ctx.getGroup()}`));
  const box = h('div', { class: 'cqa-pal__box', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Палитра команд' },
    h('div', { class: 'cqa-pal__search' }, h('span', { class: 'cqa-pal__icon', 'aria-hidden': 'true' }, '⌕'), input, h('kbd', null, `${MOD} K`)), list, foot);
  paletteEl = h('div', { class: 'cqa-pal', onmousedown: (e) => { if (e.target === paletteEl) closePalette(); } }, box);
  ctx.appEl.append(paletteEl);
  input.focus();

  let convs = null;
  loadConversations().then((r) => { convs = r; render(); });

  function render() {
    const q = input.value.trim();
    const cmd = commands().filter((c) => !q || matches(q, `${c.label} ${c.group} ${c.kw || ''}`));
    let dlg = [];
    if (convs) {
      dlg = convs.filter((r) => !q || matches(q, `${r.conversation_id} ${r.topic} ${LANG[norm(r.language)] || r.language} ${channelLabel(r.channel)}`));
      // Точное начало id — выше; без запроса показываем самые проблемные (грубая ошибка, проверка, низкий итог).
      const sev = (r) => (r.latest?.critical ? 0 : r.latest?.needs_review ? 1 : 2) * 1000 + (r.latest?.final_total ?? 999);
      dlg.sort((x, y) => (q ? (norm(y.conversation_id).startsWith(norm(q)) - norm(x.conversation_id).startsWith(norm(q))) : 0) || sev(x) - sev(y));
      dlg = dlg.slice(0, q ? 8 : 5).map((r) => ({ group: q ? 'Диалоги' : 'Требуют внимания', conv: r, run: () => { location.hash = `#/conversation/${r.id}`; } }));
    }
    items = q ? [...dlg, ...cmd] : [...cmd.slice(0, 6), ...dlg, ...cmd.slice(6)];
    active = Math.min(active, Math.max(0, items.length - 1));
    const out = [];
    let last = null;
    items.forEach((it, i) => {
      if (it.group !== last) { out.push(h('div', { class: 'cqa-pal__sect' }, it.group)); last = it.group; }
      out.push(row(it, i));
    });
    if (!items.length) out.push(h('div', { class: 'cqa-pal__empty' }, convs ? 'Ничего не найдено' : 'Загрузка…'));
    else if (!convs) out.push(h('div', { class: 'cqa-pal__empty' }, 'Загрузка диалогов…'));
    list.replaceChildren(...out);
    input.setAttribute('aria-activedescendant', `cqa-pal-${active}`);
  }
  function row(it, i) {
    const r = it.conv;
    const body = r
      ? [h('span', { class: 'cqa-pal__mono' }, r.conversation_id),
        h('span', { class: 'cqa-pal__label' }, r.topic || h('span', { class: 'cqa-faint' }, 'без темы')),
        h('span', { class: 'cqa-pal__meta' }, `${LANG[norm(r.language)] || r.language} · ${channelLabel(r.channel)}`),
        r.latest?.critical ? h('span', { class: 'cqa-pal__flag' }, '08') : null,
        r.latest?.final_total != null ? h('b', { class: `cqa-pal__score ${scoreClass(r.latest.final_total)}` }, fmtScore(r.latest.final_total)) : h('span', { class: 'cqa-pal__meta' }, 'не оценён')]
      : [h('span', { class: 'cqa-pal__ico', 'aria-hidden': 'true' }, it.icon), h('span', { class: 'cqa-pal__label' }, it.label), it.hint ? h('kbd', null, it.hint) : null];
    return h('div', { class: 'cqa-pal__item', id: `cqa-pal-${i}`, role: 'option', 'aria-selected': String(i === active),
      onmousemove: () => { if (active !== i) { active = i; mark(); } }, onclick: () => choose(i) }, body);
  }
  function mark() {
    list.querySelectorAll('.cqa-pal__item').forEach((el) => el.setAttribute('aria-selected', String(el.id === `cqa-pal-${active}`)));
    list.querySelector(`#cqa-pal-${active}`)?.scrollIntoView({ block: 'nearest' });
    input.setAttribute('aria-activedescendant', `cqa-pal-${active}`);
  }
  function choose(i) { const it = items[i]; if (!it) return; closePalette(); it.run?.(); }
  input.addEventListener('input', () => { active = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % Math.max(1, items.length); mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % Math.max(1, items.length); mark(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  });
  render();
}
export function closePalette() { paletteEl?.remove(); paletteEl = null; }

// ---------- Справка ----------
const HELP = [
  ['Везде', [[`${MOD} K`, 'Палитра команд: диалог, экран или действие'], ['?', 'Эта справка'], ['G, затем D / L / R / A / C / N', 'Дашборд · Диалоги · Проверка · Апелляции · Чек-лист · Новый'], ['T', 'Светлая / тёмная тема'], ['Esc', 'Закрыть окно']]],
  ['Списки', [['/', 'Перейти к поиску'], ['J / K', 'Следующая / предыдущая строка'], ['Enter', 'Открыть строку']]],
  ['Карточка диалога', [['[ / ]', 'Предыдущий / следующий диалог'], ['Пробел', 'Пауза записи (звонок)']]],
];
export function openHelp() {
  if (helpEl) return;
  const close = () => { helpEl?.remove(); helpEl = null; };
  helpEl = h('div', { class: 'cqa-modal cqa-help', onmousedown: (e) => { if (e.target === helpEl) close(); } },
    h('div', { class: 'cqa-modal__box', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Горячие клавиши' },
      h('div', { class: 'cqa-modal__head' }, h('h2', { class: 'cqa-h2' }, 'Горячие клавиши'),
        h('button', { type: 'button', class: 'cqa-modal__x', 'aria-label': 'Закрыть', onclick: close }, '×')),
      h('div', { class: 'cqa-help__grid' }, HELP.map(([title, rows]) => h('section', null, h('h3', null, title),
        h('dl', null, rows.flatMap(([k, v]) => [h('dt', null, k.split(' / ').flatMap((p, i) => [i ? ' / ' : null, h('kbd', null, p)])), h('dd', null, v)]))))),
      h('div', { class: 'cqa-modal__foot' }, h('button', { type: 'button', class: 'cqa-btn cqa-btn--primary', onclick: () => { close(); ctx.actions.startTour(); } }, '✦ Тур по интерфейсу'))));
  ctx.appEl.append(helpEl);
  helpEl.querySelector('.cqa-modal__x').focus();
  helpEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
}

// ---------- Клавиатура ----------
function rowNav(dir) {
  const rows = [...document.querySelectorAll('#cqa-main tr[tabindex="0"], #cqa-main [data-kbd-row]')].filter((el) => el.offsetParent);
  if (!rows.length) return false;
  const i = rows.indexOf(document.activeElement);
  const next = rows[i < 0 ? (dir > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, i + dir))];
  next.focus(); next.scrollIntoView({ block: 'nearest' });
  return true;
}
function focusSearch() {
  const el = document.querySelector('#cqa-main input[type="search"], #cqa-main input[type="text"]');
  if (!el) return false;
  el.focus(); el.select?.();
  return true;
}

function onKey(e) {
  const k = e.key;
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (k === 'k' || k === 'K' || k === 'л' || k === 'Л')) {
    e.preventDefault(); paletteEl ? closePalette() : openPalette(); return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || paletteEl || modalOpen()) return;
  const key = k.length === 1 ? k.toLowerCase() : k;
  // Русская раскладка: те же физические клавиши.
  const RU = { п: 'g', о: 'j', л: 'k', е: 't', в: 'd', д: 'l', к: 'r', ф: 'a', с: 'c', т: 'n', х: '[', ъ: ']' };
  const c = RU[key] || key;
  if (gPending && Date.now() - gPending < 1200 && GO[c]) { gPending = 0; e.preventDefault(); location.hash = GO[c][0]; return; }
  gPending = 0;
  if (k === '?' || (k === ',' && e.shiftKey)) { e.preventDefault(); openHelp(); }
  else if (c === 'g') gPending = Date.now();
  else if (c === 't') ctx.actions.toggleTheme();
  else if (k === '/') { if (focusSearch()) e.preventDefault(); else { e.preventDefault(); openPalette(); } }
  else if (c === 'j') { if (rowNav(1)) e.preventDefault(); }
  else if (c === 'k') { if (rowNav(-1)) e.preventDefault(); }
  else if (c === '[' || c === ']') {
    const btn = document.querySelectorAll('#cqa-main .cqa-card__step')[c === '[' ? 0 : 1];
    if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
  }
}

export function initShellUx(options) {
  ctx = options;
  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', () => { closePalette(); });
}
