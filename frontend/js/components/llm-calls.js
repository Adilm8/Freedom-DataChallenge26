// «Сырой ответ»: вызовы LLM одной оценки из GET /evaluations/{id}/calls — запрос, ответ, finish_reason, ошибка.
// Грузится лениво при первом показе; каждый вызов и его JSON сворачиваются.
import { h, clear, fmtMoney, skeletonRows, errorState, emptyState } from '../ui.js';
import { getEvaluationCalls } from '../api.js';

function pretty(raw) {
  if (raw == null || raw === '') return '';
  if (typeof raw !== 'string') return JSON.stringify(raw, null, 2);
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}

function jsonBlock(title, text, hint) {
  const pre = h('pre', { class: 'cqa-pre' }, text || '(пусто)');
  const copy = h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm cqa-btn--ghost',
    onclick: async (e) => {
      e.preventDefault();
      try { await navigator.clipboard.writeText(text || ''); copy.textContent = 'Скопировано'; }
      catch { copy.textContent = 'Не удалось скопировать'; }
      setTimeout(() => { copy.textContent = 'Копировать'; }, 1500);
    } }, 'Копировать');
  return h('details', { class: 'cqa-calls__json' },
    h('summary', null, h('span', null, title), hint ? h('span', { class: 'cqa-faint' }, hint) : null, copy), pre);
}

const FINISH_OK = new Set(['stop', 'end_turn', 'STOP']);

export function mount(el, params = {}) {
  let p = { ...params };
  const root = h('div', { class: 'cqa-calls' });
  el.append(root);
  let token = 0;

  function call(c, i) {
    const keys = (c.criteria_keys || []).join(', ');
    const finish = c.finish_reason;
    const bad = c.error || (finish && !FINISH_OK.has(finish));
    const resp = pretty(c.response_raw);
    return h('div', { class: `cqa-calls__item ${bad ? 'cqa-calls__item--bad' : ''}` },
      h('div', { class: 'cqa-calls__head' },
        h('b', null, `Вызов ${i + 1}`),
        keys ? h('span', { class: 'cqa-chip' }, `критерии ${keys}`) : null,
        c.attempt > 1 ? h('span', { class: 'cqa-badge cqa-badge--warn' }, `повтор ${c.attempt}`) : h('span', { class: 'cqa-chip' }, 'попытка 1'),
        finish ? h('span', { class: `cqa-badge ${FINISH_OK.has(finish) ? 'cqa-badge--muted' : 'cqa-badge--warn'}` }, `finish_reason: ${finish}`) : null,
        h('span', { class: 'cqa-calls__nums' },
          `${(c.tokens_in || 0).toLocaleString('ru-RU')} → ${(c.tokens_out || 0).toLocaleString('ru-RU')} ток.`,
          c.cached_tokens ? ` (кэш ${c.cached_tokens.toLocaleString('ru-RU')})` : '',
          ` · ${fmtMoney(c.cost_usd)} · ${((c.latency_ms || 0) / 1000).toFixed(1)} с`)),
      h('div', { class: 'cqa-calls__sub cqa-faint' }, [c.provider, c.model].filter(Boolean).join(' · ')),
      c.error ? h('div', { class: 'cqa-warnbox' }, h('b', null, 'Ошибка вызова'), h('div', null, c.error)) : null,
      jsonBlock('Ответ модели', resp, resp ? `${resp.length.toLocaleString('ru-RU')} симв.` : 'нет ответа'),
      jsonBlock('Параметры запроса', pretty(c.request), 'без текста промпта'));
  }

  async function load() {
    const my = ++token;
    clear(root).append(skeletonRows(3));
    try {
      const calls = await getEvaluationCalls(p.evaluationId);
      if (my !== token) return;
      clear(root);
      if (!calls.length) {
        root.append(emptyState({ title: 'Вызовов нет', text: 'Для этой оценки не сохранено ни одного вызова LLM: все ответы взяты из прошлой оценки или запуск не дошёл до модели.', icon: '∅' }));
        return;
      }
      const errs = calls.filter((c) => c.error).length;
      root.append(h('div', { class: 'cqa-calls__top cqa-faint' },
        `Вызовов: ${calls.length}${errs ? `, с ошибкой: ${errs}` : ''}. Сохранены как есть: модель, токены, стоимость, время и сырой JSON.`),
      ...calls.map(call));
    } catch (e) {
      if (my !== token) return;
      clear(root).append(errorState(e, load));
    }
  }

  load();
  return {
    update(np) { const r = np.evaluationId !== p.evaluationId; p = { ...p, ...np }; if (r) load(); },
    reload: load,
    unmount() { token++; root.remove(); },
  };
}
