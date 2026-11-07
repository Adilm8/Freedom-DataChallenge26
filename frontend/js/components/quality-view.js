// Экран качества (FR-OPS-05, NFR-12…14): прогоны run_eval.py на gold-разметке DEV и их сравнение.
// Параметры: runs — выбранные прогоны через запятую (до 3), сохраняются в адресе (cqa:location).
// Данные: GET /quality/runs (список), GET /quality/runs/{name} (метрики по критериям, языкам, калибровка).
// В mock-режиме данные вымышленные — экран говорит об этом баннером.
import { h, clear, emit, errorState, emptyState, fmtDate, LANG, channelLabel } from '../ui.js';
import { listQualityRuns, getQualityRun } from '../api.js';
import { createTip, fmtPct, fmtNum, fmtUsd, plural, vpanel, clamp01 } from './viz.js';

const SLOTS = ['var(--cqa-viz-1)', 'var(--cqa-viz-2)', 'var(--cqa-viz-3)'];
const MAX_SEL = 3;
const STRATEGY = { grouped: 'по группам', single: 'один вызов', per_criterion: 'по критерию' };
const SPLIT = { dev: 'dev', holdout: 'holdout', all: 'все' };
const CONF = [['high', 'высокая'], ['medium', 'средняя'], ['low', 'низкая']];
// Цели из architecture/quality-eval.md §2 (NFR-01, 14). better: 1 — больше лучше, -1 — меньше лучше.
const T = {
  agreement: { goal: 0.9, better: 1, text: '≥ 90%' }, crit: { goal: 0.8, better: 1, text: '≥ 80%' },
  step: { goal: 0.95, better: 1, text: '≥ 95%' }, recall: { goal: 1, better: 1, text: '100%' },
  mae: { goal: 5, better: -1, text: '≤ 5' }, w10: { goal: 0.9, better: 1, text: '≥ 90%' },
  changed: { goal: 0.05, better: -1, text: '≤ 5%' }, delta: { goal: 2, better: -1, text: '≤ 2 балла' },
};
const meets = (t, v) => v != null && t && (t.better > 0 ? v >= t.goal - 1e-9 : v <= t.goal + 1e-9);

const runLabel = (r) => r.model || r.provider || r.name;
const goldBadge = (r) => (r.gold_source || []).includes('draft')
  ? h('span', { class: 'cqa-badge cqa-badge--warn', title: 'Эталон — черновик Claude, не проверенная Лидой разметка' }, (r.gold_source || []).includes('gold') ? 'gold + черновик' : 'черновик')
  : (r.gold_source || []).includes('gold') ? h('span', { class: 'cqa-badge cqa-badge--yes' }, 'gold') : null;

export function mount(el, params = {}) {
  let p = { ...params };
  let list = null;
  let token = 0;
  const details = new Map(); // name → детали или Promise
  let sel = []; // [{name, slot}] — цвет закреплён за прогоном, а не за позицией
  let sort = { key: 'created_at', dir: -1 };
  const root = h('div', { class: 'cqa-page cqa-q' });
  el.append(root);
  const tip = createTip(root);

  const runs = () => (list?.runs || []);
  const slotOf = (n) => sel.find((s) => s.name === n)?.slot;

  function syncLocation() {
    const q = sel.map((s) => s.name).join(',');
    emit(root, 'cqa:location', { to: q ? `#/quality?runs=${encodeURIComponent(q)}` : '#/quality' });
  }
  function toggle(name) {
    if (slotOf(name) != null) sel = sel.filter((s) => s.name !== name);
    else if (sel.length < MAX_SEL) {
      const used = new Set(sel.map((s) => s.slot));
      sel.push({ name, slot: [0, 1, 2].find((i) => !used.has(i)) });
    }
    syncLocation();
    renderAll();
    fetchSelected();
  }

  // ---------- Таблица прогонов ----------
  const COLS = [
    ['created_at', 'Время', (r) => r.created_at || ''],
    ['model', 'Модель', (r) => runLabel(r)],
    ['strategy', 'Стратегия', (r) => r.strategy || ''],
    ['dialogs', 'Выборка', (r) => r.dialogs ?? -1],
    ['mean_agreement', 'Согласие', (r) => r.mean_agreement ?? -1, true],
    ['mae', 'MAE итога', (r) => (r.mae == null ? Infinity : r.mae), true],
    ['within_10', '±5 / ±10', (r) => r.within_10 ?? -1, true],
    ['flag_recall', '08: recall / precision', (r) => r.flag_recall ?? -1, true],
    ['cost_per_dialog_usd', 'Цена · время', (r) => (r.cost_per_dialog_usd == null ? Infinity : r.cost_per_dialog_usd), true],
    ['stability', 'Повтор', (r) => (r.stability?.changed_share == null ? Infinity : r.stability.changed_share), true],
  ];

  function runsTable() {
    const getter = COLS.find((c) => c[0] === sort.key)?.[2] || ((r) => r.created_at);
    const rows = runs().slice().sort((a, b) => {
      const x = getter(a), y = getter(b);
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * sort.dir || (b.created_at || '').localeCompare(a.created_at || '');
    });
    const th = ([key, label, , num]) => {
      const on = sort.key === key;
      return h('th', { class: num ? 'cqa-num' : '', 'aria-sort': on ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none' },
        h('button', { type: 'button', class: 'cqa-th-sort', 'data-dir': on ? 'on' : null,
          onclick: () => { sort = { key, dir: on ? -sort.dir : (key === 'mae' || key.includes('cost') || key === 'stability' ? 1 : -1) }; renderAll(); } },
        label, on ? (sort.dir > 0 ? '↑' : '↓') : '↕'));
    };
    const table = h('table', { class: 'cqa-table cqa-q__runs' },
      h('thead', null, h('tr', null, h('th', { style: 'width:36px' }, h('span', { class: 'cqa-sr' }, 'Сравнить')), COLS.map(th))),
      h('tbody', null, rows.map((r) => {
        const slot = slotOf(r.name);
        const can = r.complete && !r.error;
        const tr = h('tr', { 'aria-selected': slot != null ? 'true' : 'false', class: can ? '' : 'cqa-q__run--off',
          onclick: (e) => { if (can && !e.target.closest('input')) toggle(r.name); } },
        h('td', null, can
          ? h('span', { class: 'cqa-q__pick' },
            h('input', { type: 'checkbox', class: 'cqa-check', checked: slot != null, disabled: slot == null && sel.length >= MAX_SEL,
              'aria-label': `Сравнить прогон ${runLabel(r)} от ${fmtDate(r.created_at)}`, onchange: () => toggle(r.name) }),
            slot != null ? h('span', { class: 'cqa-q__sw', style: `background:${SLOTS[slot]}`, 'aria-hidden': 'true' }) : null)
          : null),
        h('td', { class: 'cqa-q__time' }, fmtDate(r.created_at)),
        h('td', null, h('div', { class: 'cqa-q__model' }, runLabel(r)), h('div', { class: 'cqa-q__prov' }, r.provider || '', r.prompt_version ? ` · промпт ${r.prompt_version}` : '')),
        h('td', null, STRATEGY[r.strategy] || r.strategy || '—'),
        h('td', null, h('div', { class: 'cqa-q__split' }, h('span', { class: 'cqa-chip' }, SPLIT[r.split] || r.split || '—'), goldBadge(r)),
          r.dialogs != null ? h('div', { class: 'cqa-q__prov' }, `${r.dialogs} ${plural(r.dialogs, 'диалог', 'диалога', 'диалогов')}${r.repeat > 1 ? ` × ${r.repeat}` : ''}`) : null),
        r.error
          ? h('td', { colspan: COLS.length - 4 }, h('span', { class: 'cqa-badge cqa-badge--no' }, r.error))
          : !r.complete
            ? [h('td', { colspan: 4 }, h('span', { class: 'cqa-badge cqa-badge--warn', title: 'Файл *.partial.json: прогон прерван или ещё идёт; метрики считаются в конце' }, 'не завершён')),
              h('td', { class: 'cqa-num' }, h('div', null, fmtUsd(r.cost_per_dialog_usd)), h('div', { class: 'cqa-q__prov' }, `оплачено ${fmtUsd(r.cost_total_usd)}`)),
              h('td', { class: 'cqa-num' }, '—')]
            : [metricTd(r.mean_agreement, T.agreement, fmtPct(r.mean_agreement, 1)),
              metricTd(r.mae, T.mae, fmtNum(r.mae)),
              h('td', { class: 'cqa-num' }, h('span', { class: 'cqa-q__metric' }, `${fmtPct(r.within_5)} / `, metricSpan(r.within_10, T.w10, fmtPct(r.within_10)))),
              h('td', { class: 'cqa-num' }, r.flag_recall == null && r.flag_precision == null ? '—' : `${fmtPct(r.flag_recall)} / ${fmtPct(r.flag_precision)}`),
              h('td', { class: 'cqa-num' }, h('div', null, fmtUsd(r.cost_per_dialog_usd)), h('div', { class: 'cqa-q__prov' }, r.mean_seconds == null ? '—' : `${fmtNum(r.mean_seconds, 1)} с на диалог`)),
              h('td', { class: 'cqa-num' }, r.stability ? metricSpan(r.stability.changed_share, T.changed, fmtPct(r.stability.changed_share, 1)) : h('span', { class: 'cqa-faint', title: 'Нет повтора: запустите с --repeat 2' }, '—'))]);
        if (r.stability) tr.lastChild.title = `доля ответов, сменившихся при повторе; итог в среднем ±${fmtNum(r.stability.mean_total_delta)}`;
        return tr;
      })));
    return vpanel({ title: 'Прогоны', sub: `Отметьте до ${MAX_SEL} прогонов, чтобы сравнить их ниже. Клик по заголовку — сортировка. ✓ — значение в цели NFR-01. Цена — за один диалог.` },
      h('div', { class: 'cqa-tablewrap' }, table));
  }
  function metricSpan(v, t, text) {
    return h('span', { class: 'cqa-q__metric' }, text, meets(t, v) ? h('span', { class: 'cqa-q__ok', title: `в цели (${t.text})`, 'aria-label': `в цели ${t.text}` }, '✓') : null);
  }
  function metricTd(v, t, text) { return h('td', { class: 'cqa-num' }, metricSpan(v, t, text)); }

  // ---------- Сравнение ----------
  function cmpRow(label, sub, cells, { better = 1, target, bar = true, fmt = (v) => fmtPct(v, 1), extra } = {}) {
    const vals = cells.map((c) => c.v).filter((v) => v != null);
    const best = vals.length > 1 ? (better > 0 ? Math.max(...vals) : Math.min(...vals)) : null;
    const allSame = vals.length > 1 && vals.every((v) => Math.abs(v - vals[0]) < 1e-9);
    return h('tr', null,
      h('th', { scope: 'row', class: 'cqa-qcmp__label' }, h('div', null, label), sub ? h('div', { class: 'cqa-qcmp__sub' }, sub) : null),
      cells.map((c) => {
        const isBest = best != null && !allSame && c.v != null && Math.abs(c.v - best) < 1e-9;
        const td = h('td', { class: `cqa-qcmp__cell ${isBest ? 'cqa-qcmp__cell--best' : ''}` },
          h('div', { class: 'cqa-qcmp__val' }, h('b', null, c.v == null ? '—' : fmt(c.v)),
            c.n != null ? h('span', { class: 'cqa-faint' }, ` n=${c.n}`) : null,
            meets(target, c.v) ? h('span', { class: 'cqa-q__ok', title: `в цели (${target.text})` }, '✓') : null,
            isBest ? h('span', { class: 'cqa-qcmp__star', title: 'лучшее значение среди выбранных' }, 'лучший') : null),
          bar && c.v != null ? h('div', { class: 'cqa-qcmp__bar' }, h('span', { style: `width:${clamp01(c.v) * 100}%;background:${c.color}` })) : null,
          c.extra ? h('div', { class: 'cqa-qcmp__sub' }, c.extra) : null);
        tip.bind(td, () => ({ title: label, rows: [{ value: c.v == null ? '—' : fmt(c.v), label: c.run, key: c.color }, c.extra ? { value: '', label: c.extra } : null].filter(Boolean) }));
        return td;
      }),
      h('td', { class: 'cqa-qcmp__goal' }, target ? target.text : extra || ''));
  }

  function comparison(ds) {
    const cols = ds.map(({ d, slot }) => ({ d, color: SLOTS[slot], run: `${runLabel(d)} · ${fmtDate(d.created_at)}` }));
    const cell = (f, n, extra) => cols.map((c) => ({ v: f(c.d), n: n ? n(c.d) : null, color: c.color, run: c.run, extra: extra ? extra(c.d) : null }));
    const keys = [...new Set(ds.flatMap(({ d }) => (d.criteria || []).map((c) => c.key)))].sort();
    const critOf = (d, k) => (d.criteria || []).find((c) => c.key === k);
    const title = (k) => ds.map(({ d }) => critOf(d, k)?.title).find((t) => t && t !== k) || '';
    const langs = [...new Set(ds.flatMap(({ d }) => Object.keys(d.by_language || {})))].sort((a, b) => ['RU', 'KZ', 'EN'].indexOf(a.toUpperCase()) - ['RU', 'KZ', 'EN'].indexOf(b.toUpperCase()));
    const chans = [...new Set(ds.flatMap(({ d }) => Object.keys(d.by_channel || {})))].sort();
    const group = (text) => h('tr', { class: 'cqa-qcmp__group' }, h('th', { colspan: cols.length + 2, scope: 'colgroup' }, text));
    const mean = (d) => d.mean_agreement;

    const body = h('tbody', null,
      group('Итог'),
      cmpRow('Среднее согласие по критериям', 'доля точных совпадений ответа, без флага 08', cell(mean), { target: T.agreement }),
      cmpRow('MAE итога', 'среднее отклонение итога от эталона, баллы', cell((d) => d.total?.mae, (d) => d.total?.n), { better: -1, target: T.mae, bar: false, fmt: (v) => fmtNum(v) }),
      cmpRow('Максимальное отклонение', 'баллы', cell((d) => d.total?.max_abs), { better: -1, bar: false, fmt: (v) => fmtNum(v) }),
      cmpRow('Итог в пределах ±5', null, cell((d) => d.total?.within_5)),
      cmpRow('Итог в пределах ±10', null, cell((d) => d.total?.within_10), { target: T.w10 }),
      group('По критериям — точное совпадение'),
      keys.map((k) => {
        const any = critOf(ds[0].d, k) || ds.map(({ d }) => critOf(d, k)).find(Boolean);
        const isFlag = any && 'recall' in any;
        if (isFlag) {
          return [cmpRow(`${k} · ${title(k)}`, 'флаг: recall — найдены все грубые ошибки эталона', cell((d) => critOf(d, k)?.recall, (d) => critOf(d, k)?.n,
            (d) => `precision ${fmtPct(critOf(d, k)?.precision)} · совпадение ${fmtPct(critOf(d, k)?.exact)}`), { target: T.recall })];
        }
        return cmpRow(`${k} · ${title(k)}`, any && 'within_1_step' in any ? 'шкала; ниже — «± 1 ступень»' : null,
          cell((d) => critOf(d, k)?.exact, (d) => critOf(d, k)?.n, (d) => ('within_1_step' in (critOf(d, k) || {}) ? `± 1 ступень ${fmtPct(critOf(d, k).within_1_step)}` : null)),
          { target: T.crit });
      }),
      langs.length ? group('По языкам — согласие · MAE итога') : null,
      langs.map((l) => cmpRow(LANG[l.toLowerCase()] || l, null, cell((d) => d.by_language?.[l]?.agreement, (d) => d.by_language?.[l]?.n, (d) => `MAE ${fmtNum(d.by_language?.[l]?.mae)}`),
        { extra: 'не хуже среднего на 10 п.п.' })),
      chans.length ? group('По каналам — согласие · MAE итога') : null,
      chans.map((c) => cmpRow(channelLabel(c), null, cell((d) => d.by_channel?.[c]?.agreement, (d) => d.by_channel?.[c]?.n, (d) => `MAE ${fmtNum(d.by_channel?.[c]?.mae)}`))),
      group('Цена и время'),
      cmpRow('Цена одной оценки', 'долларов на диалог', cell((d) => d.cost_per_dialog_usd), { better: -1, bar: false, fmt: fmtUsd }),
      cmpRow('Время одной оценки', 'секунд на диалог', cell((d) => d.mean_seconds), { better: -1, bar: false, fmt: (v) => `${fmtNum(v, 1)} с` }),
      cmpRow('Доля «требует проверки»', 'диалоги с предупреждением или низкой уверенностью', cell((d) => d.checks?.needs_review_share), { better: -1 }));

    // Предупреждение о несопоставимых прогонах: разные выборки или эталон
    const splits = new Set(ds.map(({ d }) => d.split)), golds = new Set(ds.map(({ d }) => (d.gold_source || []).join('+')));
    const dialogs = new Set(ds.map(({ d }) => d.dialogs));
    const warn = splits.size > 1 || golds.size > 1 || dialogs.size > 1
      ? h('div', { class: 'cqa-banner cqa-banner--warn cqa-q__note' }, h('span', { class: 'cqa-banner__icon' }, '!'),
        h('div', null, h('div', { class: 'cqa-banner__title' }, 'Прогоны не полностью сопоставимы'),
          h('div', null, [splits.size > 1 ? 'разные выборки' : null, golds.size > 1 ? 'разный эталон' : null, dialogs.size > 1 ? 'разное число диалогов (например, звонки не отправлялись в Gemini)' : null].filter(Boolean).join(' · '))))
      : null;

    return vpanel({ title: 'Сравнение прогонов', sub: 'Лучшее значение в строке отмечено «лучший»; ✓ — значение в цели. Полоса — доля от 0 до 100%.' },
      h('div', { class: 'cqa-vlegend' }, cols.map((c) => h('span', { class: 'cqa-vlegend__item' }, h('span', { class: 'cqa-vlegend__sw', style: `background:${c.color}` }), c.run))),
      warn,
      h('div', { class: 'cqa-tablewrap' }, h('table', { class: 'cqa-qcmp' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Метрика'),
          cols.map((c) => h('th', { scope: 'col' }, h('span', { class: 'cqa-q__sw', style: `background:${c.color}` }), h('span', null, runLabel(c.d)),
            h('div', { class: 'cqa-qcmp__sub' }, `${fmtDate(c.d.created_at)} · ${STRATEGY[c.d.strategy] || c.d.strategy} · ${SPLIT[c.d.split] || c.d.split} · ${c.d.dialogs} ${plural(c.d.dialogs || 0, 'диалог', 'диалога', 'диалогов')}`))),
          h('th', { scope: 'col' }, 'Цель'))),
        body)));
  }

  // ---------- Стабильность, калибровка, цена ----------
  function stabilityPanel(ds) {
    const withS = ds.filter(({ d }) => d.stability);
    const body = withS.length
      ? h('div', { class: 'cqa-q__cards' }, withS.map(({ d, slot }) => h('div', { class: 'cqa-q__card' },
        h('div', { class: 'cqa-q__cardhead' }, h('span', { class: 'cqa-q__sw', style: `background:${SLOTS[slot]}` }), runLabel(d)),
        h('div', { class: 'cqa-q__big' }, metricSpan(d.stability.changed_share, T.changed, fmtPct(d.stability.changed_share, 1))),
        h('div', { class: 'cqa-q__cap' }, `ответов сменилось между двумя одинаковыми прогонами (из ${d.stability.answers}); цель ${T.changed.text}`),
        h('div', { class: 'cqa-q__big cqa-q__big--sm' }, metricSpan(d.stability.mean_total_delta, T.delta, `${fmtNum(d.stability.mean_total_delta)} балла`)),
        h('div', { class: 'cqa-q__cap' }, `среднее изменение итога; цель ${T.delta.text}`))))
      : null;
    const missing = ds.filter(({ d }) => !d.stability);
    return vpanel({ title: 'Стабильность', sub: 'NFR-14: повтор с той же конфигурацией почти не меняет ответы.' },
      body,
      missing.length ? h('div', { class: 'cqa-q__hint' }, `${withS.length ? 'Без повтора: ' + missing.map(({ d }) => runLabel(d)).join(', ') + '. ' : 'У выбранных прогонов нет повтора. '}Запустите с повтором:`,
        h('code', { class: 'cqa-q__cmd' }, 'python eval/run_eval.py … --repeat 2')) : null);
  }

  function calibrationPanel(ds) {
    const rows = ds.map(({ d, slot }) => {
      const cal = d.calibration || {};
      const lv = CONF.filter(([k]) => cal[k]);
      if (!lv.length) return h('div', { class: 'cqa-q__card' }, h('div', { class: 'cqa-q__cardhead' }, h('span', { class: 'cqa-q__sw', style: `background:${SLOTS[slot]}` }), runLabel(d)), h('div', { class: 'cqa-faint' }, 'нет данных об уверенности'));
      const max = Math.max(0.0001, ...lv.map(([k]) => cal[k].error_rate));
      const hi = cal.high?.error_rate, lo = cal.low?.error_rate;
      const verdict = hi != null && lo != null
        ? lo > hi ? h('div', { class: 'cqa-q__verdict cqa-q__verdict--ok' }, h('span', { 'aria-hidden': 'true' }, '✓ '), hi > 0 ? `у «низкой» ошибок в ${(lo / hi).toFixed(1)} раза больше — уверенность помогает искать спорное` : 'у «высокой» ошибок нет — уверенность работает')
          : h('div', { class: 'cqa-q__verdict cqa-q__verdict--bad' }, h('span', { 'aria-hidden': 'true' }, '! '), 'у «низкой» ошибок не больше, чем у «высокой» — уверенности верить нельзя')
        : h('div', { class: 'cqa-q__verdict' }, 'нужны обе ступени — «высокая» и «низкая»');
      return h('div', { class: 'cqa-q__card' },
        h('div', { class: 'cqa-q__cardhead' }, h('span', { class: 'cqa-q__sw', style: `background:${SLOTS[slot]}` }), runLabel(d)),
        h('div', { class: 'cqa-q__cal', role: 'list' }, lv.map(([k, l]) => {
          const r = h('div', { class: 'cqa-q__calrow', role: 'listitem', tabindex: 0, 'aria-label': `Уверенность ${l}: ошибок ${fmtPct(cal[k].error_rate)} из ${cal[k].n} ответов` },
            h('span', { class: 'cqa-q__callabel' }, l),
            h('span', { class: 'cqa-crow__track' }, h('span', { class: 'cqa-crow__fill', style: `width:${(cal[k].error_rate / max) * 100}%;background:${SLOTS[slot]}` })),
            h('b', { class: 'cqa-q__calval' }, fmtPct(cal[k].error_rate)), h('span', { class: 'cqa-faint cqa-q__caln' }, `n=${cal[k].n}`));
          tip.bind(r, { title: `Уверенность: ${l}`, rows: [{ value: fmtPct(cal[k].error_rate, 1), label: 'ответов не совпали с эталоном', key: SLOTS[slot] }, { value: String(cal[k].n), label: 'ответов' }] });
          return r;
        })),
        verdict);
    });
    return vpanel({ title: 'Калибровка уверенности', sub: 'Доля ошибок по уровню уверенности модели. У «низкой» ошибок должно быть заметно больше — тогда очередь «требует проверки» ловит спорные ответы.' },
      h('div', { class: 'cqa-q__cards' }, rows));
  }

  function costPanel(ds) {
    return vpanel({ title: 'Цена одной оценки', sub: 'Фактическая стоимость из usage провайдера; прогноз — по средней цене диалога.' },
      h('div', { class: 'cqa-q__cards' }, ds.map(({ d, slot }) => {
        const per = d.cost_per_dialog_usd;
        return h('div', { class: 'cqa-q__card' },
          h('div', { class: 'cqa-q__cardhead' }, h('span', { class: 'cqa-q__sw', style: `background:${SLOTS[slot]}` }), runLabel(d)),
          h('div', { class: 'cqa-q__big' }, per === 0 ? 'бесплатно' : fmtUsd(per), h('small', null, per ? ' за диалог' : '')),
          h('dl', { class: 'cqa-q__dl' },
            h('dt', null, 'Время'), h('dd', null, d.mean_seconds == null ? '—' : `${fmtNum(d.mean_seconds, 1)} с на диалог`),
            h('dt', null, 'Весь прогон'), h('dd', null, `${fmtUsd(d.cost_total_usd)} · ${d.dialogs} ${plural(d.dialogs || 0, 'диалог', 'диалога', 'диалогов')}${d.repeat > 1 ? ` × ${d.repeat}` : ''}`),
            h('dt', null, 'Контроль, 10 диалогов'), h('dd', null, per == null ? '—' : `≈ ${fmtUsd(per * 10)}`),
            h('dt', null, '1000 диалогов'), h('dd', null, per == null ? '—' : `≈ ${fmtUsd(per * 1000)}`),
            h('dt', null, 'Повторов вызова'), h('dd', null, d.checks?.retry_share == null ? '—' : `${fmtPct(d.checks.retry_share, 1)} из ${d.checks.calls}`)));
      })));
  }

  // ---------- Сборка ----------
  function header() {
    return h('div', { class: 'cqa-pagehead' },
      h('div', null, h('h1', { class: 'cqa-h1' }, 'Качество оценки'),
        h('div', { class: 'cqa-pagehead__sub' }, 'Согласие AI с эталонной разметкой DEV по прогонам run_eval.py: близость итога, точность по критериям и языкам, стабильность, цена.')),
      h('div', { class: 'cqa-pagehead__actions' }, h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm', onclick: () => load() }, '↻ Обновить')));
  }

  function mockBanner() {
    return list?.mock ? h('div', { class: 'cqa-banner cqa-banner--warn cqa-q__mock', role: 'note' }, h('span', { class: 'cqa-banner__icon' }, '!'),
      h('div', null, h('div', { class: 'cqa-banner__title' }, 'Демо-данные: прогоны вымышленные'),
        h('div', null, 'Режим ?mock=1 показывает, как выглядит экран. Цифры не получены моделью — настоящие метрики появятся после запуска run_eval.py.'))) : null;
  }

  let cmpEl = null;
  function renderAll() {
    clear(root);
    root.append(tip.el);
    tip.hide();
    root.append(header());
    const mb = mockBanner();
    if (mb) root.append(mb);
    if (!runs().length) {
      root.append(h('div', { class: 'cqa-panel' }, emptyState({ title: 'Прогонов пока нет', icon: '◎',
        text: `Экран читает файлы прогонов из ${list?.dir || 'eval/runs/'}. Запустите оценку на gold-разметке — бесплатная отладка на Gemini или платный прогон с согласия Лиды:` }),
      h('div', { class: 'cqa-q__cmds' },
        h('code', { class: 'cqa-q__cmd' }, 'python eval/run_eval.py --provider gemini --split dev --limit 3'),
        h('code', { class: 'cqa-q__cmd' }, 'python eval/run_eval.py --provider openrouter --model <модель> --split dev --repeat 2 --approved "Лида, ЧЧ:ММ"'))));
      return;
    }
    cmpEl = h('div', { class: 'cqa-q__cmp' });
    root.append(runsTable(), cmpEl);
    renderCmp();
  }

  function renderCmp() {
    if (!cmpEl) return;
    clear(cmpEl);
    if (!sel.length) {
      cmpEl.append(h('div', { class: 'cqa-panel' }, emptyState({ title: 'Выберите прогоны для сравнения', icon: '⇆', text: `Отметьте до ${MAX_SEL} завершённых прогонов в таблице.` })));
      return;
    }
    const ready = sel.map((s) => ({ ...s, d: details.get(s.name) })).filter((x) => x.d && !(x.d instanceof Promise) && !x.d.error);
    const failed = sel.map((s) => details.get(s.name)).filter((d) => d?.error);
    if (failed.length) cmpEl.append(h('div', { class: 'cqa-panel' }, errorState(failed[0].error, fetchSelected)));
    if (ready.length < sel.length - failed.length) cmpEl.classList.add('cqa-q__cmp--loading'); else cmpEl.classList.remove('cqa-q__cmp--loading');
    if (!ready.length) { if (!failed.length) cmpEl.append(h('div', { class: 'cqa-panel cqa-vpanel' }, h('div', { class: 'cqa-skeleton', style: 'height:260px' }))); return; }
    cmpEl.append(comparison(ready), h('div', { class: 'cqa-dash__grid cqa-dash__grid--three' }, stabilityPanel(ready), calibrationPanel(ready), costPanel(ready)));
  }

  function fetchSelected() {
    for (const s of sel) {
      if (details.has(s.name) && !details.get(s.name)?.error) continue;
      const pr = getQualityRun(s.name).then((d) => { details.set(s.name, d); }).catch((e) => { details.set(s.name, { error: e }); })
        .finally(() => { if (slotOf(s.name) != null) renderCmp(); });
      details.set(s.name, pr);
    }
    renderCmp();
  }

  async function load() {
    const my = ++token;
    if (!list) clear(root).append(header(), h('div', { class: 'cqa-panel cqa-vpanel' }, h('div', { class: 'cqa-skeleton', style: 'height:180px' })));
    try {
      const l = await listQualityRuns();
      if (my !== token) return;
      list = l;
      details.clear();
      const okNames = new Set(runs().filter((r) => r.complete && !r.error).map((r) => r.name));
      const want = String(p.runs || '').split(',').filter((n) => okNames.has(n));
      const pickDefault = runs().filter((r) => okNames.has(r.name)).slice(0, 2).map((r) => r.name);
      sel = (want.length ? want : sel.length ? sel.map((s) => s.name).filter((n) => okNames.has(n)) : pickDefault).slice(0, MAX_SEL).map((name, i) => ({ name, slot: i }));
      renderAll();
      fetchSelected();
    } catch (e) {
      if (my !== token) return;
      clear(root).append(header(), h('div', { class: 'cqa-panel' }, errorState(e, load)));
    }
  }
  load();

  return {
    update(np) { p = { ...p, ...np }; },
    unmount() { token++; tip.remove(); root.remove(); },
  };
}
