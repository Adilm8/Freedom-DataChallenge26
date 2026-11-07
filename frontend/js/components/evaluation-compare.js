// Сравнение двух оценок одного диалога (FR-EVAL-20, FR-CARD-06): что изменилось между прогонами и откуда разница.
// A — «с чем сравниваем», B — «что сравниваем»: стрелки и разница читаются A → B (по умолчанию A — прошлая, B — последняя).
// Та же конфигурация (модель, стратегия, промпт, чек-лист) и другие ответы — нестабильность модели (NFR-14);
// другая конфигурация — эффект изменения. Ответы, взятые из прошлой оценки без вызова, подписаны: их совпадение ничего не доказывает.
// Параметры: conversation (id диалога; годится и id), a, b (id оценок). Без b — последняя неупавшая оценка диалога,
// без a — предыдущая для B (GET /evaluations/{b}/compare без other). Без диалога он берётся из оценки a или b.
// Наружу: cqa:navigate {to}, cqa:location {to} (адрес без перехода), cqa:run-request {ids, preset, ...} — оценить повторно
// с конфигурацией B. Внутрь: cqa:refresh на el — после прогона: B — новая последняя оценка, A — предыдущая.
import { h, clear, emit, answerBadge, score, fmtScore, fmtMoney, fmtDate, channelBadge, langChip, skeletonRows, errorState, emptyState } from '../ui.js';
import { getConversation, getEvaluation, compareEvaluations } from '../api.js';
import { STRATEGY_LABEL } from './result-panel.js';
import { plural } from './viz.js';

const CONF = { high: 'высокая', medium: 'средняя', low: 'низкая' };
const FIELD = { model: 'модель', strategy: 'стратегия', prompt_version: 'версия промпта', checklist_version_id: 'версия чек-листа' };
const STATUS = { same: ['совпало', 'muted'], changed: ['изменилось', 'warn'], added: ['только в B', 'accent'], removed: ['только в A', 'accent'] };
const ofCrit = (n) => `${n} ${plural(n, 'критерия', 'критериев', 'критериев')}`; // «из 8 критериев», «из 1 критерия»
const num = (v) => String(+Number(v).toFixed(2));
const signed = (v) => (v == null ? '—' : v > 0 ? `+${num(v)}` : v < 0 ? `−${num(-v)}` : '0');

function delta(v, cls = '') {
  if (v == null) return null;
  const dir = v > 0 ? 'up' : v < 0 ? 'down' : 'zero';
  return h('span', { class: `cqa-cmp-delta cqa-cmp-delta--${dir} ${cls}` }, signed(v));
}
const tag = (x) => h('span', { class: `cqa-cmp-tag cqa-cmp-tag--${x}`, 'aria-hidden': 'true' }, x.toUpperCase());

function conf(level) {
  if (!level) return null;
  return h('span', { class: `cqa-conf cqa-conf--${level}` },
    h('span', { class: 'cqa-conf__dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), `уверенность ${CONF[level] || level}`);
}

/** Бейдж ответа стороны: тип критерия и шкала — из полной оценки этой стороны. */
function ans(full, s) {
  if (!s) return h('span', { class: 'cqa-badge cqa-badge--muted' }, 'нет в оценке');
  if (s.answer == null) return h('span', { class: 'cqa-badge cqa-badge--muted' }, 'нет ответа');
  return answerBadge(full || (typeof s.answer === 'number' ? { type: 'scale', scale_max: null, weight: '—' } : { type: 'binary' }), s.answer);
}

export function mount(el, params = {}) {
  let p = { ...params };
  const root = h('div', { class: 'cqa-page cqa-cmp' });
  el.append(root);
  let token = 0;
  let data = null; // {conv, list, cmp, A, B, evA, evB, rows}
  let onlyChanged = null; // null — по умолчанию: включено, если хоть что-то изменилось
  const open = new Set();
  let openInit = false;

  const go = (to) => emit(root, 'cqa:navigate', { to });
  const cardHref = (conv, evId, key) => {
    const q = new URLSearchParams();
    if (evId && evId !== conv.evaluations?.[0]?.id) q.set('eval', evId);
    if (key) q.set('focus', key);
    const qs = q.toString();
    return `#/conversation/${conv.id}${qs ? `?${qs}` : ''}`;
  };

  async function load() {
    const my = ++token;
    if (data) root.classList.add('cqa-cmp--busy');
    else clear(root).append(h('div', { class: 'cqa-panel' }, skeletonRows(10)));
    try {
      let cid = p.conversation || p.id;
      if (!cid && (p.b || p.a)) cid = (await getEvaluation(p.b || p.a)).conversation_id;
      if (my !== token) return;
      if (!cid) { data = null; renderNoDialog(); return; }
      const conv = await getConversation(cid);
      if (my !== token) return;
      const list = conv.evaluations || [];
      if (!list.length) { data = null; renderState(conv, null); return; }
      const ok = (x) => x.status !== 'failed';
      const aId = p.a ? Number(p.a) : null;
      let bId = p.b ? Number(p.b) : null;
      if (!bId) bId = (aId ? list.find((x) => x.id !== aId && ok(x)) : list.find(ok) || list[0])?.id ?? null;
      // API: a — оценка B (что сравниваем), b — оценка A (с чем); без other — предыдущая неупавшая.
      const cmp = await compareEvaluations(bId ?? aId, bId && aId ? aId : undefined);
      const [evB, evA] = await Promise.all([getEvaluation(cmp.a.id), cmp.b ? getEvaluation(cmp.b.id) : null]);
      if (my !== token) return;
      root.classList.remove('cqa-cmp--busy');
      if (!cmp.b) { data = null; renderState(conv, cmp.a); return; }
      const fresh = !data || data.A.id !== cmp.b.id || data.B.id !== cmp.a.id;
      data = { conv, list, cmp, A: cmp.b, B: cmp.a, evA, evB, rows: rowsOf(cmp, evA, evB) };
      if (fresh) { onlyChanged = null; open.clear(); openInit = false; }
      p = { ...p, conversation: conv.id, a: data.A.id, b: data.B.id };
      emit(root, 'cqa:location', { to: `#/compare?conversation=${conv.id}&a=${data.A.id}&b=${data.B.id}` });
      render();
    } catch (err) {
      if (my !== token) return;
      root.classList.remove('cqa-cmp--busy');
      data = null;
      clear(root).append(h('div', { class: 'cqa-panel' }, errorState(err, load)));
    }
  }

  // Строки сравнения со стороны экрана: a — оценка A, b — оценка B, delta — баллы B − A; полные критерии — для бейджей и цитат.
  function rowsOf(cmp, evA, evB) {
    const fa = new Map((evA?.criteria || []).map((c) => [c.key, c]));
    const fb = new Map((evB?.criteria || []).map((c) => [c.key, c]));
    return cmp.criteria.map((r) => ({ key: r.key, title: r.title, status: r.status, a: r.b, b: r.a, delta: r.points_delta,
      fullA: fa.get(r.key) || null, fullB: fb.get(r.key) || null }));
  }

  function runRequest(conv, s) {
    emit(root, 'cqa:run-request', { ids: [conv.id], group: conv.group_id, label: conv.conversation_id, channel: conv.channel, lockScope: true,
      preset: s ? { provider: s.provider, model: s.model, strategy: s.strategy, reuse: 'none' } : null,
      title: s ? `Оценить повторно ${conv.conversation_id}` : `Оценить ${conv.conversation_id}`,
      intro: s ? `Конфигурация оценки #${s.id}, все критерии заново. Новая оценка встанет в B, оценка #${s.id} — в A.` : undefined });
  }

  // ---------- Шапка: диалог, выбор A и B ----------
  function head(conv, pair) {
    const last = pair?.B || null;
    return h('div', { class: 'cqa-panel cqa-cmp__head' },
      h('div', { class: 'cqa-cmp__titlerow' },
        h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm', onclick: () => go(cardHref(conv, last?.id)) }, '← К карточке'),
        h('h1', { class: 'cqa-h2 cqa-cmp__title' }, 'Сравнение оценок'),
        h('span', { class: 'cqa-cmp__cid' }, conv.conversation_id), channelBadge(conv.channel), langChip(conv.language),
        last ? h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm cqa-cmp__rerun', id: 'cqa-cmp-run', // без пары кнопка — в пустом состоянии
          title: 'Оценить ещё раз той же конфигурацией, что у оценки B', onclick: () => runRequest(conv, last) }, '↻ Оценить повторно') : null),
      pair ? pickers(pair) : null);
  }

  function pickers({ list, A, B }) {
    const sel = (side, cur) => h('select', { class: 'cqa-select', id: `cqa-cmp-${side}`, 'aria-label': `Оценка ${side.toUpperCase()}`,
      onchange: (e) => pick(side, Number(e.target.value)) },
    list.map((x, i) => h('option', { value: x.id, selected: x.id === cur, disabled: x.status === 'failed' && x.id !== cur },
      `#${x.id} · ${fmtDate(x.created_at)} · ${x.model || '—'} · ${x.status === 'failed' ? 'не выполнена' : fmtScore(x.ai_total)}${i === 0 ? ' · последняя' : ''}`)));
    return h('div', { class: 'cqa-cmp__pick' },
      h('label', { class: 'cqa-cmp__side' }, h('span', { class: 'cqa-cmp__sidelabel' }, tag('a'), 'Оценка A'), sel('a', A.id)),
      h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm cqa-cmp__swap', id: 'cqa-cmp-swap', title: 'Поменять A и B местами', 'aria-label': 'Поменять A и B местами',
        onclick: () => { p = { ...p, a: p.b, b: p.a }; load(); } }, '⇄'),
      h('label', { class: 'cqa-cmp__side' }, h('span', { class: 'cqa-cmp__sidelabel' }, tag('b'), 'Оценка B'), sel('b', B.id)));
  }

  function pick(side, id) {
    const other = side === 'a' ? p.b : p.a;
    p = Number(other) === id ? { ...p, a: p.b, b: p.a } : { ...p, [side]: id }; // та же оценка с другой стороны — меняем местами
    load();
  }

  // ---------- Вывод: откуда разница ----------
  function verdict() {
    const { A, B, cmp, rows } = data;
    const m = cmp.common, n = cmp.changed;
    const only = rows.filter((r) => r.status === 'added' || r.status === 'removed').length;
    // Ответ «родом» из одного вызова у обеих сторон (переиспользован без нового вызова) совпадает сам с собой: это не проверка стабильности.
    const origin = (s, ev) => s?.reused_from_evaluation_id || ev.id;
    const reused = rows.filter((r) => r.a && r.b && origin(r.a, A) === origin(r.b, B)).length;
    const allReused = cmp.same_config && m > 0 && reused === m;
    let tone, icon, title, text;
    if (cmp.same_config) {
      tone = allReused ? 'info' : n ? 'warn' : 'ok';
      icon = n ? '≠' : '=';
      title = n ? 'Та же конфигурация — расхождение показывает стабильность модели' : 'Та же конфигурация — ответы совпали';
      text = allReused
        ? `Изменилось 0 из ${ofCrit(m)}, но у обеих оценок ответы из одних и тех же вызовов модели — это не проверка стабильности. Оцените повторно: ответы пересчитаются заново.`
        : `Изменилось ${n} из ${ofCrit(m)}${n ? '.' : ': результат воспроизводится.'}`;
    } else {
      tone = 'info';
      icon = 'Δ';
      title = `Изменилось: ${cmp.config_diff.map((f) => FIELD[f] || f).join(', ')}`;
      text = `Изменилось ${n} из ${ofCrit(m)}: разница — эффект этого изменения (и возможной нестабильности модели).`;
    }
    const finals = A.final_total !== A.ai_total || B.final_total !== B.ai_total;
    return h('section', { class: `cqa-panel cqa-cmp-verdict cqa-cmp-verdict--${tone}`, id: 'cqa-cmp-verdict' },
      h('span', { class: 'cqa-cmp-verdict__icon', 'aria-hidden': 'true' }, icon),
      h('div', { class: 'cqa-cmp-verdict__main' },
        h('div', { class: 'cqa-cmp-verdict__title' }, title),
        h('div', { class: 'cqa-cmp-verdict__text' }, text),
        only ? h('div', { class: 'cqa-cmp-verdict__note' }, `Ещё ${only} ${plural(only, 'критерий есть', 'критерия есть', 'критериев есть')} только в одной из оценок: у них разные версии чек-листа.`) : null,
        reused && !allReused ? h('div', { class: 'cqa-cmp-verdict__note' },
          `${reused} из ${ofCrit(m)} совпали, потому что у обеих оценок ответ из одного вызова модели (взят без нового вызова): стабильность они не проверяют.`) : null),
      h('div', { class: 'cqa-cmp-verdict__totals' },
        h('div', { class: 'cqa-cmp-verdict__lbl' }, 'Итог AI'),
        h('div', { class: 'cqa-cmp-verdict__nums', id: 'cqa-cmp-total' },
          tag('a'), score(A.ai_total), h('span', { class: 'cqa-cmp-verdict__arrow', 'aria-hidden': 'true' }, '→'), tag('b'), score(B.ai_total, 'cqa-cmp-verdict__big'),
          delta(cmp.total_delta, 'cqa-cmp-delta--lg')),
        finals ? h('div', { class: 'cqa-cmp-verdict__final' }, `С апелляциями: ${fmtScore(A.final_total)} → ${fmtScore(B.final_total)}`) : null));
  }

  // ---------- Конфигурация рядом ----------
  function configPanel() {
    const { A, B, cmp } = data;
    const diff = new Set(cmp.config_diff);
    const params = (s) => [s.temperature != null ? `temperature ${s.temperature}` : null, s.seed != null ? `seed ${s.seed}` : null].filter(Boolean).join(' · ') || 'не переданы';
    const reuse = (s) => (s.reuse === 'auto' ? 'переиспользуются' : s.reuse === 'none' ? 'нет, всё заново' : s.reuse || '—');
    const status = (s) => (s.status === 'done' ? 'готово' : s.status === 'partial' ? 'неполная' : s.status === 'failed' ? 'не выполнена' : s.status || '—');
    const rows = [
      ['Дата', (s) => fmtDate(s.created_at), null],
      ['Модель', (s) => [h('span', { class: 'cqa-mono' }, s.model || '—'), h('small', { class: 'cqa-cmp-cfg__sub' }, s.provider || '')],
        diff.has('model') || A.provider !== B.provider ? 'strong' : null],
      ['Стратегия', (s) => STRATEGY_LABEL[s.strategy] || s.strategy || '—', diff.has('strategy') ? 'strong' : null],
      ['Версия промпта', (s) => h('span', { class: 'cqa-mono' }, s.prompt_version || '—'), diff.has('prompt_version') ? 'strong' : null],
      ['Версия чек-листа', (s) => `v${s.checklist_version_id}`, diff.has('checklist_version_id') ? 'strong' : null],
      ['temperature · seed', params, params(A) !== params(B) ? 'soft' : null],
      ['Прошлые ответы', reuse, A.reuse !== B.reuse ? 'soft' : null],
      ['Статус', status, A.status !== B.status ? 'soft' : null],
      ['Стоимость', (s) => fmtMoney(s.cost_usd), null],
    ];
    return h('section', { class: 'cqa-panel cqa-cmp-cfg' },
      h('div', { class: 'cqa-panel__head' }, h('h2', { class: 'cqa-h3' }, 'Конфигурация'),
        h('span', { class: 'cqa-cmp__hint' }, cmp.same_config ? 'модель, стратегия, промпт и чек-лист совпадают' : 'отличия подсвечены')),
      h('div', { class: 'cqa-cmp-cfg__grid', role: 'table', 'aria-label': 'Конфигурация оценок A и B' },
        h('div', { class: 'cqa-cmp-cfg__row cqa-cmp-cfg__row--head', role: 'row' },
          h('span', { role: 'columnheader', class: 'cqa-cmp-cfg__label' }, 'Параметр'),
          h('span', { role: 'columnheader', class: 'cqa-cmp-cfg__cell' }, tag('a'), ` #${A.id}`),
          h('span', { role: 'columnheader', class: 'cqa-cmp-cfg__cell' }, tag('b'), ` #${B.id}`)),
        rows.map(([label, val, mark]) => h('div', { class: `cqa-cmp-cfg__row ${mark ? `cqa-cmp-cfg__row--${mark}` : ''}`, role: 'row', dataset: mark ? { diff: mark } : null },
          h('span', { class: 'cqa-cmp-cfg__label', role: 'rowheader' }, label, mark === 'strong' ? h('span', { class: 'cqa-cmp-cfg__mark' }, 'отличается') : null),
          h('span', { class: 'cqa-cmp-cfg__cell', role: 'cell' }, val(A)),
          h('span', { class: 'cqa-cmp-cfg__cell', role: 'cell' }, val(B))))));
  }

  // ---------- Критерии: изменённые первыми ----------
  function criteriaPanel() {
    const { rows } = data;
    const diffRows = rows.filter((r) => r.status !== 'same');
    if (onlyChanged == null) onlyChanged = diffRows.length > 0;
    if (!openInit) { openInit = true; if (diffRows.length <= 3) diffRows.forEach((r) => open.add(r.key)); }
    const shown = onlyChanged ? diffRows : [...diffRows, ...rows.filter((r) => r.status === 'same')];
    const same = rows.length - diffRows.length;
    return h('section', { class: 'cqa-panel cqa-cmp-crit' },
      h('div', { class: 'cqa-panel__head cqa-cmp-crit__head' },
        h('h2', { class: 'cqa-h3' }, 'Критерии'),
        h('span', { class: 'cqa-cmp-crit__counts' },
          h('span', { class: `cqa-badge ${diffRows.length ? 'cqa-badge--warn' : 'cqa-badge--muted'}` }, `изменилось ${diffRows.length}`),
          h('span', { class: 'cqa-badge cqa-badge--muted' }, `совпало ${same}`)),
        h('label', { class: 'cqa-toggle cqa-cmp-crit__only' },
          h('input', { type: 'checkbox', id: 'cqa-cmp-only', checked: onlyChanged, disabled: !diffRows.length,
            onchange: (e) => { onlyChanged = e.target.checked; root.querySelector('.cqa-cmp-crit')?.replaceWith(criteriaPanel()); root.querySelector('#cqa-cmp-only')?.focus(); } }),
          'только изменённые')),
      rows.length
        ? h('div', { class: 'cqa-cmp-list' }, shown.map(rowEl),
          onlyChanged && same ? h('button', { type: 'button', class: 'cqa-linkbtn cqa-cmp-list__more',
            onclick: () => { onlyChanged = false; root.querySelector('.cqa-cmp-crit')?.replaceWith(criteriaPanel()); } },
          `Показать совпавшие: ${same}`) : null)
        : emptyState({ title: 'Ответов по критериям нет', text: 'Одна из оценок не выполнена: сравнивать нечего. Выберите другую оценку.', icon: '∅' }));
  }

  function rowEl(r) {
    const [stText, stTone] = STATUS[r.status] || [r.status, 'muted'];
    const full = r.fullB || r.fullA;
    const flag = full?.type === 'flag';
    const flagged = flag && (r.a?.answer === 'yes' || r.b?.answer === 'yes');
    const d = h('details', { class: `cqa-cmp-row cqa-cmp-row--${r.status}`, id: `cmp-${r.key}`, dataset: { key: r.key, status: r.status }, open: open.has(r.key) },
      h('summary', { class: 'cqa-cmp-row__sum' },
        h('span', { class: 'cqa-cmp-row__top' },
          h('span', { class: `cqa-code ${flagged ? 'cqa-code--flag' : ''}` }, r.key),
          h('span', { class: 'cqa-cmp-row__title' }, r.title),
          h('span', { class: `cqa-badge cqa-badge--${stTone} cqa-cmp-row__st` }, stText)),
        h('span', { class: 'cqa-cmp-row__ans' },
          ans(r.fullA, r.a), h('span', { class: 'cqa-cmp-row__arrow', 'aria-hidden': 'true' }, '→'), ans(r.fullB, r.b),
          !flag && r.delta != null && (r.status !== 'same' || r.delta) ? h('span', { class: 'cqa-cmp-row__pts', title: 'Баллы A → B и разница' },
            `${num(r.a.points ?? 0)} → ${num(r.b.points ?? 0)}`, delta(r.delta)) : null),
        meta(r)),
      h('div', { class: 'cqa-cmp-row__body' }, side('a', r, r.a, r.fullA, data.A, r.b), side('b', r, r.b, r.fullB, data.B, r.a)));
    d.addEventListener('toggle', () => { if (d.open) open.add(r.key); else open.delete(r.key); });
    return d;
  }

  // Под строкой: уверенность A → B, переиспользованные ответы, финальный ответ после апелляции.
  function meta(r) {
    const out = [];
    const ca = r.a?.confidence, cb = r.b?.confidence;
    if (ca || cb) {
      const low = ca === 'low' || cb === 'low';
      out.push(h('span', { class: `cqa-cmp-row__conf ${low ? 'cqa-cmp-row__conf--low' : ''}` },
        'уверенность ', ca && cb && ca !== cb ? `${CONF[ca] || ca} → ${CONF[cb] || cb}` : CONF[ca || cb] || ca || cb));
    }
    for (const [x, s, other] of [['A', r.a, data.B], ['B', r.b, data.A]]) {
      const from = s?.reused_from_evaluation_id;
      if (from) {
        out.push(h('span', { class: 'cqa-cmp-row__reused', title: 'Критерий не менялся: ответ взят из прошлой оценки без нового вызова модели' },
          from === other.id ? `↺ ${x}: ответ взят из ${x === 'A' ? 'B' : 'A'} (#${from}) без нового вызова` : `↺ ${x}: ответ из оценки #${from} без нового вызова`));
      }
      if (s?.overridden && String(s.final_answer) !== String(s.answer)) {
        out.push(h('span', { class: 'cqa-cmp-row__final' }, `${x} после апелляции:`, answerBadge(x === 'A' ? r.fullA || {} : r.fullB || {}, s.final_answer)));
      }
    }
    return out.length ? h('span', { class: 'cqa-cmp-row__meta' }, out) : null;
  }

  // Раскрытая строка: обоснование и доказательства A и B рядом; реплика открывается в карточке на этом критерии.
  function side(x, r, s, full, ev, otherSide) {
    const headEl = h('div', { class: 'cqa-cmp-side__head' }, tag(x), h('b', null, `#${ev.id}`),
      h('span', { class: 'cqa-faint' }, `${fmtDate(ev.created_at)} · ${ev.model || '—'}`));
    if (!s) return h('div', { class: 'cqa-cmp-side cqa-cmp-side--empty' }, headEl, h('div', { class: 'cqa-faint' }, 'В этой оценке такого критерия нет: другая версия чек-листа.'));
    const quotes = new Map((full?.evidence || []).map((e) => [e.msg_id, e]));
    const others = new Set(otherSide?.evidence || []);
    const ids = s.evidence?.length ? s.evidence : (full?.evidence || []).map((e) => e.msg_id);
    const open1 = () => go(cardHref(data.conv, ev.id, r.key));
    return h('div', { class: `cqa-cmp-side cqa-cmp-side--${x}` }, headEl,
      h('div', { class: 'cqa-cmp-side__ans' }, ans(full, s),
        s.overridden && String(s.final_answer) !== String(s.answer) ? [h('span', { class: 'cqa-faint' }, 'финал после апелляции'), answerBadge(full || {}, s.final_answer)] : null,
        conf(s.confidence)),
      h('div', { class: 'cqa-cmp-side__why' }, s.reasoning || h('span', { class: 'cqa-faint' }, 'Обоснования нет.')),
      s.answer === 'na' && full?.na_reason ? h('div', { class: 'cqa-nareason' }, h('b', null, 'Почему N/A: '), full.na_reason) : null,
      ids.length
        ? h('div', { class: 'cqa-ev' }, ids.map((id) => {
          const e = quotes.get(id);
          const uniq = otherSide && !others.has(id);
          return h('div', { class: 'cqa-ev__row' },
            h('button', { type: 'button', class: `cqa-chip cqa-tip ${uniq ? 'cqa-cmp-chip--uniq' : ''}`,
              'data-tip': uniq ? 'Этой реплики нет в доказательствах другой оценки. Открыть в карточке' : 'Открыть в карточке: реплика подсвечена', onclick: open1 }, id),
            e?.quote ? h('span', { class: `cqa-ev__quote ${e.quote_ok === false ? 'cqa-ev__quote--bad' : ''}` }, e.quote) : null);
        }))
        : h('div', { class: 'cqa-faint cqa-ev__none' }, full?.type === 'flag' ? 'Реплик-доказательств нет: нарушений не найдено.' : 'Реплик-доказательств нет.'),
      h('div', { class: 'cqa-cmp-side__foot' },
        h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm cqa-btn--ghost', onclick: open1 }, `Открыть ${x.toUpperCase()} в карточке`)));
  }

  function render() {
    const { conv, list, A, B } = data;
    clear(root).append(head(conv, { list, A, B }), verdict(), configPanel(), criteriaPanel());
  }

  // Сравнивать не с чем: оценок нет или она одна.
  function renderState(conv, only) {
    clear(root).append(head(conv, null), h('div', { class: 'cqa-panel', id: 'cqa-cmp-empty' }, only
      ? emptyState({ title: 'Пока одна оценка — сравнивать не с чем', icon: '⇄',
        text: `Есть только оценка #${only.id} от ${fmtDate(only.created_at)} (${only.model || 'модель не указана'}). Оцените диалог повторно той же конфигурацией: совпавшие ответы покажут, что результат воспроизводится, а расхождения — какие критерии «плавают».`,
        actionLabel: 'Оценить повторно', onAction: () => runRequest(conv, only) })
      : emptyState({ title: 'Диалог ещё не оценён', icon: '☆', text: 'Сравнивать нечего: запустите первую оценку, затем повторную.',
        actionLabel: 'Оценить', onAction: () => runRequest(conv, null) })));
  }

  function renderNoDialog() {
    clear(root).append(h('div', { class: 'cqa-panel' }, emptyState({ title: 'Не выбран диалог', icon: '⇄',
      text: 'Сравнение открывается из карточки диалога: кнопка «Сравнить с прошлой» появляется, когда у диалога две оценки или больше.',
      actionLabel: 'К списку диалогов', onAction: () => go('#/conversations') })));
  }

  // После прогона: B — новая последняя оценка, A — предыдущая.
  const onRefresh = () => { p = { ...p, a: undefined, b: undefined }; load(); };
  el.addEventListener('cqa:refresh', onRefresh);
  load();

  return {
    update(np) {
      const keys = ['conversation', 'id', 'a', 'b'];
      const changed = keys.some((k) => k in np && String(np[k] ?? '') !== String(p[k] ?? ''));
      p = { ...p, ...np };
      if (changed) load();
    },
    unmount() { token++; el.removeEventListener('cqa:refresh', onRefresh); root.remove(); },
  };
}
