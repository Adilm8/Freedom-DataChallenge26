// Песочница критерия: проверить новый или изменённый критерий черновика на 1–5 диалогах до сохранения версии.
// POST /checklists/trial — один вызов модели на диалог, оценки диалогов не меняются (backend services/trial.py).
// Рядом с новым ответом — прошлый ответ по тому же коду из последней оценки диалога: «было → стало».
import { h, clear, answerBadge, channelLabel, langChip, fmtMoney, toast } from '../ui.js';
import { listConversations, trialCriterion } from '../api.js';

const MAX = 5;

function critView(c) {
  const scaleMax = c.type === 'scale' && Array.isArray(c.scale) && c.scale.length ? Math.max(...c.scale.map((s) => Number(s.value))) : Number(c.weight);
  return { type: c.type, weight: Number(c.weight), scale_max: scaleMax };
}

/** Начальный выбор: по одному оценённому диалогу каждого языка и канала, всего до трёх. */
function preselect(rows) {
  const seen = new Set(), out = [];
  for (const r of rows.filter((x) => x.latest)) {
    const k = `${r.channel}|${r.language}`;
    if (seen.has(k)) continue;
    seen.add(k); out.push(r.id);
    if (out.length >= 3) break;
  }
  if (!out.length) out.push(...rows.slice(0, 3).map((r) => r.id));
  return out;
}

export function openTrial(host, { body, criterionKey, compareKey = null, group = 'DEV', versionId = null } = {}) {
  const crit = (body.criteria || []).find((c) => c.key === criterionKey);
  const view = critView(crit || {});
  let rows = null, picked = new Set(), filter = '', busy = false, result = null, error = null;

  const box = h('div', { class: 'cqa-modal__box cqa-trial', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cqa-trial-title' });
  const overlay = h('div', { class: 'cqa-modal', onmousedown: (e) => { if (e.target === overlay && !busy) close(); } }, box);
  const prevFocus = document.activeElement;

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('hashchange', close);
    prevFocus?.focus?.({ preventScroll: true });
  }
  function onKey(e) { if (e.key === 'Escape' && !busy) { e.stopPropagation(); close(); } }

  async function load() {
    try {
      rows = await listConversations({ group_id: group });
      picked = new Set(preselect(rows));
    } catch (e) { error = e; }
    render();
  }

  async function runTrial() {
    busy = true; error = null; result = null; render();
    try {
      result = await trialCriterion({ body, criterion_key: criterionKey, conversation_ids: [...picked], base_version_id: versionId, compare_key: compareKey });
    } catch (e) { error = e; }
    busy = false; render();
    if (result) toast(host, `Проверка ${criterionKey}: ${result.items.length} диал., ${fmtMoney(result.cost_usd)}`);
  }

  function head() {
    return h('div', { class: 'cqa-modal__head' },
      h('div', null,
        h('h2', { class: 'cqa-h2', id: 'cqa-trial-title' }, `Проверить критерий ${criterionKey}`),
        h('div', { class: 'cqa-faint cqa-trial__sub' }, crit?.title || '', compareKey && compareKey !== criterionKey ? ` · «было» — ответ заменённого критерия ${compareKey}` : '')),
      h('button', { type: 'button', class: 'cqa-modal__x', 'aria-label': 'Закрыть', disabled: busy, onclick: close }, '×'));
  }

  function picker() {
    const q = filter.trim().toLowerCase();
    // выбранные — сверху, чтобы их было видно без прокрутки
    const list = (rows || []).filter((r) => !q || r.conversation_id.toLowerCase().includes(q))
      .sort((a, b) => Number(picked.has(b.id)) - Number(picked.has(a.id)));
    const full = picked.size >= MAX;
    return h('div', { class: 'cqa-trial__pick' },
      h('div', { class: 'cqa-trial__pickhead' },
        h('input', { class: 'cqa-input', type: 'search', placeholder: 'Найти диалог…', value: filter, 'aria-label': 'Найти диалог',
          oninput: (e) => { filter = e.target.value; const pos = e.target.selectionStart; render(); const inp = box.querySelector('.cqa-trial__pickhead input'); inp?.focus(); inp?.setSelectionRange(pos, pos); } }),
        h('span', { class: 'cqa-faint' }, `выбрано ${picked.size} из ${MAX}`)),
      h('div', { class: 'cqa-trial__list', role: 'group', 'aria-label': 'Диалоги для проверки' },
        list.slice(0, 80).map((r) => {
          const on = picked.has(r.id);
          return h('label', { class: `cqa-trial__opt${on ? ' cqa-trial__opt--on' : ''}` },
            h('input', { type: 'checkbox', checked: on, disabled: busy || (!on && full),
              onchange: (e) => { if (e.target.checked) picked.add(r.id); else picked.delete(r.id); render(); } }),
            h('span', { class: 'cqa-mono' }, r.conversation_id),
            h('span', { class: 'cqa-chip' }, channelLabel(r.channel)), langChip(r.language),
            h('span', { class: 'cqa-faint cqa-trial__was' }, r.latest ? `итог ${r.latest.final_total ?? r.latest.ai_total ?? '—'}` : 'не оценён'));
        }),
        list.length > 80 ? h('div', { class: 'cqa-faint' }, `…ещё ${list.length - 80}, уточните поиск`) : null));
  }

  function itemView(it) {
    const prev = it.previous?.answer;
    const changed = prev != null && it.answer != null && String(prev) !== String(it.answer);
    return h('div', { class: `cqa-panel cqa-trial__res${changed ? ' cqa-trial__res--changed' : ''}` },
      h('div', { class: 'cqa-trial__reshead' },
        h('a', { class: 'cqa-mono', href: `#/conversation/${it.conversation_pk}`, onclick: () => close() }, it.conversation_id || `#${it.conversation_pk}`),
        it.channel ? h('span', { class: 'cqa-chip' }, channelLabel(it.channel)) : null, it.language ? langChip(it.language) : null,
        h('span', { class: 'cqa-trial__ans' },
          prev != null ? [h('span', { class: 'cqa-faint' }, 'было'), answerBadge(view, prev), h('span', { 'aria-hidden': 'true' }, '→')] : h('span', { class: 'cqa-faint' }, 'раньше не оценивался ·'),
          h('span', { class: 'cqa-faint' }, 'стало'), it.answer != null ? answerBadge(view, it.answer) : h('span', { class: 'cqa-badge cqa-badge--muted' }, 'нет ответа')),
        changed ? h('span', { class: 'cqa-badge cqa-badge--warn' }, 'ответ изменился') : null),
      it.error ? h('div', { class: 'cqa-banner cqa-banner--warn' }, it.error) : null,
      it.reasoning ? h('p', { class: 'cqa-trial__why' }, it.reasoning) : null,
      it.na_reason ? h('div', { class: 'cqa-faint' }, `N/A: ${it.na_reason}`) : null,
      (it.evidence || []).length ? h('ul', { class: 'cqa-trial__ev' }, it.evidence.map((e) =>
        h('li', null, h('span', { class: 'cqa-chip cqa-mono' }, e.msg_id), e.quote ? ` «${e.quote}»` : ' ', e.quote_ok === false ? h('span', { class: 'cqa-badge cqa-badge--warn' }, 'цитата не найдена') : null))) : null,
      (it.issues || []).length ? h('ul', { class: 'cqa-errlist' }, it.issues.map((m) => h('li', null, m))) : null,
      it.trial_id ? h('div', { class: 'cqa-faint cqa-trial__meta' },
        `${it.tokens ? `${it.tokens[0]} → ${it.tokens[1]} токенов · ` : ''}${fmtMoney(it.cost_usd)} · ${((it.latency_ms || 0) / 1000).toFixed(1)} с`) : null);
  }

  function render() {
    clear(box).append(head());
    box.append(h('div', { class: 'cqa-banner cqa-banner--info cqa-trial__note' },
      'Критерий берётся из черновика вместе с несохранёнными правками. Оценки диалогов не меняются. Один вызов модели на диалог, тот же промпт и проверка цитат, что и в обычной оценке.'));
    if (!rows && !error) { box.append(h('div', { class: 'cqa-faint' }, 'Загружаю диалоги…')); return; }
    if (rows) box.append(picker());
    if (error) box.append(h('div', { class: 'cqa-banner cqa-banner--warn', role: 'alert' }, error.message || String(error)));
    if (busy) box.append(h('div', { class: 'cqa-trial__busy', role: 'status' }, h('span', { class: 'cqa-spinner', 'aria-hidden': 'true' }), `Модель оценивает ${picked.size} диал.…`));
    if (result) {
      const changed = result.items.filter((it) => it.previous?.answer != null && it.answer != null && String(it.previous.answer) !== String(it.answer)).length;
      box.append(h('div', { class: 'cqa-trial__sum' },
        h('b', null, `Результат: ${result.items.length} диал.`),
        h('span', { class: 'cqa-faint' }, `изменилось ответов: ${changed} · ${result.model} · ${fmtMoney(result.cost_usd)}`)),
      h('div', { class: 'cqa-trial__results' }, result.items.map(itemView)));
    }
    box.append(h('div', { class: 'cqa-modal__foot' },
      h('button', { type: 'button', class: 'cqa-btn cqa-btn--ghost', disabled: busy, onclick: close }, result ? 'Готово' : 'Отмена'),
      h('button', { type: 'button', class: 'cqa-btn cqa-btn--primary', id: 'cqa-trial-run', disabled: busy || !picked.size || !crit,
        onclick: runTrial }, result ? `Проверить ещё раз (${picked.size})` : `Проверить на ${picked.size} диал.`)));
  }

  document.addEventListener('keydown', onKey, true);
  window.addEventListener('hashchange', close);
  host.append(overlay);
  render();
  load();
  return { close };
}
