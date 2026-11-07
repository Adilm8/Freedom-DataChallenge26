// Очередь апелляций и решение проверяющего (FR-APL-02…06). Маршрут #/appeals?status=open&id=<appealId>.
// Слева — список апелляций группы с фильтром по статусу, справа — карточка апелляции: спорная оценка, обоснование AI,
// комментарий аналитика, фрагмент диалога (доказательства ± 2 реплики, цитаты подсвечены) и форма решения.
// Решение (режим «Проверяющий»): подтвердить оценку AI или изменить ответ из разрешённых; причина обязательна.
// Итог пересчитывает бэкенд (scoring.py); AI-оценка не меняется — после решения видно «AI → финальный».
// Параметры: group, mode ('analyst' | 'reviewer'), status, id. Наружу: cqa:navigate, cqa:location, cqa:mode, cqa:counts-changed.
import { h, clear, emit, answerBadge, score, fmtScore, fmtDate, channelBadge, langChip, ROLE, EVENT_LABEL, skeletonRows, errorState, emptyState } from '../ui.js';
import { listAppeals, decideAppeal } from '../api.js';
import { findQuote } from './transcript-view.js';

const STATUS = {
  open: ['Открыта', 'warn'], confirmed: ['Подтверждена', 'yes'], changed: ['Ответ изменён', 'accent'],
};
const FILTERS = [['open', 'Открытые'], ['closed', 'Рассмотренные'], ['changed', 'Изменённые'], ['confirmed', 'Подтверждённые'], ['all', 'Все']];
const CONF = { high: 'высокая', medium: 'средняя', low: 'низкая' };
const matches = (a, f) => f === 'all' || (f === 'closed' ? a.status !== 'open' : a.status === f);
const pts = (c, v) => (c.type === 'flag' || v == null ? null : h('span', { class: 'cqa-faint cqa-apr__pts' }, `${+Number(v).toFixed(2)} из ${c.weight}`));
const delta = (a, b) => { const d = b - a; return `${d > 0 ? '+' : ''}${d.toFixed(2)}`; };

/** Пояснение к варианту ответа в форме решения (бейдж уже называет ответ): описание ступени шкалы, смысл N/A. */
function answerLabel(c, v) {
  if (v === 'na') return 'критерий неприменим: вес перераспределится на остальные';
  if (c.type !== 'scale') return '';
  return (c.scale || []).find((s) => Number(s.value) === Number(v))?.label || '';
}

/** Текст реплики с подсвеченными цитатами-доказательствами. */
function markedText(text, quotes) {
  const ranges = (quotes || []).map((q) => findQuote(text, q)).filter(Boolean).sort((a, b) => a[0] - b[0]);
  const out = [];
  let pos = 0;
  for (const [s, e] of ranges) {
    if (s < pos) continue;
    out.push(text.slice(pos, s), h('mark', { class: 'cqa-mark' }, text.slice(s, e)));
    pos = e;
  }
  out.push(text.slice(pos));
  return out;
}

export function mount(el, params = {}) {
  let p = { ...params };
  const reviewer = p.mode === 'reviewer';
  const st = {
    filter: FILTERS.some(([f]) => f === p.status) ? p.status : 'open',
    scope: 'group', rows: null, selected: p.id ? Number(p.id) : null,
    form: { action: 'change', answer: null, reason: '' }, busy: false, error: null, result: null,
  };
  const root = h('div', { class: 'cqa-page cqa-apr' });
  el.append(root);
  const listEl = h('div', { class: 'cqa-apr__list', role: 'list', 'aria-label': 'Апелляции' });
  const detailEl = h('div', { class: 'cqa-apr__detail', id: 'cqa-apr-detail', tabindex: -1 });
  const toolbarEl = h('div', { class: 'cqa-toolbar cqa-apr__toolbar' });
  let token = 0;

  const group = () => p.group || 'DEV';
  const visible = () => (st.rows || []).filter((a) => matches(a, st.filter));
  const current = () => (st.rows || []).find((a) => a.id === st.selected) || null;
  const syncUrl = () => emit(root, 'cqa:location', { to: `#/appeals?status=${st.filter}${st.selected ? `&id=${st.selected}` : ''}` });

  async function load({ quiet = false } = {}) {
    const my = ++token;
    if (!quiet) { clear(listEl).append(skeletonRows(6)); clear(detailEl); }
    try {
      const rows = await listAppeals(st.scope === 'group' ? { group_id: group() } : {});
      if (my !== token) return;
      st.rows = rows;
      // Апелляция из адреса не попадает в фильтр — показываем все, чтобы её было видно.
      if (st.selected && !visible().some((a) => a.id === st.selected) && rows.some((a) => a.id === st.selected)) st.filter = 'all';
      if (!st.selected || !rows.some((a) => a.id === st.selected)) st.selected = visible()[0]?.id ?? null;
      renderAll();
    } catch (e) {
      if (my !== token) return;
      clear(listEl).append(errorState(e, () => load()));
      clear(detailEl);
    }
  }

  function renderAll() {
    renderToolbar();
    renderList();
    renderDetail();
  }

  function renderToolbar() {
    const rows = st.rows || [];
    clear(toolbarEl).append(
      h('div', { class: 'cqa-seg cqa-apr__filters', role: 'group', 'aria-label': 'Статус апелляции' },
        FILTERS.map(([f, label]) => {
          const n = rows.filter((a) => matches(a, f)).length;
          return h('button', { type: 'button', class: 'cqa-seg__btn', 'aria-pressed': String(st.filter === f), dataset: { filter: f },
            onclick: () => { st.filter = f; st.result = null; if (!visible().some((a) => a.id === st.selected)) st.selected = visible()[0]?.id ?? null; syncUrl(); renderAll(); } },
          label, h('span', { class: 'cqa-apr__n' }, String(n)));
        })),
      h('span', { class: 'cqa-toolbar__spacer' }),
      h('label', { class: 'cqa-toggle', title: 'Показать апелляции всех групп, а не только текущей' },
        h('input', { type: 'checkbox', checked: st.scope === 'all', onchange: (e) => { st.scope = e.target.checked ? 'all' : 'group'; load(); } }), 'Все группы'),
      h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm cqa-btn--ghost', onclick: () => load({ quiet: true }) }, '↻ Обновить'));
  }

  function renderList() {
    clear(listEl);
    const list = visible();
    if (!st.rows?.length) {
      listEl.append(emptyState({ icon: '⚖', title: 'Апелляций пока нет',
        text: 'Аналитик оспаривает оценку критерия в карточке диалога кнопкой «Оспорить» — апелляция появится здесь.',
        actionLabel: 'К списку диалогов', onAction: () => emit(root, 'cqa:navigate', { to: '#/conversations' }) }));
      return;
    }
    if (!list.length) {
      listEl.append(emptyState({ icon: '✓', title: st.filter === 'open' ? 'Открытых апелляций нет' : 'Ничего не найдено',
        text: st.filter === 'open' ? 'Все апелляции рассмотрены.' : 'Выберите другой статус.', actionLabel: 'Показать все',
        onAction: () => { st.filter = 'all'; st.selected = visible()[0]?.id ?? null; syncUrl(); renderAll(); } }));
      return;
    }
    for (const a of list) {
      const c = a.criterion || { key: a.criterion_key, title: a.criterion_key, type: 'binary' };
      const [stText, tone] = STATUS[a.status] || [a.status, 'muted'];
      listEl.append(h('button', { type: 'button', class: 'cqa-apr__item', role: 'listitem', 'aria-current': a.id === st.selected ? 'true' : null, dataset: { id: a.id },
        onclick: () => select(a.id) },
        h('div', { class: 'cqa-apr__itop' },
          h('span', { class: 'cqa-row-id' }, a.conversation.conversation_id),
          h('span', { class: 'cqa-code' }, c.key),
          h('span', { class: `cqa-badge cqa-badge--${tone}` }, stText)),
        h('div', { class: 'cqa-apr__ititle' }, c.title),
        h('div', { class: 'cqa-apr__icomment' }, a.comment),
        h('div', { class: 'cqa-apr__ians' },
          h('span', { class: 'cqa-faint' }, 'AI'), answerBadge(c, a.ai_answer_snapshot ?? c.ai_answer),
          a.status === 'changed' ? [h('span', { class: 'cqa-faint' }, '→'), answerBadge(c, a.decision_answer)] : null,
          h('span', { class: 'cqa-faint cqa-apr__idate' }, `№${a.id} · ${fmtDate(a.decided_at || a.created_at)}`))));
    }
  }

  function select(id) {
    if (st.selected !== id) { st.selected = id; st.form = { action: 'change', answer: null, reason: '' }; st.error = null; st.result = null; }
    syncUrl();
    listEl.querySelectorAll('.cqa-apr__item').forEach((b) => (Number(b.dataset.id) === id ? b.setAttribute('aria-current', 'true') : b.removeAttribute('aria-current')));
    renderDetail();
    // На узком экране карточка ниже списка: переводим к ней.
    if (window.matchMedia('(max-width: 900px)').matches) detailEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    detailEl.focus({ preventScroll: true });
  }

  function renderDetail() {
    clear(detailEl);
    const a = current();
    if (!a) {
      if (st.rows?.length) detailEl.append(h('div', { class: 'cqa-panel' }, emptyState({ icon: '←', title: 'Выберите апелляцию', text: 'Слева — очередь; здесь появятся спорная оценка, фрагмент диалога и решение.' })));
      return;
    }
    const c = a.criterion;
    const conv = a.conversation;
    const cardUrl = `#/conversation/${conv.id}?eval=${a.evaluation_id}&focus=${encodeURIComponent(a.criterion_key)}`;
    const [stText, tone] = STATUS[a.status] || [a.status, 'muted'];
    detailEl.append(...[
      st.result ? resultBanner(a) : null,
      h('div', { class: 'cqa-panel cqa-apr__card' },
        h('div', { class: 'cqa-apr__head' },
          h('h2', { class: 'cqa-h2' }, `Апелляция №${a.id}`),
          h('span', { class: `cqa-badge cqa-badge--${tone}`, id: 'cqa-apr-status' }, stText),
          h('span', { class: 'cqa-faint cqa-apr__when' }, `подана ${fmtDate(a.created_at)}${a.decided_at ? ` · решение ${fmtDate(a.decided_at)}` : ''}`),
          h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm cqa-apr__open', onclick: () => emit(root, 'cqa:navigate', { to: cardUrl }) }, 'Открыть в карточке →'),
          a.status === 'open' && reviewer ? h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm cqa-btn--primary', id: 'cqa-apr-to-decision',
            onclick: () => { const f = detailEl.querySelector('#cqa-apr-decision'); f?.scrollIntoView({ behavior: 'smooth', block: 'start' }); f?.querySelector('button, input, textarea')?.focus({ preventScroll: true }); } }, 'К решению ↓') : null),
        h('div', { class: 'cqa-apr__meta' },
          h('span', { class: 'cqa-row-id' }, conv.conversation_id), channelBadge(conv.channel), langChip(conv.language),
          h('span', { class: 'cqa-faint' }, `оценка #${a.evaluation.id} · ${a.evaluation.model || '—'}`),
          h('span', { class: 'cqa-apr__totals' }, h('span', { class: 'cqa-faint' }, 'Итог AI'), score(a.evaluation.ai_total),
            h('span', { class: 'cqa-faint' }, '· финальный'), score(a.evaluation.final_total))),
        c ? disputed(a, c) : h('div', { class: 'cqa-banner cqa-banner--warn' }, h('span', { class: 'cqa-banner__icon' }, '!'), h('div', null, 'Критерия нет в версии чек-листа этой оценки.')),
        h('section', { class: 'cqa-apr__sec' },
          h('h3', { class: 'cqa-h3' }, 'Комментарий аналитика'),
          h('blockquote', { class: 'cqa-apr__comment' }, a.comment)),
        fragmentSec(a),
        h('section', { class: 'cqa-apr__sec cqa-apr__decision', id: 'cqa-apr-decision' },
          h('h3', { class: 'cqa-h3' }, 'Решение'),
          a.status !== 'open' ? decided(a, c) : reviewer && c ? decisionForm(a, c) : analystNote()))].filter(Boolean));
  }

  function disputed(a, c) {
    const evs = c.evidence || [];
    return h('section', { class: 'cqa-apr__sec' },
      h('h3', { class: 'cqa-h3' }, 'Спорная оценка'),
      h('div', { class: 'cqa-apr__crit' },
        h('span', { class: 'cqa-code' }, c.key), h('b', { class: 'cqa-apr__ctitle' }, c.title),
        h('span', { class: 'cqa-faint' }, c.type === 'flag' ? 'флаг, без баллов' : `вес ${c.weight}`)),
      h('div', { class: 'cqa-apr__answers' },
        h('span', { class: 'cqa-faint' }, 'Ответ AI'), answerBadge(c, c.ai_answer), pts(c, c.ai_points),
        c.overridden ? [h('span', { class: 'cqa-faint' }, '· сейчас финальный'), answerBadge(c, c.final_answer), pts(c, c.final_points)] : null,
        c.confidence ? h('span', { class: `cqa-badge ${c.confidence === 'low' ? 'cqa-badge--warn' : 'cqa-badge--muted'}` }, `уверенность: ${CONF[c.confidence] || c.confidence}`) : null),
      c.reasoning ? h('div', { class: 'cqa-apr__why' }, h('b', null, 'Обоснование AI: '), c.reasoning) : null,
      c.na_reason ? h('div', { class: 'cqa-nareason' }, h('b', null, 'Почему N/A: '), c.na_reason) : null,
      evs.length ? h('div', { class: 'cqa-ev' }, evs.map((e) => h('div', { class: `cqa-ev__row ${e.quote_ok === false ? 'cqa-ev__row--bad' : ''}` },
        h('button', { type: 'button', class: 'cqa-chip', title: 'Показать во фрагменте', onclick: () => flash(e.msg_id) }, e.msg_id),
        e.quote_ok === false ? h('span', { class: 'cqa-badge cqa-badge--warn' }, 'цитата не найдена') : null,
        h('span', { class: 'cqa-ev__quote' }, e.quote || '—')))) : null,
      (c.issues || []).length ? h('div', { class: 'cqa-warnbox' }, h('b', null, 'Предупреждения проверки'), h('ul', null, c.issues.map((i) => h('li', null, i)))) : null,
      c.advice ? h('div', { class: 'cqa-advice' }, h('b', null, 'Рекомендация оператору'), c.advice) : null);
  }

  function fragmentSec(a) {
    const frag = a.fragment || [];
    const hasEv = frag.some((m) => m.is_evidence);
    return h('section', { class: 'cqa-apr__sec' },
      h('div', { class: 'cqa-apr__sechead' }, h('h3', { class: 'cqa-h3' }, 'Фрагмент диалога'),
        h('span', { class: 'cqa-faint' }, frag.length ? (hasEv ? 'реплики-доказательства и по 2 соседних' : 'проверенный участок') : '')),
      frag.length
        ? h('div', { class: 'cqa-tr cqa-apr__frag' }, frag.map((m) => [
          m.gap_before ? h('div', { class: 'cqa-apr__gap', 'aria-label': 'пропущены реплики' }, '⋯') : null,
          h('div', { class: `cqa-msg cqa-msg--${m.speaker} ${m.is_evidence ? 'cqa-msg--hl' : ''} ${m.internal ? 'cqa-msg--internal' : ''}`, id: `apr-${m.msg_id}` },
            h('div', { class: 'cqa-msg__meta' },
              h('span', { class: 'cqa-msg__role' }, ROLE[m.speaker] || m.speaker),
              m.event ? h('span', { class: 'cqa-badge cqa-badge--muted' }, EVENT_LABEL[m.event] || m.event) : null,
              h('span', { class: 'cqa-msg__time' }, String(m.timestamp || '').includes('T') ? m.timestamp.slice(11, 19) : m.timestamp),
              h('span', { class: 'cqa-msg__id' }, m.msg_id),
              m.is_evidence ? h('span', { class: 'cqa-msg__tags' }, h('span', { class: 'cqa-msg__tag' }, a.criterion_key)) : null),
            h('div', { class: 'cqa-msg__text' }, markedText(m.text || '', m.quotes)))])
        )
        : h('div', { class: 'cqa-faint cqa-apr__nofrag' }, 'Модель не привела доказательств и проверенного участка — откройте полный транскрипт в карточке.'));
  }

  function flash(msgId) {
    const n = detailEl.querySelector(`#apr-${CSS.escape(msgId)}`);
    if (!n) return;
    n.scrollIntoView({ behavior: 'smooth', block: 'center' });
    n.classList.remove('cqa-msg--pulse'); void n.offsetWidth; n.classList.add('cqa-msg--pulse');
  }

  function analystNote() {
    return h('div', { class: 'cqa-banner cqa-banner--info' }, h('span', { class: 'cqa-banner__icon' }, 'i'),
      h('div', null, h('div', { class: 'cqa-banner__title' }, 'Ждёт решения проверяющего'),
        'Решение принимает проверяющий: подтвердить оценку AI или изменить ответ с причиной.',
        h('div', null, h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm', style: 'margin-top:8px', id: 'cqa-apr-to-reviewer',
          onclick: () => emit(root, 'cqa:mode', { mode: 'reviewer' }) }, 'Перейти в режим «Проверяющий»'))));
  }

  function decided(a, c) {
    const changed = a.status === 'changed';
    return h('div', { class: `cqa-apr__verdict cqa-apr__verdict--${a.status}` },
      h('div', { class: 'cqa-apr__answers' },
        h('span', { class: 'cqa-faint' }, 'AI'), c ? answerBadge(c, a.ai_answer_snapshot) : String(a.ai_answer_snapshot),
        h('span', { class: 'cqa-faint' }, '→'),
        h('b', null, changed ? 'проверяющий изменил на' : 'проверяющий подтвердил'),
        changed && c ? answerBadge(c, a.decision_answer) : null),
      h('div', null, h('b', null, 'Причина: '), a.decision_reason || '—'),
      h('div', { class: 'cqa-faint' }, `Решение от ${fmtDate(a.decided_at)}. Итог диалога сейчас: AI ${fmtScore(a.evaluation.ai_total)} · финальный ${fmtScore(a.evaluation.final_total)}.`));
  }

  function decisionForm(a, c) {
    const f = st.form;
    const cur = c.final_answer;
    const options = (c.allowed_answers || []).filter((v) => String(v) !== String(cur));
    if (f.answer != null && !options.some((v) => String(v) === String(f.answer))) f.answer = null;
    const errFor = (path) => (st.error?.errors || []).find((e) => e.path === path)?.message;
    const reason = h('textarea', { class: 'cqa-input cqa-textarea', id: 'cqa-apr-reason', rows: 3, maxlength: 4000, 'aria-invalid': errFor('reason') ? 'true' : null,
      placeholder: f.action === 'change' ? 'Почему ответ другой: какая реплика или правило чек-листа это подтверждает' : 'Почему оценка AI верна',
      oninput: (e) => { f.reason = e.target.value; } });
    reason.value = f.reason;
    const submit = h('button', { type: 'submit', class: 'cqa-btn cqa-btn--primary', id: 'cqa-apr-submit', disabled: st.busy },
      st.busy ? 'Сохраняем…' : f.action === 'change' ? 'Изменить ответ' : 'Подтвердить оценку AI');
    const general = st.error && !['reason', 'answer'].some((x) => errFor(x)) ? st.error.detail || st.error.message : null;
    return h('form', { class: 'cqa-apr__form', onsubmit: (e) => { e.preventDefault(); decide(a, c); } },
      h('div', { class: 'cqa-seg cqa-seg--wide', role: 'radiogroup', 'aria-label': 'Решение' },
        [['change', 'Изменить ответ'], ['confirm', 'Подтвердить оценку AI']].map(([v, t]) =>
          h('button', { type: 'button', class: 'cqa-seg__btn', role: 'radio', 'aria-checked': String(f.action === v), 'aria-pressed': String(f.action === v), dataset: { action: v },
            onclick: () => { f.action = v; st.error = null; renderDetail(); } }, t))),
      f.action === 'change'
        ? h('fieldset', { class: 'cqa-apr__opts' }, h('legend', { class: 'cqa-field__label' }, 'Новый ответ'),
          h('div', { class: 'cqa-apr__current' }, h('span', { class: 'cqa-faint' }, 'Сейчас:'), answerBadge(c, cur), h('span', { class: 'cqa-faint' }, answerLabel(c, cur))),
          options.map((v) => h('label', { class: `cqa-apr__opt ${String(f.answer) === String(v) ? 'cqa-apr__opt--on' : ''}` },
            h('input', { type: 'radio', name: 'cqa-apr-answer', value: String(v), checked: String(f.answer) === String(v),
              onchange: () => { f.answer = v; st.error = null; renderDetail(); } }),
            answerBadge(c, v), h('span', { class: 'cqa-apr__optlabel' }, answerLabel(c, v)))),
          errFor('answer') ? h('div', { class: 'cqa-fielderr' }, errFor('answer')) : null)
        : h('div', { class: 'cqa-faint' }, 'Ответ останется прежним: ', answerBadge(c, cur), '. Апелляция закроется со статусом «подтверждена».'),
      h('label', { class: 'cqa-field' }, h('span', { class: 'cqa-field__label' }, 'Причина решения · обязательно'), reason,
        errFor('reason') ? h('div', { class: 'cqa-fielderr' }, errFor('reason')) : null),
      general ? h('div', { class: 'cqa-banner cqa-banner--flag', role: 'alert' }, h('span', { class: 'cqa-banner__icon' }, '!'), h('div', null, general)) : null,
      h('div', { class: 'cqa-apr__formfoot' },
        h('span', { class: 'cqa-faint' }, 'Итог пересчитает код по чек-листу; оценка AI сохранится без изменений.'),
        submit));
  }

  async function decide(a, c) {
    const f = st.form;
    const local = [];
    if (f.action === 'change' && f.answer == null) local.push({ path: 'answer', message: 'Выберите новый ответ.' });
    if (!f.reason.trim()) local.push({ path: 'reason', message: 'Укажите причину: без неё решение не сохраняется.' });
    if (local.length) {
      st.error = { errors: local };
      renderDetail();
      detailEl.querySelector(local[0].path === 'reason' ? '#cqa-apr-reason' : '.cqa-apr__opt input')?.focus();
      return;
    }
    st.busy = true; st.error = null; renderDetail();
    const before = { ai: a.evaluation.ai_total, final: a.evaluation.final_total };
    try {
      const body = { action: f.action, reason: f.reason.trim() };
      if (f.action === 'change') body.answer = f.answer;
      const res = await decideAppeal(a.id, body);
      st.result = { id: a.id, before, ai: res.evaluation.ai_score?.total, final: res.evaluation.final_score?.total, appeal: res.appeal, criterion: c };
      st.form = { action: 'change', answer: null, reason: '' };
      emit(root, 'cqa:counts-changed', {});
      await load({ quiet: true });
      detailEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } catch (e) {
      st.error = e;
      if (e.status === 409) await load({ quiet: true });
    } finally {
      st.busy = false;
      renderDetail();
    }
  }

  function resultBanner(a) {
    const r = st.result;
    if (!r || r.id !== a.id) return null;
    const changed = r.appeal.status === 'changed';
    const next = (st.rows || []).find((x) => x.status === 'open' && x.id !== a.id);
    return h('div', { class: 'cqa-panel cqa-apr__result', id: 'cqa-apr-result', role: 'status' },
      h('div', { class: 'cqa-apr__restitle' }, h('span', { class: 'cqa-banner__icon' }, '✓'),
        changed ? ['Ответ изменён: ', answerBadge(r.criterion, r.appeal.ai_answer_snapshot), ' → ', answerBadge(r.criterion, r.appeal.decision_answer)] : 'Оценка AI подтверждена'),
      h('div', { class: 'cqa-apr__resgrid' },
        h('div', { class: 'cqa-apr__resbox' }, h('div', { class: 'cqa-sum__label' }, 'Итог AI · не меняется'), h('div', { class: 'cqa-apr__resnum' }, score(r.ai))),
        h('div', { class: 'cqa-apr__resbox cqa-apr__resbox--final', id: 'cqa-apr-final' }, h('div', { class: 'cqa-sum__label' }, 'Финальный итог'),
          h('div', { class: 'cqa-apr__resnum' },
            r.before.final !== r.final ? [h('span', { class: 'cqa-apr__old' }, fmtScore(r.before.final)), h('span', { class: 'cqa-faint' }, ' → ')] : null,
            score(r.final), r.before.final !== r.final && r.final != null && r.before.final != null ? h('span', { class: 'cqa-delta' }, delta(r.before.final, r.final)) : h('span', { class: 'cqa-faint' }, ' без изменений')))),
      h('div', { class: 'cqa-apr__resacts' },
        h('button', { type: 'button', class: 'cqa-btn cqa-btn--primary', id: 'cqa-apr-card', onclick: () => emit(root, 'cqa:navigate', { to: `#/conversation/${a.conversation.id}?eval=${a.evaluation_id}&focus=${encodeURIComponent(a.criterion_key)}` }) }, 'Открыть карточку диалога'),
        next ? h('button', { type: 'button', class: 'cqa-btn', onclick: () => { st.result = null; if (st.filter !== 'all' && !matches(next, st.filter)) st.filter = 'open'; renderToolbar(); renderList(); select(next.id); } }, 'Следующая открытая →') : null));
  }

  root.append(...[
    h('div', { class: 'cqa-pagehead' },
      h('div', null, h('h1', { class: 'cqa-h1' }, 'Апелляции'),
        h('div', { class: 'cqa-pagehead__sub' }, `Группа ${group()}: спорные оценки AI, комментарий аналитика, фрагмент диалога и решение проверяющего`)),
      h('div', { class: 'cqa-pagehead__actions' },
        h('span', { class: `cqa-badge ${reviewer ? 'cqa-badge--accent' : 'cqa-badge--muted'}` }, reviewer ? 'Режим: проверяющий' : 'Режим: аналитик'))),
    reviewer ? null : h('div', { class: 'cqa-banner cqa-banner--info cqa-apr__modenote' }, h('span', { class: 'cqa-banner__icon' }, 'i'),
      h('div', null, 'Вы в режиме аналитика: здесь видно, что с вашими апелляциями. Решения принимает проверяющий — переключатель режима в шапке.')),
    h('div', { class: 'cqa-panel cqa-apr__panel' }, toolbarEl, h('div', { class: 'cqa-apr__cols' }, listEl, detailEl))].filter(Boolean));
  load();

  return {
    update(np) { const g = np.group !== p.group; p = { ...p, ...np }; if (g) load(); },
    unmount() { token++; root.remove(); },
  };
}
