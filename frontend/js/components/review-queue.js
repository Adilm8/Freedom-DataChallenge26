// Очередь «требует проверки» (FR-UX-02). Маршрут #/review?reason=<причина>.
// Элементы GET /review-queue: критерий последней оценки (или вся оценка) с главной причиной, важные сверху.
// Клик → карточка диалога на нужном критерии с подсветкой доказательств (#/conversation/<id>?eval=..&focus=<код>).
// Параметры: group, mode, reason. Наружу: cqa:navigate, cqa:location.
import { h, clear, emit, channelBadge, langChip, skeletonRows, errorState, emptyState } from '../ui.js';
import { getReviewQueue, getFactLabels } from '../api.js';

export const REASON = {
  failed: ['Оценка не получена', 'flag', 'Модель не вернула результат: баллов нет'],
  missing: ['Нет ответа по критерию', 'no', 'Модель пропустила критерий'],
  appeal: ['Апелляция', 'accent', 'Аналитик оспорил оценку'],
  guard: ['Противоречит фактам', 'warn', 'Ответ модели не сходится с фактами, извлечёнными кодом'],
  validator: ['Предупреждение проверки', 'warn', 'Цитата не найдена или ответ не прошёл проверку'],
  low_confidence: ['Низкая уверенность', 'na', 'Модели не хватило данных для уверенного вывода'],
};
const ORDER = ['failed', 'missing', 'appeal', 'guard', 'validator', 'low_confidence'];
const CONF = { high: 'высокая', medium: 'средняя', low: 'низкая' };
const ANS = { yes: 'Да', no: 'Нет', na: 'N/A' };
const ansText = (v) => (v == null ? '—' : ANS[v] || String(v));
/** «противоречие фактам: !identity_verified, ended_abruptly» → подписи фактов из реестра бэкенда вместо ключей. */
export function humanizeFacts(text, labels) {
  if (!text || !labels) return text;
  return String(text).replace(/(!?)\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+|[a-z]{3,})\b/g, (m, neg, key) => {
    const label = labels[key];
    if (!label) return m;
    return `«${label}» — ${neg ? "нет" : "да"}`;
  });
}

export function mount(el, params = {}) {
  let p = { ...params };
  const st = { items: null, reason: ORDER.includes(p.reason) ? p.reason : '', q: '', lang: '', labels: null };
  const root = h('div', { class: 'cqa-page cqa-rq' });
  el.append(root);
  const body = h('div');
  let token = 0;
  const group = () => p.group || 'DEV';

  async function load({ quiet = false } = {}) {
    const my = ++token;
    if (!quiet) clear(body).append(skeletonRows(8));
    try {
      const [items, facts] = await Promise.all([getReviewQueue({ group_id: group() }), getFactLabels().catch(() => null)]);
      if (my !== token) return;
      st.labels = facts?.labels || null;
      st.items = items;
      render();
    } catch (e) {
      if (my === token) clear(body).append(errorState(e, () => load()));
    }
  }

  const visible = () => st.items.filter((it) => (!st.reason || (it.reasons || [it.reason]).includes(st.reason))
    && (!st.q || it.conversation_code.toLowerCase().includes(st.q.toLowerCase()))
    && (!st.lang || String(it.language).toLowerCase() === st.lang));

  function setReason(r) {
    st.reason = r;
    emit(root, 'cqa:location', { to: r ? `#/review?reason=${r}` : '#/review' });
    render();
  }

  function render() {
    const items = st.items;
    clear(body);
    if (!items.length) {
      body.append(emptyState({ icon: '✓', title: 'Проверять нечего',
        text: `В последних оценках группы ${group()} нет критериев с низкой уверенностью, предупреждениями или открытыми апелляциями. Если диалоги ещё не оценены — запустите оценку из списка.`,
        actionLabel: 'К списку диалогов', onAction: () => emit(root, 'cqa:navigate', { to: '#/conversations' }) }));
      return;
    }
    const counts = Object.fromEntries(ORDER.map((r) => [r, items.filter((it) => (it.reasons || [it.reason]).includes(r)).length]));
    const dialogs = new Set(items.map((it) => it.conversation_id)).size;
    const toolbar = h('div', { class: 'cqa-toolbar cqa-rq__toolbar' },
      h('div', { class: 'cqa-rq__chips', role: 'group', 'aria-label': 'Причина' },
        h('button', { type: 'button', class: 'cqa-rq__chip', 'aria-pressed': String(!st.reason), dataset: { reason: '' }, onclick: () => setReason('') },
          'Все', h('span', { class: 'cqa-rq__n' }, String(items.length))),
        ORDER.filter((r) => counts[r]).map((r) => h('button', { type: 'button', class: `cqa-rq__chip cqa-rq__chip--${r}`, 'aria-pressed': String(st.reason === r),
          dataset: { reason: r }, title: REASON[r][2], onclick: () => setReason(st.reason === r ? '' : r) },
        h('span', { class: `cqa-rq__dot cqa-rq__dot--${r}`, 'aria-hidden': 'true' }), REASON[r][0], h('span', { class: 'cqa-rq__n' }, String(counts[r]))))),
      h('span', { class: 'cqa-toolbar__spacer' }),
      h('input', { class: 'cqa-input', type: 'search', placeholder: 'Поиск по id диалога', value: st.q, 'aria-label': 'Поиск по id диалога', style: 'width:180px',
        oninput: (e) => { st.q = e.target.value; renderList(); } }),
      h('select', { class: 'cqa-select', 'aria-label': 'Язык', onchange: (e) => { st.lang = e.target.value; renderList(); } },
        [['', 'Все языки'], ['ru', 'RU'], ['kz', 'KZ'], ['en', 'EN']].map(([v, t]) => h('option', { value: v, selected: st.lang === v }, t))));
    const listEl = h('div', { class: 'cqa-rq__list', role: 'list' });
    const foot = h('div', { class: 'cqa-tfoot' });
    body.append(toolbar, listEl, foot);
    function renderList() {
      const list = visible();
      clear(listEl);
      if (!list.length) listEl.append(emptyState({ icon: '⌕', title: 'Ничего не найдено', text: 'Измените причину, язык или поиск.', actionLabel: 'Сбросить',
        onAction: () => { st.q = ''; st.lang = ''; setReason(''); } }));
      else listEl.append(...list.map(item));
      foot.textContent = `Показано ${list.length} из ${items.length} · диалогов в очереди: ${dialogs}`;
    }
    renderList();
  }

  function cardUrl(it) {
    const q = [`eval=${it.evaluation_id}`];
    if (it.criterion_key) q.push(`focus=${encodeURIComponent(it.criterion_key)}`);
    return `#/conversation/${it.conversation_id}?${q.join('&')}`;
  }

  function item(it) {
    const [label, tone] = REASON[it.reason] || [it.reason, 'muted'];
    const hf = (t) => humanizeFacts(t, st.labels);
    const extra = (it.messages || []).slice(1).map(hf);
    const issues = (it.issues || []).filter((x) => !(it.messages || []).some((m) => m.includes(x))).map(hf);
    const go = () => emit(root, 'cqa:navigate', { to: cardUrl(it) });
    return h('article', { class: `cqa-rq__item cqa-rq__item--${it.reason}`, role: 'listitem', tabindex: 0, dataset: { key: it.criterion_key || '', conv: it.conversation_id },
      onclick: (e) => { if (!e.target.closest('button')) go(); }, onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) go(); } },
    h('div', { class: 'cqa-rq__main' },
      h('div', { class: 'cqa-rq__top' },
        h('span', { class: 'cqa-row-id' }, it.conversation_code), channelBadge(it.channel), langChip(it.language),
        it.criterion_key ? [h('span', { class: 'cqa-code' }, it.criterion_key), h('span', { class: 'cqa-rq__title' }, it.criterion_title || '')]
          : h('span', { class: 'cqa-rq__title' }, 'Вся оценка')),
      h('div', { class: 'cqa-rq__why' },
        h('span', { class: `cqa-badge cqa-badge--${tone}` }, label),
        (it.reasons || []).filter((r) => r !== it.reason).map((r) => h('span', { class: 'cqa-badge cqa-badge--muted', title: REASON[r]?.[2] }, REASON[r]?.[0] || r)),
        h('span', { class: 'cqa-rq__msg' }, hf(it.message))),
      extra.length || issues.length ? h('ul', { class: 'cqa-rq__more' }, extra.map((m) => h('li', null, m)), issues.map((m) => h('li', null, m))) : null,
      it.criterion_key ? h('div', { class: 'cqa-rq__facts' },
        h('span', null, 'Ответ AI: ', h('b', null, ansText(it.ai_answer))),
        it.final_answer != null && String(it.final_answer) !== String(it.ai_answer) ? h('span', null, 'финальный: ', h('b', null, ansText(it.final_answer))) : null,
        it.confidence ? h('span', { class: it.confidence === 'low' ? 'cqa-rq__low' : '' }, `уверенность: ${CONF[it.confidence] || it.confidence}`) : null) : null),
    h('div', { class: 'cqa-rq__acts' },
      // Вся строка кликабельна; кнопка — вторичная, чтобы 60 одинаковых фиолетовых кнопок не спорили с содержанием.
      h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm cqa-rq__go', onclick: go }, it.criterion_key ? `К критерию ${it.criterion_key} →` : 'Открыть карточку →'),
      it.appeal_id && p.mode === 'reviewer'
        ? h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm', onclick: () => emit(root, 'cqa:navigate', { to: `#/appeals?id=${it.appeal_id}` }) }, `Апелляция №${it.appeal_id}`) : null));
  }

  root.append(
    h('div', { class: 'cqa-pagehead' },
      h('div', null, h('h1', { class: 'cqa-h1' }, 'Требует проверки'),
        h('div', { class: 'cqa-pagehead__sub' }, `Группа ${group()}: где модели не хватило данных, сработали проверки или есть открытые апелляции. Важное сверху.`)),
      h('div', { class: 'cqa-pagehead__actions' }, h('button', { type: 'button', class: 'cqa-btn', onclick: () => load({ quiet: true }) }, '↻ Обновить'))),
    h('div', { class: 'cqa-panel' }, body));
  const onRefresh = () => load({ quiet: true });
  el.addEventListener('cqa:refresh', onRefresh);
  load();

  return {
    update(np) { const g = np.group !== p.group; p = { ...p, ...np }; if (g) load(); },
    unmount() { token++; el.removeEventListener('cqa:refresh', onRefresh); root.remove(); },
  };
}
