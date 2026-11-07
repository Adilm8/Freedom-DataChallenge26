// Панель результата: обзор, итог и секции, параметры оценки с сырыми вызовами LLM, критерии с доказательствами.
// События наружу: cqa:evidence-click {msg_id|msg_ids, quote(s), from, to, key}, cqa:run-request {ids, preset},
// cqa:navigate {to}. Внутрь: cqa:focus-criterion {key} на el.
import { h, clear, emit, answerBadge, answerState, score, fmtScore, fmtMoney, fmtDate, skeletonRows, errorState, emptyState, ring } from '../ui.js';
import { getEvaluation, getEvaluationCalls } from '../api.js';
import { mount as mountCalls } from './llm-calls.js';
import { openAppealForm } from './appeal-form.js';

const RESOLVED = { yes: ['Вопрос решён', 'yes'], no: ['Вопрос не решён', 'no'], unclear: ['Решён ли вопрос — неясно', 'na'] };
const CONF = {
  high: ['Высокая уверенность', 'Модель уверена в ответе'],
  medium: ['Средняя уверенность', 'Модель уверена частично'],
  low: ['Низкая уверенность', 'Данных для вывода мало: ответ стоит проверить вручную'],
};
export const STRATEGY_LABEL = { grouped: 'по группам', single: 'один вызов', per_criterion: 'по критерию' };
const AP_STATUS = { open: ['Апелляция открыта', 'warn'], confirmed: ['Оценка подтверждена', 'yes'], changed: ['Ответ изменён', 'accent'] };
const SECTION_TITLES = { start: 'Начало и понимание запроса', safety: 'Безопасность и решение', dialog: 'Ведение и завершение диалога', critical: 'Грубые нарушения' };

function confidence(level) {
  // Высокая уверенность — норма, её не подписываем: шум на каждом критерии. Видны только средняя и низкая.
  if (!level || level === 'high') return null;
  const [text, tip] = CONF[level] || [level, ''];
  if (level === 'low') {
    return h('span', { class: 'cqa-badge cqa-badge--warn cqa-conf-low cqa-tip', 'data-tip': tip }, h('span', { class: 'cqa-conf-low__mark', 'aria-hidden': 'true' }, '!'), text);
  }
  return h('span', { class: `cqa-conf cqa-conf--${level} cqa-tip`, 'data-tip': tip },
    h('span', { class: 'cqa-conf__dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), text);
}

function pointsText(c) {
  if (c.type === 'flag') return null;
  if (c.final_answer === 'na') return h('span', { class: 'cqa-crit__pts cqa-faint' }, 'вне расчёта');
  if (c.final_answer == null) return h('span', { class: 'cqa-crit__pts cqa-faint' }, 'нет ответа');
  const pts = c.final_points ?? 0;
  return h('span', { class: 'cqa-crit__pts' }, `${pts}`, h('small', null, ` / ${c.weight}`));
}

export function mount(el, params = {}) {
  let p = { ...params };
  const root = h('div', { class: 'cqa-res' });
  el.append(root);
  let ev = null;
  let calls = null;
  let rawOpen = false;
  let token = 0;

  const preset = () => ({ provider: ev.provider, model: ev.model, strategy: ev.strategy, reuse: 'none' });
  const showInTranscript = (c, extra = {}) => {
    const evs = c.evidence || [];
    emit(root, 'cqa:evidence-click', { key: c.key, msg_ids: evs.map((e) => e.msg_id), quotes: evs.map((e) => e.quote),
      from: c.checked_range?.from, to: c.checked_range?.to, ...extra });
  };

  function section(sec, list) {
    const sf = ev.final_score.sections.find((x) => x.id === sec.id);
    return h('section', { class: 'cqa-ressec' },
      h('div', { class: 'cqa-sechead' },
        h('h3', { class: 'cqa-h3' }, sec.title),
        sf?.applicable_weight ? h('span', { class: 'cqa-sechead__pts', title: `${fmtScore(sf.pct)}% от применимого веса секции` }, `${+Number(sf.points).toFixed(2)} из ${+Number(sf.applicable_weight).toFixed(2)}`) : null),
      list.map(criterion));
  }

  function evidenceRow(c, e) {
    const bad = e.quote_ok === false;
    return h('div', { class: `cqa-ev__row ${bad ? 'cqa-ev__row--bad' : ''}` },
      h('button', { type: 'button', class: 'cqa-chip cqa-tip', 'data-tip': 'Показать реплику в расшифровке',
        onclick: () => emit(root, 'cqa:evidence-click', { msg_id: e.msg_id, key: c.key, quote: bad ? null : e.quote }) }, e.msg_id),
      bad
        ? h('span', { class: 'cqa-ev__bad' },
          h('span', { class: 'cqa-badge cqa-badge--warn' }, 'цитата не найдена'),
          e.quote ? h('span', { class: 'cqa-ev__quote cqa-ev__quote--bad' }, e.quote) : null,
          h('span', { class: 'cqa-faint' }, 'фразы модели нет в тексте реплики — сверьте реплику вручную'))
        : h('span', { class: 'cqa-ev__quote' }, e.quote || '—'));
  }

  function criterion(c) {
    const flagged = c.type === 'flag' && c.final_answer === 'yes';
    const review = c.confidence === 'low' || (c.issues || []).length;
    const state = flagged ? 'flag' : answerState(c); // полоса слева: грубая ошибка > не выполнен > частично
    const body = [];
    if (c.reasoning) body.push(h('div', { class: 'cqa-crit__why' }, c.reasoning));
    if (c.final_answer === 'na' || c.ai_answer === 'na') {
      body.push(h('div', { class: 'cqa-nareason' }, h('b', null, 'Почему N/A: '), c.na_reason || h('span', { class: 'cqa-faint' }, 'причина не указана')));
    }
    if (c.evidence?.length || c.checked_range) {
      body.push(h('div', { class: 'cqa-ev' },
        (c.evidence || []).map((e) => evidenceRow(c, e)),
        c.checked_range
          ? h('div', { class: 'cqa-ev__row' }, h('span', { class: 'cqa-faint' }, 'Проверен участок:'),
            h('button', { type: 'button', class: 'cqa-chip cqa-chip--range cqa-tip', 'data-tip': 'Подсветить проверенный диапазон реплик',
              onclick: () => emit(root, 'cqa:evidence-click', { from: c.checked_range.from, to: c.checked_range.to, key: c.key }) },
            `${c.checked_range.from} – ${c.checked_range.to}`))
          : null));
    } else if (c.final_answer != null && c.type !== 'flag') {
      body.push(h('div', { class: 'cqa-faint cqa-ev__none' }, 'Модель не привела реплик-доказательств.'));
    }
    if ((c.issues || []).length) {
      body.push(h('div', { class: 'cqa-warnbox' }, h('b', null, 'Предупреждения проверки'),
        h('ul', null, c.issues.map((i) => h('li', null, i)))));
    }
    if (c.advice) body.push(h('div', { class: 'cqa-advice' }, h('b', null, 'Рекомендация оператору'), c.advice));


    const foot = [confidence(c.confidence)];
    // «Требует проверки» — чипом в подвале (полоса слева занята результатом); низкая уверенность уже видна своим чипом.
    if ((c.issues || []).length && c.confidence !== 'low') foot.push(h('span', { class: 'cqa-badge cqa-badge--warn cqa-tip', 'data-tip': 'Есть предупреждения проверки ответа — сверьте вручную' }, 'Требует проверки'));
    if (c.reused_from_evaluation_id) {
      foot.push(h('button', { type: 'button', class: 'cqa-chip cqa-chip--reused cqa-tip', 'data-tip': 'Критерий не менялся: ответ взят из прошлой оценки без нового вызова. Открыть ту оценку',
        onclick: () => emit(root, 'cqa:navigate', { to: `#/conversation/${ev.conversation_id}?eval=${c.reused_from_evaluation_id}` }) },
      `↺ ответ из оценки #${c.reused_from_evaluation_id}`));
    }
    if (c.evidence?.length || c.checked_range) {
      foot.push(h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm cqa-btn--ghost', onclick: () => showInTranscript(c) }, 'Перейти к фрагменту'));
    }
    if (p.mode !== 'reviewer') {
      const open = c.appeal?.status === 'open';
      const why = open ? `Апелляция №${c.appeal.id} уже ждёт решения проверяющего` : c.final_answer == null ? 'Ответа нет — оспаривать нечего' : '';
      foot.push(h('button', { type: 'button', class: `cqa-btn cqa-btn--sm cqa-crit__appeal ${why ? 'cqa-tip' : ''}`, disabled: !!why, 'data-tip': why || null,
        dataset: { appeal: c.key }, onclick: () => appeal(c) }, c.appeal ? 'Оспорить снова' : 'Оспорить оценку'));
    }

    return h('article', { class: `cqa-panel cqa-crit ${state ? `cqa-crit--${state}` : ''} ${review ? 'cqa-crit--review' : ''}`, id: `crit-${c.key}`, dataset: { key: c.key, state: state || 'ok' }, tabindex: -1 },
      h('div', { class: 'cqa-crit__head' },
        h('span', { class: `cqa-code ${flagged ? 'cqa-code--flag' : state ? `cqa-code--${state}` : ''}` }, c.key),
        h('span', { class: 'cqa-crit__title' }, c.title),
        c.final_answer == null ? h('span', { class: 'cqa-badge cqa-badge--muted' }, 'нет ответа') : answerBadge(c, undefined, { words: true }),
        c.overridden ? h('span', { class: 'cqa-badge cqa-badge--accent' }, 'изменено') : null,
        pointsText(c)),
      h('div', { class: 'cqa-crit__body' }, body, appealBlock(c)),
      h('div', { class: 'cqa-crit__foot' }, foot));
  }

  // Три слоя оспоренного критерия: ответ AI (не меняется) → решение проверяющего → финальный ответ (FR-APL-04, 05).
  function appealBlock(c) {
    const a = c.appeal;
    if (!a) return null;
    const hist = c.appeal_history?.length ? c.appeal_history : [a];
    const [stText, tone] = AP_STATUS[a.status] || [a.status, 'muted'];
    const pts = (v) => (c.type === 'flag' || v == null ? null : h('small', { class: 'cqa-apl__pts' }, `${+Number(v).toFixed(2)} / ${c.weight}`));
    const layer = (label, ...kids) => h('div', { class: 'cqa-apl__layer' }, h('span', { class: 'cqa-apl__label' }, label), h('span', { class: 'cqa-apl__val' }, kids));
    const decision = a.status === 'open' ? h('span', { class: 'cqa-badge cqa-badge--warn' }, 'ждёт проверяющего')
      : a.status === 'changed' ? [h('span', { class: 'cqa-faint' }, 'изменить на'), answerBadge(c, a.decision_answer)]
        : h('span', { class: 'cqa-badge cqa-badge--yes' }, 'подтвердить AI');
    const older = hist.slice(0, -1).reverse();
    return h('div', { class: `cqa-apl cqa-apl--${a.status}`, id: `appeal-${c.key}` },
      h('div', { class: 'cqa-apl__head' },
        h('b', null, `Апелляция №${a.id}`), h('span', { class: `cqa-badge cqa-badge--${tone}` }, stText),
        h('span', { class: 'cqa-faint' }, fmtDate(a.decided_at || a.created_at)),
        a.status === 'open' && p.mode === 'reviewer'
          ? h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm cqa-btn--primary cqa-apl__go', onclick: () => emit(root, 'cqa:navigate', { to: `#/appeals?id=${a.id}` }) }, 'Рассмотреть')
          : null),
      h('div', { class: 'cqa-apl__layers' },
        layer('AI', answerBadge(c, c.ai_answer), pts(c.ai_points)),
        h('span', { class: 'cqa-apl__arrow', 'aria-hidden': 'true' }, '→'),
        layer('Решение', decision),
        h('span', { class: 'cqa-apl__arrow', 'aria-hidden': 'true' }, '→'),
        layer('Финал', answerBadge(c, c.final_answer), pts(c.final_points))),
      h('div', { class: 'cqa-apl__text' }, h('b', null, 'Комментарий: '), a.comment),
      a.decision_reason ? h('div', { class: 'cqa-apl__text' }, h('b', null, 'Причина решения: '), a.decision_reason) : null,
      older.length ? h('details', { class: 'cqa-apl__hist' }, h('summary', null, `Прошлые апелляции: ${older.length}`),
        h('ul', null, older.map((x) => h('li', null, h('b', null, `№${x.id}`), ` · ${(AP_STATUS[x.status] || [x.status])[0].toLowerCase()} · ${fmtDate(x.decided_at || x.created_at)} — ${x.comment}`,
          x.decision_reason ? h('span', { class: 'cqa-faint' }, ` → ${x.decision_reason}`) : null)))) : null);
  }

  function appeal(c) {
    const host = root.closest('.cqa-root') || document.body;
    openAppealForm(host, { evaluation: ev, criterion: c, onSaved: async () => {
      emit(root, 'cqa:counts-changed', {});
      const my = ++token;
      try {
        const fresh = await getEvaluation(ev.id);
        if (my !== token) return;
        ev = fresh;
        render();
        emit(root, 'cqa:evaluation-updated', { evaluation: ev });
        focusCriterion(c.key, false);
      } catch { /* карточка обновится при следующем открытии */ }
    } });
  }

  // Обзор — строкой внутри панели итога (тема, решён ли вопрос, резюме в две строки; клик — полностью).
  // Отдельной панелью — только когда итога нет (оценка не выполнена).
  function overview(inline) {
    const o = ev.overview;
    if (!o) return null;
    const [rt, rc] = RESOLVED[o.resolved] || RESOLVED.unclear;
    const text = o.summary ? h('div', { class: 'cqa-ov__text cqa-sum__ovtext', title: inline ? 'Показать полностью' : null, tabindex: inline ? 0 : null,
      onclick: inline ? (e) => e.currentTarget.classList.toggle('cqa-sum__ovtext--open') : null,
      onkeydown: inline ? (e) => { if (e.key === 'Enter') e.currentTarget.classList.toggle('cqa-sum__ovtext--open'); } : null }, o.summary)
      : h('div', { class: 'cqa-ov__text cqa-faint' }, 'Резюме не сформировано.');
    const badges = [o.topic ? h('span', { class: 'cqa-badge cqa-badge--accent cqa-sum__topic' }, o.topic) : null, h('span', { class: `cqa-badge cqa-badge--${rc}` }, rt)];
    if (inline) return h('div', { class: 'cqa-sum__ov', 'aria-label': 'Обзор диалога' }, h('div', { class: 'cqa-sum__ovhead' }, badges), text);
    return h('div', { class: 'cqa-panel cqa-ovpanel' },
      h('div', { class: 'cqa-ovpanel__head' }, h('h3', { class: 'cqa-h3' }, 'Обзор'), badges), text);
  }

  function summary() {
    const ai = ev.ai_score, fin = ev.final_score;
    const changed = fin.total !== ai.total && fin.total != null && ai.total != null;
    // После решений по апелляциям итог AI и финальный стоят рядом, даже если ответ подтверждён.
    const both = changed || ev.criteria.some((c) => (c.appeal_history || []).some((a) => a.status !== 'open'));
    const parts = [];
    parts.push(h('div', { class: 'cqa-sum__top' },
      ring(fin.total ?? ai.total, 76, 8),
      h('div', { id: 'cqa-sum-ai' }, h('div', { class: 'cqa-sum__label' }, both ? 'Итог AI · не меняется' : 'Итог AI'),
        h('div', { class: `cqa-sum__big ${changed ? 'cqa-muted' : ''}` }, changed ? h('span', { style: 'font-size:.6em' }, fmtScore(ai.total)) : score(ai.total), ' ', h('span', { class: 'cqa-sum__of' }, '/ 100'))),
      both ? h('div', { class: 'cqa-sum__arrow' }, '→') : null,
      both ? h('div', { id: 'cqa-sum-final' }, h('div', { class: 'cqa-sum__label' }, 'Финальный итог'),
        h('div', { class: 'cqa-sum__big' }, score(fin.total), ' ', changed ? h('span', { class: 'cqa-delta' }, `${fin.total - ai.total > 0 ? '+' : ''}${(fin.total - ai.total).toFixed(2)}`)
          : h('span', { class: 'cqa-sum__of' }, 'как у AI'))) : null,
      h('div', { class: 'cqa-sum__aw' },
        h('div', { class: 'cqa-sum__label' }, 'Применимый вес'),
        h('b', null, `${fin.applicable_weight ?? 0} из 100`))));
    const ov = overview(true);
    if (ov) parts.push(ov);

    const secs = (fin.sections || []).filter((s) => s.applicable_weight);
    if (secs.length) {
      parts.push(h('div', { class: 'cqa-secbars' }, secs.map((s) => {
        const cls = s.pct >= 85 ? '' : s.pct >= 60 ? 'cqa-bar__fill--mid' : 'cqa-bar__fill--bad';
        return h('div', null,
          h('div', { class: 'cqa-secbar__row' }, h('span', null, s.title), h('b', null, `${s.points} / ${s.applicable_weight}`)),
          h('div', { class: 'cqa-bar', role: 'img', 'aria-label': `${s.title}: ${s.pct}%` }, h('div', { class: `cqa-bar__fill ${cls}`, style: `width:${s.pct}%` })));
      })));
    }
    parts.push(whyLowered());
    return h('div', { class: 'cqa-panel cqa-sum' }, parts);
  }

  // «Почему снижена оценка»: критерии, где финальный балл ниже веса, и грубые ошибки — по убыванию потерь.
  function whyLowered() {
    const firstSentence = (t) => { const x = String(t || '').trim(); const m = /^(.{20,220}?[.!?])(\s|$)/.exec(x); return m ? m[1] : x.length > 220 ? x.slice(0, 217) + '…' : x; };
    const items = ev.criteria.map((c) => {
      if (c.type === 'flag') return c.final_answer === 'yes' ? { c, lost: Infinity, label: 'грубая ошибка' } : null;
      const max = Number(c.weight), pts = Number(c.final_points);
      if (c.final_answer == null || c.final_answer === 'na' || !Number.isFinite(pts) || !(pts < max)) return null;
      return { c, lost: max - pts, label: `−${fmtNum(max - pts)} из ${fmtNum(max)}` };
    }).filter(Boolean).sort((a, b) => b.lost - a.lost);
    const head = h('div', { class: 'cqa-why__title' }, 'Почему снижена оценка');
    if (!items.length) return h('div', { class: 'cqa-why', id: 'cqa-why' }, head, h('div', { class: 'cqa-faint' }, 'Не снижена: все применимые критерии выполнены полностью.'));
    return h('div', { class: 'cqa-why', id: 'cqa-why' }, head,
      h('ul', { class: 'cqa-why__list' }, items.map(({ c, label }) => {
        const canAppeal = p.mode !== 'reviewer' && c.appeal?.status !== 'open';
        return h('li', { class: `cqa-why__item ${c.type === 'flag' ? 'cqa-why__item--flag' : ''}` },
          h('div', { class: 'cqa-why__main' },
            h('div', { class: 'cqa-why__head' }, h('span', { class: 'cqa-code' }, c.key), h('b', null, c.title), h('span', { class: 'cqa-why__lost' }, label)),
            c.reasoning ? h('div', { class: 'cqa-why__text' }, firstSentence(c.reasoning)) : null),
          h('div', { class: 'cqa-why__acts' },
            c.evidence?.length || c.checked_range ? h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm cqa-btn--primary', onclick: () => showInTranscript(c) }, 'Перейти к фрагменту') : null,
            canAppeal ? h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm', onclick: () => appeal(c) }, 'Оспорить оценку') : null,
            h('button', { type: 'button', class: 'cqa-linkbtn', onclick: () => { const el = root.querySelector(`#crit-${CSS.escape(c.key)}`); el?.scrollIntoView({ block: 'start', behavior: 'smooth' }); el?.focus({ preventScroll: true }); } }, 'подробнее')));
      })));
  }
  const fmtNum = (v) => (Number.isInteger(v) ? String(v) : Number(v).toFixed(2).replace(/\.?0+$/, ''));

  function metaPanel() {
    const pr = ev.params || {};
    const dl = (label, value) => h('div', { class: 'cqa-kv__item' }, h('dt', null, label), h('dd', null, value));
    const callsEl = h('div', { class: 'cqa-rawbox', hidden: !rawOpen });
    const toggle = h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm', 'aria-expanded': String(rawOpen), id: 'cqa-raw-toggle',
      onclick: () => {
        rawOpen = !rawOpen;
        callsEl.hidden = !rawOpen;
        toggle.setAttribute('aria-expanded', String(rawOpen));
        toggle.textContent = rawOpen ? 'Скрыть сырой ответ' : 'Сырой ответ';
        if (rawOpen && !calls) calls = mountCalls(callsEl, { evaluationId: ev.id });
      } }, rawOpen ? 'Скрыть сырой ответ' : 'Сырой ответ');
    if (rawOpen) calls = mountCalls(callsEl, { evaluationId: ev.id });
    return h('div', { class: 'cqa-panel cqa-metapanel' },
      h('div', { class: 'cqa-metapanel__head' }, h('h3', { class: 'cqa-h3' }, `Оценка #${ev.id}`), h('span', { class: 'cqa-faint' }, fmtDate(ev.created_at)), toggle),
      h('dl', { class: 'cqa-kv' },
        dl('Провайдер', ev.provider || '—'),
        dl('Модель', h('span', { class: 'cqa-mono' }, ev.model || '—')),
        dl('Стратегия', STRATEGY_LABEL[ev.strategy] || ev.strategy || '—'),
        dl('Чек-лист · промпт', `v${ev.checklist_version_id} · ${ev.prompt_version || '—'}`),
        dl('Токены', `${(ev.tokens_in || 0).toLocaleString('ru-RU')} вход · ${(ev.tokens_out || 0).toLocaleString('ru-RU')} выход`),
        dl('Стоимость', fmtMoney(ev.cost_usd)),
        dl('Время', `${((ev.latency_ms || 0) / 1000).toFixed(1)} с`),
        dl('Параметры', [pr.temperature != null ? `temperature ${pr.temperature}` : null, pr.seed != null ? `seed ${pr.seed}` : null,
          pr.reuse ? (pr.reuse === 'auto' ? 'прошлые ответы: да' : 'прошлые ответы: нет') : null].filter(Boolean).join(' · ') || '—')),
      callsEl);
  }

  function banners() {
    const out = [];
    if (ev.status === 'failed' || ev.status === 'partial') {
      const failed = ev.status === 'failed';
      const reason = h('div', { class: 'cqa-banner__reason' }, failed ? 'Загружаем причину…' : '');
      out.push(h('div', { class: `cqa-banner ${failed ? 'cqa-banner--flag' : 'cqa-banner--warn'}`, role: 'alert' }, h('span', { class: 'cqa-banner__icon' }, '!'),
        h('div', null,
          h('div', { class: 'cqa-banner__title' }, failed ? 'Оценка не выполнена' : 'Оценка выполнена не полностью'),
          h('div', null, failed ? 'Модель не вернула ответов, баллы не посчитаны.' : 'По части критериев ответа нет; итог посчитан по остальным.'),
          reason,
          h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm', style: 'margin-top:8px', onclick: () => emit(root, 'cqa:run-request', { ids: [ev.conversation_id], preset: preset() }) }, 'Оценить повторно'))));
      const my = token;
      getEvaluationCalls(ev.id).then((cs) => {
        if (my !== token) return;
        const errs = [...new Set(cs.map((c) => c.error).filter(Boolean))];
        reason.textContent = errs.length ? `Причина: ${errs.join('; ')}` : (failed ? 'Причина не сохранена — смотрите «Сырой ответ».' : '');
      }).catch(() => { if (my === token) reason.textContent = ''; });
    }
    const crit = ev.ai_score?.critical || [];
    if (crit.length) {
      const c = ev.criteria.find((x) => x.key === crit[0]);
      out.push(h('div', { class: 'cqa-banner cqa-banner--flag', role: 'alert' }, h('span', { class: 'cqa-banner__icon' }, '!'),
        h('div', null, h('div', { class: 'cqa-banner__title' }, 'Грубая ошибка оператора'),
          h('div', null, c?.reasoning || 'Выявлено грубое нарушение.'),
          h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm', style: 'margin-top:8px', onclick: () => focusCriterion(crit[0], true) }, `Перейти к критерию ${crit[0]}`))));
    }
    const review = ev.criteria.filter((c) => c.confidence === 'low' || (c.issues || []).length);
    if (review.length) {
      out.push(h('div', { class: 'cqa-banner cqa-banner--warn' }, h('span', { class: 'cqa-banner__icon' }, '?'),
        h('div', null, h('div', { class: 'cqa-banner__title' }, 'Требует проверки'),
          h('div', null, 'Низкая уверенность или предупреждения: ',
            review.map((c, i) => [i ? ', ' : '', h('button', { type: 'button', class: 'cqa-linkbtn', onclick: () => focusCriterion(c.key, true) }, `${c.key} ${c.title}`)]), '.'))));
    }
    return out;
  }

  function render() {
    token++;
    calls?.unmount(); calls = null;
    clear(root);
    // Итог — первым в колонке (обзор внутри него), предупреждения — под ним.
    const noTotal = ev.status === 'failed' && ev.ai_score?.total == null;
    const out = noTotal ? [...banners(), overview(false)] : [summary(), ...banners()];
    const defs = new Map();
    for (const c of ev.criteria) { if (!defs.has(c.section)) defs.set(c.section, []); defs.get(c.section).push(c); }
    for (const [id, list] of defs) {
      const sec = ev.ai_score.sections.find((x) => x.id === id) || { id, title: SECTION_TITLES[id] || id || 'Критерии' };
      out.push(section(sec, list));
    }
    out.push(metaPanel());
    root.append(...out.filter(Boolean));
  }

  function focusCriterion(key, emitToo) {
    const node = root.querySelector(`#crit-${CSS.escape(key)}`);
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.focus({ preventScroll: true });
    node.classList.remove('cqa-crit--focus');
    void node.offsetWidth;
    node.classList.add('cqa-crit--focus');
    setTimeout(() => node.classList.remove('cqa-crit--focus'), 2400);
    if (emitToo) {
      const c = ev.criteria.find((x) => x.key === key);
      if (c && (c.evidence?.length || c.checked_range)) showInTranscript(c);
    }
  }

  async function load() {
    const my = ++token;
    clear(root).append(h('div', { class: 'cqa-panel' }, skeletonRows(8)));
    try {
      ev = p.evaluation || (p.eval ? await getEvaluation(p.eval) : null);
      if (my !== token) return;
      if (!ev) {
        clear(root).append(h('div', { class: 'cqa-panel' }, emptyState({ title: 'Диалог ещё не оценён',
          text: 'Запустите оценку: здесь появятся баллы по 8 критериям, обоснование, цитаты-доказательства и подсказки оператору.',
          icon: '—', actionLabel: 'Оценить', onAction: () => emit(root, 'cqa:run-request', { ids: [p.conversationId] }) })));
        return;
      }
      render();
    } catch (e) {
      if (my === token) clear(root).append(h('div', { class: 'cqa-panel' }, errorState(e, load)));
    }
  }

  // {key, show}: show — ещё и подсветить доказательства в транскрипте (переход из очереди и апелляций).
  // Две плавные прокрутки сразу браузер не доводит: транскрипт прокручиваем после колонки результата,
  // а в одну колонку (телефон) подсвечиваем без прокрутки — страница остаётся на критерии.
  const onFocus = (e) => {
    const d = e.detail || {};
    focusCriterion(d.key, false);
    const c = d.show && ev?.criteria.find((x) => x.key === d.key);
    if (!c || !(c.evidence?.length || c.checked_range)) return;
    const narrow = window.matchMedia('(max-width: 900px)').matches;
    setTimeout(() => { if (root.isConnected) showInTranscript(c, narrow ? { scroll: false } : {}); }, narrow ? 0 : 500);
  };
  el.addEventListener('cqa:focus-criterion', onFocus);
  load();

  return {
    update(np) {
      const reload = np.evaluation !== p.evaluation || np.eval !== p.eval;
      p = { ...p, ...np };
      if (reload) load(); else if (ev) render();
    },
    unmount() { token++; calls?.unmount(); el.removeEventListener('cqa:focus-criterion', onFocus); root.remove(); },
  };
}
