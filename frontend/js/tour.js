// Интерактивный тур: 6 шагов с подсветкой реальных элементов. Каждый шаг открывает свой экран и ждёт нужный элемент.
import { h } from './ui.js';

const STEPS = [
  { to: '#/dashboard', sel: '.cqa-kpis', title: 'Картина по группе',
    text: 'Средний итог, грубые ошибки, очередь проверки и апелляции. Итог учитывает решения по апелляциям, а AI-оценка рядом не меняется.' },
  { to: '#/dashboard', sel: '.cqa-crow-list', title: 'Где проседают операторы',
    text: 'Выполнение каждого критерия чек-листа. Клик по «не вып.» открывает именно те диалоги, где критерий провален.' },
  { to: '#/conversations', sel: '.cqa-list-table', fallback: '#cqa-main', title: 'Все диалоги на одном экране',
    text: 'Колонка «Критерии» — клетка на каждый пункт чек-листа: зелёный — выполнен, янтарный — частично, красный — нет, штриховка — N/A, красная клетка в конце — грубая ошибка. J/K и Enter — навигация с клавиатуры.' },
  { to: 'first-conversation', sel: '.cqa-card__timeline', fallback: '.cqa-card', title: 'Ход диалога',
    text: 'Бот, ожидание, работа оператора и метки критериев на шкале времени. Для звонков здесь же плеер с переходом к фразе.' },
  { to: 'stay', sel: '.cqa-crit__body', fallback: '.cqa-res', title: 'Оценка с доказательством',
    text: 'Ответ модели, обоснование и цитата из реплики. «Показать в транскрипте» подсвечивает реплику, «Оспорить» отправляет апелляцию на пересмотр.' },
  { to: 'stay', sel: '.cqa-search-btn', title: 'Всё под рукой',
    text: 'Ctrl+K — поиск диалога, экрана или действия. «?» — горячие клавиши. Чек-лист меняется в конструкторе без кода.' },
];

async function waitFor(sel, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent) return el;
    await new Promise((r) => setTimeout(r, 80));
  }
  return null;
}

let tourEl = null;
export async function startTour(appEl) {
  if (tourEl) return;
  let i = 0;
  const spot = h('div', { class: 'cqa-tour__spot' });
  const title = h('div', { class: 'cqa-tour__title' });
  const text = h('div', { class: 'cqa-tour__text' });
  const dots = h('div', { class: 'cqa-tour__dots' }, STEPS.map(() => h('span')));
  const back = h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm cqa-btn--ghost', onclick: () => show(i - 1) }, 'Назад');
  const next = h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm cqa-btn--primary', onclick: () => (i < STEPS.length - 1 ? show(i + 1) : end()) });
  const card = h('div', { class: 'cqa-tour__card', role: 'dialog', 'aria-live': 'polite', 'aria-label': 'Тур по интерфейсу' },
    h('div', { class: 'cqa-tour__step' }), title, text,
    h('div', { class: 'cqa-tour__foot' }, dots, h('button', { type: 'button', class: 'cqa-linkbtn cqa-tour__skip', onclick: () => end() }, 'Пропустить'), back, next));
  tourEl = h('div', { class: 'cqa-tour' }, spot, card);
  appEl.append(tourEl);
  let target = null;
  const place = () => {
    if (!target || !tourEl) return;
    const r = target.getBoundingClientRect();
    const pad = 8;
    Object.assign(spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${Math.min(r.height, innerHeight * 0.7) + pad * 2}px` });
    const cw = Math.min(360, innerWidth - 24), ch = card.offsetHeight || 180;
    let top = r.bottom + 16, left = Math.min(Math.max(12, r.left), innerWidth - cw - 12);
    if (top + ch > innerHeight - 12) top = Math.max(12, r.top - ch - 16);
    if (top < 12 || innerWidth < 640) { top = innerHeight - ch - 12; left = (innerWidth - cw) / 2; }
    Object.assign(card.style, { top: `${top}px`, left: `${left}px`, width: `${cw}px` });
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); end(); }
    else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next.click(); }
    else if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); show(i - 1); }
  };
  document.addEventListener('keydown', onKey, true);
  addEventListener('resize', place); addEventListener('scroll', place, true);

  async function show(n) {
    i = n;
    const s = STEPS[i];
    card.querySelector('.cqa-tour__step').textContent = `Шаг ${i + 1} из ${STEPS.length}`;
    title.textContent = s.title; text.textContent = s.text;
    [...dots.children].forEach((d, k) => d.classList.toggle('is-on', k === i));
    back.hidden = i === 0; next.textContent = i === STEPS.length - 1 ? 'Готово' : 'Далее';
    tourEl.classList.add('is-moving');
    if (s.to === 'first-conversation') {
      if (!location.hash.startsWith('#/conversation/')) {
        const row = await waitFor('#cqa-main tr[tabindex="0"]', 3000);
        if (row) row.click(); else location.hash = '#/conversations';
      }
    } else if (s.to !== 'stay' && !location.hash.startsWith(s.to)) location.hash = s.to;
    target = (await waitFor(s.sel)) || (s.fallback && (await waitFor(s.fallback, 1500))) || document.querySelector('#cqa-main');
    if (!tourEl || STEPS[i] !== s) return;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => { place(); tourEl?.classList.remove('is-moving'); next.focus(); }, 380);
  }
  function end() {
    document.removeEventListener('keydown', onKey, true);
    removeEventListener('resize', place); removeEventListener('scroll', place, true);
    tourEl?.remove(); tourEl = null;
  }
  show(0);
}
