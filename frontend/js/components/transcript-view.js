// Транскрипт: реплики блоками, метки критериев на репликах-доказательствах, подсветка и прокрутка.
// Подсветка (событие cqa:highlight или cqa:evidence-click на el): {msg_ids, quote, from, to, scroll}.
// msg_ids — реплики-доказательства (жёлтая подсветка, цитата выделяется в тексте); from/to — проверенный
// диапазон (полоса слева и мягкий фон). Подсветка держится до следующего клика.
import { h, clear, emit, ROLE, EVENT_LABEL, skeletonRows, errorState, emptyState } from '../ui.js';
import { getConversation } from '../api.js';

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');

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
  const root = h('div', { class: 'cqa-tr-root' });
  el.append(root);

  function tagsByMsg() {
    const map = new Map();
    for (const e of p.evidence || []) {
      for (const id of e.msg_ids || []) {
        if (!map.has(id)) map.set(id, []);
        const arr = map.get(id);
        if (!arr.some((t) => t.key === e.key)) arr.push({ key: e.key, flag: !!e.flag, title: e.title });
      }
    }
    return map;
  }

  function renderMsgs(messages) {
    const transcript = messages;
    clear(root);
    msgEls = new Map();
    msgText = new Map();
    order = transcript.map((m) => m.msg_id);
    if (!transcript.length) { root.append(emptyState({ title: 'Транскрипт пуст', text: 'В этом диалоге нет реплик.' })); return; }
    const tags = tagsByMsg();
    const list = h('div', { class: 'cqa-tr', role: 'log' });
    for (const m of transcript) {
      const cls = ['cqa-msg', `cqa-msg--${m.speaker}`, m.internal ? 'cqa-msg--internal' : ''].join(' ');
      const time = String(m.timestamp || '').includes('T') ? m.timestamp.slice(11, 19) : m.timestamp;
      const textEl = h('div', { class: 'cqa-msg__text' }, m.text);
      const node = h('div', { class: cls, id: `msg-${m.msg_id}`, dataset: { msgId: m.msg_id } },
        h('div', { class: 'cqa-msg__meta' },
          h('span', { class: 'cqa-msg__role' }, ROLE[m.speaker] || m.speaker),
          m.internal ? h('span', { class: 'cqa-badge cqa-badge--warn' }, 'внутренний разговор') : null,
          m.event ? h('span', { class: 'cqa-badge cqa-badge--muted' }, EVENT_LABEL[m.event] || m.event) : null,
          h('span', { class: 'cqa-msg__time' }, time),
          h('span', { class: 'cqa-msg__id' }, m.msg_id),
          (tags.get(m.msg_id) || []).length
            ? h('span', { class: 'cqa-msg__tags', 'aria-label': 'Критерии, для которых реплика — доказательство' }, tags.get(m.msg_id).map((t) =>
              h('button', { type: 'button', class: `cqa-msg__tag cqa-tip ${t.flag ? 'cqa-msg__tag--flag' : ''}`,
                'data-tip': `${t.key}${t.title ? ' · ' + t.title : ''}: показать критерий`, 'aria-label': `Критерий ${t.key}: показать в результате`,
                onclick: () => emit(root, 'cqa:criterion-click', { key: t.key, msg_id: m.msg_id }) }, t.key)))
            : null),
        textEl);
      msgEls.set(m.msg_id, node);
      msgText.set(m.msg_id, { el: textEl, text: m.text });
      list.append(node);
    }
    root.append(list);
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
  el.addEventListener('cqa:highlight', onHl);
  el.addEventListener('cqa:evidence-click', onEv);

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
      clearTimeout(pulseTimer);
      root.remove();
    },
  };
}
