// Карточка диалога: шапка, факты и транскрипт слева, результат справа. Связывает дочерние компоненты событиями DOM.
// Параметры: id (суррогатный id диалога), eval (id оценки; без него — последняя), group, mode.
// Наружу: cqa:navigate {to}, cqa:location {to} (сменить адрес без перехода), cqa:run-request {ids, label, channel, preset, ...}.
// Внутрь: cqa:refresh на el — перечитать диалог и показать последнюю оценку (после прогона).
import { h, clear, emit, channelBadge, langChip, score, fmtScore, fmtDate, skeletonRows, errorState } from '../ui.js';
import { getConversation, getEvaluation, listConversations } from '../api.js';
import { mount as mountTranscript } from './transcript-view.js';
import { mount as mountResult } from './result-panel.js';
import { mount as mountFacts } from './facts-panel.js';

export function mount(el, params = {}) {
  let p = { ...params };
  const root = h('div', { class: 'cqa-card' });
  el.append(root);
  let kids = [];
  let token = 0;
  let trEl = null, resEl = null;
  let conv = null, ev = null;

  function evidenceMap(e) {
    return (e?.criteria || [])
      .map((c) => ({ key: c.key, title: c.title, flag: c.type === 'flag' && c.final_answer === 'yes', msg_ids: (c.evidence || []).map((x) => x.msg_id) }))
      .filter((x) => x.msg_ids.length);
  }

  const preset = () => (ev ? { provider: ev.provider, model: ev.model, strategy: ev.strategy, reuse: 'none' } : null);
  function runRequest(extra = {}) {
    emit(root, 'cqa:run-request', { ids: [conv.id], group: conv.group_id, label: conv.conversation_id, channel: conv.channel, lockScope: true,
      preset: preset(), title: ev ? `Оценить повторно ${conv.conversation_id}` : `Оценить ${conv.conversation_id}`, ...extra });
  }

  async function load() {
    const my = ++token;
    kids.forEach((k) => k.unmount());
    kids = [];
    clear(root).append(
      h('div', { class: 'cqa-card__head' }, h('div', { class: 'cqa-skeleton', style: 'height:22px;width:280px' })),
      h('div', { class: 'cqa-card__cols' }, h('div', { class: 'cqa-card__col' }, h('div', { class: 'cqa-panel' }, skeletonRows(8))), h('div', { class: 'cqa-card__col' }, h('div', { class: 'cqa-panel' }, skeletonRows(8)))));
    try {
      const c = await getConversation(p.id);
      const evalId = p.eval || c.evaluations?.[0]?.id;
      const [e, rows] = await Promise.all([
        evalId ? getEvaluation(evalId) : Promise.resolve(null),
        listConversations({ group_id: c.group_id || p.group || 'DEV' }).catch(() => []),
      ]);
      if (my !== token) return;
      conv = c; ev = e;
      render(rows);
    } catch (err) {
      if (my !== token) return;
      clear(root).append(h('div', { class: 'cqa-page' }, h('div', { class: 'cqa-panel' }, errorState(err, load))));
    }
  }

  function evalPicker() {
    const list = conv.evaluations || [];
    if (!ev || list.length < 2) return null;
    const newest = list[0]?.id;
    return h('label', { class: 'cqa-card__evsel' },
      h('span', { class: 'cqa-faint' }, 'Оценка'),
      h('select', { class: 'cqa-select', 'aria-label': 'Какую оценку показать',
        onchange: (e) => { const id = Number(e.target.value); emit(root, 'cqa:navigate', { to: id === newest ? `#/conversation/${conv.id}` : `#/conversation/${conv.id}?eval=${id}` }); } },
      list.map((x, i) => h('option', { value: x.id, selected: x.id === ev.id },
        `#${x.id} · ${x.model || '—'} · ${fmtDate(x.created_at)} · ${fmtScore(x.final_total)}${i === 0 ? ' · последняя' : ''}`))));
  }

  function render(rows) {
    clear(root);
    const idx = rows.findIndex((r) => String(r.id) === String(conv.id));
    const prev = idx > 0 ? rows[idx - 1] : null;
    const next = idx >= 0 && idx < rows.length - 1 ? rows[idx + 1] : null;
    const go = (to) => emit(root, 'cqa:navigate', { to });
    const isCall = conv.channel === 'voice call';
    const duration = Math.round(Math.max(0, ...conv.messages.map((m) => m.t_sec || 0)));
    const newest = conv.evaluations?.[0]?.id;
    const old = ev && newest && ev.id !== newest;

    root.append(h('div', { class: 'cqa-card__head' },
      h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm', onclick: () => go('#/conversations') }, '← К списку'),
      h('span', { class: 'cqa-card__id' }, conv.conversation_id),
      channelBadge(conv.channel), langChip(conv.language),
      ev ? h('span', { class: 'cqa-card__total' }, h('span', { class: 'cqa-faint cqa-h3' }, 'Итог'), score(ev.final_score?.total, 'cqa-text-lg'))
        : h('span', { class: 'cqa-badge cqa-badge--muted' }, 'Не оценён'),
      ev?.ai_score?.critical?.length ? h('span', { class: 'cqa-badge cqa-badge--flag' }, 'Грубая ошибка') : null,
      ev?.needs_review ? h('span', { class: 'cqa-badge cqa-badge--warn' }, 'Требует проверки') : null,
      ev && ev.status !== 'done' ? h('span', { class: 'cqa-badge cqa-badge--no' }, ev.status === 'failed' ? 'Оценка не выполнена' : 'Оценка неполная') : null,
      old ? h('button', { type: 'button', class: 'cqa-badge cqa-badge--warn cqa-card__old', onclick: () => go(`#/conversation/${conv.id}`) }, 'не последняя оценка · к последней') : null,
      evalPicker(),
      h('button', { type: 'button', class: `cqa-btn cqa-btn--sm ${ev ? '' : 'cqa-btn--primary'}`, id: 'cqa-card-run', onclick: () => runRequest() }, ev ? '↻ Оценить повторно' : 'Оценить'),
      h('div', { class: 'cqa-card__nav' },
        idx >= 0 ? h('span', { class: 'cqa-faint', style: 'font-size:var(--cqa-text-xs)' }, `${idx + 1} из ${rows.length}`) : null,
        h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm', disabled: !prev, onclick: () => prev && go(`#/conversation/${prev.id}`) }, '‹ Предыдущий'),
        h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm', disabled: !next, onclick: () => next && go(`#/conversation/${next.id}`) }, 'Следующий ›'))));

    const left = h('div', { class: 'cqa-card__col', id: 'cqa-col-left' });
    const right = h('div', { class: 'cqa-card__col', id: 'cqa-col-right' });
    root.append(h('div', { class: 'cqa-card__cols' }, left, right));

    if (isCall) {
      left.append(h('div', { class: 'cqa-player', id: 'cqa-player-slot' },
        h('div', { class: 'cqa-player__icon' }, '▶'),
        h('div', { style: 'flex:1;min-width:0' },
          h('div', { style: 'font-weight:600;font-size:var(--cqa-text-sm)' }, 'Запись звонка'),
          h('div', { class: 'cqa-faint', style: 'font-size:var(--cqa-text-xs)' }, conv.has_audio || conv.audio_url ? 'Плеер подключим на следующем шаге' : 'Запись недоступна: ссылки на аудио нет'),
          h('div', { class: 'cqa-player__bar', style: 'margin-top:6px' })),
        duration ? h('span', { class: 'cqa-chip' }, `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}`) : null));
    }
    const factsEl = h('div');
    trEl = h('div');
    resEl = h('div');
    left.append(factsEl, h('div', { class: 'cqa-panel' },
      h('div', { class: 'cqa-panel__head cqa-trhead' }, h('h3', { class: 'cqa-h3' }, 'Транскрипт'),
        h('span', { class: 'cqa-faint cqa-trhead__n' }, `${conv.messages.length} реплик`),
        isCall ? h('span', { class: 'cqa-faint cqa-trhead__hint' }, 'расшифровка устной речи') : null),
      trEl));
    right.append(resEl);

    const fx = ev ? mountFacts(factsEl, { facts: ev.facts }) : null;
    const tr = mountTranscript(trEl, { messages: conv.messages, evidence: evidenceMap(ev) });
    const rs = mountResult(resEl, { evaluation: ev, mode: p.mode, conversationId: conv.id });
    kids = [tr, rs, fx].filter(Boolean);
  }

  // Результат и факты -> транскрипт, транскрипт -> результат. Слушатели вешаются один раз.
  root.addEventListener('cqa:evidence-click', (e) => {
    if (!trEl || trEl.contains(e.target)) return;
    const d = e.detail || {};
    trEl.dispatchEvent(new CustomEvent('cqa:highlight', { detail: { ...d, msg_ids: d.msg_ids || (d.msg_id ? [d.msg_id] : []) } }));
  });
  root.addEventListener('cqa:criterion-click', (e) => {
    resEl?.dispatchEvent(new CustomEvent('cqa:focus-criterion', { detail: e.detail }));
  });
  // Запрос оценки от дочерних компонентов (пустое состояние, «Оценить повторно» в баннере): дополняем контекстом карточки.
  root.addEventListener('cqa:run-request', (e) => {
    if (!conv || e.detail?.lockScope) return;
    Object.assign(e.detail, { ids: [conv.id], group: conv.group_id, label: conv.conversation_id, channel: conv.channel, lockScope: true,
      preset: e.detail.preset || preset(), title: ev ? `Оценить повторно ${conv.conversation_id}` : `Оценить ${conv.conversation_id}` });
  });
  const onRefresh = () => {
    if (p.eval) { p = { ...p, eval: undefined }; emit(root, 'cqa:location', { to: `#/conversation/${p.id}` }); }
    load();
  };
  el.addEventListener('cqa:refresh', onRefresh);

  load();

  return {
    update(np) {
      const changed = np.id !== p.id || np.eval !== p.eval;
      p = { ...p, ...np };
      if (changed) load();
    },
    unmount() { token++; el.removeEventListener('cqa:refresh', onRefresh); kids.forEach((k) => k.unmount()); root.remove(); },
  };
}
