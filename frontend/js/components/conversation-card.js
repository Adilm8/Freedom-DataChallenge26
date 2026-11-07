// Карточка диалога: шапка, факты и транскрипт слева, результат справа. Связывает дочерние компоненты событиями DOM.
// Параметры: id (суррогатный id диалога), eval (id оценки; без него — последняя), focus (код критерия: прокрутить к нему
// и подсветить доказательства — переход из очереди «требует проверки» и апелляций), group, mode.
// Наружу: cqa:navigate {to}, cqa:location {to} (сменить адрес без перехода), cqa:run-request {ids, label, channel, preset, ...}.
// Внутрь: cqa:refresh на el — перечитать диалог и показать последнюю оценку (после прогона);
// cqa:evaluation-updated {evaluation} от панели результата (апелляция подана) — обновить итог в шапке.
// Звонок: плеер над транскриптом; клик по реплике или доказательству переводит запись на секунду реплики (с поправкой).
import { h, clear, emit, channelBadge, langChip, score, fmtScore, fmtDate, skeletonRows, errorState } from '../ui.js';
import { getConversation, getEvaluation, listConversations } from '../api.js';
import { mount as mountTranscript } from './transcript-view.js';
import { mount as mountResult } from './result-panel.js';
import { mount as mountFacts } from './facts-panel.js';
import { mount as mountPlayer } from './audio-player.js';

export function mount(el, params = {}) {
  let p = { ...params };
  const root = h('div', { class: 'cqa-card' });
  el.append(root);
  let kids = [];
  let token = 0;
  let trEl = null, resEl = null, playerEl = null;
  let conv = null, ev = null, lastRows = [];

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

  // Итог в шапке: финальный; если решения по апелляциям его изменили — «AI → финальный» рядом.
  function totalEl() {
    if (!ev) return h('span', { class: 'cqa-badge cqa-badge--muted' }, 'Не оценён');
    const ai = ev.ai_score?.total, fin = ev.final_score?.total;
    if (ai == null || fin == null || ai === fin) return h('span', { class: 'cqa-card__total' }, h('span', { class: 'cqa-faint cqa-h3' }, 'Итог'), score(fin ?? ai, 'cqa-text-lg'));
    return h('span', { class: 'cqa-card__total cqa-card__total--two', title: 'AI-оценка не меняется; финальный итог — с решениями по апелляциям' },
      h('span', { class: 'cqa-faint cqa-h3' }, 'AI'), score(ai, 'cqa-faint'), h('span', { class: 'cqa-faint' }, '→'),
      h('span', { class: 'cqa-faint cqa-h3' }, 'Финальный'), score(fin, 'cqa-text-lg'));
  }

  function render(rows) {
    clear(root);
    lastRows = rows;
    root.append(head(rows));
    const isCall = conv.channel === 'voice call';
    const withAudio = isCall && (conv.has_audio ?? !!conv.audio_url) === true;
    body(isCall, withAudio);
  }

  function head(rows) {
    const idx = rows.findIndex((r) => String(r.id) === String(conv.id));
    const prev = idx > 0 ? rows[idx - 1] : null;
    const next = idx >= 0 && idx < rows.length - 1 ? rows[idx + 1] : null;
    const go = (to) => emit(root, 'cqa:navigate', { to });
    const newest = conv.evaluations?.[0]?.id;
    const old = ev && newest && ev.id !== newest;

    return h('div', { class: 'cqa-card__head' },
      h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm', onclick: () => go('#/conversations') }, '← К списку'),
      h('span', { class: 'cqa-card__id' }, conv.conversation_id),
      channelBadge(conv.channel), langChip(conv.language),
      totalEl(),
      (ev?.final_score || ev?.ai_score)?.critical?.length ? h('span', { class: 'cqa-badge cqa-badge--flag' }, 'Грубая ошибка') : null,
      ev?.open_appeals ? h('span', { class: 'cqa-badge cqa-badge--accent' }, `Апелляций открыто: ${ev.open_appeals}`) : null,
      ev?.needs_review ? h('span', { class: 'cqa-badge cqa-badge--warn' }, 'Требует проверки') : null,
      ev && ev.status !== 'done' ? h('span', { class: 'cqa-badge cqa-badge--no' }, ev.status === 'failed' ? 'Оценка не выполнена' : 'Оценка неполная') : null,
      old ? h('button', { type: 'button', class: 'cqa-badge cqa-badge--warn cqa-card__old', onclick: () => go(`#/conversation/${conv.id}`) }, 'не последняя оценка · к последней') : null,
      evalPicker(),
      h('button', { type: 'button', class: `cqa-btn cqa-btn--sm ${ev ? '' : 'cqa-btn--primary'}`, id: 'cqa-card-run', onclick: () => runRequest() }, ev ? '↻ Оценить повторно' : 'Оценить'),
      h('div', { class: 'cqa-card__nav' },
        idx >= 0 ? h('span', { class: 'cqa-faint', style: 'font-size:var(--cqa-text-xs)' }, `${idx + 1} из ${rows.length}`) : null,
        h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm', disabled: !prev, onclick: () => prev && go(`#/conversation/${prev.id}`) }, '‹ Предыдущий'),
        h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm', disabled: !next, onclick: () => next && go(`#/conversation/${next.id}`) }, 'Следующий ›')));
  }

  function body(isCall, withAudio) {
    const left = h('div', { class: 'cqa-card__col', id: 'cqa-col-left' });
    const right = h('div', { class: 'cqa-card__col', id: 'cqa-col-right' });
    root.append(h('div', { class: 'cqa-card__cols' }, left, right));

    // У звонка плеер стоит над прокручиваемой частью колонки и не уезжает при прокрутке транскрипта.
    let scrollEl = left;
    playerEl = null;
    if (isCall) {
      playerEl = h('div', { class: 'cqa-card__player', id: 'cqa-player-slot' });
      scrollEl = h('div', { class: 'cqa-card__scroll' });
      left.classList.add('cqa-card__col--call');
      left.append(playerEl, scrollEl);
    }
    const factsEl = h('div');
    trEl = h('div');
    resEl = h('div');
    scrollEl.append(factsEl, h('div', { class: 'cqa-panel' },
      h('div', { class: 'cqa-panel__head cqa-trhead' }, h('h3', { class: 'cqa-h3' }, 'Транскрипт'),
        h('span', { class: 'cqa-faint cqa-trhead__n' }, `${conv.messages.length} реплик`),
        isCall ? h('span', { class: 'cqa-faint cqa-trhead__hint' }, withAudio ? 'расшифровка устной речи · клик по реплике — слушать' : 'расшифровка устной речи') : null),
      trEl));
    right.append(resEl);

    const fx = ev ? mountFacts(factsEl, { facts: ev.facts }) : null;
    const tr = mountTranscript(trEl, { messages: conv.messages, evidence: evidenceMap(ev),
      audio: isCall ? (withAudio ? 'seek' : 'times') : undefined, segments: conv.segments });
    const rs = mountResult(resEl, { evaluation: ev, mode: p.mode, conversationId: conv.id });
    const pl = playerEl ? mountPlayer(playerEl, { conversation: conv, evidence: evidenceMap(ev) }) : null;
    kids = [tr, rs, fx, pl].filter(Boolean);
    if (p.focus && ev) {
      const key = p.focus;
      p = { ...p, focus: undefined }; // один раз: после «Оценить повторно» карточка открывается сверху
      requestAnimationFrame(() => resEl?.dispatchEvent(new CustomEvent('cqa:focus-criterion', { detail: { key, show: true } })));
    }
  }

  // Результат и факты -> транскрипт, транскрипт -> результат. Слушатели вешаются один раз.
  const toPlayer = (detail) => playerEl?.dispatchEvent(new CustomEvent('cqa:seek', { detail }));
  root.addEventListener('cqa:evidence-click', (e) => {
    if (!trEl || trEl.contains(e.target)) return;
    const d = e.detail || {};
    trEl.dispatchEvent(new CustomEvent('cqa:highlight', { detail: { ...d, msg_ids: d.msg_ids || (d.msg_id ? [d.msg_id] : []) } }));
    // Доказательство звонка: запись встаёт на эту реплику (не запускаем звук сами — если уже играет, продолжит отсюда).
    const id = d.msg_id || d.msg_ids?.[0] || d.from;
    if (id && playerEl && !playerEl.contains(e.target)) toPlayer({ msg_id: id, play: false });
  });
  // Транскрипт звонка -> плеер: клик по реплике — слушать с неё; плеер -> транскрипт: звучащая реплика и поправка.
  root.addEventListener('cqa:msg-click', (e) => toPlayer({ msg_id: e.detail?.msg_id, play: true }));
  root.addEventListener('cqa:audio-time', (e) => {
    const d = e.detail || {};
    trEl?.dispatchEvent(new CustomEvent('cqa:playing', { detail: { msg_id: d.msg_id, scroll: d.playing && d.follow } }));
  });
  root.addEventListener('cqa:audio-fix', (e) => trEl?.dispatchEvent(new CustomEvent('cqa:audio-fix', { detail: e.detail })));
  // Переход к секунде или реплике записи извне (хост web resource, будущий таймлайн): {msg_id | sec, play}.
  const onSeek = (e) => { if (playerEl && !playerEl.contains(e.target)) toPlayer(e.detail); };
  el.addEventListener('cqa:seek', onSeek);
  root.addEventListener('cqa:criterion-click', (e) => {
    resEl?.dispatchEvent(new CustomEvent('cqa:focus-criterion', { detail: e.detail }));
  });
  // Запрос оценки от дочерних компонентов (пустое состояние, «Оценить повторно» в баннере): дополняем контекстом карточки.
  root.addEventListener('cqa:run-request', (e) => {
    if (!conv || e.detail?.lockScope) return;
    Object.assign(e.detail, { ids: [conv.id], group: conv.group_id, label: conv.conversation_id, channel: conv.channel, lockScope: true,
      preset: e.detail.preset || preset(), title: ev ? `Оценить повторно ${conv.conversation_id}` : `Оценить ${conv.conversation_id}` });
  });
  root.addEventListener('cqa:evaluation-updated', (e) => {
    if (!conv || !e.detail?.evaluation) return;
    ev = e.detail.evaluation;
    root.querySelector('.cqa-card__head')?.replaceWith(head(lastRows));
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
    unmount() { token++; el.removeEventListener('cqa:refresh', onRefresh); el.removeEventListener('cqa:seek', onSeek); kids.forEach((k) => k.unmount()); root.remove(); },
  };
}
