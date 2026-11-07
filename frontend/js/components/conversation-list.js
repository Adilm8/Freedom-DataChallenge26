// Таблица диалогов: фильтры, сортировка по итогу, выбор строк и запуск оценки, экспорт (FR-EXP-01), импорт набора, новый диалог.
// Параметры: group, appeal ('open' | 'any' | 'none' — фильтр апелляций по последней оценке).
import { h, clear, emit, channelBadge, langChip, score, skeletonRows, errorState, emptyState, toast, fmtScore } from '../ui.js';
import { listConversations, downloadExport, getAnalytics, getReviewQueue } from '../api.js';

const APPEAL_FILTER = [['', 'Апелляции: все'], ['open', 'Есть открытые'], ['any', 'Были апелляции'], ['none', 'Без апелляций']];
// Короткие подписи причин из очереди проверки: вместо одинаковой метки «Требует проверки» на 70% строк — почему именно.
const WHY = { failed: 'нет оценки', missing: 'нет ответа', appeal: 'апелляция', guard: 'противоречие фактам', validator: 'цитата не найдена', low_confidence: 'низк. увер.' };
const WHY_ORDER = ['failed', 'missing', 'appeal', 'guard', 'validator', 'low_confidence'];

export function mount(el, params = {}) {
  let p = { ...params };
  let rows = [];
  let topics = new Map(); // id диалога → тема (из обзора последней оценки, GET /analytics)
  let why = new Map(); // id диалога → {причина: [коды критериев]} (GET /review-queue)
  const st = { q: '', lang: '', channel: '', flag: false, review: false, appeal: '', sort: null, selected: new Set() };
  // Фильтры из адреса (переход с дашборда): ?lang=kz&channel=voice%20call&flag=1&review=1&appeal=open или ?ids=1,2&label=…
  const on = (v) => v === '1' || v === 'true';
  Object.assign(st, { lang: String(p.lang || '').toLowerCase(), channel: p.channel || '', flag: on(p.flag), review: on(p.review),
    appeal: APPEAL_FILTER.some(([v]) => v && v === p.appeal) ? p.appeal : (on(p.appeals) ? 'open' : '') });
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
      body.append(emptyState({ title: 'В этой группе пока нет диалогов', text: 'Импортируйте набор диалогов организаторов (по group_id из API или из JSON-файла), чтобы начать оценку.', actionLabel: 'Импорт набора', onAction: () => emit(root, 'cqa:import-request', { group: p.group }), icon: '⇩' }));
      return;
    }
    const toolbar = h('div', { class: 'cqa-toolbar' },
      h('input', { class: 'cqa-input', type: 'search', placeholder: 'Поиск по id', value: st.q, 'aria-label': 'Поиск по id', style: 'width:180px',
        oninput: (e) => { st.q = e.target.value; refreshTable(); } }),
      st.ids ? h('span', { class: 'cqa-listfilter', title: 'Диалоги, выбранные на дашборде' }, h('span', null, `${st.idsLabel} · ${st.ids.size}`),
        h('button', { type: 'button', 'aria-label': 'Снять отбор с дашборда', onclick: () => { st.ids = null; syncHash(); renderTable(); } }, '×')) : null,
      select('Язык', 'lang', [['', 'Все языки'], ['ru', 'RU'], ['kz', 'KZ'], ['en', 'EN']]),
      select('Канал', 'channel', [['', 'Все каналы'], ['chat', 'Чат'], ['voice call', 'Звонок']]),
      toggle('Грубая ошибка', 'flag'), toggle('Требует проверки', 'review'),
      select('Апелляции', 'appeal', APPEAL_FILTER),
      h('span', { class: 'cqa-toolbar__spacer' }),
      (st.q || st.lang || st.channel || st.flag || st.review || st.appeal || st.ids)
        ? h('button', { type: 'button', class: 'cqa-btn cqa-btn--ghost cqa-btn--sm', onclick: reset }, 'Сбросить фильтры') : null,
      incomplete().length ? h('button', { type: 'button', class: 'cqa-btn', id: 'cqa-list-rerun',
        title: 'Оценить ещё раз только неполные и упавшие оценки; готовые ответы критериев берутся из прошлой оценки',
        onclick: () => emit(root, 'cqa:run-request', { ids: incomplete().map((r) => r.id), group: p.group || 'DEV', rows, preset: { reuse: 'auto' },
          title: 'Дооценить неполные' }) }, `Дооценить неполные (${incomplete().length})`) : null,
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
  function reset() { Object.assign(st, { q: '', lang: '', channel: '', flag: false, review: false, appeal: '', ids: null }); syncHash(); renderTable(); }
  // Снятые фильтры не должны вернуться из адреса при обновлении страницы.
  function syncHash() {
    const qs = location.hash.split('?')[1];
    if (!qs) return;
    const g = new URLSearchParams(qs).get('group');
    emit(root, 'cqa:location', { to: '#/conversations' + (g ? `?group=${encodeURIComponent(g)}` : '') });
  }
  // Неполная (часть критериев без ответа) или упавшая последняя оценка.
  function incomplete() { return rows.filter((r) => r.latest && (r.latest.status === 'partial' || r.latest.status === 'failed')); }
  function runRequest() { emit(root, 'cqa:run-request', { ids: [...st.selected], group: p.group || 'DEV', rows }); }

  function table(list) {
    const allOn = list.every((r) => st.selected.has(r.id));
    const sortBtn = h('button', { type: 'button', class: 'cqa-th-sort', 'data-dir': st.sort || null, 'aria-label': 'Сортировка по итогу',
      onclick: () => { st.sort = st.sort === null ? 'desc' : st.sort === 'desc' ? 'asc' : null; renderTable(); } },
      'Итог AI / финальный', st.sort === 'desc' ? '↓' : st.sort === 'asc' ? '↑' : '↕');
    return h('table', { class: 'cqa-table cqa-list-table' },
      h('thead', null, h('tr', null,
        h('th', { style: 'width:36px' }, h('input', { type: 'checkbox', class: 'cqa-check', checked: allOn, 'aria-label': 'Выбрать все',
          onchange: (e) => { list.forEach((r) => (e.target.checked ? st.selected.add(r.id) : st.selected.delete(r.id))); renderTable(); } })),
        h('th', null, 'Диалог'), h('th', { class: 'cqa-num' }, sortBtn), h('th', { class: 'cqa-list__heat', title: 'Критерии 01–08 по финальной оценке' }, 'Критерии'), h('th', { class: 'cqa-list__narrow' }, 'Язык, канал'),
        h('th', { class: 'cqa-list__topic' }, 'Тема'), h('th', { class: 'cqa-list__tags' }, 'Метки'), h('th', { class: 'cqa-num cqa-list__ap' }, 'Апелляции'))),
      h('tbody', null, list.map((r) => {
        const l = r.latest;
        const tr = h('tr', { tabindex: 0, 'aria-selected': st.selected.has(r.id) ? 'true' : 'false',
          onclick: (e) => { if (!e.target.closest('input')) open(r.id); },
          onkeydown: (e) => { if (e.key === 'Enter' && e.target === tr) open(r.id); } },
          h('td', null, h('input', { type: 'checkbox', class: 'cqa-check', checked: st.selected.has(r.id), 'aria-label': `Выбрать ${r.conversation_id}`,
            onchange: (e) => { e.target.checked ? st.selected.add(r.id) : st.selected.delete(r.id); renderTable(); } })),
          h('td', null, h('span', { class: 'cqa-row-id' }, r.conversation_id)),
          h('td', { class: 'cqa-num' }, l && (l.status === 'partial' || l.status === 'failed')
            ? h('span', { class: 'cqa-list__partial', title: l.status === 'failed' ? 'Оценка не выполнена: причина в карточке, блок «Сырой ответ»'
              : `Неполная оценка: без ответа ${(l.criteria || []).filter((c) => c.answer == null).length || 'часть'} крит. Итог не окончательный` },
              l.status === 'failed' ? 'ошибка' : 'неполная', l.final_total != null ? h('span', { class: 'cqa-faint' }, fmtScore(l.final_total)) : null)
            : l
            ? h('span', { style: 'display:inline-flex;gap:10px;align-items:baseline' },
              score(l.ai_total, l.ai_total === l.final_total ? '' : 'cqa-faint'),
              l.ai_total !== l.final_total ? [h('span', { class: 'cqa-faint' }, '→'), score(l.final_total)] : null)
            : h('span', { class: 'cqa-badge cqa-badge--muted' }, 'Не оценён')),
          h('td', { class: 'cqa-list__heat' }, heat(l)),
          h('td', { class: 'cqa-list__narrow' }, h('span', { class: 'cqa-list__lc' }, langChip(r.language), channelBadge(r.channel))),
          h('td', { class: 'cqa-list__topic' }, topics.get(r.id) ? h('span', { class: 'cqa-list__topictext', title: topics.get(r.id) }, topics.get(r.id)) : h('span', { class: 'cqa-faint' }, '—')),
          h('td', { class: 'cqa-list__tags' }, h('div', { class: 'cqa-tags' },
            l?.critical ? h('span', { class: 'cqa-badge cqa-badge--flag' }, 'Грубая ошибка') : null,
            l?.needs_review ? reviewWhy(r.id) : null)),
          h('td', { class: 'cqa-num cqa-list__ap' }, appealCell(l)));
        return tr;
      })));
  }

  // Тепловая полоска: клетка на критерий (зелёный — выполнен, янтарь — частично, красный — нет, серый — N/A; 08 — флаг).
  function heat(l) {
    const cs = l?.criteria;
    if (!cs?.length) return h('span', { class: 'cqa-faint' }, '—');
    return h('span', { class: 'cqa-heat', role: 'img', 'aria-label': cs.map((c) => `${c.key}: ${heatText(c)}`).join(', ') },
      cs.map((c) => h('span', { class: `cqa-heat__c cqa-heat__c--${heatKind(c)}`, title: `${c.key} · ${heatText(c)}` })));
  }
  function heatKind(c) {
    if (c.answer == null) return 'miss';
    if (c.pct == null) return c.answer === 'yes' ? 'flag' : c.answer === 'no' ? 'clear' : 'na';
    return c.pct >= 100 ? 'yes' : c.pct <= 0 ? 'no' : 'part';
  }
  function heatText(c) {
    if (c.answer == null) return 'нет ответа модели';
    if (c.pct == null) return c.answer === 'yes' ? 'грубая ошибка' : c.answer === 'no' ? 'нарушений нет' : 'N/A';
    return c.pct >= 100 ? 'выполнен' : c.pct <= 0 ? 'не выполнен' : `частично, ${c.pct}%`;
  }

  function reviewWhy(id) {
    const w = why.get(id);
    if (!w) return h('span', { class: 'cqa-badge cqa-badge--warn', title: 'Требует проверки' }, 'Проверить');
    const parts = WHY_ORDER.filter((r) => w[r]).map((r) => `${WHY[r]}${w[r].length ? `: ${w[r].join(', ')}` : ''}`);
    return h('span', { class: 'cqa-badge cqa-badge--warn', title: `Требует проверки — ${parts.join('; ')}` }, 'Проверить');
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
      const { blob, filename, validationErrors, resultsOk, resultsError } = await downloadExport(path, { group_id: p.group || 'DEV', ...params });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: filename, hidden: true });
      root.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      if (validationErrors != null) {
        // Формат может быть верным, а записи — со статусом error (нет оценки): это тоже не зелёный итог.
        const recs = resultsOk != null ? ` · записей ok ${resultsOk} / error ${resultsError ?? 0}` : '';
        const bad = validationErrors || resultsError;
        exportNote.className = `cqa-export__note cqa-badge ${bad ? 'cqa-badge--no' : 'cqa-badge--yes'}`;
        exportNote.textContent = validationErrors ? `${filename}: ошибок проверки формата — ${validationErrors}${recs}` : `${filename}: формат проверен${recs}`;
        exportNote.title = validationErrors ? 'Подробности: python scripts/export_results.py --check <файл>' : '';
      }
      toast(root, `Файл ${filename} скачан.`);
    } catch (e) {
      toast(root, e.message || String(e));
    } finally { btn.disabled = false; btn.textContent = label; }
  }
  function exportBar() {
    const b = (id, text, title, path, params) => {
      const btn = h('button', { type: 'button', class: 'cqa-btn', id, title, onclick: () => exportFile(path, params, btn) }, text);
      return btn;
    };
    // Один пункт «Экспорт» с выпадающим списком вместо трёх кнопок: шапка экрана не перегружена.
    const menu = h('details', { class: 'cqa-menu' },
      h('summary', { class: 'cqa-btn', title: 'Выгрузить результаты группы' }, 'Экспорт', h('span', { class: 'cqa-menu__caret', 'aria-hidden': 'true' }, '▾')),
      h('div', { class: 'cqa-menu__list', role: 'menu', onclick: (e) => { if (e.target.closest('button')) e.currentTarget.parentElement.open = false; } },
        b('cqa-export-csv', 'Таблица CSV (Excel)', 'Финальные ответы и баллы, итог AI и финальный', '/export', { format: 'csv' }),
        b('cqa-export-json', 'Полный JSON', 'Тот же набор с обоснованиями, доказательствами и апелляциями', '/export', { format: 'json' }),
        b('cqa-export-results', 'Файл сдачи (results.json)', 'Формат организаторов 1.0 с проверкой формата', '/export/results', {})));
    return h('div', { class: 'cqa-export', role: 'group', 'aria-label': 'Экспорт результатов группы' }, exportNote, menu);
  }

  async function load({ quiet = false } = {}) {
    if (!quiet) clear(body).append(skeletonRows(7));
    try {
      rows = await listConversations({ group_id: p.group || 'DEV' });
      const known = new Set(rows.map((r) => r.id));
      for (const id of [...st.selected]) if (!known.has(id)) st.selected.delete(id);
      renderTable();
      loadExtras();
    } catch (e) {
      clear(body).append(errorState(e, load));
    }
  }
  // Тема и причины проверки — дополнительные запросы: таблица видна сразу, колонки дополняются, когда ответы придут.
  let extrasToken = 0;
  async function loadExtras() {
    const my = ++extrasToken;
    const g = p.group || 'DEV';
    const [a, q] = await Promise.all([getAnalytics({ group_id: g }).catch(() => null), getReviewQueue({ group_id: g }).catch(() => null)]);
    if (my !== extrasToken) return;
    topics = new Map();
    for (const t of a?.topics || []) for (const id of t.ids || []) topics.set(Number(id), t.topic);
    why = new Map();
    for (const it of q || []) {
      const w = why.get(it.conversation_id) || {};
      for (const r of it.reasons || [it.reason]) {
        w[r] ||= [];
        if (it.criterion_key && !w[r].includes(it.criterion_key)) w[r].push(it.criterion_key);
      }
      why.set(it.conversation_id, w);
    }
    if (rows.length) refreshTable();
  }

  // После прогона оценки оболочка шлёт cqa:refresh: перечитываем итоги без мигания и с тем же выбором.
  const onRefresh = () => load({ quiet: true });
  el.addEventListener('cqa:refresh', onRefresh);

  root.append(
    h('div', { class: 'cqa-pagehead' },
      h('div', null, h('h1', { class: 'cqa-h1' }, 'Диалоги'), h('div', { class: 'cqa-pagehead__sub' }, `Группа ${p.group || 'DEV'}: оценки AI, финальные итоги и метки для проверки`)),
      h('div', { class: 'cqa-pagehead__actions cqa-list__actions' }, exportBar(),
        h('button', { type: 'button', class: 'cqa-btn', id: 'cqa-list-import', title: 'Набор диалогов по group_id из API организаторов или из JSON-файла',
          onclick: () => emit(root, 'cqa:import-request', {}) }, 'Импорт набора'),
        h('button', { type: 'button', class: 'cqa-btn', id: 'cqa-list-new', title: 'Вставить переписку и оценить её сразу', onclick: () => emit(root, 'cqa:navigate', { to: '#/new' }) }, '+ Новый диалог'))),
    h('div', { class: 'cqa-panel' }, body));
  load();

  return {
    update(np) { const g = np.group !== p.group; p = { ...p, ...np }; if (g) { st.selected.clear(); load(); } },
    unmount() { el.removeEventListener('cqa:refresh', onRefresh); root.remove(); },
  };
}
