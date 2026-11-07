// Таблица диалогов: фильтры, сортировка по итогу, выбор строк и запуск оценки, экспорт (FR-EXP-01), новый диалог.
// Параметры: group, appeal ('open' | 'any' | 'none' — фильтр апелляций по последней оценке).
import { h, clear, emit, channelBadge, langChip, score, skeletonRows, errorState, emptyState, toast } from '../ui.js';
import { listConversations, downloadExport } from '../api.js';

const APPEAL_FILTER = [['', 'Апелляции: все'], ['open', 'Есть открытые'], ['any', 'Были апелляции'], ['none', 'Без апелляций']];

export function mount(el, params = {}) {
  let p = { ...params };
  let rows = [];
  const st = { q: '', lang: '', channel: '', flag: false, review: false, appeal: APPEAL_FILTER.some(([v]) => v && v === p.appeal) ? p.appeal : '', sort: null, selected: new Set() };
  const root = h('div', { class: 'cqa-page' });
  el.append(root);
  const body = h('div');

  function visible() {
    let r = rows.filter((x) => {
      const l = x.latest;
      if (st.q && !x.conversation_id.toLowerCase().includes(st.q.toLowerCase())) return false;
      if (st.lang && String(x.language).toLowerCase() !== st.lang) return false;
      if (st.channel && (x.channel === 'voice call' ? 'voice call' : 'chat') !== st.channel) return false;
      if (st.flag && !l?.critical) return false;
      if (st.review && !l?.needs_review) return false;
      if (st.appeal === 'open' && !(l?.open_appeals > 0)) return false;
      if (st.appeal === 'any' && !(l?.appeals > 0)) return false;
      if (st.appeal === 'none' && l?.appeals > 0) return false;
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
      select('Язык', 'lang', [['', 'Все языки'], ['ru', 'RU'], ['kz', 'KZ'], ['en', 'EN']]),
      select('Канал', 'channel', [['', 'Все каналы'], ['chat', 'Чат'], ['voice call', 'Звонок']]),
      toggle('Грубая ошибка', 'flag'), toggle('Требует проверки', 'review'),
      select('Апелляции', 'appeal', APPEAL_FILTER),
      h('span', { class: 'cqa-toolbar__spacer' }),
      (st.q || st.lang || st.channel || st.flag || st.review || st.appeal)
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
  function reset() { Object.assign(st, { q: '', lang: '', channel: '', flag: false, review: false, appeal: '' }); renderTable(); }
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
          h('td', { class: 'cqa-num' }, appealCell(l)));
        return tr;
      })));
  }

  function appealCell(l) {
    const open = l?.open_appeals || 0, done = Math.max(0, (l?.appeals || 0) - open);
    if (!open && !done) return h('span', { class: 'cqa-faint' }, '—');
    return h('span', { class: 'cqa-tags cqa-list__appeals' },
      open ? h('span', { class: 'cqa-badge cqa-badge--accent', title: 'Открытые апелляции ждут проверяющего' }, `${open} откр.`) : null,
      done ? h('span', { class: 'cqa-badge cqa-badge--muted', title: 'Рассмотренные апелляции' }, `${done} рассм.`) : null);
  }

  // Экспорт: файл скачивается через api.js, у файла сдачи показываем итог проверки формата (X-Validation-Errors).
  const exportNote = h('span', { class: 'cqa-export__note', id: 'cqa-export-note', 'aria-live': 'polite' });
  async function exportFile(path, params, btn) {
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Готовим…';
    try {
      const { blob, filename, validationErrors } = await downloadExport(path, { group_id: p.group || 'DEV', ...params });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: filename, hidden: true });
      root.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      if (validationErrors != null) {
        exportNote.className = `cqa-export__note cqa-badge ${validationErrors ? 'cqa-badge--no' : 'cqa-badge--yes'}`;
        exportNote.textContent = validationErrors ? `${filename}: ошибок проверки формата — ${validationErrors}` : `${filename}: формат проверен, ошибок нет`;
        exportNote.title = validationErrors ? 'Подробности: python scripts/export_results.py --check <файл>' : '';
      }
      toast(root, `Файл ${filename} скачан.`);
    } catch (e) {
      toast(root, e.message || String(e));
    } finally { btn.disabled = false; btn.textContent = label; }
  }
  function exportBar() {
    const b = (id, text, title, path, params) => {
      const btn = h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm', id, title, onclick: () => exportFile(path, params, btn) }, text);
      return btn;
    };
    return h('div', { class: 'cqa-export', role: 'group', 'aria-label': 'Экспорт результатов группы' },
      h('span', { class: 'cqa-faint cqa-export__label' }, 'Экспорт'),
      b('cqa-export-csv', '⇩ CSV', 'Таблица для Excel: финальные ответы и баллы, итог AI и финальный', '/export', { format: 'csv' }),
      b('cqa-export-json', '⇩ JSON', 'Тот же набор с обоснованиями, доказательствами и апелляциями', '/export', { format: 'json' }),
      b('cqa-export-results', '⇩ Файл сдачи', 'results.json в формате организаторов 1.0 с проверкой формата', '/export/results', {}),
      exportNote);
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
      h('div', null, h('h1', { class: 'cqa-h1' }, 'Диалоги'), h('div', { class: 'cqa-pagehead__sub' }, `Группа ${p.group || 'DEV'}: оценки AI, финальные итоги и метки для проверки`)),
      h('div', { class: 'cqa-pagehead__actions cqa-list__actions' }, exportBar(),
        h('button', { type: 'button', class: 'cqa-btn cqa-btn--primary', id: 'cqa-list-new', title: 'Вставить переписку и оценить её сразу', onclick: () => emit(root, 'cqa:navigate', { to: '#/new' }) }, '+ Новый диалог'))),
    h('div', { class: 'cqa-panel' }, body));
  load();

  return {
    update(np) { const g = np.group !== p.group; p = { ...p, ...np }; if (g) { st.selected.clear(); load(); } },
    unmount() { el.removeEventListener('cqa:refresh', onRefresh); root.remove(); },
  };
}
