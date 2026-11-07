// Карточка диалога: шапка, транскрипт слева, результат справа. Связывает дочерние компоненты событиями DOM.
import { h, clear, emit, channelBadge, langChip, score, skeletonRows, errorState } from '../ui.js';
import { getConversation, getEvaluation, listConversations } from '../api.js';
import { mount as mountTranscript } from './transcript-view.js';
import { mount as mountResult } from './result-panel.js';

export function mount(el, params = {}) {
  let p = { ...params };
  const root = h('div', { class: 'cqa-card' });
  el.append(root);
  let kids = [];
  let token = 0;

  function evidenceMap(ev) {
    return (ev?.criteria || []).filter((c) => c.final_answer !== 'na' || c.evidence?.length)
      .map((c) => ({ key: c.key, flag: c.type === 'flag' && c.ai_answer === 'yes', msg_ids: (c.evidence || []).map((e) => e.msg_id) }))
      .filter((e) => e.msg_ids.length);
  }

  async function load() {
    const my = ++token;
    kids.forEach((k) => k.unmount());
    kids = [];
    clear(root).append(h('div', { class: 'cqa-card__cols' }, h('div', { class: 'cqa-card__col' }, skeletonRows(8)), h('div', { class: 'cqa-card__col' }, skeletonRows(8))));
    try {
      const conv = await getConversation(p.id);
      const evalId = p.eval || conv.evaluations?.[0]?.id;
      const [ev, rows] = await Promise.all([
        evalId ? getEvaluation(evalId) : Promise.resolve(null),
        listConversations({ group_id: p.group || 'DEV' }).catch(() => []),
      ]);
      if (my !== token) return;
      render(conv, ev, rows);
    } catch (e) {
      if (my !== token) return;
      clear(root).append(h('div', { class: 'cqa-page' }, h('div', { class: 'cqa-panel' }, errorState(e, load))));
    }
  }

  function render(conv, ev, rows) {
    clear(root);
    const idx = rows.findIndex((r) => String(r.id) === String(conv.id));
    const prev = idx > 0 ? rows[idx - 1] : null;
    const next = idx >= 0 && idx < rows.length - 1 ? rows[idx + 1] : null;
    const go = (to) => emit(root, 'cqa:navigate', { to });
    const isCall = conv.channel === 'voice call';
    const duration = Math.round(Math.max(0, ...conv.messages.map((m) => m.t_sec || 0)));

    root.append(h('div', { class: 'cqa-card__head' },
      h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm', onclick: () => go('#/conversations') }, '← К списку'),
      h('span', { class: 'cqa-card__id' }, conv.conversation_id),
      channelBadge(conv.channel), langChip(conv.language),
      ev ? h('span', { style: 'display:inline-flex;align-items:baseline;gap:6px;margin-left:8px' }, h('span', { class: 'cqa-faint cqa-h3' }, 'Итог'), score(ev.final_score.total, 'cqa-text-lg')) : h('span', { class: 'cqa-badge cqa-badge--muted' }, 'Не оценён'),
      ev?.ai_score.critical.length ? h('span', { class: 'cqa-badge cqa-badge--flag' }, 'Грубая ошибка') : null,
      ev?.needs_review ? h('span', { class: 'cqa-badge cqa-badge--warn' }, 'Требует проверки') : null,
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
        h('div', { style: 'flex:1' },
          h('div', { style: 'font-weight:600;font-size:var(--cqa-text-sm)' }, 'Запись звонка'),
          h('div', { class: 'cqa-faint', style: 'font-size:var(--cqa-text-xs)' }, conv.audio_url ? 'Плеер будет подключён на следующем шаге' : 'Запись недоступна: audio_url не задан'),
          h('div', { class: 'cqa-player__bar', style: 'margin-top:6px' })),
        duration ? h('span', { class: 'cqa-chip' }, `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}`) : null));
    }
    const trEl = h('div'), resEl = h('div');
    left.append(h('div', { class: 'cqa-panel' }, trEl));
    right.append(resEl);

    const tr = mountTranscript(trEl, { messages: conv.messages, evidence: evidenceMap(ev) });
    const rs = mountResult(resEl, { evaluation: ev, mode: p.mode, conversationId: conv.id });
    kids = [tr, rs];

    // Результат -> транскрипт, и обратно, через события.
    root.addEventListener('cqa:evidence-click', (e) => {
      if (trEl.contains(e.target)) return;
      const d = e.detail || {};
      trEl.dispatchEvent(new CustomEvent('cqa:highlight', { detail: { msg_ids: d.msg_id ? [d.msg_id] : [], from: d.from, to: d.to } }));
    });
    root.addEventListener('cqa:criterion-click', (e) => {
      resEl.dispatchEvent(new CustomEvent('cqa:focus-criterion', { detail: e.detail }));
    });
  }

  load();

  return {
    update(np) {
      const changed = np.id !== p.id || np.eval !== p.eval;
      p = { ...p, ...np };
      if (changed) load();
    },
    unmount() { token++; kids.forEach((k) => k.unmount()); root.remove(); },
  };
}
