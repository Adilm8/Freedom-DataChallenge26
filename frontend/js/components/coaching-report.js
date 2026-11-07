// Коучинг-отчёт для оператора по одной оценке: сильные стороны, зоны роста по потерянным баллам итога,
// реплики-доказательства и подсказки модели «что сделать иначе». Собирается из готовой оценки, без вызовов модели.
// Маршрут #/coaching?id=<id диалога>[&eval=<id оценки>]; кнопка «Печать / PDF» — печать браузера (FR-UX-05).
import { h, clear, ROLE, answerBadge, channelLabel, langChip, score, fmtDate, fmtScore, skeletonRows, errorState } from '../ui.js';
import { getConversation, getEvaluation } from '../api.js';

const trunc = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

function lostPoints(ev, c) {
  const s = ev.final_score?.criteria?.[c.key];
  const aw = ev.final_score?.applicable_weight;
  if (!s || !s.applicable || s.points == null || !aw) return 0;
  return Math.max(0, ((s.weight - s.points) / aw) * 100);
}

export function mount(el, params = {}) {
  const root = h('div', { class: 'cqa-page cqa-coach' });
  el.append(root);
  let alive = true;

  async function load() {
    clear(root).append(h('div', { class: 'cqa-panel' }, skeletonRows(10)));
    try {
      const conv = await getConversation(params.id);
      const evalId = params.eval || conv.evaluations?.find((x) => x.status !== 'failed')?.id;
      const ev = evalId ? await getEvaluation(evalId) : null;
      if (!alive) return;
      render(conv, ev);
    } catch (e) {
      if (alive) clear(root).append(errorState(e, load));
    }
  }

  function quotes(c, msgs) {
    const ev = (c.evidence || []).filter((e) => e.quote || e.msg_id).slice(0, 2);
    if (!ev.length) return null;
    return h('div', { class: 'cqa-coach__quotes' }, ev.map((e) => {
      const m = msgs.get(e.msg_id);
      return h('blockquote', { class: 'cqa-coach__quote' },
        h('span', { class: 'cqa-coach__who' }, m ? `${ROLE[m.speaker] || m.speaker} · ${e.msg_id}` : e.msg_id),
        `«${e.quote || trunc(m?.text || '', 180)}»`);
    }));
  }

  function render(conv, ev) {
    clear(root);
    const back = h('a', { class: 'cqa-btn cqa-btn--sm cqa-noprint', href: `#/conversation/${conv.id}${ev ? `?eval=${ev.id}` : ''}` }, '← К карточке');
    if (!ev || ev.status === 'failed') {
      root.append(back, h('div', { class: 'cqa-panel cqa-coach__empty' }, h('h2', { class: 'cqa-h2' }, 'Отчёт появится после оценки'),
        h('p', { class: 'cqa-faint' }, 'Оцените диалог, и здесь будет разбор для оператора: что получилось, где потеряны баллы и что сказать иначе.')));
      return;
    }
    const msgs = new Map((conv.messages || []).map((m) => [m.msg_id, m]));
    const crit = ev.criteria || [];
    const flags = crit.filter((c) => c.type === 'flag' && c.final_answer === 'yes');
    const scored = crit.filter((c) => c.type !== 'flag');
    const growth = scored.map((c) => ({ c, lost: lostPoints(ev, c) })).filter((x) => x.lost > 0.004).sort((a, b) => b.lost - a.lost);
    const strong = scored.filter((c) => c.final_answer !== 'na' && c.final_answer != null && lostPoints(ev, c) <= 0.004);
    const na = scored.filter((c) => c.final_answer === 'na');
    const total = ev.final_score?.total;
    const lostSum = growth.reduce((s, x) => s + x.lost, 0);
    const ov = ev.overview || {};
    const operatorName = (() => {
      const first = (conv.messages || []).find((m) => m.speaker === 'operator');
      const m = first && /(?:меня зовут|[Яя] |I'm |I am |[Mm]y name is |[Мм]ен )([A-ZА-ЯЁӘҒҚҢӨҰҮҺІ][a-zа-яёәғқңөұүһі]+)/u.exec(first.text);
      return m ? m[1].replace(/(?:пын|мын|бын|пін|мін|бін)$/u, '') : null;
    })();

    root.append(
      h('div', { class: 'cqa-coach__bar cqa-noprint' }, back,
        h('button', { type: 'button', class: 'cqa-btn cqa-btn--primary', id: 'cqa-coach-print', onclick: () => window.print() }, '🖨 Печать / PDF')),
      h('article', { class: 'cqa-panel cqa-coach__sheet' },
        h('header', { class: 'cqa-coach__head' },
          h('div', null,
            h('div', { class: 'cqa-coach__kicker' }, 'Разбор диалога для оператора'),
            h('h1', { class: 'cqa-coach__title' }, conv.conversation_id, operatorName ? h('span', { class: 'cqa-faint' }, ` · оператор ${operatorName}`) : null),
            h('div', { class: 'cqa-coach__meta' }, h('span', { class: 'cqa-chip' }, channelLabel(conv.channel)), langChip(conv.language),
              ov.topic ? h('span', null, `Тема: ${ov.topic}`) : null,
              h('span', { class: 'cqa-faint' }, `оценка #${ev.id} · ${fmtDate(ev.created_at)} · ${ev.model}`))),
          h('div', { class: 'cqa-coach__score' }, h('div', { class: 'cqa-faint' }, 'Итог'), score(total, 'cqa-text-2xl'),
            lostSum > 0.004 ? h('div', { class: 'cqa-faint' }, `до 100 не хватает ${fmtScore(lostSum)}`) : h('div', { class: 'cqa-coach__ok' }, 'максимум'))),
        ov.summary ? h('p', { class: 'cqa-coach__summary' }, ov.summary) : null,
        flags.length ? h('section', { class: 'cqa-coach__sec cqa-coach__sec--flag' },
          h('h2', { class: 'cqa-h3' }, '⚠ Грубое нарушение'),
          flags.map((c) => h('div', { class: 'cqa-coach__item' }, h('b', null, c.title), c.reasoning ? h('p', null, c.reasoning) : null, quotes(c, msgs),
            c.advice ? h('p', { class: 'cqa-coach__advice' }, h('b', null, 'Как правильно: '), c.advice) : null))) : null,
        h('section', { class: 'cqa-coach__sec' },
          h('h2', { class: 'cqa-h3' }, growth.length ? `Зоны роста · ${growth.length}` : 'Зоны роста'),
          growth.length ? h('ol', { class: 'cqa-coach__list' }, growth.map(({ c, lost }) => h('li', { class: 'cqa-coach__item' },
            h('div', { class: 'cqa-coach__ihead' }, h('b', null, c.title), answerBadge(c, c.final_answer),
              h('span', { class: 'cqa-coach__lost' }, `−${fmtScore(lost)} к итогу`),
              c.overridden ? h('span', { class: 'cqa-badge cqa-badge--muted' }, 'после апелляции') : null),
            c.reasoning ? h('p', null, c.reasoning) : null,
            quotes(c, msgs),
            c.advice ? h('p', { class: 'cqa-coach__advice' }, h('b', null, 'Что сделать иначе: '), c.advice) : null)))
            : h('p', { class: 'cqa-faint' }, 'Все применимые критерии выполнены полностью.')),
        strong.length ? h('section', { class: 'cqa-coach__sec' },
          h('h2', { class: 'cqa-h3' }, `Получилось хорошо · ${strong.length}`),
          h('ul', { class: 'cqa-coach__good' }, strong.map((c) => h('li', null, h('span', { class: 'cqa-coach__tick', 'aria-hidden': 'true' }, '✓'),
            h('b', null, c.title), c.reasoning ? h('span', { class: 'cqa-faint' }, ` — ${c.reasoning}`) : null)))) : null,
        na.length ? h('p', { class: 'cqa-faint cqa-coach__na' }, `Не применялись (N/A): ${na.map((c) => c.title).join(', ')}. Их вес перераспределён на остальные критерии.`) : null,
        h('footer', { class: 'cqa-coach__foot cqa-faint' },
          'Отчёт собран из AI-оценки' + (crit.some((c) => c.overridden) ? ' с учётом решений по апелляциям' : '') + '. Оценку можно оспорить в карточке диалога.')));
  }

  load();
  return { unmount() { alive = false; root.remove(); } };
}
