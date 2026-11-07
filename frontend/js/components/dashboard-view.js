// Дашборд группы (FR-ANL-01…03): KPI, распределение итогов, выполнение по критериям, языки и каналы, темы.
// Параметры: group (группа данных), version (id версии чек-листа; по умолчанию — активная).
// Данные — GET /analytics и GET /conversations той же версии (итоги по диалогам для корзин гистограммы).
// Клик по цифре или полосе → cqa:navigate в список диалогов с фильтром (#/conversations?lang=…, ?ids=…&label=…).
// Наружу: cqa:navigate {to}, cqa:run-request {ids: [], group, rows}, cqa:import-request {group} (пустая группа). Внутрь: cqa:refresh на el — перечитать.
import { h, clear, emit, errorState, emptyState, fmtScore, scoreClass, LANG, channelLabel, ring } from '../ui.js';
import { getAnalytics, listConversations } from '../api.js';
import { createTip, fmtPct, fmtPct100, plural, tableToggle, vpanel, legend, clamp01 } from './viz.js';

const C1 = 'var(--cqa-viz-1)', C2 = 'var(--cqa-viz-2)';
const RESOLVED = [['yes', 'решён', 'var(--cqa-viz-good)'], ['unclear', 'неясно', 'var(--cqa-viz-neutral)'], ['no', 'не решён', 'var(--cqa-viz-bad)']];

const langName = (l) => LANG[String(l).toLowerCase()] || String(l).toUpperCase();
const nDialogs = (n) => `${n} ${plural(n, 'диалог', 'диалога', 'диалогов')}`;
/** Заливка полосы критерия по порогу: слабые видны сразу. */
const fillColor = (v) => (v == null ? C1 : v < 60 ? 'var(--cqa-no)' : v < 80 ? 'var(--cqa-warn-line)' : C1);

export function mount(el, params = {}) {
  let p = { ...params };
  let data = null, rows = [];
  let token = 0;
  let showAllTopics = false;
  const root = h('div', { class: 'cqa-page cqa-dash' });
  el.append(root);
  const tip = createTip(root);
  const group = () => p.group || 'DEV';
  const go = (to) => emit(root, 'cqa:navigate', { to });
  // Группа — в адресе списка: переход с дашборда открывает ту же группу, даже если в шапке выбрана другая.
  const listUrl = (q = {}) => `#/conversations?${new URLSearchParams({ group: group(), ...q }).toString()}`;
  const goIds = (ids, label) => go(listUrl({ ids: ids.join(','), label }));

  function header(a) {
    const ver = a?.checklist_version;
    return h('div', { class: 'cqa-pagehead' },
      h('div', null,
        h('h1', { class: 'cqa-h1' }, 'Дашборд'),
        h('div', { class: 'cqa-pagehead__sub' },
          `Группа ${group()}`, ver ? ` · «${ver.name || ver.key}» v${ver.version}` : '',
          ' · последние оценки с учётом апелляций')),
      h('div', { class: 'cqa-pagehead__actions' },
        h('button', { type: 'button', class: 'cqa-btn', onclick: () => load({ quiet: true }) }, '↻ Обновить'),
        h('a', { class: 'cqa-btn', href: listUrl() }, 'Все диалоги'),
        a?.not_evaluated ? h('button', { type: 'button', class: 'cqa-btn cqa-btn--primary', onclick: runRequest },
          `Оценить группу (${a.conversations})`) : null));
  }

  function runRequest() { emit(root, 'cqa:run-request', { ids: [], group: group(), rows }); }

  // ---------- KPI ----------
  function tile({ label, value, sub, cls = '', onClick, aria, hero }) {
    const tag = onClick ? 'button' : 'div';
    return h(tag, { class: `cqa-kpi ${hero ? 'cqa-kpi--hero' : ''} ${cls} ${onClick ? 'cqa-kpi--link' : ''}`, type: onClick ? 'button' : null,
      onclick: onClick || null, 'aria-label': aria || null },
    h('div', { class: 'cqa-kpi__label' }, label),
    h('div', { class: 'cqa-kpi__value' }, value),
    sub ? h('div', { class: 'cqa-kpi__sub' }, sub) : null);
  }

  function kpis(a) {
    const st = a.status_counts || {};
    const delta = a.avg_final_total != null && a.avg_ai_total != null ? +(a.avg_final_total - a.avg_ai_total).toFixed(2) : null;
    const notDone = (st.partial || 0) + (st.failed || 0);
    const r = a.resolved || {};
    const rs = { yes: r.yes || 0, no: r.no || 0, unclear: r.unclear || 0 };
    rs.total = rs.yes + rs.no + rs.unclear;
    return h('div', { class: 'cqa-kpis' },
      tile({ hero: true, label: 'Средний итог', aria: `Средний финальный итог ${fmtScore(a.avg_final_total)} из 100`,
        value: h('span', { class: 'cqa-kpi__herowrap' }, ring(a.avg_final_total, 72, 8),
          h('span', { class: `cqa-kpi__hero ${scoreClass(a.avg_final_total)}` }, fmtScore(a.avg_final_total), h('small', null, ' / 100'))),
        sub: [h('span', null, `AI: ${fmtScore(a.avg_ai_total)}`),
          delta ? h('span', { class: 'cqa-kpi__delta' }, `${delta > 0 ? '+' : ''}${delta.toFixed(2)} после апелляций`) : h('span', { class: 'cqa-faint' }, 'апелляции итог не меняли')] }),
      tile({ label: 'Оценено диалогов', value: [String(a.count), h('small', null, ` из ${a.conversations}`)],
        sub: [a.not_evaluated ? `не оценено ${a.not_evaluated}` : 'оценены все', notDone ? ` · неполных и с ошибкой ${notDone}` : ''],
        onClick: () => go(listUrl()), aria: `Оценено ${a.count} из ${a.conversations}: открыть список` }),
      tile({ label: 'Грубые ошибки', value: String(a.critical_count), cls: a.critical_count ? 'cqa-kpi--flag' : '',
        sub: a.count ? `${fmtPct(a.critical_count / a.count)} диалогов${a.ai_critical_count !== a.critical_count ? ` · AI: ${a.ai_critical_count}` : ''}` : null,
        onClick: a.critical_count ? () => go(listUrl({ flag: '1' })) : null, aria: `Грубые ошибки: ${a.critical_count}. Открыть список` }),
      tile({ label: 'Требует проверки', value: [String(a.needs_review_count), h('small', null, ` ${plural(a.needs_review_count, 'диалог', 'диалога', 'диалогов')}`)],
        cls: a.needs_review_count ? 'cqa-kpi--warn' : '',
        sub: a.review_queue_count != null ? `${a.review_queue_count} ${plural(a.review_queue_count, 'пункт', 'пункта', 'пунктов')} в очереди проверки` : null,
        onClick: a.needs_review_count ? () => go(listUrl({ review: '1' })) : null, aria: `Требует проверки: ${a.needs_review_count}. Открыть список` }),
      tile({ label: 'Открытые апелляции', value: String(a.appeals?.open ?? 0),
        sub: `решено: без изменений ${a.appeals?.confirmed ?? 0}, изменено ${a.appeals?.changed ?? 0}`,
        onClick: a.appeals?.open ? () => go(listUrl({ appeal: 'open' })) : null, aria: `Открытые апелляции: ${a.appeals?.open ?? 0}. Открыть список` }),
      tile({ label: 'Вопрос клиента решён', value: rs.total ? fmtPct(rs.yes / rs.total) : '—',
        sub: rs.total ? `не решён ${rs.no} · неясно ${rs.unclear} · из ${rs.total} ${plural(rs.total, 'диалога', 'диалогов', 'диалогов')}` : 'по резюме диалогов',
        aria: rs.total ? `Вопрос клиента решён в ${fmtPct(rs.yes / rs.total)} диалогов` : null }));
  }

  // ---------- Главное: вывод из цифр за 10 секунд ----------
  function insights(a) {
    const crit = (a.by_criterion || []).filter((c) => c.type !== 'flag' && c.avg_pct != null);
    const weak = crit.reduce((m, c) => (!m || c.avg_pct < m.avg_pct ? c : m), null);
    const item = ({ tone, title, sub, onClick, aria }) => h(onClick ? 'button' : 'div', {
      type: onClick ? 'button' : null, class: `cqa-insight cqa-insight--${tone} ${onClick ? 'cqa-insight--link' : ''}`, onclick: onClick || null, 'aria-label': aria || null },
    h('span', { class: 'cqa-insight__text' }, h('b', null, title), sub ? h('small', null, sub) : null),
    onClick ? h('span', { class: 'cqa-insight__go', 'aria-hidden': 'true' }, '→') : null);
    const items = [];
    if (weak) {
      const fails = weak.not_passed_ids || [];
      items.push(weak.avg_pct < 85
        ? item({ tone: weak.avg_pct < 60 ? 'bad' : 'warn', title: `${weak.key} ${weak.title} — ${fmtPct100(weak.avg_pct)}`,
          sub: `слабее всего${fails.length ? ` · не выполнен в ${fails.length} ${plural(fails.length, 'диалоге', 'диалогах', 'диалогах')}` : ''}`,
          onClick: fails.length ? () => goIds(fails, `${weak.key}: не выполнен`) : null, aria: `Слабее всего ${weak.key} ${weak.title}: открыть диалоги, где он не выполнен` })
        : item({ tone: 'ok', title: 'Все критерии выполняются на 85% и выше', sub: `самый слабый — ${weak.key} ${weak.title}, ${fmtPct100(weak.avg_pct)}` }));
    }
    items.push(a.critical_count
      ? item({ tone: 'bad', title: `Грубые ошибки: ${nDialogs(a.critical_count)}`, sub: 'флаг 08, открыть список', onClick: () => go(listUrl({ flag: '1' })) })
      : item({ tone: 'ok', title: 'Грубых ошибок нет', sub: `оценено ${nDialogs(a.count)}` }));
    if (a.needs_review_count) {
      items.push(item({ tone: 'warn', title: `На проверку: ${nDialogs(a.needs_review_count)}`, sub: 'низкая уверенность, противоречия', onClick: () => go('#/review'),
        aria: `Требует проверки: ${nDialogs(a.needs_review_count)}. Открыть очередь` }));
    }
    if (a.appeals?.open) {
      items.push(item({ tone: 'accent', title: `Открытых апелляций: ${a.appeals.open}`, sub: 'ждут решения', onClick: () => go('#/appeals') }));
    }
    return h('section', { class: 'cqa-insights', 'aria-label': 'Главное' }, h('div', { class: 'cqa-insights__label' }, 'Главное'), items);
  }

  // ---------- Распределение итогов ----------
  function bucketIds(b) {
    return rows.filter((r) => {
      const v = r.latest?.final_total;
      return v != null && v >= b.from && (v < b.to || (b.to === 100 && v === 100));
    }).map((r) => r.id);
  }

  function histogram(a) {
    const all = a.histogram || [];
    const twin = all.some((b) => b.ai_count !== b.count);
    // Пустые корзины слева не рисуем: шкала начинается за одну корзину до первой непустой (финальной или AI),
    // иначе столбцы прижаты к правому краю, а 70% панели пустые. Таблица под графиком — по всем корзинам.
    const first = all.findIndex((b) => b.count || (twin && b.ai_count));
    const bins = first > 0 ? all.slice(first - 1) : all;
    const lo = bins[0]?.from ?? 0, hi = bins[bins.length - 1]?.to ?? 100;
    const max = Math.max(1, ...bins.map((b) => Math.max(b.count, twin ? b.ai_count : 0)));
    const plot = h('div', { class: `cqa-hist ${twin ? 'cqa-hist--twin' : ''} ${bins.length > 6 ? 'cqa-hist--dense' : ''}`, role: 'group',
      style: `grid-template-columns:repeat(${Math.max(1, bins.length)}, minmax(0, 1fr))`,
      'aria-label': `Распределение финальных итогов по корзинам 10 баллов, от ${lo} до ${hi}` });
    for (const b of bins) {
      const ids = bucketIds(b);
      const label = `Итог ${b.from}–${b.to}`;
      const col = h('button', { type: 'button', class: 'cqa-hist__col', disabled: !b.count,
        'aria-label': `${label}: ${b.count} ${plural(b.count, 'диалог', 'диалога', 'диалогов')}${twin ? `, по AI ${b.ai_count}` : ''}${b.count ? '. Открыть список' : ''}`,
        onclick: () => b.count && goIds(ids, label) },
      h('span', { class: 'cqa-hist__bars' },
        h('span', { class: 'cqa-hist__bar', style: `height:${(b.count / max) * 100}%;background:${C1}` },
          b.count ? h('span', { class: 'cqa-hist__val' }, String(b.count)) : null),
        twin ? h('span', { class: 'cqa-hist__bar cqa-hist__bar--ai', style: `height:${(b.ai_count / max) * 100}%;background:${C2}` }) : null),
      h('span', { class: 'cqa-hist__x' }, String(b.from)));
      tip.bind(col, () => ({ title: label, rows: [{ value: String(b.count), label: 'финальный итог', key: C1 },
        twin ? { value: String(b.ai_count), label: 'итог AI', key: C2 } : null].filter(Boolean) }));
      plot.append(col);
    }
    const avg = a.avg_final_total;
    // Среднее — тонкая линия без подписи на графике (подпись не наезжает на столбцы), значение — в легенде.
    if (avg != null && hi > lo) plot.append(h('span', { class: 'cqa-hist__mean', style: `left:${clamp01((avg - lo) / (hi - lo)) * 100}%`, 'aria-hidden': 'true' }));
    plot.append(h('span', { class: 'cqa-hist__xend', 'aria-hidden': 'true' }, String(hi)));
    const table = h('table', { class: 'cqa-table cqa-vtable' },
      h('thead', null, h('tr', null, h('th', null, 'Итог'), h('th', { class: 'cqa-num' }, 'Финальный'), h('th', { class: 'cqa-num' }, 'AI'))),
      h('tbody', null, all.map((b) => h('tr', null, h('td', null, `${b.from}–${b.to}`), h('td', { class: 'cqa-num' }, b.count), h('td', { class: 'cqa-num' }, b.ai_count)))));
    return vpanel({ title: 'Распределение итогов', sub: `Сколько диалогов в каждой корзине по 10 баллов${lo > 0 ? ` (ниже ${lo} — ни одного)` : ''}. Клик по столбцу — эти диалоги.`,
      actions: tableToggle(table) },
    legend([...(twin ? [{ label: 'Финальный (с апелляциями)', key: C1 }, { label: 'AI', key: C2 }] : []),
      ...(avg != null ? [{ label: `среднее ${fmtScore(avg)}`, key: 'var(--cqa-text)', shape: 'tick' }] : [])]),
    h('div', { class: 'cqa-hist__wrap' }, plot, h('div', { class: 'cqa-hist__axis' }, 'итог диалога, баллы')),
    table);
  }

  // ---------- Критерии ----------
  function criteria(a) {
    const list = (a.by_criterion || []).filter((c) => c.type !== 'flag');
    const flags = (a.by_criterion || []).filter((c) => c.type === 'flag');
    const twin = list.some((c) => c.ai_avg_pct != null && c.avg_pct != null && Math.abs(c.ai_avg_pct - c.avg_pct) > 0.001);
    const body = h('div', { class: 'cqa-crow-list', role: 'list' });
    const worst = list.reduce((m, c) => (c.avg_pct != null && c.avg_pct < 85 && (!m || c.avg_pct < m.avg_pct) ? c : m), null);
    for (const c of list) {
      const v = c.avg_pct;
      const fails = c.not_passed_ids || [];
      const titleText = `${c.key} ${c.title}`;
      const bar = h('div', { class: 'cqa-crow__track' },
        v != null ? h('span', { class: 'cqa-crow__fill', style: `width:${clamp01(v / 100) * 100}%;background:${fillColor(v)}` }) : null,
        twin && c.ai_avg_pct != null ? h('span', { class: 'cqa-crow__tick', style: `left:${clamp01(c.ai_avg_pct / 100) * 100}%;background:${C2}` }) : null);
      const row = h('div', { class: `cqa-crow ${c === worst ? 'cqa-crow--worst' : ''}`, role: 'listitem', tabindex: 0,
        'aria-label': `${titleText}: ${c.type === 'scale' ? 'средняя доля балла' : 'выполнено'} ${fmtPct100(v)}${c.na_rate ? `, N/A ${fmtPct(c.na_rate)}` : ''}, не выполнено в ${fails.length}` },
      h('span', { class: `cqa-code ${v != null && v < 60 ? 'cqa-code--no' : v != null && v < 80 ? 'cqa-code--part' : ''}` }, c.key),
      h('div', { class: 'cqa-crow__main' },
        h('div', { class: 'cqa-crow__title' }, h('span', { class: 'cqa-crow__name' }, c.title),
          h('span', { class: 'cqa-crow__w' }, `вес ${c.weight}`),
          c.type === 'scale' ? h('span', { class: 'cqa-crow__w' }, `полный балл ${fmtPct(c.pass_rate)}`) : null),
        bar),
      h('b', { class: 'cqa-crow__val' }, fmtPct100(v)),
      h('span', { class: `cqa-crow__na ${c.na_rate ? '' : 'cqa-faint'}` }, `N/A ${fmtPct(c.na_rate)}`),
      fails.length
        ? h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm cqa-crow__fails', onclick: (e) => { e.stopPropagation(); goIds(fails, `${c.key}: не выполнен`); },
          'aria-label': `Открыть ${fails.length} ${plural(fails.length, 'диалог', 'диалога', 'диалогов')}, где ${c.key} не выполнен`,
          title: `Диалоги, где ${c.key} не выполнен` }, `${fails.length} не вып.`)
        : h('span', { class: 'cqa-crow__fails cqa-faint' }, '—'));
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' && fails.length) goIds(fails, `${c.key}: не выполнен`); });
      tip.bind(row, () => ({ title: titleText, rows: [
        { value: fmtPct100(v), label: c.type === 'scale' ? 'средняя доля балла (финальная)' : '«Да» среди применимых (финальный)', key: C1 },
        twin ? { value: fmtPct100(c.ai_avg_pct), label: 'по ответам AI', key: C2 } : null,
        { value: fmtPct(c.na_rate), label: 'N/A (вес перераспределён)' },
        { value: Object.entries(c.answers || {}).map(([k, n]) => `${k === 'yes' ? 'Да' : k === 'no' ? 'Нет' : k === 'na' ? 'N/A' : k}: ${n}`).join(' · ') || '—', label: 'ответы' },
        c.low_confidence_count ? { value: String(c.low_confidence_count), label: 'с низкой уверенностью' } : null,
        c.appeals_count ? { value: `${c.appeals_count} / ${c.appeals_changed}`, label: 'апелляций / изменено' } : null,
      ].filter(Boolean) }));
      body.append(row);
    }
    const flagRows = flags.map((c) => {
      const n = (c.answers || {}).yes || 0;
      return h('button', { type: 'button', class: `cqa-cflag ${n ? 'cqa-cflag--on' : ''}`, disabled: !n,
        onclick: () => n && go(listUrl({ flag: '1' })), 'aria-label': `${c.key} ${c.title}: ${n} ${plural(n, 'диалог', 'диалога', 'диалогов')}` },
      h('span', { class: 'cqa-code cqa-code--flag' }, c.key),
      h('span', { class: 'cqa-cflag__title' }, c.title, h('small', null, ' · флаг, без баллов')),
      h('b', null, n ? `${n} ${plural(n, 'диалог', 'диалога', 'диалогов')}` : 'нарушений нет'),
      c.count ? h('span', { class: 'cqa-faint' }, fmtPct(n / c.count)) : null);
    });
    return vpanel({ title: 'Выполнение по критериям', sub: 'Бинарный критерий — доля «Да» среди применимых, шкала — средняя доля балла. N/A не входит в долю. «не вып.» — открыть диалоги, где критерий не выполнен.' },
      twin ? legend([{ label: 'Финальный (с апелляциями)', key: C1 }, { label: 'AI', key: C2, shape: 'tick' }]) : null,
      body, flagRows.length ? h('div', { class: 'cqa-cflags' }, flagRows) : null);
  }

  // ---------- Разрезы ----------
  function slices(title, map, toQuery, name) {
    const entries = Object.entries(map || {});
    const body = h('div', { class: 'cqa-slice-list' }, entries.map(([k, s]) => {
      const v = s.avg_total;
      const row = h('button', { type: 'button', class: 'cqa-slice', onclick: () => go(listUrl(toQuery(k))),
        'aria-label': `${name(k)}: средний итог ${fmtScore(v)}, оценено ${s.count} из ${s.conversations}. Открыть список` },
      h('span', { class: 'cqa-slice__name' }, name(k)),
      h('span', { class: 'cqa-slice__n' }, `${s.count} / ${s.conversations}`),
      h('span', { class: 'cqa-crow__track' }, v != null ? h('span', { class: 'cqa-crow__fill', style: `width:${clamp01(v / 100) * 100}%;background:${C1}` }) : null),
      h('b', { class: 'cqa-slice__val' }, fmtScore(v)),
      h('span', { class: 'cqa-slice__tags' },
        s.critical_count ? h('span', { class: 'cqa-badge cqa-badge--flag' }, `грубых ${s.critical_count}`) : null,
        s.needs_review_count ? h('span', { class: 'cqa-badge cqa-badge--warn' }, `проверить ${s.needs_review_count}`) : null));
      tip.bind(row, () => ({ title: name(k), rows: [
        { value: fmtScore(v), label: 'средний финальный итог', key: C1 },
        { value: fmtScore(s.avg_ai_total), label: 'средний итог AI' },
        { value: `${s.count} из ${s.conversations}`, label: 'оценено' },
        { value: String(s.critical_count), label: 'грубых ошибок' },
        { value: String(s.needs_review_count), label: 'требует проверки' }] }));
      return row;
    }));
    return vpanel({ title, sub: 'Средний финальный итог, оценено / всего. Клик — диалоги разреза.' },
      entries.length ? body : h('div', { class: 'cqa-faint cqa-vempty' }, 'Нет данных'));
  }

  function resolvedPanel(a) {
    const r = a.resolved || {};
    const total = RESOLVED.reduce((s, [k]) => s + (r[k] || 0), 0);
    const seg = h('div', { class: 'cqa-segbar', role: 'img',
      'aria-label': `Вопрос клиента: ${RESOLVED.map(([k, l]) => `${l} ${r[k] || 0}`).join(', ')}` },
    RESOLVED.filter(([k]) => r[k]).map(([k, l, color]) => {
      const part = h('span', { class: 'cqa-segbar__part', style: `flex:${r[k]};background:${color}` });
      tip.bind(part, { title: `Вопрос ${l}`, rows: [{ value: `${r[k]} (${fmtPct(r[k] / total)})`, label: 'диалогов', key: color }] });
      return part;
    }));
    return vpanel({ title: 'Решён ли вопрос клиента', sub: 'Из обзора диалога, который модель пишет вместе с оценкой.' },
      total ? [seg, h('div', { class: 'cqa-vlegend' }, RESOLVED.map(([k, l, color]) => h('span', { class: 'cqa-vlegend__item' },
        h('span', { class: 'cqa-vlegend__sw', style: `background:${color}` }), `${l}: `, h('b', null, String(r[k] || 0)), total ? h('span', { class: 'cqa-faint' }, ` ${fmtPct(( r[k] || 0) / total)}`) : null)))]
        : h('div', { class: 'cqa-faint cqa-vempty' }, 'Обзоров пока нет'));
  }

  function topicsPanel(a) {
    const all = a.topics || [];
    if (!all.length) return vpanel({ title: 'Темы обращений', sub: 'Темы появятся, когда модель напишет обзор диалогов.' }, h('div', { class: 'cqa-faint cqa-vempty' }, 'Нет тем'));
    const list = showAllTopics ? all : all.slice(0, 8);
    const table = h('table', { class: 'cqa-table cqa-topics' },
      h('thead', null, h('tr', null, h('th', null, 'Тема'), h('th', { class: 'cqa-num' }, 'Диалогов'), h('th', null, 'Решено'),
        h('th', { class: 'cqa-num' }, 'Средний итог'), h('th', null, 'Слабый критерий'))),
      h('tbody', null, list.map((t) => {
        const tr = h('tr', { tabindex: 0, onclick: () => goIds(t.ids, `Тема: ${t.topic}`), onkeydown: (e) => { if (e.key === 'Enter') goIds(t.ids, `Тема: ${t.topic}`); },
          'aria-label': `Тема ${t.topic}: ${t.count} ${plural(t.count, 'диалог', 'диалога', 'диалогов')}. Открыть список` },
        h('td', { class: 'cqa-topics__name' }, t.topic),
        h('td', { class: 'cqa-num' }, t.count),
        h('td', null, t.resolved_rate == null ? h('span', { class: 'cqa-faint' }, '—')
          : h('span', { class: 'cqa-meter' }, h('span', { class: 'cqa-meter__track' }, h('span', { class: 'cqa-meter__fill', style: `width:${t.resolved_rate * 100}%` })),
            h('span', { class: 'cqa-meter__val' }, fmtPct(t.resolved_rate)))),
        h('td', { class: 'cqa-num' }, h('span', { class: `cqa-score ${scoreClass(t.avg_total)}` }, fmtScore(t.avg_total))),
        h('td', null, t.weakest ? h('span', { class: 'cqa-topics__weak' }, h('span', { class: 'cqa-code' }, t.weakest.key), ` ${t.weakest.title} · ${fmtPct100(t.weakest.avg_pct)}`) : h('span', { class: 'cqa-faint' }, '—')));
        return tr;
      })));
    return vpanel({ title: 'Темы обращений', sub: 'Тема и «вопрос решён» — из обзора диалога; слабый критерий — с наименьшей средней долей балла в теме. Клик — диалоги темы.',
      actions: all.length > 8 ? h('button', { type: 'button', class: 'cqa-btn cqa-btn--ghost cqa-btn--sm', onclick: () => { showAllTopics = !showAllTopics; render(); } },
        showAllTopics ? 'Свернуть' : `Все ${all.length}`) : null },
    h('div', { class: 'cqa-tablewrap' }, table));
  }

  // ---------- Сборка ----------
  function render() {
    const a = data;
    clear(root);
    root.append(tip.el);
    tip.hide();
    root.append(header(a));
    if (!a.conversations) {
      root.append(h('div', { class: 'cqa-panel' }, emptyState({ title: `В группе ${group()} пока нет диалогов`, icon: '⇩',
        text: 'Импортируйте набор диалогов организаторов — по group_id из API или из JSON-файла, затем запустите оценку.', actionLabel: 'Импорт набора',
        onAction: () => emit(root, 'cqa:import-request', { group: group() }) })));
      return;
    }
    if (!a.count) {
      root.append(h('div', { class: 'cqa-panel' }, emptyState({ title: 'Оценок пока нет', icon: '▶',
        text: `В группе ${a.conversations} ${plural(a.conversations, 'диалог', 'диалога', 'диалогов')} без оценки по активной версии чек-листа. Запустите оценку — дашборд заполнится по мере готовности.`,
        actionLabel: `Оценить группу (${a.conversations})`, onAction: runRequest })));
      return;
    }
    const langs = slices('По языкам', a.by_language, (k) => ({ lang: String(k).toLowerCase() }), langName);
    const chans = slices('По каналам', a.by_channel, (k) => ({ channel: k === 'voice call' ? 'voice call' : 'chat' }), channelLabel);
    root.append(kpis(a), insights(a),
      h('div', { class: 'cqa-dash__grid cqa-dash__grid--main' }, histogram(a), criteria(a)),
      h('div', { class: 'cqa-dash__grid cqa-dash__grid--three' }, langs, chans, resolvedPanel(a)),
      topicsPanel(a));
  }

  async function load({ quiet = false } = {}) {
    const my = ++token;
    if (quiet && data) root.classList.add('cqa-dash--stale');
    else clear(root).append(header(null), h('div', { class: 'cqa-kpis' }, Array.from({ length: 6 }, () => h('div', { class: 'cqa-kpi' }, h('div', { class: 'cqa-skeleton', style: 'height:56px' })))),
      h('div', { class: 'cqa-dash__grid cqa-dash__grid--main' }, [1, 2].map(() => h('div', { class: 'cqa-panel cqa-vpanel' }, h('div', { class: 'cqa-skeleton', style: 'height:220px' })))));
    try {
      const a = await getAnalytics({ group_id: group(), checklist_version_id: p.version });
      const r = await listConversations({ group_id: group(), checklist_version_id: a.checklist_version_id }).catch(() => []);
      if (my !== token) return;
      data = a; rows = r;
      root.classList.remove('cqa-dash--stale');
      render();
    } catch (e) {
      if (my !== token) return;
      root.classList.remove('cqa-dash--stale');
      clear(root).append(header(null), h('div', { class: 'cqa-panel' }, errorState(e, () => load())));
    }
  }

  const onRefresh = () => load({ quiet: true });
  el.addEventListener('cqa:refresh', onRefresh);
  load();

  return {
    update(np) { const changed = np.group !== p.group || np.version !== p.version; p = { ...p, ...np }; if (changed) load(); },
    unmount() { token++; el.removeEventListener('cqa:refresh', onRefresh); tip.remove(); root.remove(); },
  };
}
