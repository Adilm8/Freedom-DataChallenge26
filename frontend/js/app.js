// Оболочка: шапка, переключатели, hash-роутинг. Экраны монтируются как самостоятельные компоненты.
import { icon } from './icons.js';
import { h, clear, emptyState } from './ui.js';
import { getHealth, isMock, listGroups, listAppeals, getReviewQueue } from './api.js';
import { openRunDialog } from './components/run-dialog.js';
import { openImportDialog } from './components/import-dialog.js';
import { initShellUx, openPalette } from './shell-ux.js';
import { LANGS, getLang, setLang } from './i18n.js';

const appEl = document.getElementById('app');

const NAV = [
  ['dashboard', 'Аналитика'], ['conversations', 'Диалоги'], ['review', 'Требует проверки'],
  ['appeals', 'Апелляции'], ['checklist', 'Чек-листы'],
];
const ROUTES = {
  dashboard: { nav: 'dashboard', load: () => import('./components/dashboard-view.js') },
  // Служебные экраны команды, без пункта в меню: точность против эталона (#/quality) и проверка эталона (#/gold).
  quality: { nav: 'quality', load: () => import('./components/quality-view.js') },
  conversations: { nav: 'conversations', load: () => import('./components/conversation-list.js') },
  conversation: { nav: 'conversations', load: () => import('./components/conversation-card.js'), full: true },
  gold: { nav: 'gold', load: () => import('./components/gold-review.js'), full: true },
  checklist: { nav: 'checklist', load: () => import('./components/checklist-editor.js') },
  appeals: { nav: 'appeals', load: () => import('./components/appeal-review.js') },
  review: { nav: 'review', load: () => import('./components/review-queue.js') },
  new: { nav: 'conversations', load: () => import('./components/new-dialog.js') },
  coaching: { nav: 'conversations', load: () => import('./components/coaching-report.js') }, // #/coaching?id=<диалог>[&eval=<оценка>]
  compare: { nav: 'conversations', load: () => import('./components/evaluation-compare.js') }, // #/compare?conversation=&a=&b= или #/compare/<id>?a=&b=
};
const PLACEHOLDERS = {};

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
  theme: ['light', 'dark'].includes(query.get('theme')) ? query.get('theme') : store.get('theme', 'auto'), // auto — как в системе
};
if (query.has('demo')) store.set('demo', query.get('demo') === '1' ? '1' : '0'); // ?demo=1 переживает перезагрузку
const darkMq = window.matchMedia?.('(prefers-color-scheme: dark)');
const isDark = () => settings.theme === 'dark' || (settings.theme === 'auto' && !!darkMq?.matches);

let current = null; // { name, instance, el }
let importDlg = null; // открытое окно импорта набора
let healthEl, groupSel;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  const seg = path.split('/').filter(Boolean);
  const q = Object.fromEntries(new URLSearchParams(qs || ''));
  // Привычные адреса во множественном числе: #/checklists → редактор, #/conversations/<id> → карточка.
  let name = seg[0] || 'dashboard';
  if (name === 'checklists') name = 'checklist';
  if (name === 'conversations' && seg[1]) name = 'conversation';
  return { name, arg: seg[1], q };
}

const MODE_HINT = { analyst: 'Смотрит оценки и подаёт апелляции', reviewer: 'Решает апелляции и меняет оценки' };

function navIcon(id) { return icon(id, 20, 'cqa-nav__icon'); }

// Оболочка: слева — фирменное меню (логотип, разделы, группа данных, роль), сверху — поиск и служебные переключатели.
function buildHeader() {
  const nav = h('nav', { class: 'cqa-nav', 'aria-label': 'Разделы' },
    NAV.map(([id, label]) => h('a', { class: 'cqa-nav__link', href: `#/${id}`, dataset: { nav: id } }, navIcon(id), h('span', { class: 'cqa-nav__label' }, label),
      COUNTED[id] ? h('span', { class: 'cqa-nav__count', hidden: true, title: COUNTED[id] }) : null)));
  // Группы — из реальных данных (loadGroups); до ответа сервера — только текущая.
  groupSel = h('select', { class: 'cqa-select cqa-side__select', 'aria-label': 'Набор диалогов',
    onchange: (e) => { settings.group = e.target.value; store.set('group', settings.group); syncHeader(); route(); refreshCounts(); } },
    h('option', { value: settings.group, selected: true }, settings.group));
  // Роль — без входа в систему (по ТЗ авторизация не нужна): аналитик подаёт апелляцию, проверяющий её решает.
  // Подсказка под переключателем говорит, что умеет выбранная роль.
  const modeSeg = h('div', { class: 'cqa-seg cqa-side__seg', role: 'group', 'aria-label': 'Роль' },
    [['analyst', 'Аналитик'], ['reviewer', 'Проверяющий']].map(([id, label]) =>
      h('button', { type: 'button', class: 'cqa-seg__btn', dataset: { mode: id }, 'aria-pressed': String(settings.mode === id),
        onclick: () => { settings.mode = id; store.set('mode', id); syncHeader(); route(); } }, label)));
  // Язык интерфейса: подписи кнопок не переводятся (data-i18n-skip), смена — с перезагрузкой страницы.
  const langSeg = h('div', { class: 'cqa-seg cqa-side__seg', role: 'group', 'aria-label': 'Язык интерфейса' },
    LANGS.map(([id, short, name]) => h('button', { type: 'button', class: 'cqa-seg__btn', title: name, lang: id,
      'aria-pressed': String(getLang() === id), 'data-i18n-skip': true,
      onclick: () => { if (getLang() !== id) setLang(id); } }, short)));
  const demo = h('label', { class: 'cqa-toggle', title: 'Крупнее шрифт для проектора' },
    h('input', { type: 'checkbox', checked: settings.demo, onchange: (e) => { settings.demo = e.target.checked; store.set('demo', settings.demo ? '1' : '0'); syncHeader(); } }), 'Крупный шрифт');
  const themeBtn = h('button', { type: 'button', class: 'cqa-btn cqa-btn--ghost cqa-btn--sm cqa-themebtn', id: 'cqa-theme',
    onclick: () => { settings.theme = isDark() ? 'light' : 'dark'; store.set('theme', settings.theme); syncHeader(); } });
  const searchBtn = h('button', { type: 'button', class: 'cqa-search-btn', title: 'Поиск диалога, раздела или действия', onclick: () => openPalette() },
    h('span', { class: 'cqa-search-btn__ico' }, icon('search', 16)), h('span', { class: 'cqa-search-btn__text' }, 'Поиск диалога, раздела или действия'),
    h('kbd', null, /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘K' : 'Ctrl K'));
  healthEl = h('span', { class: 'cqa-health' }, h('span', { class: 'cqa-health__dot' }), h('span', { class: 'cqa-health__text' }, 'проверка…'));
  const side = h('aside', { class: 'cqa-side', 'aria-label': 'Навигация' },
    h('a', { class: 'cqa-brand', href: '#/dashboard', 'aria-label': 'Freedom Broker · Контроль качества' },
      h('img', { class: 'cqa-brand__logo', src: 'img/freedom-broker-white.png', alt: 'Freedom Broker', width: 176, height: 55 }),
      h('span', { class: 'cqa-brand__product' }, 'Контроль качества обслуживания')),
    nav,
    h('div', { class: 'cqa-side__foot' },
      h('label', { class: 'cqa-side__field', title: 'DEV — выданные 65 диалогов; контрольный набор появится здесь после импорта' },
        h('span', { class: 'cqa-side__label' }, 'Набор диалогов'), groupSel),
      h('div', { class: 'cqa-side__field' }, h('span', { class: 'cqa-side__label' }, 'Роль'), modeSeg,
        h('span', { class: 'cqa-side__hint', id: 'cqa-mode-hint' }, MODE_HINT[settings.mode] || MODE_HINT.analyst)),
      h('div', { class: 'cqa-side__field' }, h('span', { class: 'cqa-side__label' }, 'Язык интерфейса'), langSeg)));
  const top = h('header', { class: 'cqa-header' }, searchBtn, h('div', { class: 'cqa-header__tools' }, healthEl, demo, themeBtn));
  return { side, top };
}

const themeIcon = (dark) => icon(dark ? 'sun' : 'moon', 20);
// Эталон размечаем только для DEV; в режиме «Демо» пункт скрыт (это рабочий инструмент команды, а не экран для жюри).

function syncHeader() {
  appEl.classList.toggle('cqa-demo', settings.demo);
  appEl.dataset.theme = isDark() ? 'dark' : 'light';
  const tb = appEl.querySelector('#cqa-theme');
  if (tb) { tb.replaceChildren(themeIcon(isDark())); tb.title = isDark() ? 'Светлая тема' : 'Тёмная тема'; tb.setAttribute('aria-label', tb.title); }
  appEl.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === settings.mode)));
  const hint = appEl.querySelector('#cqa-mode-hint');
  if (hint) hint.textContent = MODE_HINT[settings.mode] || MODE_HINT.analyst;
}
function markNav(name) {
  const nav = (ROUTES[name] || {}).nav || name;
  appEl.querySelectorAll('.cqa-nav__link').forEach((a) => (a.dataset.nav === nav ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
}

async function checkHealth() {
  const set = (cls, text) => { healthEl.className = `cqa-health cqa-health--${cls}`; healthEl.title = text; healthEl.querySelector('.cqa-health__text').textContent = text; };
  try {
    const hl = await getHealth();
    if (isMock()) set('mock', 'демо-данные');
    else {
      // Короткое имя модели («claude-sonnet-4.5» из «anthropic/claude-sonnet-4.5»), полное — в подсказке.
      const short = hl.model ? String(hl.model).split('/').pop() : null;
      set('ok', short ? `модель: ${short}` : 'сервер на связи');
      healthEl.title = `Сервер на связи · ${hl.provider || '—'} · ${hl.model || 'модель не задана'}`;
    }
  } catch { set('bad', 'бэкенд недоступен'); }
}

// ---------- Группы и счётчики в меню ----------
const COUNTED = { review: 'Пунктов в очереди проверки (критерий или оценка целиком); диалогов меньше — см. дашборд', appeals: 'Открытых апелляций' };
/** Список групп из данных; select — сделать группу текущей (после нового диалога). true — текущая группа сменилась. */
async function loadGroups(select) {
  let groups;
  try { groups = await listGroups(); } catch { return false; }
  const before = settings.group;
  if (select) settings.group = select;
  else if (groups.length && !groups.some((g) => g.group_id === settings.group)) settings.group = (groups.find((g) => g.default) || groups[0]).group_id;
  if (!groups.some((g) => g.group_id === settings.group)) groups.push({ group_id: settings.group, count: 0 });
  store.set('group', settings.group);
  groupSel.replaceChildren(...groups.map((g) => h('option', { value: g.group_id, selected: g.group_id === settings.group, title: `диалогов: ${g.count}` }, `${g.group_id} · ${g.count}`)));
  groupSel.title = groups.map((g) => `${g.group_id}: ${g.count}`).join(' · ');
  syncHeader();
  return settings.group !== before;
}
let countSeq = 0;
async function refreshCounts() {
  const my = ++countSeq;
  const [ap, rq] = await Promise.all([listAppeals({ status: 'open', group_id: settings.group }).catch(() => null), getReviewQueue({ group_id: settings.group }).catch(() => null)]);
  if (my !== countSeq) return;
  for (const [id, list] of [['appeals', ap], ['review', rq]]) {
    const el = appEl.querySelector(`.cqa-nav__link[data-nav="${id}"] .cqa-nav__count`);
    if (el) { el.hidden = !list?.length; el.textContent = list?.length > 99 ? '99+' : String(list?.length || ''); }
  }
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
  const params = name === 'conversation' || name === 'gold' ? { ...base, id: arg }
    : name === 'compare' ? { ...base, conversation: q.conversation || arg } : base;
  current = { name, instance: mod.mount(host, params), el: host };
}

function onAppEvent(e) {
  if (e.type === 'cqa:navigate' && e.detail?.to) location.hash = e.detail.to;
  else if (e.type === 'cqa:location' && e.detail?.to) history.replaceState(null, '', e.detail.to); // адрес без перехода
  else if (e.type === 'cqa:run-request') {
    // По завершении прогона обновляем тот экран, который открыт в этот момент (карточка или список).
    openRunDialog(appEl, { group: settings.group, ...e.detail,
      onFinished: () => { current?.el?.dispatchEvent(new CustomEvent('cqa:refresh')); refreshCounts(); } });
  } else if (e.type === 'cqa:import-request') {
    // Импорт набора: новая группа сразу появляется в селекторе; экран той же группы перечитывается. Окно одно.
    if (importDlg?.isOpen()) return;
    importDlg = openImportDialog(appEl, { group: e.detail?.group || '',
      onImported: (res) => {
        loadGroups().then(refreshCounts);
        if (res.group_id === (parseHash().q.group || settings.group)) current?.el?.dispatchEvent(new CustomEvent('cqa:refresh'));
      } });
  } else if (e.type === 'cqa:counts-changed') refreshCounts();
  else if (e.type === 'cqa:groups-changed') {
    // select — сделать группу текущей; to — после этого открыть экран (без to экран остаётся);
    // run — затем открыть окно запуска (detail как у cqa:run-request). Переход через pushState: hashchange закрыл бы окно.
    const { to, run } = e.detail || {};
    loadGroups(e.detail?.select).then(() => {
      refreshCounts();
      if (to) { if (location.hash !== to) history.pushState(null, '', to); route(); }
      if (run) onAppEvent(new CustomEvent('cqa:run-request', { detail: run }));
    });
  }
  else if (e.type === 'cqa:mode' && e.detail?.mode) { settings.mode = e.detail.mode; store.set('mode', settings.mode); syncHeader(); route(); }
}

function init() {
  const { side, top } = buildHeader();
  mainEl = h('main', { class: 'cqa-main', id: 'cqa-main' });
  appEl.append(h('div', { class: 'cqa-shell' }, side, h('div', { class: 'cqa-workspace' }, top, mainEl)));
  appEl.style.setProperty('--cqa-header-h', '56px');
  for (const t of ['cqa:navigate', 'cqa:location', 'cqa:run-request', 'cqa:import-request', 'cqa:counts-changed', 'cqa:groups-changed', 'cqa:mode']) appEl.addEventListener(t, onAppEvent);
  syncHeader();
  window.addEventListener('hashchange', () => { route(); refreshCounts(); });
  darkMq?.addEventListener?.('change', syncHeader);
  // replaceState не вызывает hashchange: первый показ — один раз, после загрузки групп.
  if (!location.hash) history.replaceState(null, '', '#/dashboard' + (query.has('group') ? `?group=${query.get('group')}` : ''));
  // Сохранённой группы может не быть в данных (другая БД, демо-режим): сначала сверяем список групп.
  loadGroups().finally(() => { route(); refreshCounts(); });
  checkHealth();
  initShellUx({
    appEl, getGroup: () => settings.group,
    actions: {
      toggleTheme: () => { settings.theme = isDark() ? 'light' : 'dark'; store.set('theme', settings.theme); syncHeader(); },
      toggleDemo: () => { settings.demo = !settings.demo; store.set('demo', settings.demo ? '1' : '0'); const cb = appEl.querySelector('.cqa-toggle input'); if (cb) cb.checked = settings.demo; syncHeader(); },
      setMode: (mode) => onAppEvent(new CustomEvent('cqa:mode', { detail: { mode } })),
      runGroup: async () => {
        const rows = await import('./api.js').then((m) => m.listConversations({ group_id: settings.group })).catch(() => null);
        onAppEvent(new CustomEvent('cqa:run-request', { detail: { ids: [], group: settings.group, rows } }));
      },
      importSet: () => onAppEvent(new CustomEvent('cqa:import-request', { detail: { group: '' } })),
      startTour: () => import('./tour.js').then((m) => m.startTour(appEl)),
    },
  });
}
init();
