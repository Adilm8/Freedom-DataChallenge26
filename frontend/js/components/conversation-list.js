// Таблица диалогов: фильтры, сортировка по итогу, выбор строк и запуск оценки.
import { h, clear, emit, channelBadge, langChip, score, skeletonRows, errorState, emptyState } from '../ui.js';
import { listConversations } from '../api.js';

export function mount(el, params = {}) {
  let p = { ...params };
  let rows = [];
  const st = { q: '', lang: '', channel: '', flag: false, review: false, appeals: false, sort: null, selected: new Set() };
  // Фильтры из адреса (переход с дашборда): ?lang=kz&channel=voice%20call&flag=1&review=1&appeals=1 или ?ids=1,2&label=…
  const on = (v) => v === '1' || v === 'true';
  Object.assign(st, { lang: String(p.lang || '').toLowerCase(), channel: p.channel || '', flag: on(p.flag), review: on(p.review), appeals: on(p.appeals) });
  st.ids = p.ids ? new Set(String(p.ids).split(',').map(Number).filter((x) => !isNaN(x))) : null;
  st.idsLabel = p.label || 'отбор с дашборда';
  const root = h('div', { class: 'cqa-page' });
  el.append(root);
  const body = h('div');

  function visible() {
    let r = rows.filter((x) => {
      const l = x.latest;
      if (st.ids && !st.ids.has(x.id)) return false;
      if (st.q && !x.conversation_id.toLowerCase().includes(st.q.toLowerCase())) return false;
      if (st.lang && String(x.language).toLowerCase() !== st.lang) return false;
      if (st.channel && (x.channel === 'voice call' ? 'voice call' : 'chat') !== st.channel) return false;
      if (st.flag && !l?.critical) return false;
      if (st.review && !l?.needs_review) return false;
      if (st.appeals && !(l?.open_appeals > 0)) return false;
      return true;
    });
    if (st.sort) {
      const dir = st.sort === 'asc' ? 1 : -1;
      r = r.slice().sort((a, b) => {
        const x = a.latest?.final_total, y = b.latest?.final_total;
        if (x == null && y == null) return 0;
        if (x == null) return 1; // без оценки всегда внизу
        if (y == null) return -1;
        return (x - y) * dir;
      });
    }
    return r;
  }

  const open = (id) => emit(root, 'cqa:navigate', { to: `#/conversation/${id}` });

  function renderTable() {
    const list = visible();
    clear(body);
    if (!rows.length) {
      body.append(emptyState({ title: 'В этой группе пока нет диалогов', text: 'Импортируйте набор диалогов организаторов, чтобы начать оценку.', actionLabel: 'Импорт набора', onAction: () => emit(root, 'cqa:import-request', {}), icon: '⇩' }));
      return;
    }
    const toolbar = h('div', { class: 'cqa-toolbar' },
      h('input', { class: 'cqa-input', type: 'search', placeholder: 'Поиск по id', value: st.q, 'aria-label': 'Поиск по id', style: 'width:180px',
        oninput: (e) => { st.q = e.target.value; refreshTable(); } }),
      st.ids ? h('span', { class: 'cqa-listfilter', title: 'Диалоги, выбранные на дашборде' }, h('span', null, `${st.idsLabel} · ${st.ids.size}`),
        h('button', { type: 'button', 'aria-label': 'Снять отбор с дашборда', onclick: () => { st.ids = null; syncHash(); renderTable(); } }, '×')) : null,
      select('Язык', 'lang', [['', 'Все языки'], ['ru', 'RU'], ['kz', 'KZ'], ['en', 'EN']]),
      select('Канал', 'channel', [['', 'Все каналы'], ['chat', 'Чат'], ['voice call', 'Звонок']]),
      toggle('Грубая ошибка', 'flag'), toggle('Требует проверки', 'review'), toggle('Есть апелляции', 'appeals'),
      h('span', { class: 'cqa-toolbar__spacer' }),
      (st.q || st.lang || st.channel || st.flag || st.review || st.appeals || st.ids)
        ? h('button', { type: 'button', class: 'cqa-btn cqa-btn--ghost cqa-btn--sm', onclick: reset }, 'Сбросить фильтры') : null,
      h('button', { type: 'button', class: 'cqa-btn cqa-btn--primary', id: 'cqa-list-run', onclick: runRequest,
        title: st.selected.size ? 'Оценить выбранные диалоги' : 'Ничего не выбрано: оценить всю группу' },
      st.selected.size ? `Оценить (${st.selected.size})` : `Оценить группу (${rows.length})`));
    const wrap = h('div', { class: 'cqa-tablewrap' });
    if (!list.length) {
      wrap.append(emptyState({ title: 'Ничего не найдено', text: 'Измените условия поиска или сбросьте фильтры.', actionLabel: 'Сбросить фильтры', onAction: reset, icon: '⌕' }));
    } else wrap.append(table(list));
    body.append(toolbar, wrap, h('div', { class: 'cqa-tfoot' }, `Показано ${list.length} из ${rows.length}`));
  }

  // Перерисовка без потери фокуса в поиске: пересобираем только таблицу и подвал.
  function refreshTable() {
    const search = body.querySelector('input[type=search]');
    const had = document.activeElement === search;
    const pos = search?.selectionStart;
    renderTable();
    if (had) { const s = body.querySelector('input[type=search]'); s.focus(); s.setSelectionRange(pos, pos); }
  }

  function select(label, key, opts) {
    return h('select', { class: 'cqa-select', 'aria-label': label, onchange: (e) => { st[key] = e.target.value; renderTable(); } },
      opts.map(([v, t]) => h('option', { value: v, selected: st[key] === v }, t)));
  }
  function toggle(label, key) {
    return h('label', { class: 'cqa-toggle' }, h('input', { type: 'checkbox', checked: st[key], onchange: (e) => { st[key] = e.target.checked; renderTable(); } }), label);
  }
  function reset() { Object.assign(st, { q: '', lang: '', channel: '', flag: false, review: false, appeals: false, ids: null }); syncHash(); renderTable(); }
  // Снятые фильтры не должны вернуться из адреса при обновлении страницы.
  function syncHash() {
    const qs = location.hash.split('?')[1];
    if (!qs) return;
    const g = new URLSearchParams(qs).get('group');
    emit(root, 'cqa:location', { to: '#/conversations' + (g ? `?group=${encodeURIComponent(g)}` : '') });
  }
  function runRequest() { emit(root, 'cqa:run-request', { ids: [...st.selected], group: p.group || 'DEV', rows }); }

  function table(list) {
    const allOn = list.every((r) => st.selected.has(r.id));
    const sortBtn = h('button', { type: 'button', class: 'cqa-th-sort', 'data-dir': st.sort || null, 'aria-label': 'Сортировка по итогу',
      onclick: () => { st.sort = st.sort === null ? 'desc' : st.sort === 'desc' ? 'asc' : null; renderTable(); } },
      'Итог AI / финальный', st.sort === 'desc' ? '↓' : st.sort === 'asc' ? '↑' : '↕');
    return h('table', { class: 'cqa-table' },
      h('thead', null, h('tr', null,
        h('th', { style: 'width:36px' }, h('input', { type: 'checkbox', class: 'cqa-check', checked: allOn, 'aria-label': 'Выбрать все',
          onchange: (e) => { list.forEach((r) => (e.target.checked ? st.selected.add(r.id) : st.selected.delete(r.id))); renderTable(); } })),
        h('th', null, 'Диалог'), h('th', null, 'Канал'), h('th', null, 'Язык'),
        h('th', { class: 'cqa-num' }, sortBtn), h('th', null, 'Метки'), h('th', { class: 'cqa-num' }, 'Апелляции'))),
      h('tbody', null, list.map((r) => {
        const l = r.latest;
        const tr = h('tr', { tabindex: 0, 'aria-selected': st.selected.has(r.id) ? 'true' : 'false',
          onclick: (e) => { if (!e.target.closest('input')) open(r.id); },
          onkeydown: (e) => { if (e.key === 'Enter' && e.target === tr) open(r.id); } },
          h('td', null, h('input', { type: 'checkbox', class: 'cqa-check', checked: st.selected.has(r.id), 'aria-label': `Выбрать ${r.conversation_id}`,
            onchange: (e) => { e.target.checked ? st.selected.add(r.id) : st.selected.delete(r.id); renderTable(); } })),
          h('td', null, h('span', { class: 'cqa-row-id' }, r.conversation_id)),
          h('td', null, channelBadge(r.channel)), h('td', null, langChip(r.language)),
          h('td', { class: 'cqa-num' }, l
            ? h('span', { style: 'display:inline-flex;gap:10px;align-items:baseline' },
              score(l.ai_total, l.ai_total === l.final_total ? '' : 'cqa-faint'),
              l.ai_total !== l.final_total ? [h('span', { class: 'cqa-faint' }, '→'), score(l.final_total)] : null)
            : h('span', { class: 'cqa-badge cqa-badge--muted' }, 'Не оценён')),
          h('td', null, h('div', { class: 'cqa-tags' },
            l?.critical ? h('span', { class: 'cqa-badge cqa-badge--flag' }, 'Грубая ошибка') : null,
            l?.needs_review ? h('span', { class: 'cqa-badge cqa-badge--warn' }, 'Требует проверки') : null)),
          h('td', { class: 'cqa-num' }, l?.open_appeals ? h('span', { class: 'cqa-badge cqa-badge--accent' }, `${l.open_appeals} откр.`) : h('span', { class: 'cqa-faint' }, '—')));
        return tr;
      })));
  }

  async function load({ quiet = false } = {}) {
    if (!quiet) clear(body).append(skeletonRows(7));
    try {
      rows = await listConversations({ group_id: p.group || 'DEV' });
      const known = new Set(rows.map((r) => r.id));
      for (const id of [...st.selected]) if (!known.has(id)) st.selected.delete(id);
      renderTable();
    } catch (e) {
      clear(body).append(errorState(e, load));
    }
  }
  // После прогона оценки оболочка шлёт cqa:refresh: перечитываем итоги без мигания и с тем же выбором.
  const onRefresh = () => load({ quiet: true });
  el.addEventListener('cqa:refresh', onRefresh);

  root.append(
    h('div', { class: 'cqa-pagehead' },
      h('div', null, h('h1', { class: 'cqa-h1' }, 'Диалоги'), h('div', { class: 'cqa-pagehead__sub' }, `Группа ${p.group || 'DEV'}: оценки AI, финальные итоги и метки для проверки`))),
    h('div', { class: 'cqa-panel' }, body));
  load();

  return {
    update(np) { const g = np.group !== p.group; p = { ...p, ...np }; if (g) { st.selected.clear(); load(); } },
    unmount() { el.removeEventListener('cqa:refresh', onRefresh); root.remove(); },
  };
}
