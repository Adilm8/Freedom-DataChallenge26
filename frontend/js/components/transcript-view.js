// Транскрипт: реплики блоками, метки критериев на репликах-доказательствах, подсветка и прокрутка.
import { h, clear, emit, ROLE, skeletonRows, errorState, emptyState } from '../ui.js';
import { getConversation } from '../api.js';

export function mount(el, params = {}) {
  let p = { ...params };
  let msgEls = new Map();
  let order = [];
  let fadeTimer = null;
  const root = h('div', { class: 'cqa-tr-root' });
  el.append(root);

  function tagsByMsg() {
    const map = new Map();
    for (const e of p.evidence || []) {
      for (const id of e.msg_ids || []) {
        if (!map.has(id)) map.set(id, []);
        const arr = map.get(id);
        if (!arr.some((t) => t.key === e.key)) arr.push({ key: e.key, flag: !!e.flag });
      }
    }
    return map;
  }

  function renderMsgs(transcript) {
    clear(root);
    msgEls = new Map();
    order = transcript.map((m) => m.msg_id);
    if (!transcript.length) { root.append(emptyState({ title: 'Транскрипт пуст', text: 'В этом диалоге нет реплик.' })); return; }
    const tags = tagsByMsg();
    const list = h('div', { class: 'cqa-tr', role: 'log' });
    for (const m of transcript) {
      const cls = ['cqa-msg', `cqa-msg--${m.role}`, m.internal ? 'cqa-msg--internal' : ''].join(' ');
      const time = String(m.time || '').includes('T') ? m.time.slice(11, 19) : m.time;
      const node = h('div', { class: cls, id: `msg-${m.msg_id}`, dataset: { msgId: m.msg_id } },
        h('div', { class: 'cqa-msg__meta' },
          h('span', { class: 'cqa-msg__role' }, ROLE[m.role] || m.role),
          m.internal ? h('span', { class: 'cqa-badge cqa-badge--warn' }, 'внутренний разговор') : null,
          h('span', { class: 'cqa-msg__time' }, time),
          h('span', { class: 'cqa-msg__id' }, m.msg_id),
          (tags.get(m.msg_id) || []).length
            ? h('span', { class: 'cqa-msg__tags' }, tags.get(m.msg_id).map((t) =>
              h('button', { type: 'button', class: `cqa-msg__tag cqa-tip ${t.flag ? 'cqa-msg__tag--flag' : ''}`, 'data-tip': `Критерий ${t.key}: показать в результате`,
                onclick: () => emit(root, 'cqa:criterion-click', { key: t.key }) }, t.key)))
            : null),
        h('div', { class: 'cqa-msg__text' }, m.text));
      msgEls.set(m.msg_id, node);
      list.append(node);
    }
    root.append(list);
  }

  async function load() {
    clear(root).append(skeletonRows(7));
    try {
      let tr = p.transcript;
      if (!tr) tr = (await getConversation(p.conversation)).transcript;
      renderMsgs(tr);
    } catch (e) {
      clear(root).append(errorState(e, load));
    }
  }

  function highlight({ msg_ids = [], from, to, scroll = true } = {}) {
    let ids = msg_ids.slice();
    if (from && to) {
      const a = order.indexOf(from), b = order.indexOf(to);
      if (a >= 0 && b >= 0) ids = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    }
    for (const n of msgEls.values()) n.classList.remove('cqa-msg--hl');
    clearTimeout(fadeTimer);
    const nodes = ids.map((id) => msgEls.get(id)).filter(Boolean);
    nodes.forEach((n) => n.classList.add('cqa-msg--hl'));
    if (nodes[0] && scroll) nodes[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    fadeTimer = setTimeout(() => nodes.forEach((n) => n.classList.remove('cqa-msg--hl')), 6000);
  }

  const onHl = (e) => highlight(e.detail || {});
  const onEv = (e) => {
    const d = e.detail || {};
    if (d.msg_id || d.from) highlight({ msg_ids: d.msg_id ? [d.msg_id] : [], from: d.from, to: d.to });
  };
  el.addEventListener('cqa:highlight', onHl);
  el.addEventListener('cqa:evidence-click', onEv);

  if (p.transcript || p.conversation != null) load();
  else root.append(emptyState({ title: 'Нет диалога', text: 'Укажите параметр conversation.' }));

  return {
    update(np) {
      const reload = np.transcript !== p.transcript || np.conversation !== p.conversation;
      p = { ...p, ...np };
      if (reload) load(); else if (p.transcript) renderMsgs(p.transcript);
    },
    highlight,
    unmount() {
      el.removeEventListener('cqa:highlight', onHl);
      el.removeEventListener('cqa:evidence-click', onEv);
      clearTimeout(fadeTimer);
      root.remove();
    },
  };
}
