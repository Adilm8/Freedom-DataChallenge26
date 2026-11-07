// Общие помощники графиков (дашборд, качество, таймлайн): форматирование, подсказка при наведении и фокусе.
// Графики рисуются чистым HTML/CSS; цвета — только токены --cqa-viz-* из cqa.css (светлая и тёмная тема).
// Подсказка дополняет, но не заменяет: каждое значение есть и в подписи, таблице или aria-label.
import { h } from '../ui.js';

export const fmtPct = (v, digits = 0) => (v == null ? '—' : `${(Number(v) * 100).toFixed(digits)}%`);
/** Уже в процентах (0…100). */
export const fmtPct100 = (v, digits = 0) => (v == null ? '—' : `${Number(v).toFixed(digits)}%`);
export const fmtNum = (v, digits = 2) => (v == null ? '—' : Number(v).toFixed(digits));
export function fmtUsd(v) {
  if (v == null) return '—';
  const n = Number(v);
  if (n === 0) return '$0';
  return '$' + (n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(3) : n.toFixed(4));
}
export const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

/** Одна подсказка на корень экрана. rows: [{label, value, key?: 'var(--cqa-viz-1)'}] или строка. */
export function createTip(root) {
  const el = h('div', { class: 'cqa-vtip', role: 'tooltip', hidden: true });
  root.append(el);
  let owner = null;

  function render(title, rows) {
    el.replaceChildren(
      title ? h('div', { class: 'cqa-vtip__title' }, title) : null,
      (rows || []).map((r) => h('div', { class: 'cqa-vtip__row' },
        r.key ? h('span', { class: 'cqa-vtip__key', style: `background:${r.key}` }) : null,
        h('b', { class: 'cqa-vtip__val' }, r.value),
        h('span', { class: 'cqa-vtip__label' }, r.label))));
  }
  function place(x, y) {
    const pad = 12, w = el.offsetWidth, hh = el.offsetHeight;
    let left = x + pad, top = y - hh - pad;
    if (left + w > window.innerWidth - 8) left = Math.max(8, x - w - pad);
    if (top < 8) top = y + pad + 8;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }
  function show(target, content, ev) {
    owner = target;
    render(content.title, content.rows);
    el.hidden = false;
    if (ev && ev.clientX != null) place(ev.clientX, ev.clientY);
    else { const r = target.getBoundingClientRect(); place(r.left + r.width / 2, r.top); }
  }
  function hide(target) { if (!target || target === owner) { el.hidden = true; owner = null; } }

  /** Привязать подсказку к элементу: наведение, движение указателя, фокус клавиатуры. */
  function bind(target, content) {
    const get = typeof content === 'function' ? content : () => content;
    target.addEventListener('pointerenter', (e) => { if (e.pointerType !== 'touch') show(target, get(), e); });
    target.addEventListener('pointermove', (e) => { if (owner === target && e.pointerType !== 'touch') place(e.clientX, e.clientY); });
    target.addEventListener('pointerleave', () => hide(target));
    target.addEventListener('focus', () => show(target, get()));
    target.addEventListener('blur', () => hide(target));
    return target;
  }
  return { bind, show, hide, el, remove: () => el.remove() };
}

/** Кнопка «Таблица» для графика: переключает видимость табличного двойника. */
export function tableToggle(tableEl, label = 'Таблица') {
  tableEl.hidden = true;
  const btn = h('button', { type: 'button', class: 'cqa-btn cqa-btn--ghost cqa-btn--sm', 'aria-expanded': 'false',
    onclick: () => {
      tableEl.hidden = !tableEl.hidden;
      btn.setAttribute('aria-expanded', String(!tableEl.hidden));
      btn.textContent = tableEl.hidden ? label : 'Скрыть таблицу';
    } }, label);
  return btn;
}

/** Панель с заголовком, подписью и действиями справа. */
export function vpanel({ title, sub, actions, cls = '' }, ...body) {
  return h('section', { class: `cqa-panel cqa-vpanel ${cls}`, 'aria-label': title },
    h('div', { class: 'cqa-vpanel__head' },
      h('div', { class: 'cqa-vpanel__titles' }, h('h2', { class: 'cqa-vpanel__title' }, title), sub ? h('div', { class: 'cqa-vpanel__sub' }, sub) : null),
      actions ? h('div', { class: 'cqa-vpanel__actions' }, actions) : null),
    h('div', { class: 'cqa-vpanel__body' }, body));
}

/** Легенда: [{label, key: css-цвет, shape: 'bar' | 'tick' | 'dot'}]. */
export function legend(items) {
  return h('div', { class: 'cqa-vlegend', role: 'list' }, items.map((it) =>
    h('span', { class: 'cqa-vlegend__item', role: 'listitem' },
      h('span', { class: `cqa-vlegend__sw cqa-vlegend__sw--${it.shape || 'bar'}`, style: `background:${it.key}` }), it.label)));
}
