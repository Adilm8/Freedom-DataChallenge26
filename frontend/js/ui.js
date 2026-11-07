// Общие помощники интерфейса: построитель DOM, бейджи, состояния. Без побочных эффектов вне переданных элементов.

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  appendKids(el, kids);
  return el;
}
function appendKids(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
export function clear(el) { el.replaceChildren(); return el; }

export function emit(el, name, detail) {
  el.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
}

export const LANG = { ru: 'RU', kz: 'KZ', en: 'EN' };
export const EVENT_LABEL = {
  escalation: 'Эскалация на оператора', identity_verified: 'Личность клиента подтверждена', operator_closed: 'Оператор закрыл чат',
  client_left: 'Клиент покинул чат', client_ended: 'Клиент завершил диалог', connection_lost: 'Соединение прервано',
  session_timeout: 'Сессия закрыта по таймауту',
  agent_joined: 'Оператор подключился', consult_start: 'Консультация с коллегой: начало', consult_end: 'Консультация с коллегой: конец',
  consult_initiated: 'Оператор начал консультацию', hold_start: 'Клиент поставлен на удержание', hold_end: 'Удержание снято',
  recording_started: 'Запись начата', recording_paused: 'Запись приостановлена', recording_resumed: 'Запись возобновлена', language_changed: 'Язык изменён',
};
export const channelLabel = (c) => (c === 'voice call' ? 'Звонок' : 'Чат');
export const ROLE = { client: 'Клиент', operator: 'Оператор', bot: 'Бот', system: 'Система' };

export function fmtScore(v) {
  return v == null ? '—' : Number(v).toFixed(2);
}
export function scoreClass(v) {
  if (v == null) return 'cqa-score--none';
  return v >= 85 ? 'cqa-score--good' : v >= 60 ? 'cqa-score--mid' : 'cqa-score--bad';
}
export function score(v, extraClass = '') {
  return h('span', { class: `cqa-score ${scoreClass(v)} ${extraClass}` }, fmtScore(v));
}
export function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d) ? String(s) : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
/** $0 · $0.0712 · $4.38: ноль без нулей, мелкие суммы — до 4 знаков, от доллара — 2. */
export function fmtMoney(v) {
  if (v == null) return '—';
  const n = Number(v);
  if (!n) return '$0';
  if (Math.abs(n) >= 1) return '$' + n.toFixed(2);
  const s = +n.toFixed(4);
  return s ? '$' + String(s) : '< $0.0001';
}

export function langChip(l) { return h('span', { class: 'cqa-chip' }, LANG[String(l).toLowerCase()] || String(l).toUpperCase()); }
export function channelBadge(c) {
  return h('span', { class: 'cqa-badge cqa-badge--muted' }, channelLabel(c));
}

/** Единый бейдж ответа: Да / Нет / N/A / ступень / флаг. */
export function answerBadge(c, answer, opts = {}) {
  answer = answer === undefined ? c.final_answer : answer;
  if (c.type === 'flag') {
    return answer === 'yes'
      ? h('span', { class: 'cqa-badge cqa-badge--flag' }, 'Грубая ошибка')
      : h('span', { class: 'cqa-badge cqa-badge--yes' }, 'Нет нарушений');
  }
  if (answer === 'na') return h('span', { class: 'cqa-badge cqa-badge--na' }, 'N/A');
  if (answer === 'yes') return h('span', { class: 'cqa-badge cqa-badge--yes' }, 'Да');
  if (answer === 'no') return h('span', { class: 'cqa-badge cqa-badge--no' }, 'Нет');
  // Шкала: цвет по доле балла (полный — зелёный, 0 — красный, между — янтарный). words — «Полностью / Частично / Нет»,
  // когда баллы стоят рядом (карточка), иначе «15 из 20».
  const max = Number(c.scale_max ?? c.weight), v = Number(answer);
  if (!Number.isFinite(max) || !Number.isFinite(v) || max <= 0) return h('span', { class: 'cqa-badge cqa-badge--step' }, String(answer));
  const tone = v >= max ? 'yes' : v <= 0 ? 'no' : 'warn';
  const text = opts.words ? (v >= max ? 'Полностью' : v <= 0 ? 'Нет' : 'Частично') : `${+v.toFixed(2)} из ${+max.toFixed(2)}`;
  return h('span', { class: `cqa-badge cqa-badge--${tone} cqa-badge--scale`, title: `Шкала: ${+v.toFixed(2)} из ${+max.toFixed(2)}` }, text);
}

/** Не выполнен (Нет / шкала 0) или выполнен частично (0 < шкала < max). Флаг — отдельно. */
export function answerState(c, answer) {
  answer = answer === undefined ? c.final_answer : answer;
  if (c.type === 'flag' || answer == null || answer === 'na' || answer === 'yes') return null;
  if (answer === 'no') return 'no';
  const max = Number(c.scale_max ?? c.weight), v = Number(answer);
  if (!Number.isFinite(v)) return null;
  return v <= 0 ? 'no' : Number.isFinite(max) && v < max ? 'part' : null;
}

export function skeletonRows(n = 6) {
  return h('div', { class: 'cqa-skel-rows', role: 'status', 'aria-label': 'Загрузка' },
    Array.from({ length: n }, (_, i) => h('div', { class: 'cqa-skeleton', style: `height:${i % 3 === 0 ? 22 : 16}px;width:${90 - (i % 4) * 12}%` })));
}

export function emptyState({ title, text, actionLabel, onAction, icon = '∅' }) {
  return h('div', { class: 'cqa-state' },
    h('div', { class: 'cqa-state__icon' }, icon),
    h('div', { class: 'cqa-state__title' }, title),
    text ? h('div', { class: 'cqa-state__text' }, text) : null,
    actionLabel ? h('button', { class: 'cqa-btn cqa-btn--primary', type: 'button', onclick: onAction }, actionLabel) : null);
}
export function errorState(err, onRetry) {
  return h('div', { class: 'cqa-state cqa-state--error', role: 'alert' },
    h('div', { class: 'cqa-state__icon' }, '!'),
    h('div', { class: 'cqa-state__title' }, 'Не удалось загрузить данные'),
    h('div', { class: 'cqa-state__text' }, err?.message || String(err)),
    onRetry ? h('button', { class: 'cqa-btn', type: 'button', onclick: onRetry }, 'Повторить') : null);
}

export function toast(root, text) {
  let host = root.querySelector('.cqa-toast-host');
  if (!host) { host = h('div', { class: 'cqa-toast-host', 'aria-live': 'polite' }); root.append(host); }
  const t = h('div', { class: 'cqa-toast' }, text);
  host.append(t);
  setTimeout(() => t.remove(), 3800);
}

export function paramsFromQuery(search = location.search) {
  return Object.fromEntries(new URLSearchParams(search));
}
