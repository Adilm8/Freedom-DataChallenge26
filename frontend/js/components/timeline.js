// Таймлайн диалога (FR-UX-01): полоса времени над транскриптом — бот, ожидание оператора, работа оператора,
// удержания и консультации, паузы записи, долгие паузы; метки событий (эскалация, первый ответ с задержкой,
// подтверждение личности, завершение) и метки доказательств критериев.
// Параметры: conversation (ConversationDetail: messages, events, segments) или conversation=<id> (загрузить),
//            evaluation (Evaluation: facts, criteria) — необязательно; без оценки события берутся из системных сообщений.
// Наружу: cqa:evidence-click {msg_ids, from?, to?, source: 'timeline'} — карточка прокручивает транскрипт к реплике
//         и ставит запись звонка на эту секунду. Внутрь: cqa:audio-time {msg_id} на el — отметить звучащую реплику.
import { h, clear, emit, EVENT_LABEL, errorState } from '../ui.js';
import { getConversation } from '../api.js';
import { createTip, plural } from './viz.js';

const END_EVENTS = ['operator_closed', 'client_left', 'client_ended', 'connection_lost', 'session_timeout'];
const END_SHORT = {
  operator_closed: 'Оператор закрыл чат', client_left: 'Клиент покинул чат', client_ended: 'Клиент завершил разговор',
  connection_lost: 'Соединение прервано', session_timeout: 'Закрыто по таймауту', normal: 'Последняя реплика оператора', unknown: 'Конец диалога',
};
const ABRUPT = new Set(['client_left', 'client_ended', 'connection_lost']);
const BAND = {
  bot: ['Бот', 'cqa-tl__band--bot'], wait: ['Ожидание оператора', 'cqa-tl__band--wait'], slow: ['Ожидание дольше порога', 'cqa-tl__band--slow'],
  op: ['Оператор с клиентом', 'cqa-tl__band--op'], hold: ['Удержание', 'cqa-tl__band--hold'], consult: ['Консультация с коллегой', 'cqa-tl__band--consult'],
  recording_paused: ['Запись на паузе', 'cqa-tl__band--recording_paused'], gap: ['Долгая пауза без предупреждения', 'cqa-tl__band--gap'],
  gapok: ['Долгая пауза с предупреждением', 'cqa-tl__band--gapok'],
};
const ROLE_TICK = { client: 'Клиент', operator: 'Оператор', bot: 'Бот', system: 'Система' };

export function clock(sec) {
  if (sec == null || !isFinite(sec)) return '—';
  const s = Math.max(0, Math.round(sec)), hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60);
  return `${hh ? `${hh}:${String(mm).padStart(2, '0')}` : mm}:${String(s % 60).padStart(2, '0')}`;
}
export function dur(sec) {
  const s = Math.round(Number(sec));
  if (!isFinite(s)) return '—';
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `${m} мин ${r} с` : `${m} мин`;
}
const fv = (facts, k) => (facts && facts[k] && typeof facts[k] === 'object' && 'value' in facts[k] ? facts[k].value : undefined);

/** Модель таймлайна из диалога и (необязательно) оценки. Чистая функция — удобно проверять. */
export function buildModel(conv, ev) {
  const msgs = (conv?.messages || []).map((m, i) => ({ ...m, idx: m.idx ?? i }));
  const byId = new Map(msgs.map((m) => [m.msg_id, m]));
  const timed = msgs.filter((m) => m.t_sec != null && isFinite(m.t_sec));
  let t0 = timed.length ? Math.min(...timed.map((m) => m.t_sec)) : 0;
  let t1 = timed.length ? Math.max(...timed.map((m) => m.t_sec)) : 0;
  const byOrder = timed.length < Math.max(2, msgs.length * 0.6) || t1 - t0 <= 0;
  if (byOrder) { t0 = 0; t1 = Math.max(1, msgs.length - 1); }
  const tOf = (m) => (m == null ? null : byOrder ? m.idx : m.t_sec ?? null);
  const span = Math.max(1e-6, t1 - t0);
  const x = (t) => (t == null ? null : Math.max(0, Math.min(1, (t - t0) / span)));
  const xm = (id) => x(tOf(byId.get(id)));
  const tm = (id) => tOf(byId.get(id));
  const facts = ev?.facts || null;
  const events = conv?.events || [];

  // --- ключевые события
  const pins = [];
  const evOf = (type) => events.find((e) => e.type === type);
  const escF = fv(facts, 'escalation_at');
  const escEv = evOf('escalation') || evOf('agent_joined');
  const escId = escF?.msg_id || escEv?.msg_id || null;
  const escSrc = escF?.source || (escEv ? 'event' : null);
  const isOperator = (m) => String(m.speaker).toLowerCase() === 'operator' && !m.internal;
  const firstF = fv(facts, 'first_operator_msg');
  const escIdx = escId ? byId.get(escId)?.idx ?? -1 : -1;
  const firstId = firstF?.msg_id || (msgs.find((m) => isOperator(m) && m.idx >= escIdx) || msgs.find(isOperator))?.msg_id || null;
  let delay = fv(facts, 'first_response_delay_sec');
  if (delay === undefined) {
    const a = byId.get(escId), b = byId.get(firstId);
    delay = a && b && a.t_sec != null && b.t_sec != null && b.t_sec >= a.t_sec && escEv ? b.t_sec - a.t_sec : null;
  }
  const slow = fv(facts, 'first_response_slow') === true;
  if (escId && escSrc !== 'first_operator_msg') pins.push({ kind: 'esc', icon: '⇄', msg_id: escId, label: 'Эскалация на оператора', t: tm(escId) });
  if (firstId) {
    pins.push({ kind: slow ? 'first-slow' : 'first', icon: '↩', msg_id: firstId, t: tm(firstId),
      label: delay != null ? `Первый ответ оператора через ${dur(delay)}${slow ? ' — дольше порога' : ''}` : 'Первый ответ оператора',
      short: delay != null ? `ответ через ${dur(delay)}` : null });
  }
  const idF = fv(facts, 'identity_verified_at');
  const idId = idF?.msg_id || evOf('identity_verified')?.msg_id;
  if (idId) pins.push({ kind: 'id', icon: '✓', msg_id: idId, label: 'Личность клиента подтверждена', t: tm(idId) });
  const endedBy = fv(facts, 'ended_by');
  const endEv = events.find((e) => END_EVENTS.includes(e.type));
  const endType = endEv?.type || (endedBy && endedBy !== 'normal' && endedBy !== 'unknown' ? endedBy : null) || endedBy || null;
  const lastOp = [...msgs].reverse().find(isOperator);
  const endId = endEv?.msg_id || (facts?.ended_by?.msg_ids || [])[0] || (endType === 'normal' ? lastOp?.msg_id : msgs[msgs.length - 1]?.msg_id);
  if (endId) {
    pins.push({ kind: ABRUPT.has(endType) ? 'end-abrupt' : 'end', icon: ABRUPT.has(endType) ? '✕' : '■', msg_id: endId, t: tm(endId),
      label: `Завершение: ${END_SHORT[endType] || EVENT_LABEL[endType] || 'конец диалога'}` });
  }
  for (const r of fv(facts, 'risk_terms') || []) {
    if (r?.msg_id && byId.has(r.msg_id)) pins.push({ kind: 'risk', icon: '!', msg_id: r.msg_id, t: tm(r.msg_id), label: `Слово-подсказка о нарушении: «${r.phrase || r.text || r.category}»` });
  }
  for (const e of events) {
    if (['hold_start', 'consult_start', 'recording_paused', 'consult_initiated'].includes(e.type) || !e.msg_id) continue;
    if (['escalation', 'agent_joined', 'identity_verified', ...END_EVENTS, 'hold_end', 'consult_end', 'recording_started', 'recording_resumed'].includes(e.type)) continue;
    pins.push({ kind: 'event', icon: '•', msg_id: e.msg_id, t: tm(e.msg_id), label: EVENT_LABEL[e.type] || e.text || e.type });
  }
  pins.forEach((p) => { p.x = x(p.t); });

  // --- полосы
  const bands = [];
  const firstBot = msgs.find((m) => String(m.speaker).toLowerCase() === 'bot');
  const lastT = tOf(msgs[msgs.length - 1]);
  if (firstBot && escId && byId.get(escId).idx > firstBot.idx) bands.push({ type: 'bot', from: tOf(msgs[0]), to: tm(escId), msg_ids: [firstBot.msg_id] });
  if (escId && firstId && tm(firstId) > tm(escId)) bands.push({ type: slow ? 'slow' : 'wait', from: tm(escId), to: tm(firstId), msg_ids: [firstId], from_id: escId, to_id: firstId, sec: delay });
  if (firstId) bands.push({ type: 'op', from: tm(firstId), to: tm(endId) ?? lastT, msg_ids: [firstId] });
  for (const s of conv?.segments || []) {
    const a = msgs[s.start_idx], b = s.end_idx != null ? msgs[s.end_idx] : msgs[msgs.length - 1];
    const from = byOrder ? a?.idx : s.start_sec ?? tOf(a), to = byOrder ? b?.idx : s.end_sec ?? tOf(b);
    if (from == null || to == null || !BAND[s.type]) continue;
    bands.push({ type: s.type, from, to, overlay: true, msg_ids: a ? [a.msg_id] : [], from_id: a?.msg_id, to_id: b?.msg_id, sec: byOrder ? null : to - from });
  }
  for (const g of fv(facts, 'long_gaps') || []) {
    if (!byId.has(g.from_msg_id) || !byId.has(g.to_msg_id)) continue;
    bands.push({ type: g.warned ? 'gapok' : 'gap', from: tm(g.from_msg_id), to: tm(g.to_msg_id), overlay: true, sec: g.sec,
      msg_ids: [g.to_msg_id], from_id: g.from_msg_id, to_id: g.to_msg_id, waiting: g.waiting, on_hold: g.on_hold });
  }
  bands.forEach((b) => { b.x0 = x(b.from); b.x1 = x(b.to); });

  // --- доказательства критериев: одна метка на реплику, коды через пробел
  const evMap = new Map();
  for (const c of ev?.criteria || []) {
    const answer = c.final_answer ?? c.ai_answer;
    const bad = c.type === 'flag' ? answer === 'yes' : answer === 'no' || (c.type === 'scale' && typeof answer === 'number' && answer < (c.scale_max ?? c.weight));
    for (const e of c.evidence || []) {
      if (!byId.has(e.msg_id)) continue;
      const cur = evMap.get(e.msg_id) || { msg_id: e.msg_id, keys: [], flag: false, bad: false, items: [] };
      if (!cur.keys.includes(c.key)) cur.keys.push(c.key);
      cur.flag ||= c.type === 'flag' && answer === 'yes';
      cur.bad ||= bad;
      cur.items.push({ key: c.key, title: c.title, quote: e.quote });
      evMap.set(e.msg_id, cur);
    }
  }
  const evidence = [...evMap.values()].map((e) => ({ ...e, x: xm(e.msg_id), t: tm(e.msg_id) })).filter((e) => e.x != null).sort((a, b) => a.x - b.x);

  const ticks = msgs.map((m) => ({ msg_id: m.msg_id, role: String(m.speaker).toLowerCase(), internal: !!m.internal, x: xm(m.msg_id) })).filter((m) => m.x != null);
  return { byOrder, t0, t1, duration: byOrder ? null : t1 - t0, pins: pins.filter((p) => p.x != null), bands: bands.filter((b) => b.x0 != null && b.x1 != null),
    evidence, ticks, x, msgs: msgs.length, endType, delay, slow };
}

/** Раскладка меток по рядам без наложения: [{x (0…1), w (px)}] → номер ряда у каждой. */
function pack(items, width, maxRows) {
  const ends = [];
  return items.map((it) => {
    const left = it.x * width - it.w / 2;
    let row = ends.findIndex((e) => e <= left - 3);
    if (row < 0) row = ends.length < maxRows ? ends.length : ends.indexOf(Math.min(...ends));
    ends[row] = left + it.w;
    return row;
  });
}

export function mount(el, params = {}) {
  let p = { ...params };
  let model = null;
  let playingId = null;
  const root = h('section', { class: 'cqa-panel cqa-tl', 'aria-label': 'Ход диалога' });
  el.append(root);
  const tip = createTip(root);
  let ro = null, lastW = 0;

  const jump = (detail) => emit(root, 'cqa:evidence-click', { ...detail, source: 'timeline' });

  function summary(m) {
    const out = [];
    if (m.duration != null) out.push(`длительность ${clock(m.duration)}`);
    if (m.delay != null) out.push(`первый ответ через ${dur(m.delay)}${m.slow ? ' (дольше порога)' : ''}`);
    const gaps = m.bands.filter((b) => b.type === 'gap').length;
    if (gaps) out.push(`${gaps} ${plural(gaps, 'долгая пауза', 'долгие паузы', 'долгих пауз')} без предупреждения`);
    if (m.endType && END_SHORT[m.endType]) out.push(END_SHORT[m.endType].toLowerCase());
    return out.join(' · ');
  }

  function axis(m) {
    const ax = h('div', { class: 'cqa-tl__axis', 'aria-hidden': 'true' });
    if (m.byOrder) {
      ax.append(h('span', { style: 'left:0' }, 'начало'), h('span', { class: 'cqa-tl__axis-end', style: 'left:100%' }, `реплика ${m.msgs}`));
      return ax;
    }
    const d = m.duration;
    const steps = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const step = steps.find((s) => d / s <= 5) || 3600;
    for (let t = 0; t <= d + 1e-6; t += step) {
      if (d - t < step * 0.45 && t > 0) break; // не наезжать на подпись конца
      ax.append(h('span', { style: `left:${(t / d) * 100}%` }, clock(t)));
    }
    ax.append(h('span', { class: 'cqa-tl__axis-end', style: 'left:100%' }, clock(d)));
    return ax;
  }

  function render() {
    clear(root);
    root.append(tip.el);
    tip.hide();
    const m = model;
    if (!m || !m.msgs) { root.append(h('div', { class: 'cqa-tl__empty' }, 'Нет реплик — ход диалога не построить.')); return; }
    const width = Math.max(200, root.clientWidth - 32);
    lastW = root.clientWidth;

    root.append(h('div', { class: 'cqa-tl__head' },
      h('h3', { class: 'cqa-h3' }, 'Ход диалога'),
      h('span', { class: 'cqa-tl__sum' }, summary(m)),
      m.byOrder ? h('span', { class: 'cqa-badge cqa-badge--muted', title: 'У реплик нет времени: шкала построена по порядку реплик' }, 'по порядку реплик') : null));

    const plot = h('div', { class: 'cqa-tl__plot' });
    // Метки событий (над полосой)
    const pinRows = pack(m.pins.map((p) => ({ x: p.x, w: 22 })), width, 2);
    const pinsEl = h('div', { class: 'cqa-tl__pins', style: `height:${pinRows.length ? (Math.max(...pinRows) + 1) * 22 : 0}px` });
    m.pins.forEach((pn, i) => {
      const b = h('button', { type: 'button', class: `cqa-tl__pin cqa-tl__pin--${pn.kind}`, style: `left:${pn.x * 100}%;bottom:${pinRows[i] * 22}px`,
        'aria-label': `${clock(pn.t)} ${pn.label}: показать реплику ${pn.msg_id}`, dataset: { msgId: pn.msg_id },
        onclick: () => jump({ msg_ids: [pn.msg_id] }) }, pn.icon);
      tip.bind(b, { title: pn.label, rows: [{ value: m.byOrder ? pn.msg_id : clock(pn.t), label: m.byOrder ? 'реплика' : `реплика ${pn.msg_id}` }] });
      pinsEl.append(b);
    });

    // Полоса фаз и наложений
    const track = h('div', { class: 'cqa-tl__track' });
    const bandEls = [];
    for (const b of m.bands) {
      const [label, cls] = BAND[b.type];
      const w = Math.max(b.x1 - b.x0, 0.004);
      const extra = b.sec != null ? dur(b.sec) : null;
      const node = h('button', { type: 'button', class: `cqa-tl__band ${cls} ${b.overlay ? 'cqa-tl__band--overlay' : ''}`,
        style: `left:${b.x0 * 100}%;width:${w * 100}%`, tabindex: b.overlay || b.type === 'wait' || b.type === 'slow' ? 0 : -1,
        'aria-label': `${label}${extra ? ` ${extra}` : ''}${m.byOrder ? '' : `, ${clock(b.from)}–${clock(b.to)}`}`,
        onclick: () => jump(b.from_id && b.to_id ? { msg_ids: b.msg_ids, from: b.from_id, to: b.to_id } : { msg_ids: b.msg_ids }) });
      tip.bind(node, () => ({ title: label, rows: [
        extra ? { value: extra, label: 'длительность' } : null,
        m.byOrder ? null : { value: `${clock(b.from)}–${clock(b.to)}`, label: 'время' },
        b.waiting ? { value: b.waiting === 'client' ? 'клиент' : 'оператор', label: 'кто ждал' } : null,
        b.on_hold ? { value: 'да', label: 'клиент на удержании' } : null,
      ].filter(Boolean) }));
      if (b.overlay) bandEls.push(node); else track.append(node);
    }
    // Наложения поверх фаз; долгие паузы — скобкой над полосой, чтобы не закрывать удержание и консультацию.
    track.append(...bandEls);
    // Реплики — тонкие риски по ролям
    const rail = h('div', { class: 'cqa-tl__rail', 'aria-hidden': 'true' },
      m.ticks.map((t) => h('span', { class: `cqa-tl__tick cqa-tl__tick--${t.internal ? 'internal' : t.role}${t.msg_id === playingId ? ' cqa-tl__tick--playing' : ''}`, style: `left:${t.x * 100}%`, dataset: { msgId: t.msg_id } })));
    const playhead = h('span', { class: 'cqa-tl__playhead', hidden: true, 'aria-hidden': 'true' });

    // Доказательства критериев (под полосой)
    const evW = m.evidence.map((e) => 12 + e.keys.join(' ').length * 7.4);
    const evRows = pack(m.evidence.map((e, i) => ({ x: e.x, w: evW[i] })), width, 3);
    const evEl = h('div', { class: 'cqa-tl__ev', style: `height:${m.evidence.length ? (Math.max(...evRows) + 1) * 20 : 0}px` });
    m.evidence.forEach((e, i) => {
      const node = h('button', { type: 'button', class: `cqa-tl__evchip ${e.flag ? 'cqa-tl__evchip--flag' : e.bad ? 'cqa-tl__evchip--bad' : ''}`,
        style: `left:clamp(0px, calc(${e.x * 100}% - ${evW[i] / 2}px), calc(100% - ${evW[i]}px));top:${evRows[i] * 20}px`,
        'aria-label': `Доказательство ${e.keys.join(', ')} в реплике ${e.msg_id}: показать`, onclick: () => jump({ msg_ids: [e.msg_id], quote: e.items[0]?.quote }) },
      e.keys.join(' '));
      tip.bind(node, () => ({ title: `Реплика ${e.msg_id}${m.byOrder ? '' : ` · ${clock(e.t)}`}`,
        rows: e.items.map((it) => ({ value: it.key, label: it.quote ? `${it.title || ''} — «${it.quote.length > 60 ? it.quote.slice(0, 59) + '…' : it.quote}»` : it.title || '' })) }));
      evEl.append(node);
    });

    plot.append(pinsEl, h('div', { class: 'cqa-tl__trackwrap' }, track, rail, playhead), evEl, axis(m));
    root.append(plot);

    // Ключевые события списком: читаются без наведения и с клавиатуры
    const items = [
      ...m.pins.filter((pn) => pn.kind !== 'event').map((pn) => ({ t: pn.t, x: pn.x, cls: pn.kind, icon: pn.icon, text: pn.short ? `${pn.label.split(' через')[0]} · ${pn.short.replace('ответ ', '')}` : pn.label, go: { msg_ids: [pn.msg_id] } })),
      ...m.bands.filter((b) => b.overlay).map((b) => ({ t: b.from, x: b.x0, cls: b.type, icon: '◫', text: `${BAND[b.type][0]}${b.sec != null ? ` ${dur(b.sec)}` : ''}`, go: { msg_ids: b.msg_ids, from: b.from_id, to: b.to_id } })),
    ].sort((a, b) => a.x - b.x);
    if (items.length) {
      root.append(h('ol', { class: 'cqa-tl__list', 'aria-label': 'Ключевые события по времени' }, items.map((it) =>
        h('li', null, h('button', { type: 'button', class: `cqa-tl__item cqa-tl__item--${it.cls}`, onclick: () => jump(it.go) },
          h('span', { class: 'cqa-tl__itime' }, m.byOrder ? (it.go.msg_ids[0] || '') : clock(it.t)), h('span', { class: 'cqa-tl__iicon', 'aria-hidden': 'true' }, it.icon), it.text)))));
    }
    // Легенда — только то, что есть на полосе
    const present = [...new Set(m.bands.map((b) => b.type))];
    root.append(h('div', { class: 'cqa-tl__legend', 'aria-label': 'Обозначения' },
      present.map((t) => h('span', { class: 'cqa-tl__lg' }, h('span', { class: `cqa-tl__sw ${BAND[t][1]}` }), BAND[t][0])),
      m.evidence.length ? h('span', { class: 'cqa-tl__lg' }, h('span', { class: 'cqa-tl__sw cqa-tl__sw--ev' }), 'доказательство критерия') : null,
      m.evidence.some((e) => e.bad || e.flag) ? h('span', { class: 'cqa-tl__lg' }, h('span', { class: 'cqa-tl__sw cqa-tl__sw--evbad' }), 'критерий не выполнен') : null,
      h('span', { class: 'cqa-tl__lg' }, Object.entries(ROLE_TICK).filter(([r]) => m.ticks.some((t) => t.role === r)).map(([r, l]) =>
        h('span', { class: 'cqa-tl__lgtick' }, h('span', { class: `cqa-tl__tick cqa-tl__tick--${r} cqa-tl__tick--static` }), l)))));
    setPlaying(playingId);
  }

  function setPlaying(id) {
    playingId = id;
    const ph = root.querySelector('.cqa-tl__playhead');
    root.querySelectorAll('.cqa-tl__tick--playing').forEach((n) => n.classList.remove('cqa-tl__tick--playing'));
    const t = id && model?.ticks.find((x) => x.msg_id === id);
    if (!ph) return;
    if (!t) { ph.hidden = true; return; }
    ph.hidden = false;
    ph.style.left = `${t.x * 100}%`;
    root.querySelector(`.cqa-tl__tick[data-msg-id="${CSS.escape(id)}"]`)?.classList.add('cqa-tl__tick--playing');
  }

  async function load() {
    try {
      let conv = p.conversation;
      if (conv != null && typeof conv !== 'object') conv = await getConversation(conv);
      model = buildModel(conv, p.evaluation || null);
      render();
    } catch (e) {
      clear(root).append(errorState(e, load));
    }
  }

  const onPlaying = (e) => setPlaying(e.detail?.msg_id || null);
  el.addEventListener('cqa:audio-time', onPlaying);
  if (typeof ResizeObserver === 'function') {
    let raf = 0;
    ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { if (model && Math.abs(root.clientWidth - lastW) > 24) render(); }); });
    ro.observe(root);
  }
  load();

  return {
    update(np) { p = { ...p, ...np }; load(); },
    unmount() { el.removeEventListener('cqa:audio-time', onPlaying); ro?.disconnect(); tip.remove(); root.remove(); },
  };
}
