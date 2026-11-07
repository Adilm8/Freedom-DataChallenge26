// Проверка gold-разметки (FR-GOLD-01…05): список диалогов и экран проверки одного диалога.
// Параметры: id (conversation_id) — экран диалога; без id — список. Всё управляется с клавиатуры.
import { h, clear, emit, answerBadge, channelBadge, langChip, skeletonRows, errorState, emptyState } from '../ui.js';
import { listGold, getGold, putGold, getConversation } from '../api.js';
import { mount as mountTranscript } from './transcript-view.js';

const CONF = { high: 'высокая', medium: 'средняя', low: 'низкая' };
const SPLIT = { dev: 'dev', holdout: 'holdout' };
const same = (a, b) => String(a) === String(b);
const hhmm = (d = new Date()) => d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function mount(el, params = {}) {
  const root = h('div', { class: 'cqa-gold-root' });
  el.append(root);
  let view = null;
  const start = () => { view = params.id ? detailView(root, params.id) : listView(root); };
  start();
  return {
    update(np) { if (np.id !== params.id) { view?.unmount(); clear(root); params = { ...params, ...np }; start(); } },
    unmount() { view?.unmount(); root.remove(); },
  };
}

// ---------------------------------------------------------------- список

function statusOf(r) {
  if (!r.has_draft) return ['cqa-badge--muted', 'нет черновика'];
  if (r.reviewed) return ['cqa-badge--yes', 'проверено'];
  if (r.has_label) return ['cqa-badge--warn', 'в работе'];
  return ['cqa-badge--accent', 'ждёт проверки'];
}

function listView(root) {
  const page = h('div', { class: 'cqa-page' });
  root.append(page);
  let alive = true;

  async function load() {
    clear(page).append(h('div', { class: 'cqa-panel' }, skeletonRows(8)));
    try {
      const rows = await listGold();
      if (alive) render(rows);
    } catch (e) { if (alive) clear(page).append(h('div', { class: 'cqa-panel' }, errorState(e, load))); }
  }

  function render(rows) {
    clear(page);
    if (!rows.length) {
      page.append(h('div', { class: 'cqa-panel' }, emptyState({
        title: 'Выборка для gold ещё не готова',
        text: 'Нет файла data/gold/selection.json. Он появится, когда будут подобраны диалоги и подготовлены черновики разметки.',
        icon: '☰' })));
      return;
    }
    const ready = rows.filter((r) => r.has_draft);
    const done = rows.filter((r) => r.reviewed).length;
    const next = ready.find((r) => !r.reviewed && r.conversation_pk);
    page.append(h('div', { class: 'cqa-pagehead' },
      h('div', null, h('h1', { class: 'cqa-h1' }, 'Проверка gold'),
        h('div', { class: 'cqa-pagehead__sub' }, `Проверено ${done} из ${rows.length}. Черновиков готово: ${ready.length}.`)),
      h('div', { class: 'cqa-pagehead__actions' },
        h('button', { type: 'button', class: 'cqa-btn cqa-btn--primary', disabled: !next,
          onclick: () => emit(page, 'cqa:navigate', { to: `#/gold/${next.conversation_id}` }) }, next ? 'Продолжить проверку' : 'Всё проверено'))));
    page.append(h('div', { class: 'cqa-gold__progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': rows.length, 'aria-valuenow': done },
      h('div', { class: 'cqa-gold__progress-fill', style: `width:${Math.round((done / rows.length) * 100)}%` })));
    const body = rows.map((r) => {
      const [cls, text] = statusOf(r);
      const open = () => emit(page, 'cqa:navigate', { to: `#/gold/${r.conversation_id}` });
      return h('tr', { class: 'cqa-gold__row', tabindex: r.has_draft ? 0 : -1, onclick: r.has_draft ? open : null,
        onkeydown: (e) => { if (e.key === 'Enter' && r.has_draft) open(); } },
        h('td', null, h('span', { class: 'cqa-row-id' }, r.conversation_id)),
        h('td', null, langChip(r.language || '')),
        h('td', null, channelBadge(r.channel)),
        h('td', null, r.split ? h('span', { class: 'cqa-badge cqa-badge--muted' }, SPLIT[r.split]) : '—'),
        h('td', null, h('span', { class: `cqa-badge ${cls}` }, text)),
        h('td', null, r.low_confidence ? h('span', { class: 'cqa-badge cqa-badge--warn' }, `низкая уверенность: ${r.low_confidence}`) : '—'),
        h('td', null, r.has_second_opinion ? 'есть' : '—'),
        h('td', null, r.has_label ? String(r.changed) : '—'),
        h('td', null, r.has_label ? String(r.uncertain) : '—'),
        h('td', { class: 'cqa-mono' }, r.total == null ? '—' : Number(r.total).toFixed(2)),
        h('td', { class: 'cqa-faint' }, r.why || ''));
    });
    page.append(h('div', { class: 'cqa-panel cqa-tablewrap' }, h('table', { class: 'cqa-table' },
      h('thead', null, h('tr', null, ['Диалог', 'Язык', 'Канал', 'Часть', 'Статус', 'Черновик', 'Вторая разметка', 'Изменено', 'Не уверены', 'Итог', 'Почему в выборке']
        .map((t) => h('th', null, t)))),
      h('tbody', null, body))));
  }

  load();
  return { unmount() { alive = false; } };
}

// ---------------------------------------------------------------- проверка одного диалога

function detailView(root, convId) {
  let alive = true;
  let kids = [];
  let keyHandler = null;
  let notesTimer = null;
  let flashTimer = null;
  let stepTimer = null;

  // состояние экрана
  let rows = [];
  let data = null;
  let crit = []; // критерии чек-листа
  let answers = {};
  let uncertain = new Set();
  let notes = '';
  let total = null;
  let reviewedAt = null;
  let cur = 0;
  let stepBuf = null; // null — не ждём ступень; строка — набранные цифры
  let onlyDiff = false;
  const expanded = new Set();
  let chain = Promise.resolve();
  let status = { kind: 'idle', text: '' };

  const wrap = h('div', { class: 'cqa-card' });
  root.append(wrap);
  let headEl, keysEl, critEl, trEl, statusEl, flashEl, notesEl;

  async function load() {
    clear(wrap).append(h('div', { class: 'cqa-page' }, h('div', { class: 'cqa-panel' }, skeletonRows(8))));
    try {
      const [list, g] = await Promise.all([listGold(), getGold(convId)]);
      const conv = await getConversation(g.conversation_pk);
      if (!alive) return;
      rows = list; data = g; crit = g.criteria;
      const dAns = draftAnswers();
      const lab = g.label;
      answers = {};
      for (const c of crit) {
        const v = lab?.criteria?.[c.key]?.answer ?? dAns[c.key];
        if (v != null) answers[c.key] = v;
      }
      uncertain = new Set(lab?.uncertain || []);
      notes = lab?.notes || '';
      total = lab?.total ?? null;
      reviewedAt = lab?.reviewed_at || null;
      render(conv);
    } catch (e) {
      if (alive) clear(wrap).append(h('div', { class: 'cqa-page' }, h('div', { class: 'cqa-panel' }, errorState(e, load))));
    }
  }

  const draftAnswers = () => Object.fromEntries(Object.entries(data?.draft?.criteria || {}).map(([k, v]) => [k, v.answer]));
  const dCrit = (k) => data?.draft?.criteria?.[k];
  const sCrit = (k) => data?.second_opinion?.criteria?.[k];
  const hasSecond = () => !!data?.second_opinion;
  const isDiff = (k) => !!sCrit(k) && !!dCrit(k) && !same(sCrit(k).answer, dCrit(k).answer);
  const isChanged = (k) => !!dCrit(k) && answers[k] != null && !same(answers[k], dCrit(k).answer);
  const meta = (c) => ({ type: c.type, scale_max: c.type === 'scale' ? Math.max(...c.allowed_answers.filter((x) => typeof x === 'number')) : undefined, weight: c.weight });
  const badge = (c, a) => answerBadge(meta(c), a);
  const idx = () => rows.findIndex((r) => r.conversation_id === convId);
  const reviewedCount = () => rows.filter((r) => r.reviewed).length;

  // ---------- сохранение (последовательная очередь PUT, выбранные ответы не теряются) ----------
  function snapshot(reviewed) {
    const criteria = {};
    for (const [k, v] of Object.entries(answers)) criteria[k] = { answer: v };
    return { criteria, uncertain: [...uncertain], notes, ...(reviewed ? { reviewed: true } : {}) };
  }
  function save(reviewed = false) {
    clearTimeout(notesTimer); notesTimer = null;
    const body = snapshot(reviewed);
    setStatus('saving', 'Сохранение…');
    chain = chain.then(() => putGold(convId, body)).then((item) => {
      total = item.total;
      reviewedAt = item.reviewed_at;
      const r = rows[idx()];
      if (r) Object.assign(r, { has_label: true, reviewed: !!item.reviewed_at, changed: item.changed.length, uncertain: item.uncertain.length, total: item.total });
      if (alive) { setStatus('saved', `Сохранено ${hhmm()}`); renderHead(); }
      return true;
    }).catch((e) => { if (alive) setStatus('error', e.message || 'Ошибка сохранения'); return false; });
    return chain;
  }
  function setStatus(kind, text) {
    status = { kind, text };
    if (statusEl) { statusEl.className = `cqa-gold__status cqa-gold__status--${kind}`; statusEl.textContent = text; }
  }

  // ---------- изменения ----------
  function setAnswer(key, v) {
    answers[key] = v;
    stepBuf = null;
    renderCrit(); renderKeys();
    save();
  }
  function toggleUncertain(key) {
    if (uncertain.has(key)) uncertain.delete(key); else uncertain.add(key);
    renderCrit();
    save();
  }
  function select(i, { scroll = true } = {}) {
    cur = Math.max(0, Math.min(crit.length - 1, i));
    const c = crit[cur];
    stepBuf = c.type === 'scale' ? '' : null;
    clearTimeout(stepTimer);
    renderCrit(); renderKeys();
    const ev = dCrit(c.key)?.evidence || [];
    if (ev.length) trEl.dispatchEvent(new CustomEvent('cqa:highlight', { detail: { msg_ids: ev, scroll } }));
    critEl.querySelector('.cqa-gold__crit--cur')?.scrollIntoView({ block: 'nearest' });
  }
  function flash(text) {
    if (!flashEl) return;
    flashEl.textContent = text;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { if (flashEl) flashEl.textContent = ''; }, 2600);
  }

  // ---------- ввод ступени цифрами ----------
  const stepValues = (c) => c.allowed_answers.filter((x) => typeof x === 'number').map(String);
  function stepDigit(d) {
    const c = crit[cur];
    const V = stepValues(c);
    const buf = stepBuf + d;
    if (!V.some((v) => v.startsWith(buf))) {
      if (stepBuf === '') return false; // не ступень: пусть цифра выберет критерий
      stepBuf = ''; renderKeys(); flash(`Нет ступени «${buf}». Допустимо: ${V.join(', ')}`); return true;
    }
    stepBuf = buf;
    clearTimeout(stepTimer);
    if (V.includes(buf) && !V.some((v) => v !== buf && v.startsWith(buf))) { setAnswer(c.key, Number(buf)); return true; }
    if (V.includes(buf)) stepTimer = setTimeout(() => commitStep(), 900);
    renderKeys();
    return true;
  }
  function commitStep() {
    const c = crit[cur];
    if (stepBuf && stepValues(c).includes(stepBuf)) { setAnswer(c.key, Number(stepBuf)); return true; }
    return false;
  }

  // ---------- переходы ----------
  async function go(i) {
    const r = rows[i];
    if (!r) return;
    await chain;
    emit(wrap, 'cqa:navigate', { to: `#/gold/${r.conversation_id}` });
  }
  async function finish() {
    const missing = crit.filter((c) => answers[c.key] == null);
    if (missing.length) { flash(`Нет ответа по критериям: ${missing.map((c) => c.key).join(', ')}`); select(crit.indexOf(missing[0])); return; }
    const ok = await save(true);
    if (!ok) return;
    const i = idx();
    const next = rows.findIndex((r, j) => j > i && r.has_draft && r.conversation_pk && !r.reviewed);
    const any = next >= 0 ? next : rows.findIndex((r, j) => j > i && r.has_draft && r.conversation_pk);
    if (any >= 0) go(any); else emit(wrap, 'cqa:navigate', { to: '#/gold' });
  }

  function onKey(e) {
    if (!alive || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT')) {
      if (e.key === 'Escape') t.blur();
      return;
    }
    if (!crit.length) return;
    const c = crit[cur];
    const code = e.code || '';
    const digit = /^Digit(\d)$/.exec(code)?.[1] ?? /^Numpad(\d)$/.exec(code)?.[1];
    let handled = true;
    if (digit != null) {
      const n = Number(digit);
      if (stepBuf !== null && stepDigit(digit)) { /* ступень принята или набирается */ }
      else if (n >= 1 && n <= crit.length) select(n - 1);
      else handled = false;
    } else if (e.key === 'Enter') {
      if (stepBuf && commitStep()) { /* ступень зафиксирована */ } else finish();
    } else if (e.key === 'Escape') { stepBuf = null; renderKeys(); renderCrit(); }
    else if (e.key === 'ArrowLeft') go(idx() - 1);
    else if (e.key === 'ArrowRight') go(idx() + 1);
    else if (e.key === 'ArrowUp') select(cur - 1);
    else if (e.key === 'ArrowDown') select(cur + 1);
    else if (code === 'KeyY' || code === 'KeyN') {
      const v = code === 'KeyY' ? 'yes' : 'no';
      if (c.allowed_answers.includes(v)) setAnswer(c.key, v);
      else flash(`Критерий ${c.key} — шкала: введите цифрами ступень (${stepValues(c).join(', ')})`);
    } else if (code === 'KeyA') {
      if (c.allowed_answers.includes('na')) setAnswer(c.key, 'na'); else flash(`Для критерия ${c.key} N/A недопустим`);
    } else if (code === 'KeyU') toggleUncertain(c.key);
    else if (code === 'KeyD') { onlyDiff = !onlyDiff; renderCrit(); renderHead(); }
    else handled = false;
    if (handled) e.preventDefault();
  }

  // ---------- отрисовка ----------
  function render(conv) {
    clear(wrap);
    headEl = h('div', { class: 'cqa-card__head' });
    keysEl = h('div', { class: 'cqa-gold__keys', 'aria-label': 'Подсказка по клавишам' });
    trEl = h('div');
    critEl = h('div', { class: 'cqa-gold__crits' });
    notesEl = h('textarea', { class: 'cqa-input cqa-gold__notes', rows: 2, placeholder: 'Заметка к диалогу (необязательно)', 'aria-label': 'Заметка',
      oninput: (e) => { notes = e.target.value; clearTimeout(notesTimer); setStatus('saving', 'Сохранение…'); notesTimer = setTimeout(() => { notesTimer = null; save(); }, 700); } });
    notesEl.value = notes;
    const left = h('div', { class: 'cqa-card__col' }, h('div', { class: 'cqa-panel' }, trEl));
    const right = h('div', { class: 'cqa-card__col' }, critEl, h('div', { class: 'cqa-panel cqa-gold__notes-box' }, notesEl));
    wrap.append(headEl, keysEl, h('div', { class: 'cqa-card__cols' }, left, right));
    const evidence = crit.map((c) => ({ key: c.key, flag: c.type === 'flag' && dCrit(c.key)?.answer === 'yes', msg_ids: dCrit(c.key)?.evidence || [] })).filter((e) => e.msg_ids.length);
    const tr = mountTranscript(trEl, { messages: conv.messages, evidence });
    kids = [tr];
    trEl.addEventListener('cqa:criterion-click', (e) => { const i = crit.findIndex((c) => c.key === e.detail?.key); if (i >= 0) select(i); });
    wrap.dataset.channel = conv.channel;
    wrap._conv = conv;
    renderHead(); renderKeys(); renderCrit();
    if (!keyHandler) { keyHandler = onKey; document.addEventListener('keydown', keyHandler); }
    setStatus(reviewedAt ? 'saved' : 'idle', reviewedAt ? 'Диалог отмечен как проверенный' : 'Изменения сохраняются автоматически');
    if (!data.draft) flash('Черновика нет: разметка с нуля.');
  }

  function renderHead() {
    if (!headEl) return;
    const conv = wrap._conv;
    const i = idx();
    statusEl = h('span', { class: `cqa-gold__status cqa-gold__status--${status.kind}`, role: 'status', 'aria-live': 'polite' }, status.text);
    flashEl = flashEl && flashEl.isConnected ? flashEl : h('span', { class: 'cqa-gold__flash', role: 'alert' });
    clear(headEl).append(
      h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm', onclick: async () => { await chain; emit(wrap, 'cqa:navigate', { to: '#/gold' }); } }, '← К списку'),
      h('span', { class: 'cqa-card__id' }, convId), channelBadge(conv.channel), langChip(conv.language),
      reviewedAt ? h('span', { class: 'cqa-badge cqa-badge--yes' }, 'проверено') : h('span', { class: 'cqa-badge cqa-badge--accent' }, 'ждёт проверки'),
      total != null ? h('span', { class: 'cqa-gold__total' }, 'Итог по разметке ', h('b', null, Number(total).toFixed(2))) : null,
      hasSecond()
        ? h('label', { class: 'cqa-toggle', title: 'Клавиша D' }, h('input', { type: 'checkbox', checked: onlyDiff, onchange: (e) => { onlyDiff = e.target.checked; renderCrit(); } }), 'Только расхождения')
        : h('span', { class: 'cqa-faint cqa-gold__nosecond' }, 'второй разметки нет'),
      statusEl, flashEl,
      h('div', { class: 'cqa-card__nav' },
        h('span', { class: 'cqa-faint', style: 'font-size:var(--cqa-text-xs)' }, `${i + 1} из ${rows.length} · проверено ${reviewedCount()}`),
        h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm', disabled: i <= 0, onclick: () => go(i - 1), title: 'Клавиша ←' }, '‹ Назад'),
        h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm', disabled: i < 0 || i >= rows.length - 1, onclick: () => go(i + 1), title: 'Клавиша →' }, 'Вперёд ›'),
        h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm cqa-btn--primary', onclick: finish, title: 'Клавиша Enter' }, 'Всё ок, дальше ⏎')));
  }

  function renderKeys() {
    if (!keysEl) return;
    const k = (t) => h('kbd', null, t);
    clear(keysEl);
    if (stepBuf !== null) {
      const c = crit[cur];
      keysEl.append(h('span', { class: 'cqa-gold__step' }, `Критерий ${c.key}: введите ступень цифрами (${stepValues(c).join(', ')}) `,
        h('b', null, stepBuf || '…'), ' · ', k('Esc'), ' отмена'));
      return;
    }
    keysEl.append(
      h('span', null, k('1'), '–', k(String(crit.length || 8)), ' критерий'),
      h('span', null, k('Y'), ' да'), h('span', null, k('N'), ' нет'), h('span', null, k('A'), ' N/A'),
      h('span', null, 'шкала: после выбора критерия цифрами, напр. ', k('1'), k('5'), ' = 15'),
      h('span', null, k('U'), ' не уверены'), h('span', null, k('D'), ' только расхождения'),
      h('span', null, k('↑'), k('↓'), ' критерий'), h('span', null, k('←'), k('→'), ' диалог'),
      h('span', null, k('Enter'), ' всё ок, дальше'));
  }

  function renderCrit() {
    if (!critEl) return;
    clear(critEl);
    if (!data.draft) critEl.append(h('div', { class: 'cqa-banner cqa-banner--info' }, h('div', null, h('div', { class: 'cqa-banner__title' }, 'Черновика для этого диалога нет'), 'Расставьте ответы сами, по всем критериям.')));
    crit.forEach((c, i) => critEl.append(critCard(c, i)));
  }

  function critCard(c, i) {
    const d = dCrit(c.key);
    const so = sCrit(c.key);
    const isCur = i === cur;
    const diff = isDiff(c.key);
    const collapsed = onlyDiff && hasSecond() && !diff && !isCur && !expanded.has(c.key);
    const low = d?.confidence === 'low';
    const cls = ['cqa-panel', 'cqa-crit', 'cqa-gold__crit', isCur ? 'cqa-gold__crit--cur' : '', low ? 'cqa-gold__crit--low' : '', isChanged(c.key) ? 'cqa-gold__crit--changed' : '', collapsed ? 'cqa-gold__crit--collapsed' : ''].filter(Boolean).join(' ');
    const head = h('div', { class: 'cqa-crit__head' },
      h('kbd', { class: 'cqa-gold__num' }, String(i + 1)),
      h('span', { class: 'cqa-crit__title' }, c.title, h('small', { class: 'cqa-faint' }, ` · ${c.key}${c.type === 'flag' ? '' : ', вес ' + c.weight}`)),
      answers[c.key] != null ? badge(c, answers[c.key]) : h('span', { class: 'cqa-badge cqa-badge--warn' }, 'нет ответа'),
      isChanged(c.key) ? h('span', { class: 'cqa-badge cqa-badge--accent', title: 'Ответ отличается от черновика' }, 'изменено') : null,
      uncertain.has(c.key) ? h('span', { class: 'cqa-badge cqa-badge--warn' }, 'не уверены') : null,
      diff ? h('span', { class: 'cqa-badge cqa-badge--flag' }, 'расхождение') : null,
      collapsed ? h('span', { class: 'cqa-faint', style: 'font-size:var(--cqa-text-xs)' }, 'черновики совпали') : null);
    if (collapsed) {
      return h('div', { class: cls, onclick: () => { expanded.add(c.key); select(i, { scroll: false }); } }, head);
    }
    const body = h('div', { class: 'cqa-crit__body' });
    if (d) {
      body.append(h('div', { class: 'cqa-gold__draft' },
        h('span', { class: 'cqa-faint' }, 'Черновик: '), badge(c, d.answer), ' ',
        d.confidence ? h('span', { class: `cqa-conf cqa-conf--${d.confidence}` }, h('span', { class: 'cqa-conf__dots' }, h('i'), h('i'), h('i')), `уверенность ${CONF[d.confidence] || d.confidence}`) : null));
      if (d.reasoning) body.append(h('div', { class: 'cqa-crit__why' }, d.reasoning));
      if ((d.evidence || []).length) {
        body.append(h('div', { class: 'cqa-gold__ev' }, h('span', { class: 'cqa-faint' }, 'Доказательства: '),
          d.evidence.map((m) => h('button', { type: 'button', class: 'cqa-chip', onclick: (e) => {
            e.stopPropagation();
            trEl.dispatchEvent(new CustomEvent('cqa:highlight', { detail: { msg_ids: [m] } }));
          } }, m))));
      }
    }
    if (so) {
      body.append(h('div', { class: `cqa-gold__second ${diff ? 'cqa-gold__second--diff' : ''}` },
        h('span', { class: 'cqa-faint' }, 'Вторая разметка: '), badge(c, so.answer),
        so.reason ? h('span', { class: 'cqa-gold__second-why' }, so.reason) : null,
        (so.evidence || []).map((m) => h('button', { type: 'button', class: 'cqa-chip', onclick: (e) => {
          e.stopPropagation();
          trEl.dispatchEvent(new CustomEvent('cqa:highlight', { detail: { msg_ids: [m] } }));
        } }, m))));
    }
    body.append(h('div', { class: 'cqa-gold__answers', role: 'group', 'aria-label': `Ответ по критерию ${c.key}` },
      c.allowed_answers.map((a) => {
        const lbl = a === 'yes' ? (c.type === 'flag' ? 'Грубая ошибка' : 'Да') : a === 'no' ? (c.type === 'flag' ? 'Нет нарушений' : 'Нет') : a === 'na' ? 'N/A' : String(a);
        const hot = a === 'yes' ? 'Y' : a === 'no' ? 'N' : a === 'na' ? 'A' : null;
        const on = answers[c.key] != null && same(answers[c.key], a);
        const isDraft = d && same(d.answer, a);
        return h('button', { type: 'button', class: `cqa-btn cqa-btn--sm cqa-gold__ans ${on ? 'cqa-gold__ans--on' : ''}`, 'aria-pressed': String(on),
          title: isDraft ? 'Ответ черновика' : '', onclick: (e) => { e.stopPropagation(); cur = i; setAnswer(c.key, a); } },
          lbl, hot ? h('kbd', null, hot) : null, isDraft ? h('span', { class: 'cqa-gold__dot', 'aria-label': 'ответ черновика' }) : null);
      }),
      h('button', { type: 'button', class: `cqa-btn cqa-btn--sm cqa-btn--ghost cqa-gold__unc ${uncertain.has(c.key) ? 'cqa-gold__unc--on' : ''}`, 'aria-pressed': String(uncertain.has(c.key)),
        onclick: (e) => { e.stopPropagation(); toggleUncertain(c.key); } }, 'Не уверены', h('kbd', null, 'U'))));
    return h('div', { class: cls, id: `gold-crit-${c.key}`, onclick: () => { if (cur !== i) select(i, { scroll: false }); } }, head, body);
  }

  load();

  return {
    unmount() {
      alive = false;
      if (notesTimer) { clearTimeout(notesTimer); if (data) putGold(convId, snapshot(false)).catch(() => {}); }
      clearTimeout(flashTimer); clearTimeout(stepTimer);
      if (keyHandler) document.removeEventListener('keydown', keyHandler);
      kids.forEach((k) => k.unmount());
      wrap.remove();
    },
  };
}
