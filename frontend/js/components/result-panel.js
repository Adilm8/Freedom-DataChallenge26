// Панель результата: итог, секции, обзор, метаданные и критерии с доказательствами.
import { h, clear, emit, answerBadge, score, fmtScore, fmtMoney, fmtDate, skeletonRows, errorState, emptyState } from '../ui.js';
import { getEvaluation } from '../api.js';

const RESOLVED = { yes: ['Вопрос решён', 'yes'], no: ['Вопрос не решён', 'no'], unclear: ['Решение неясно', 'na'] };
const CONF = { high: 'Высокая уверенность', medium: 'Средняя уверенность', low: 'Низкая уверенность' };
const CONF_SHORT = { high: 'Уверенность высокая', medium: 'Уверенность средняя', low: 'Низкая уверенность' };

function confidence(level) {
  return h('span', { class: `cqa-conf cqa-conf--${level} cqa-tip`, 'data-tip': CONF[level] || level },
    h('span', { class: 'cqa-conf__dots' }, h('i'), h('i'), h('i')),
    CONF_SHORT[level] || level);
}

function pointsText(c) {
  if (c.type === 'flag') return null;
  if (c.final_answer === 'na') return h('span', { class: 'cqa-crit__pts cqa-faint' }, 'вне расчёта');
  const pts = c.final_points ?? 0;
  return h('span', { class: 'cqa-crit__pts' }, `${pts}`, h('small', null, ` / ${c.weight}`));
}

export function mount(el, params = {}) {
  let p = { ...params };
  const root = h('div', { class: 'cqa-res' });
  el.append(root);
  let ev = null;

  function section(sec, list, ai) {
    const s = ai.ai_score.sections.find((x) => x.id === sec.id);
    const sf = ev.final_score.sections.find((x) => x.id === sec.id);
    return h('section', null,
      h('div', { class: 'cqa-sechead' },
        h('h3', { class: 'cqa-h3' }, sec.title),
        sf ? h('span', { class: 'cqa-sechead__pts' }, `${sf.points} из ${sf.applicable_weight} · ${fmtScore(sf.pct)}%`) : null),
      list.map(criterion));
  }

  function criterion(c) {
    const flagged = c.type === 'flag' && c.final_answer === 'yes';
    const review = c.confidence === 'low' || (c.issues || []).length;
    const body = [];
    body.push(h('div', { class: 'cqa-crit__why' }, c.reasoning));
    if (c.final_answer === 'na' && c.na_reason) body.push(h('div', { class: 'cqa-nareason' }, h('b', null, 'Причина N/A: '), c.na_reason));
    if (c.evidence?.length || c.checked_range) {
      body.push(h('div', { class: 'cqa-ev' },
        (c.evidence || []).map((e) => h('div', { class: 'cqa-ev__row' },
          h('button', { type: 'button', class: 'cqa-chip cqa-tip', 'data-tip': 'Показать реплику в транскрипте',
            onclick: () => emit(root, 'cqa:evidence-click', { msg_id: e.msg_id, key: c.key, quote: e.quote }) }, e.msg_id),
          h('span', { class: 'cqa-ev__quote' }, e.quote),
          e.quote_ok === false ? h('span', { class: 'cqa-badge cqa-badge--warn' }, 'цитата не проверена') : null)),
        c.checked_range
          ? h('div', { class: 'cqa-ev__row' }, h('span', { class: 'cqa-faint' }, 'Проверено:'),
            h('button', { type: 'button', class: 'cqa-chip cqa-chip--range cqa-tip', 'data-tip': 'Показать проверенный диапазон',
              onclick: () => emit(root, 'cqa:evidence-click', { from: c.checked_range.from, to: c.checked_range.to, key: c.key }) },
            `${c.checked_range.from} – ${c.checked_range.to}`))
          : null));
    }
    if ((c.issues || []).length) {
      body.push(h('div', { class: 'cqa-warnbox' }, h('b', null, 'Требует проверки'),
        h('ul', null, c.issues.map((i) => h('li', null, i)))));
    }
    if (c.advice) body.push(h('div', { class: 'cqa-advice' }, h('b', null, 'Рекомендация оператору'), c.advice));
    if (c.reused_from_evaluation_id) body.push(h('div', { class: 'cqa-faint' }, `Из оценки #${c.reused_from_evaluation_id}`));

    const foot = [];
    const appealLine = [];
    if (c.overridden) {
      appealLine.push(h('span', { class: 'cqa-appeal__text' },
        h('b', null, 'Пересмотр: '), 'AI ', answerBadge(c, c.ai_answer), ' → проверяющий ', answerBadge(c, c.final_answer),
        c.appeal?.decision_reason ? ` · ${c.appeal.decision_reason}` : ''));
    } else if (c.appeal?.status === 'open') {
      appealLine.push(h('span', { class: 'cqa-appeal__text' }, h('span', { class: 'cqa-badge cqa-badge--warn' }, 'Апелляция открыта'), ` ${c.appeal.comment}`));
    }
    if (p.mode !== 'reviewer') {
      foot.push(h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm cqa-tip', disabled: true, 'data-tip': 'Подача апелляции появится на следующем шаге' }, 'Оспорить'));
    }

    return h('article', { class: `cqa-panel cqa-crit ${flagged ? 'cqa-crit--flag' : review ? 'cqa-crit--review' : ''}`, id: `crit-${c.key}`, dataset: { key: c.key } },
      h('div', { class: 'cqa-crit__head' },
        h('span', { class: `cqa-code ${flagged ? 'cqa-code--flag' : ''}` }, c.key),
        h('span', { class: 'cqa-crit__title' }, c.title),
        answerBadge(c),
        c.overridden ? h('span', { class: 'cqa-badge cqa-badge--accent' }, 'изменено') : null,
        pointsText(c)),
      h('div', { class: 'cqa-crit__body' }, body, appealLine.length ? h('div', { class: 'cqa-appeal' }, appealLine) : null),
      h('div', { class: 'cqa-appeal', style: 'border-top:0;padding-top:8px' }, confidence(c.confidence), foot));
  }

  function summary() {
    const ai = ev.ai_score, fin = ev.final_score;
    const changed = fin.total !== ai.total;
    const warnCount = ev.criteria.filter((c) => c.confidence === 'low' || (c.issues || []).length).length;
    const parts = [];
    parts.push(h('div', { class: 'cqa-sum__top' },
      h('div', null, h('div', { class: 'cqa-sum__label' }, 'Итог AI'),
        h('div', { class: `cqa-sum__big ${changed ? 'cqa-muted' : ''}` }, changed ? h('span', { style: 'font-size:.6em' }, fmtScore(ai.total)) : score(ai.total), ' ', h('span', { class: 'cqa-sum__of' }, '/ 100'))),
      changed ? h('div', { class: 'cqa-sum__arrow' }, '→') : null,
      changed ? h('div', null, h('div', { class: 'cqa-sum__label' }, 'Финальный итог'),
        h('div', { class: 'cqa-sum__big' }, score(fin.total), ' ', h('span', { class: 'cqa-delta' }, `${fin.total - ai.total > 0 ? '+' : ''}${(fin.total - ai.total).toFixed(2)}`))) : null,
      h('div', { style: 'margin-left:auto;text-align:right' },
        h('div', { class: 'cqa-sum__label' }, 'Применимый вес'),
        h('b', null, `${fin.applicable_weight} из 100`))));

    parts.push(h('div', { class: 'cqa-secbars' }, fin.sections.map((s) => {
      const cls = s.pct >= 85 ? '' : s.pct >= 60 ? 'cqa-bar__fill--mid' : 'cqa-bar__fill--bad';
      return h('div', null,
        h('div', { class: 'cqa-secbar__row' }, h('span', null, s.title), h('b', null, `${s.points} / ${s.applicable_weight}`)),
        h('div', { class: 'cqa-bar', role: 'img', 'aria-label': `${s.title}: ${s.pct}%` }, h('div', { class: `cqa-bar__fill ${cls}`, style: `width:${s.pct}%` })));
    })));

    if (ev.overview) {
      const [rt, rc] = RESOLVED[ev.overview.resolved] || RESOLVED.unclear;
      parts.push(h('div', { class: 'cqa-ov' },
        h('div', { class: 'cqa-tags' }, h('span', { class: 'cqa-badge cqa-badge--accent' }, ev.overview.topic), h('span', { class: `cqa-badge cqa-badge--${rc}` }, rt)),
        h('div', { class: 'cqa-ov__text' }, ev.overview.summary)));
    }

    const rawStub = h('div', { class: 'cqa-rawstub cqa-banner cqa-banner--info', hidden: true }, h('span', { class: 'cqa-banner__icon' }, 'i'),
      h('div', null, 'Сырые ответы LLM появятся после подключения бэкенда (GET /evaluations/{id}/calls).'));
    parts.push(h('div', { class: 'cqa-meta' },
      h('span', { class: 'cqa-chip' }, `модель: ${ev.model}`),
      h('span', { class: 'cqa-chip' }, `стратегия: ${ev.strategy}`),
      h('span', { class: 'cqa-chip' }, `чек-лист v${ev.checklist_version_id}`),
      h('span', { class: 'cqa-chip' }, `промпт ${ev.prompt_version}`),
      h('span', { class: 'cqa-chip' }, `${(ev.tokens_in + ev.tokens_out).toLocaleString('ru-RU')} ток.`),
      h('span', { class: 'cqa-chip' }, fmtMoney(ev.cost_usd)),
      h('span', { class: 'cqa-chip' }, `${(ev.latency_ms / 1000).toFixed(1)} с`),
      h('span', { class: 'cqa-chip' }, fmtDate(ev.created_at)),
      h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm', onclick: () => { rawStub.hidden = !rawStub.hidden; } }, 'Сырой ответ')));
    parts.push(rawStub);
    return h('div', { class: 'cqa-panel cqa-sum' }, parts);
  }

  function render() {
    clear(root);
    const out = [];
    const crit = ev.ai_score.critical;
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
          h('div', null, `Критерии с низкой уверенностью или предупреждениями: ${review.map((c) => c.key).join(', ')}.`))));
    }
    out.push(summary());
    const sections = ev.ai_score.sections.map((s) => s.id);
    const defs = new Map();
    for (const c of ev.criteria) { if (!defs.has(c.section)) defs.set(c.section, []); defs.get(c.section).push(c); }
    const titles = { start: 'Начало и понимание запроса', safety: 'Безопасность и решение', dialog: 'Ведение и завершение диалога', critical: 'Грубые нарушения' };
    for (const [id, list] of defs) {
      const sec = ev.ai_score.sections.find((x) => x.id === id) || { id, title: titles[id] || id };
      out.push(section(sec, list, ev));
    }
    void sections;
    root.append(...out);
  }

  function focusCriterion(key, emitToo) {
    const node = root.querySelector(`#crit-${CSS.escape(key)}`);
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.add('cqa-crit--focus');
    setTimeout(() => node.classList.remove('cqa-crit--focus'), 2200);
    if (emitToo) {
      const c = ev.criteria.find((x) => x.key === key);
      const ids = (c?.evidence || []).map((e) => e.msg_id);
      if (ids.length) emit(root, 'cqa:evidence-click', { msg_id: ids[0], key });
    }
  }

  async function load() {
    clear(root).append(skeletonRows(8));
    try {
      ev = p.evaluation || (p.eval ? await getEvaluation(p.eval) : null);
      if (!ev) {
        clear(root).append(h('div', { class: 'cqa-panel' }, emptyState({ title: 'Диалог ещё не оценён', text: 'Выберите его в списке и нажмите «Оценить». Результат с баллами, обоснованием и цитатами появится здесь.', icon: '☆' })));
        return;
      }
      render();
    } catch (e) {
      clear(root).append(errorState(e, load));
    }
  }

  const onFocus = (e) => focusCriterion(e.detail?.key, false);
  el.addEventListener('cqa:focus-criterion', onFocus);
  load();

  return {
    update(np) {
      const reload = np.evaluation !== p.evaluation || np.eval !== p.eval;
      p = { ...p, ...np };
      if (reload) load(); else if (ev) render();
    },
    unmount() { el.removeEventListener('cqa:focus-criterion', onFocus); root.remove(); },
  };
}
