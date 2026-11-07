// Транскрипт: реплики блоками, метки критериев на репликах-доказательствах, подсветка и прокрутка.
// Подсветка (событие cqa:highlight или cqa:evidence-click на el): {msg_ids, quote, from, to, scroll}.
// msg_ids — реплики-доказательства (жёлтая подсветка, цитата выделяется в тексте); from/to — проверенный
// диапазон (полоса слева и мягкий фон). Подсветка держится до следующего клика.
// Звонок (параметр audio: 'seek' | 'times', segments): у реплики — секунда записи «▶ 0:40» (с поправкой из cqa:audio-fix {fix});
// при 'seek' клик по реплике отправляет наружу cqa:msg-click {msg_id}. Звучащая реплика — событие cqa:playing {msg_id, scroll}.
// Реплики внутри паузы записи помечены «вне записи», внутри удержания и консультации — «внутренний разговор».
import { h, clear, emit, ROLE, EVENT_LABEL, skeletonRows, errorState, emptyState } from '../ui.js';
import { getConversation } from '../api.js';

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');
const clock = (sec) => {
  const s = Math.max(0, Math.floor(sec + 1e-6)), hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60);
  return `${hh ? `${hh}:${String(mm).padStart(2, '0')}` : mm}:${String(s % 60).padStart(2, '0')}`;
};

/** Реплики внутри паузы записи: их нет в файле записи. */
function offRecord(messages, segments) {
  const out = new Set();
  for (const s of segments || []) {
    if (s.type !== 'recording_paused') continue;
    const end = s.end_idx ?? Infinity;
    for (const m of messages) if ((m.idx ?? 0) > s.start_idx && (m.idx ?? 0) < end && m.speaker !== 'system') out.add(m.msg_id);
  }
  return out;
}

function scrollParent(node) {
  for (let n = node.parentElement; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n;
  }
  return null;
}

/** Ищет цитату в тексте без учёта регистра и лишних пробелов. Возвращает [start, end) в исходном тексте или null. */
export function findQuote(text, quote) {
  const q = norm(quote).replace(/[«»"“”„.,!?…:;—–-]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!q.length) return null;
  const t = norm(text);
  // Слова цитаты подряд, между ними — любые пробелы и знаки препинания.
  const esc = q.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(esc.join('[\\s«»"“”„.,!?…:;—–-]+'), 'u');
  const m = re.exec(t);
  return m ? [m.index, m.index + m[0].length] : null;
}

export function mount(el, params = {}) {
  let p = { ...params };
  let msgEls = new Map();
  let msgText = new Map();
  let order = [];
  let pulseTimer = null;
  let recEls = new Map();
  let fix = 0;
  let playingId = null;
  const root = h('div', { class: 'cqa-tr-root' });
  el.append(root);

  function tagsByMsg() {
    const map = new Map();
    for (const e of p.evidence || []) {
      for (const id of e.msg_ids || []) {
        if (!map.has(id)) map.set(id, []);
        const arr = map.get(id);
        if (!arr.some((t) => t.key === e.key)) arr.push({ key: e.key, flag: !!e.flag, bad: !!e.bad, part: !!e.part, title: e.title });
      }
    }
    return map;
  }

  function renderMsgs(messages) {
    const transcript = messages;
    clear(root);
    msgEls = new Map();
    msgText = new Map();
    recEls = new Map();
    playingId = null;
    order = transcript.map((m) => m.msg_id);
    if (!transcript.length) { root.append(emptyState({ title: 'Транскрипт пуст', text: 'В этом диалоге нет реплик.' })); return; }
    const tags = tagsByMsg();
    const seek = p.audio === 'seek';
    const off = p.audio ? offRecord(transcript, p.segments) : new Set();
    const list = h('div', { class: `cqa-tr ${seek ? 'cqa-tr--seek' : ''}`, role: 'log' });
    for (const m of transcript) {
      const cls = ['cqa-msg', `cqa-msg--${m.speaker}`, m.internal ? 'cqa-msg--internal' : '', off.has(m.msg_id) ? 'cqa-msg--offrec' : ''].join(' ');
      const time = String(m.timestamp || '').includes('T') ? m.timestamp.slice(11, 19) : m.timestamp;
      const textEl = h('div', { class: 'cqa-msg__text' }, m.text);
      const node = h('div', { class: cls, id: `msg-${m.msg_id}`, dataset: { msgId: m.msg_id } },
        h('div', { class: 'cqa-msg__meta' },
          h('span', { class: 'cqa-msg__role' }, ROLE[m.speaker] || m.speaker),
          p.audio ? recChip(m, off.has(m.msg_id), seek) : null,
          m.internal ? h('span', { class: 'cqa-badge cqa-badge--warn cqa-tip', 'data-tip': 'Во время удержания или консультации с коллегой: клиент этого не слышит' }, 'внутренний разговор') : null,
          m.event ? h('span', { class: 'cqa-badge cqa-badge--muted' }, EVENT_LABEL[m.event] || m.event) : null,
          h('span', { class: 'cqa-msg__time' }, time),
          h('span', { class: 'cqa-msg__id' }, m.msg_id),
          (tags.get(m.msg_id) || []).length
            ? h('span', { class: 'cqa-msg__tags', 'aria-label': 'Критерии, для которых реплика — доказательство' }, tags.get(m.msg_id).map((t) =>
              h('button', { type: 'button', class: `cqa-msg__tag cqa-tip ${t.flag ? 'cqa-msg__tag--flag' : t.bad ? 'cqa-msg__tag--bad' : t.part ? 'cqa-msg__tag--part' : ''}`,
                'data-tip': `${t.key}${t.title ? ' · ' + t.title : ''}${t.flag ? ' — грубая ошибка' : t.bad ? ' — не выполнен' : t.part ? ' — выполнен частично' : ''}: показать критерий`, 'aria-label': `Критерий ${t.key}: показать в результате`,
                onclick: () => emit(root, 'cqa:criterion-click', { key: t.key, msg_id: m.msg_id }) }, t.key)))
            : null),
        textEl);
      msgEls.set(m.msg_id, node);
      msgText.set(m.msg_id, { el: textEl, text: m.text });
      list.append(node);
    }
    if (seek) list.addEventListener('click', onListClick);
    root.append(list);
  }

  function recChip(m, offRec, seek) {
    if (m.audio_offset_sec == null) return h('span', { class: 'cqa-msg__rec cqa-msg__rec--none', title: 'Реплика прозвучала до начала записи' }, 'до записи');
    if (offRec) return h('span', { class: 'cqa-msg__rec cqa-msg__rec--none', title: 'Запись была приостановлена: этой реплики в файле нет' }, 'вне записи');
    const label = clock(m.audio_offset_sec + fix);
    const chip = seek
      ? h('button', { type: 'button', class: 'cqa-msg__rec', title: 'Слушать с этого места', 'aria-label': `Слушать запись с ${label}` }, `▶ ${label}`)
      : h('span', { class: 'cqa-msg__rec cqa-msg__rec--static', title: 'Секунда этой реплики в записи' }, label);
    recEls.set(m.msg_id, { el: chip, off: m.audio_offset_sec, seek });
    return chip;
  }

  function relabel() {
    for (const { el: c, off, seek } of recEls.values()) {
      const label = clock(off + fix);
      c.textContent = seek ? `▶ ${label}` : label;
      if (seek) c.setAttribute('aria-label', `Слушать запись с ${label}`);
    }
  }

  // Клик по реплике звонка (кроме кнопок-меток и выделения текста) — перейти к ней в записи.
  function onListClick(e) {
    const node = e.target.closest('.cqa-msg');
    if (!node || !root.contains(node)) return;
    const btn = e.target.closest('button, a');
    if (btn && !btn.classList.contains('cqa-msg__rec')) return;
    const sel = window.getSelection?.();
    if (!btn && sel && !sel.isCollapsed && node.contains(sel.anchorNode)) return;
    emit(root, 'cqa:msg-click', { msg_id: node.dataset.msgId }); // реплика до начала записи — плеер сам скажет об этом
  }

  function setPlaying({ msg_id = null, scroll = false } = {}) {
    if (playingId !== msg_id) {
      msgEls.get(playingId)?.classList.remove('cqa-msg--playing');
      playingId = msg_id;
    }
    const node = msgEls.get(msg_id);
    if (!node) return;
    node.classList.add('cqa-msg--playing');
    if (!scroll) return;
    const box = scrollParent(node);
    const r = node.getBoundingClientRect();
    const top = box ? box.getBoundingClientRect().top : 0;
    const bottom = box ? box.getBoundingClientRect().bottom : window.innerHeight;
    if (r.top < top + 8 || r.bottom > bottom - 8) node.scrollIntoView({ behavior: 'smooth', block: r.height > bottom - top ? 'start' : 'center' });
  }

  async function load() {
    clear(root).append(skeletonRows(7));
    try {
      let tr = p.messages;
      if (!tr) tr = (await getConversation(p.conversation)).messages;
      renderMsgs(tr);
    } catch (e) {
      clear(root).append(errorState(e, load));
    }
  }

  function resetMarks() {
    for (const n of msgEls.values()) n.classList.remove('cqa-msg--hl', 'cqa-msg--pulse', 'cqa-msg--range', 'cqa-msg--range-start', 'cqa-msg--range-end');
    for (const { el: t, text } of msgText.values()) if (t.childNodes.length !== 1 || t.firstChild.nodeType !== 3) t.replaceChildren(text);
  }

  function markQuote(id, quote) {
    const rec = msgText.get(id);
    if (!rec || !quote) return;
    const at = findQuote(rec.text, quote);
    if (!at) return;
    rec.el.replaceChildren(rec.text.slice(0, at[0]), h('mark', { class: 'cqa-mark' }, rec.text.slice(at[0], at[1])), rec.text.slice(at[1]));
  }

  function highlight({ msg_ids = [], quote, quotes, from, to, scroll = true } = {}) {
    resetMarks();
    clearTimeout(pulseTimer);
    const range = [];
    if (from && to) {
      const a = order.indexOf(from), b = order.indexOf(to);
      if (a >= 0 && b >= 0) range.push(...order.slice(Math.min(a, b), Math.max(a, b) + 1));
    }
    range.forEach((id, i) => {
      const n = msgEls.get(id);
      if (!n) return;
      n.classList.add('cqa-msg--range');
      if (i === 0) n.classList.add('cqa-msg--range-start');
      if (i === range.length - 1) n.classList.add('cqa-msg--range-end');
    });
    const ids = msg_ids.filter((id) => msgEls.has(id));
    ids.forEach((id, i) => {
      msgEls.get(id).classList.add('cqa-msg--hl', 'cqa-msg--pulse');
      markQuote(id, quotes?.[i] ?? (i === 0 ? quote : null));
    });
    const first = msgEls.get(ids[0] || range[0]);
    if (first && scroll) first.scrollIntoView({ behavior: 'smooth', block: ids.length ? 'center' : 'start' });
    pulseTimer = setTimeout(() => { for (const n of msgEls.values()) n.classList.remove('cqa-msg--pulse'); }, 1600);
    return ids.length + range.length;
  }

  const onHl = (e) => highlight(e.detail || {});
  const onEv = (e) => {
    const d = e.detail || {};
    if (d.msg_id || d.msg_ids || d.from) highlight({ ...d, msg_ids: d.msg_ids || (d.msg_id ? [d.msg_id] : []) });
  };
  const onPlaying = (e) => setPlaying(e.detail || {});
  const onFix = (e) => { fix = Number(e.detail?.fix) || 0; relabel(); };
  el.addEventListener('cqa:highlight', onHl);
  el.addEventListener('cqa:evidence-click', onEv);
  el.addEventListener('cqa:playing', onPlaying);
  el.addEventListener('cqa:audio-fix', onFix);

  if (p.messages || p.conversation != null) load();
  else root.append(emptyState({ title: 'Нет диалога', text: 'Укажите параметр conversation.' }));

  return {
    update(np) {
      const reload = np.messages !== p.messages || np.conversation !== p.conversation;
      p = { ...p, ...np };
      if (reload) load(); else if (p.messages) renderMsgs(p.messages);
    },
    highlight,
    clear: resetMarks,
    unmount() {
      el.removeEventListener('cqa:highlight', onHl);
      el.removeEventListener('cqa:evidence-click', onEv);
      el.removeEventListener('cqa:playing', onPlaying);
      el.removeEventListener('cqa:audio-fix', onFix);
      clearTimeout(pulseTimer);
      root.remove();
    },
  };
}
