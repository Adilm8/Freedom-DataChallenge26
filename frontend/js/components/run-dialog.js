// Запуск оценки и прогресс прогона (FR-EVAL-01, 08; FR-CHK-04, 06, 10; FR-EVAL-20; FR-UX-03).
// openRunDialog(host, opts) — модальное окно поверх host (корень .cqa-root); mount(el, params) — то же внутри el
// (отдельная страница / web resource). opts: {ids: [pk], group, rows?: [ConversationRow], channel?, label?,
// preset?: {provider, model, strategy, reuse}, checklistVersionId?, title?, intro?, onFinished?(run),
// offerActivate? (галочка «Сделать версию активной», по умолчанию включена), onActivated?(versionId), onPick?() (ссылка «выбрать диалоги…»)}.
// Модель и провайдер — из GET /meta/models; версии чек-листа — GET /checklists (по умолчанию активная);
// оценка стоимости — POST /runs/estimate (без LLM); запуск — POST /runs; прогресс — GET /runs/{id} раз в секунду.
import { h, clear, fmtMoney, toast, skeletonRows, errorState } from '../ui.js';
import { getMetaModels, listChecklists, activateChecklist, estimateRun, createRun, getRun } from '../api.js';

const PROVIDER = { openrouter: 'OpenRouter', gemini: 'Gemini', ollama: 'Ollama (локально)', mock: 'Демо' };
const STRATEGY = {
  grouped: ['По группам', 'Связанные критерии — в одном вызове. Рекомендуется.'],
  single: ['Один вызов', 'Все критерии разом: дешевле, но ответ длиннее.'],
  per_criterion: ['По критерию', 'Отдельный вызов на каждый критерий: дольше и дороже.'],
};
const STATUS = {
  queued: ['В очереди', 'muted'], running: ['Идёт оценка', 'accent'], done: ['Готово', 'yes'],
  partial: ['Готово, есть ошибки', 'warn'], failed: ['Не выполнено', 'no'],
};
const FINAL = new Set(['done', 'partial', 'failed']);
const POLL_MS = 1000;
const ESTIMATE_DEBOUNCE_MS = 350;
const COST_SOURCE = {
  history: 'по средней цене прошлых вызовов этой модели',
  pricing: 'по прайсу провайдера',
  unknown: 'цены модели нет ни в истории, ни в прайсе',
};
const approxMoney = (v) => (v == null ? 'цена неизвестна' : v === 0 ? '$0' : `≈ $${v >= 0.01 ? v.toFixed(2) : v.toFixed(4)}`);
const approxTime = (s) => (s < 60 ? `≈ ${Math.max(1, Math.round(s))} с` : `≈ ${Math.round(s / 60)} мин`);
const kTokens = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
export const versionLabel = (v) => `v${v.version} · ${v.name || v.key}${v.is_active ? ' · активная' : ''}`;

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
}
const nDialogs = (n) => `${n} ${plural(n, 'диалог', 'диалога', 'диалогов')}`;
const nCalls = (n) => `${n} ${plural(n, 'звонок', 'звонка', 'звонков')}`;
const nLLM = (n) => `${n} ${plural(n, 'вызов', 'вызова', 'вызовов')}`;
const clock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** Рисует форму запуска и прогресс внутри box. Возвращает {destroy, minimize?}. */
function runPanel(box, opts, { onClose, onMinimize, inline }) {
  const ids = (opts.ids || []).map(Number).filter((x) => !isNaN(x));
  const rows = opts.rows || null;
  const st = {
    scope: ids.length ? 'selected' : 'group',
    provider: null, model: '', strategy: opts.preset?.strategy || null,
    reuse: opts.preset?.reuse === 'auto', meta: null, error: null, busy: false,
    versions: null, version: opts.checklistVersionId != null ? Number(opts.checklistVersionId) : null, activate: !!opts.offerActivate,
    est: { sig: null, data: null, error: null, loading: false },
  };
  let pollTimer = null, estTimer = null, estSeq = 0, alive = true, run = null, runStarted = 0, fails = 0, finishedFired = false;

  const scopeRows = () => {
    if (!rows) return null;
    return st.scope === 'group' ? rows : rows.filter((r) => ids.includes(Number(r.id)));
  };
  const scopeCount = () => (st.scope === 'group' ? (rows ? rows.length : null) : ids.length);
  const voiceCount = () => {
    const r = scopeRows();
    if (r) return r.filter((x) => x.channel === 'voice call').length;
    return opts.channel === 'voice call' && st.scope !== 'group' ? ids.length : 0;
  };
  const modelInfo = (prov) => st.meta?.models.find((m) => m.provider === prov) || null;

  async function loadMeta() {
    clear(box).append(skeletonRows(5));
    try {
      const [meta, versions] = await Promise.all([getMetaModels(), listChecklists().catch(() => null)]);
      st.meta = meta;
      if (!alive) return;
      st.versions = versions;
      if (versions?.length && !versions.some((v) => v.id === st.version)) st.version = (versions.find((v) => v.is_active) || versions[0]).id;
      const usable = st.meta.models.filter((m) => m.model);
      const pre = opts.preset?.provider && modelInfo(opts.preset.provider)?.model ? opts.preset.provider : null;
      const def = modelInfo(st.meta.default_provider)?.model ? st.meta.default_provider : usable[0]?.provider;
      st.provider = pre || def || st.meta.models[0]?.provider || null;
      const conf = modelInfo(st.provider)?.model || '';
      st.model = pre && opts.preset.model && opts.preset.model === conf ? opts.preset.model : conf;
      const strategies = st.meta.strategies?.length ? st.meta.strategies : Object.keys(STRATEGY);
      if (!st.strategy || !strategies.includes(st.strategy)) st.strategy = strategies.includes('grouped') ? 'grouped' : st.meta.default_strategy || strategies[0];
      renderForm();
    } catch (e) {
      if (alive) clear(box).append(head(), errorState(e, loadMeta));
    }
  }

  function head() {
    const title = opts.title || (ids.length === 1 && opts.label ? `Оценить ${opts.label}` : 'Запуск оценки');
    return h('div', { class: 'cqa-modal__head' },
      h('h2', { class: 'cqa-h2', id: 'cqa-run-title' }, title),
      inline ? null : h('button', { type: 'button', class: 'cqa-modal__x', 'aria-label': 'Закрыть', onclick: () => (run && !FINAL.has(run.status) ? onMinimize() : onClose()) }, '×'));
  }

  function field(label, control, hint) {
    return h('div', { class: 'cqa-field' }, h('div', { class: 'cqa-field__label' }, label), control, hint ? h('div', { class: 'cqa-field__hint' }, hint) : null);
  }

  function renderForm() {
    clear(box);
    const meta = st.meta;
    const info = modelInfo(st.provider);
    const voice = voiceCount();
    const count = scopeCount();
    const voiceBlocked = info && info.voice_allowed === false && voice > 0;
    const allVoiceBlocked = voiceBlocked && count != null && voice >= count;

    const scope = ids.length && opts.group !== undefined && !opts.lockScope
      ? field('Что оценить', h('div', { class: 'cqa-radios' },
        [['selected', ids.length === 1 && opts.label ? `Диалог ${opts.label}` : `Выбранные: ${nDialogs(ids.length)}`],
          ['group', `Вся группа ${opts.group || ''}${rows ? ` (${nDialogs(rows.length)})` : ''}`]].map(([v, t]) =>
          h('label', { class: 'cqa-radio' }, h('input', { type: 'radio', name: 'cqa-run-scope', value: v, checked: st.scope === v,
            onchange: () => { st.scope = v; renderForm(); } }), t))))
      : field('Что оценить', h('div', { class: 'cqa-field__static' },
        st.scope === 'group' ? `Вся группа ${opts.group || ''}${rows ? ` · ${nDialogs(rows.length)}` : ''}` : ids.length === 1 && opts.label ? `Диалог ${opts.label}` : nDialogs(ids.length)));
    if (opts.onPick) scope.append(h('button', { type: 'button', class: 'cqa-linkbtn cqa-runform__pick', id: 'cqa-run-pick',
      onclick: () => { onClose(); opts.onPick(); } }, ids.length ? 'изменить выбор…' : 'выбрать отдельные диалоги…'));

    const provSel = h('select', { class: 'cqa-select', id: 'cqa-run-provider', 'aria-label': 'Провайдер',
      onchange: (e) => { st.provider = e.target.value; st.model = modelInfo(st.provider)?.model || ''; st.error = null; renderForm(); } },
    meta.models.map((m) => h('option', { value: m.provider, selected: m.provider === st.provider, disabled: !m.model },
      `${PROVIDER[m.provider] || m.provider}${m.paid ? ' · платный' : m.paid === false ? ' · бесплатный' : ''}${m.model ? '' : ' · модель не задана'}`)));
    // Подсказки модели: из настроек сервера (по всем провайдерам) и из прошлой оценки — без выдуманных имён.
    const known = [...new Set([modelInfo(st.provider)?.model, opts.preset?.provider === st.provider ? opts.preset?.model : null,
      ...(meta.models || []).map((m) => m.model)].filter(Boolean))];
    const modelList = h('datalist', { id: 'cqa-run-models' }, known.map((m) => h('option', { value: m })));
    const modelIn = h('input', { class: 'cqa-input cqa-mono', id: 'cqa-run-model', 'aria-label': 'Модель', value: st.model, spellcheck: 'false', autocomplete: 'off', list: 'cqa-run-models',
      placeholder: 'например, anthropic/claude-sonnet-4.5', oninput: (e) => { st.model = e.target.value.trim(); syncSubmit(); scheduleEstimate(!st.model || allVoiceBlocked); } });
    const conf = info?.model;
    const pre = opts.preset;
    const modelHint = [
      conf && st.model !== conf ? h('button', { type: 'button', class: 'cqa-linkbtn', onclick: () => { st.model = conf; renderForm(); } }, `вернуть модель из настроек: ${conf}`) : null,
      pre?.model && pre.provider === st.provider && pre.model !== st.model ? h('span', null, `в прошлой оценке: ${pre.model}`) : null,
      !conf && !st.model ? 'Модель задаётся в .env (*_MODEL) или здесь.' : null,
    ].filter(Boolean);

    const strategies = meta.strategies?.length ? meta.strategies : Object.keys(STRATEGY);
    const strat = h('div', { class: 'cqa-seg cqa-seg--wide', role: 'radiogroup', 'aria-label': 'Стратегия' },
      strategies.map((s) => h('button', { type: 'button', class: 'cqa-seg__btn', role: 'radio', 'aria-checked': String(st.strategy === s), 'aria-pressed': String(st.strategy === s),
        dataset: { strategy: s }, onclick: () => { st.strategy = s; renderForm(); } }, STRATEGY[s]?.[0] || s)));

    const reuse = h('label', { class: 'cqa-toggle cqa-toggle--block' },
      h('input', { type: 'checkbox', id: 'cqa-run-reuse', checked: st.reuse, onchange: (e) => { st.reuse = e.target.checked; renderForm(); } }),
      h('span', null, h('b', null, 'Использовать прошлые ответы'),
        h('span', { class: 'cqa-field__hint' }, st.reuse
          ? 'Вызовы только по изменённым критериям: ответы по остальным возьмём из прошлой оценки той же модели и версии промпта (подпись «ответ из оценки #N»). Смена весов — без вызовов модели.'
          : 'Выключено: все критерии оцениваются заново (как «Оценить повторно»).')));

    const vers = st.versions || [];
    const curVer = vers.find((v) => v.id === st.version);
    const canActivate = !!opts.offerActivate && !!curVer && !curVer.is_active;
    const activateBox = canActivate ? h('label', { class: 'cqa-toggle cqa-toggle--block' },
      h('input', { type: 'checkbox', id: 'cqa-run-activate', checked: st.activate, onchange: (e) => { st.activate = e.target.checked; renderForm(); } }),
      h('span', null, h('b', null, `Сделать версию v${curVer.version} активной`),
        h('span', { class: 'cqa-field__hint' }, st.activate
          ? 'Перед запуском: по ней пойдут следующие прогоны, дашборд и файл сдачи. Прошлые оценки останутся на своей версии.'
          : 'Выключено: оценки сохранятся с этой версией, а дашборд и файл сдачи останутся на активной.'))) : null;
    const versionField = vers.length
      ? field('Версия чек-листа', h('select', { class: 'cqa-select', id: 'cqa-run-version', 'aria-label': 'Версия чек-листа',
        onchange: (e) => { st.version = Number(e.target.value); renderForm(); } },
      vers.map((v) => h('option', { value: v.id, selected: v.id === st.version }, `${versionLabel(v)}${v.note ? ` — ${v.note}` : ''}`))),
      canActivate ? null : curVer && !curVer.is_active ? 'Версия не активная: оценки сохранятся с ней, а файл сдачи и дашборд по умолчанию берут активную.' : 'По умолчанию — активная версия.')
      : null;

    const warns = [];
    if (info?.paid) warns.push(h('div', { class: 'cqa-banner cqa-banner--warn cqa-run-paid', hidden: st.est.data?.calls === 0 }, h('span', { class: 'cqa-banner__icon' }, '$'),
      h('div', null, h('div', { class: 'cqa-banner__title' }, 'Платный провайдер'), `Вызовы спишут средства с баланса ${PROVIDER[st.provider] || st.provider}. Стоимость каждого вызова сохраняется и видна в прогрессе.`)));
    if (voiceBlocked) warns.push(h('div', { class: `cqa-banner ${allVoiceBlocked ? 'cqa-banner--flag' : 'cqa-banner--warn'}` }, h('span', { class: 'cqa-banner__icon' }, '!'),
      h('div', null, h('div', { class: 'cqa-banner__title' }, `${PROVIDER[st.provider] || st.provider} не принимает звонки`),
        `Бесплатный тариф может использовать данные, поэтому ${nCalls(voice)} сюда не отправляются и завершатся ошибкой. Для звонков выберите другой провайдер.`)));
    if (st.error) {
      warns.push(h('div', { class: 'cqa-banner cqa-banner--flag', role: 'alert' }, h('span', { class: 'cqa-banner__icon' }, '!'),
        h('div', null, h('div', { class: 'cqa-banner__title' }, 'Не удалось запустить'), h('div', null, st.error.message || String(st.error)),
          st.error.errors?.length ? h('ul', { class: 'cqa-errlist' }, st.error.errors.map((x) => h('li', null, x.path ? h('code', null, x.path) : null, x.path ? ' — ' : '', x.message))) : null)));
    }

    const submit = h('button', { type: 'submit', class: 'cqa-btn cqa-btn--primary', id: 'cqa-run-submit' });
    function syncSubmit() {
      const n = scopeCount();
      submit.disabled = st.busy || !st.provider || !st.model || allVoiceBlocked;
      submit.textContent = st.busy ? 'Запускаем…' : `Запустить${n != null ? ` · ${nDialogs(n)}` : ''}`;
    }
    syncSubmit();

    const form = h('form', { class: 'cqa-runform', onsubmit: (e) => { e.preventDefault(); start(); } },
      scope,
      h('div', { class: 'cqa-field-row' },
        field('Провайдер', provSel),
        field('Модель', [modelIn, modelList], modelHint.length ? h('span', { class: 'cqa-field__hints' }, modelHint) : null)),
      versionField,
      activateBox,
      field('Стратегия', strat, STRATEGY[st.strategy]?.[1]),
      reuse,
      h('div', { class: 'cqa-runest', id: 'cqa-run-estimate', 'aria-live': 'polite' }),
      warns,
      h('div', { class: 'cqa-modal__foot' },
        inline ? null : h('button', { type: 'button', class: 'cqa-btn', onclick: onClose }, 'Отмена'),
        submit));
    box.append(...[head(), opts.intro ? h('div', { class: 'cqa-banner cqa-banner--info cqa-runintro' }, h('span', { class: 'cqa-banner__icon' }, 'i'), h('div', null, opts.intro)) : null, form].filter(Boolean));
    if (!inline) provSel.focus({ preventScroll: true });
    scheduleEstimate(!st.model || allVoiceBlocked);
  }

  function runBody() {
    const body = { provider: st.provider, model: st.model, strategy: st.strategy, reuse: st.reuse ? 'auto' : 'none' };
    if (st.version != null) body.checklist_version_id = st.version;
    if (st.scope === 'group') body.group_id = opts.group; else body.conversation_ids = ids;
    return body;
  }

  // Оценка стоимости до запуска: пересчитывается при смене версии, стратегии, reuse, модели или области (с задержкой).
  function scheduleEstimate(skip) {
    const body = runBody();
    const sig = JSON.stringify(body);
    if (skip) { st.est = { sig: null, data: null, error: null, loading: false }; clearTimeout(estTimer); paintEstimate(); return; }
    if (sig === st.est.sig && (st.est.data || st.est.error || st.est.loading)) { paintEstimate(); return; }
    st.est = { sig, data: null, error: null, loading: true };
    paintEstimate();
    clearTimeout(estTimer);
    const my = ++estSeq;
    estTimer = setTimeout(async () => {
      try {
        const data = await estimateRun(body);
        if (alive && my === estSeq) st.est = { sig, data, error: null, loading: false };
      } catch (e) {
        if (alive && my === estSeq) st.est = { sig, data: null, error: e, loading: false };
      }
      if (alive && my === estSeq && !run) paintEstimate();
    }, ESTIMATE_DEBOUNCE_MS);
  }

  function paintEstimate() {
    const el = box.querySelector('#cqa-run-estimate');
    if (!el) return;
    const { data, error, loading } = st.est;
    clear(el);
    el.className = 'cqa-runest';
    el.hidden = false;
    // без вызовов модели предупреждение о платном провайдере не нужно
    const paid = box.querySelector('.cqa-run-paid');
    if (paid) paid.hidden = !!data && !data.calls;
    if (loading) { el.classList.add('cqa-runest--loading'); el.append(h('span', { class: 'cqa-runest__icon' }, '≈'), h('span', null, 'Считаем стоимость и время…')); return; }
    if (error) { el.classList.add('cqa-runest--muted'); el.append(h('span', { class: 'cqa-runest__icon' }, '?'), h('span', null, `Оценка стоимости недоступна. ${error.message || ''}`)); return; }
    if (!data) { el.hidden = true; return; }
    if (!data.calls) {
      el.classList.add('cqa-runest--free');
      el.append(h('span', { class: 'cqa-runest__icon' }, '✓'),
        h('span', null, h('b', null, 'Без вызовов модели, только пересчёт баллов'),
          h('span', { class: 'cqa-runest__sub' }, `${nDialogs(data.dialogs)}: ответы по всем критериям уже есть в прошлых оценках.`)));
      return;
    }
    const partial = data.dialogs_with_calls < data.dialogs;
    el.append(h('span', { class: 'cqa-runest__icon' }, '≈'),
      h('span', null,
        h('b', { class: 'cqa-runest__main', title: COST_SOURCE[data.cost_source] || '' },
          `${approxMoney(data.cost_usd)} · ${approxTime(data.seconds || 0)} · ${nLLM(data.calls)}`),
        h('span', { class: 'cqa-runest__sub' },
          `${partial ? `вызовы нужны в ${data.dialogs_with_calls} из ${nDialogs(data.dialogs)}` : nDialogs(data.dialogs)} · ≈ ${kTokens(data.tokens_in)} вх. / ${kTokens(data.tokens_out)} вых. токенов`,
          data.cost_usd == null ? ' · цены модели нет в истории и прайсе' : data.cost_source === 'history' ? ' · по прошлым вызовам' : data.cost_source === 'pricing' ? ' · по прайсу' : '')));
  }

  async function start() {
    st.busy = true; st.error = null; renderForm();
    const body = runBody();
    clearTimeout(estTimer);
    try {
      const cur = (st.versions || []).find((v) => v.id === st.version);
      if (opts.offerActivate && st.activate && cur && !cur.is_active) { // сначала активация версии, потом прогон
        await activateChecklist(cur.id);
        st.versions = st.versions.map((v) => ({ ...v, is_active: v.id === cur.id }));
        opts.onActivated?.(cur.id);
        if (!alive) return;
      }
      const { run_id } = await createRun(body);
      if (!alive) return;
      run = { run_id, status: 'queued', total: scopeCount() || 0, done: 0, failed: 0, cost_usd: 0, provider: body.provider, model: body.model, strategy: body.strategy,
        checklist_version_id: body.checklist_version_id ?? null };
      runStarted = Date.now();
      renderProgress();
      poll();
    } catch (e) {
      st.busy = false; st.error = e;
      if (alive) renderForm();
    }
  }

  async function poll() {
    clearTimeout(pollTimer);
    try {
      const r = await getRun(run.run_id);
      if (!alive) return;
      run = { ...run, ...r };
      fails = 0;
    } catch (e) {
      fails += 1;
      run.pollError = e;
      if (fails >= 5) { run.pollStopped = true; renderProgress(); return; }
    }
    if (!alive) return;
    renderProgress();
    if (FINAL.has(run.status)) finish();
    else pollTimer = setTimeout(poll, POLL_MS);
  }

  function finish() {
    if (finishedFired) return;
    finishedFired = true;
    opts.onProgress?.(run);
    opts.onFinished?.(run);
  }

  function renderProgress() {
    clear(box);
    const total = run.total || 0;
    const pct = (n) => (total ? Math.min(100, (n / total) * 100) : 0);
    const [label, tone] = STATUS[run.status] || [run.status, 'muted'];
    const fin = FINAL.has(run.status);
    const elapsed = (run.finished_at && run.started_at ? new Date(run.finished_at) - new Date(run.started_at) : Date.now() - runStarted);
    opts.onProgress?.(run);
    box.append(head(),
      h('div', { class: 'cqa-run', 'aria-live': 'polite' },
        h('div', { class: 'cqa-run__top' },
          h('span', { class: `cqa-badge cqa-badge--${tone}`, id: 'cqa-run-status' }, label),
          h('span', { class: 'cqa-faint cqa-mono' }, `прогон #${run.run_id}`),
          h('span', { class: 'cqa-run__time cqa-mono' }, clock(elapsed))),
        h('div', { class: 'cqa-run__bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': run.done + run.failed, 'aria-label': 'Прогресс прогона' },
          h('div', { class: 'cqa-run__fill', style: `width:${pct(run.done)}%` }),
          h('div', { class: 'cqa-run__fill cqa-run__fill--bad', style: `width:${pct(run.failed)}%` }),
          fin ? null : h('div', { class: 'cqa-run__stripe' })),
        h('div', { class: 'cqa-run__stats' },
          stat('Оценено', `${run.done} из ${total}`),
          stat('С ошибкой', String(run.failed), run.failed ? 'cqa-run__stat--bad' : ''),
          stat('Стоимость', fmtMoney(run.cost_usd)),
          stat('Модель', `${PROVIDER[run.provider] || run.provider || '—'} · ${run.model || '—'}${verText(run.checklist_version_id)}`, 'cqa-run__stat--wide')),
        run.pollStopped
          ? h('div', { class: 'cqa-banner cqa-banner--flag', role: 'alert' }, h('span', { class: 'cqa-banner__icon' }, '!'),
            h('div', null, h('div', { class: 'cqa-banner__title' }, 'Нет ответа о прогрессе'), run.pollError?.message || '', ' Прогон на сервере продолжается.',
              h('div', null, h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm', style: 'margin-top:8px', onclick: () => { fails = 0; run.pollStopped = false; poll(); } }, 'Обновить статус'))))
          : null,
        fin ? h('div', { class: `cqa-banner ${run.failed ? 'cqa-banner--warn' : 'cqa-banner--info'}` }, h('span', { class: 'cqa-banner__icon' }, run.failed ? '!' : '✓'),
          h('div', null, run.status === 'failed'
            ? 'Ни один диалог не оценён. Причина — в карточке диалога, блок «Сырой ответ».'
            : run.failed
              ? `Оценено ${nDialogs(run.done)}, с ошибкой ${run.failed}. Ошибки видны в карточке диалога, блок «Сырой ответ».`
              : `${run.done === 1 ? 'Диалог оценён' : `Готово: оценено ${nDialogs(run.done)}`}. Результаты уже обновлены.`)) : null),
      h('div', { class: 'cqa-modal__foot' },
        fin ? null : h('span', { class: 'cqa-faint cqa-run__note' }, 'Окно можно свернуть: прогон идёт на сервере.'),
        !fin && !inline ? h('button', { type: 'button', class: 'cqa-btn', onclick: onMinimize }, 'Свернуть') : null,
        // После прогона нескольких диалогов — куда смотреть дальше (переход по ссылке закрывает окно, см. hashchange).
        fin && !inline && total > 1 && run.done ? h('a', { class: 'cqa-btn', href: '#/dashboard', id: 'cqa-run-dash' }, 'Открыть дашборд') : null,
        fin && !inline && total > 1 && run.done ? h('a', { class: 'cqa-btn', href: '#/review', id: 'cqa-run-review' }, 'Требует проверки') : null,
        fin && !inline ? h('button', { type: 'button', class: 'cqa-btn cqa-btn--primary', id: 'cqa-run-close', onclick: onClose }, 'Закрыть') : null,
        fin && inline ? h('button', { type: 'button', class: 'cqa-btn', onclick: () => { run = null; finishedFired = false; st.busy = false; st.est = { sig: null, data: null, error: null, loading: false }; renderForm(); } }, 'Новый запуск') : null));
  }

  function verText(id) {
    const v = id != null && (st.versions || []).find((x) => x.id === Number(id));
    return v ? ` · чек-лист v${v.version}` : '';
  }

  function stat(label, value, cls = '') {
    return h('div', { class: `cqa-run__stat ${cls}` }, h('div', { class: 'cqa-run__label' }, label), h('div', { class: 'cqa-run__val' }, value));
  }

  loadMeta();
  return {
    running: () => !!run && !FINAL.has(run.status),
    state: () => run,
    destroy() { alive = false; clearTimeout(pollTimer); clearTimeout(estTimer); },
  };
}

/** Модальное окно запуска поверх host. Пока прогон идёт, окно можно свернуть в плашку и развернуть обратно. */
export function openRunDialog(host, opts = {}) {
  const box = h('div', { class: 'cqa-modal__box', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cqa-run-title' });
  const overlay = h('div', { class: 'cqa-modal', onmousedown: (e) => { if (e.target === overlay) dismiss(); } }, box);
  const prevFocus = document.activeElement;
  let chip = null;

  const userFinished = opts.onFinished;
  const panel = runPanel(box, {
    ...opts,
    onProgress: (run) => { if (chip) chip.textContent = `Оценка: ${run.done + run.failed} из ${run.total}`; },
    onFinished: (run) => {
      userFinished?.(run);
      if (chip) {
        chip.remove(); chip = null;
        toast(host, run.status === 'done' ? `Оценка завершена: ${nDialogs(run.done)}, ${fmtMoney(run.cost_usd)}.` : `Оценка завершена с ошибками: оценено ${run.done}, ошибок ${run.failed}.`);
        close();
      }
    },
  }, { onClose: close, onMinimize: minimize, inline: false });

  function dismiss() { if (panel.running()) minimize(); else close(); }
  // Смена экрана: готовое окно закрывается, идущий прогон сворачивается в плашку (не висит поверх другой карточки).
  function onHash() { if (overlay.isConnected) dismiss(); }
  function onKey(e) { if (e.key === 'Escape' && overlay.isConnected) { e.stopPropagation(); dismiss(); } }
  function minimize() {
    overlay.remove();
    if (!chip) {
      chip = h('button', { type: 'button', class: 'cqa-runchip', 'aria-live': 'polite', onclick: restore }, 'Оценка идёт…');
      host.append(chip);
      const r = panel.state();
      if (r) chip.textContent = `Оценка: ${r.done + r.failed} из ${r.total}`;
    }
  }
  function restore() { chip?.remove(); chip = null; host.append(overlay); }
  function close() {
    panel.destroy();
    overlay.remove(); chip?.remove(); chip = null;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('hashchange', onHash);
    if (prevFocus && prevFocus.isConnected) prevFocus.focus?.({ preventScroll: true });
  }

  document.addEventListener('keydown', onKey, true);
  window.addEventListener('hashchange', onHash);
  host.append(overlay);
  return { close };
}

/** Встроенный вариант (страница pages/run-dialog.html или web resource): params.ids="1,2,3" или params.group. */
export function mount(el, params = {}) {
  const ids = Array.isArray(params.ids) ? params.ids : String(params.ids || '').split(',').filter(Boolean);
  const box = h('div', { class: 'cqa-panel cqa-modal__box cqa-modal__box--inline' });
  el.append(box);
  const panel = runPanel(box, { ...params, ids, group: params.group || 'DEV', checklistVersionId: params.checklistVersionId ?? params.version }, { onClose: () => {}, onMinimize: () => {}, inline: true });
  return { update() {}, unmount() { panel.destroy(); box.remove(); } };
}
