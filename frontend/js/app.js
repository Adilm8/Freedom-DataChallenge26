// Оболочка: шапка, переключатели, hash-роутинг. Экраны монтируются как самостоятельные компоненты.
import { h, clear, emptyState, toast } from './ui.js';
import { getHealth, isMock } from './api.js';

const appEl = document.getElementById('app');

const NAV = [
  ['dashboard', 'Дашборд'], ['conversations', 'Диалоги'], ['review', 'Требует проверки'],
  ['appeals', 'Апелляции'], ['checklist', 'Чек-лист'], ['quality', 'Качество'],
];
const ROUTES = {
  conversations: { nav: 'conversations', load: () => import('./components/conversation-list.js') },
  conversation: { nav: 'conversations', load: () => import('./components/conversation-card.js'), full: true },
  gold: { nav: 'gold', load: () => import('./components/gold-review.js'), full: true },
};
const PLACEHOLDERS = {
  dashboard: ['Дашборд', 'Средний итог, распределение, выполнение по критериям и грубые ошибки. Экран появится на этапе аналитики.'],
  review: ['Требует проверки', 'Очередь критериев с низкой уверенностью и предупреждениями валидатора.'],
  appeals: ['Апелляции', 'Очередь проверяющего: спорные оценки, фрагмент диалога и форма решения.'],
  checklist: ['Чек-лист', 'Версии, редактор критериев и применение к набору диалогов.'],
  quality: ['Качество', 'Согласие с эталоном и сравнение моделей и стратегий.'],
  compare: ['Сравнение', 'Два результата одного диалога рядом.'],
};

// ---------- Настройки (на уровне оболочки), сохраняются локально ----------
const store = {
  get(k, d) { try { return localStorage.getItem('cqa.' + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cqa.' + k, v); } catch { /* недоступно */ } },
};
const query = new URLSearchParams(location.search);
const settings = {
  group: store.get('group', 'DEV'),
  mode: store.get('mode', 'analyst'),
  demo: query.get('demo') === '1' || store.get('demo', '0') === '1',
};

let current = null; // { name, instance, el }
let healthEl;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  const seg = path.split('/').filter(Boolean);
  const q = Object.fromEntries(new URLSearchParams(qs || ''));
  return { name: seg[0] || 'conversations', arg: seg[1], q };
}

function buildHeader() {
  const nav = h('nav', { class: 'cqa-nav', 'aria-label': 'Разделы' },
    [...NAV, ['gold', 'Проверка gold']].map(([id, label]) => h('a', { class: 'cqa-nav__link', href: `#/${id}`, dataset: { nav: id }, hidden: id === 'gold' && settings.group !== 'DEV' }, label)));
  const groupSel = h('select', { class: 'cqa-select', 'aria-label': 'Группа данных',
    onchange: (e) => { settings.group = e.target.value; store.set('group', settings.group); syncHeader(); route(); } },
    ['DEV', 'CONTROL'].map((g) => h('option', { value: g, selected: settings.group === g }, g)));
  const modeSeg = h('div', { class: 'cqa-seg', role: 'group', 'aria-label': 'Режим' },
    [['analyst', 'Аналитик'], ['reviewer', 'Проверяющий']].map(([id, label]) =>
      h('button', { type: 'button', class: 'cqa-seg__btn', dataset: { mode: id }, 'aria-pressed': String(settings.mode === id),
        onclick: () => { settings.mode = id; store.set('mode', id); syncHeader(); route(); } }, label)));
  const demo = h('label', { class: 'cqa-toggle', title: 'Крупнее шрифт и бейджи для проектора' },
    h('input', { type: 'checkbox', checked: settings.demo, onchange: (e) => { settings.demo = e.target.checked; store.set('demo', settings.demo ? '1' : '0'); syncHeader(); } }), 'Демо');
  healthEl = h('span', { class: 'cqa-health' }, h('span', { class: 'cqa-health__dot' }), h('span', { class: 'cqa-health__text' }, 'проверка…'));
  return h('header', { class: 'cqa-header' },
    h('a', { class: 'cqa-brand', href: '#/conversations' }, h('span', { class: 'cqa-brand__mark' }, 'C'), 'CQA', h('small', null, '· Freedom Broker')),
    nav, h('div', { class: 'cqa-header__tools' }, healthEl, groupSel, modeSeg, demo));
}

function syncHeader() {
  appEl.classList.toggle('cqa-demo', settings.demo);
  const goldLink = appEl.querySelector('.cqa-nav__link[data-nav="gold"]'); // gold размечаем только для DEV
  if (goldLink) goldLink.hidden = settings.group !== 'DEV';
  appEl.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === settings.mode)));
}
function markNav(name) {
  const nav = (ROUTES[name] || {}).nav || name;
  appEl.querySelectorAll('.cqa-nav__link').forEach((a) => (a.dataset.nav === nav ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
}

async function checkHealth() {
  const set = (cls, text) => { healthEl.className = `cqa-health cqa-health--${cls}`; healthEl.querySelector('.cqa-health__text').textContent = text; };
  try {
    const hl = await getHealth();
    if (isMock()) set('mock', 'демо-данные');
    else set('ok', `бэкенд: ${hl.provider || 'ok'}`);
  } catch { set('bad', 'бэкенд недоступен'); }
}

// ---------- Роутер ----------
let mainEl;
let routeToken = 0;
async function route() {
  const my = ++routeToken;
  const { name, arg, q } = parseHash();
  markNav(name);
  if (current) { try { current.instance?.unmount?.(); } catch { /* уже снят */ } current = null; }
  clear(mainEl);
  const host = h('div', { class: 'cqa-route' });
  mainEl.append(host);
  const base = { group: q.group || settings.group, mode: settings.mode, ...q };
  const def = ROUTES[name];
  if (!def) {
    const [title, text] = PLACEHOLDERS[name] || ['Страница не найдена', 'Такого раздела нет. Вернитесь к списку диалогов.'];
    host.append(h('div', { class: 'cqa-page' }, h('div', { class: 'cqa-panel' }, emptyState({
      title: PLACEHOLDERS[name] ? `${title}: экран в работе` : title, text, icon: PLACEHOLDERS[name] ? '⚙' : '?',
      actionLabel: 'К списку диалогов', onAction: () => { location.hash = '#/conversations'; } }))));
    return;
  }
  const mod = await def.load();
  if (my !== routeToken) return;
  const params = name === 'conversation' || name === 'gold' ? { ...base, id: arg } : base;
  current = { name, instance: mod.mount(host, params), el: host };
}

function onAppEvent(e) {
  if (e.type === 'cqa:navigate' && e.detail?.to) location.hash = e.detail.to;
  else if (e.type === 'cqa:run-request') toast(appEl, `Запуск оценки подключим следующим шагом. Выбрано диалогов: ${e.detail.ids.length}.`);
  else if (e.type === 'cqa:import-request') toast(appEl, 'Импорт набора появится вместе с бэкендом.');
}

function init() {
  appEl.append(buildHeader());
  mainEl = h('main', { class: 'cqa-main', id: 'cqa-main' });
  const shell = h('div', { class: 'cqa-shell' });
  const header = appEl.querySelector('.cqa-header');
  shell.append(header, mainEl);
  appEl.append(shell);
  appEl.style.setProperty('--cqa-header-h', '60px');
  for (const t of ['cqa:navigate', 'cqa:run-request', 'cqa:import-request']) appEl.addEventListener(t, onAppEvent);
  syncHeader();
  window.addEventListener('hashchange', route);
  if (!location.hash) location.replace('#/conversations' + (query.has('group') ? `?group=${query.get('group')}` : ''));
  route();
  checkHealth();
}
init();
