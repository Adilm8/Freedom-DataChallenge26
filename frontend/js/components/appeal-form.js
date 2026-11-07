// Форма апелляции аналитика (FR-APL-01): комментарий к оценке критерия → POST /appeals.
// openAppealForm(host, {evaluation, criterion, onSaved(appeal)}) — модальное окно поверх host (.cqa-root);
// mount(el, {evaluationId, criterionKey}) — та же форма внутри el (отдельная страница / web resource).
// AI-оценка не меняется: апелляция уходит в очередь проверяющего, решение пишет финальный ответ.
import { h, clear, answerBadge, toast, skeletonRows, errorState } from '../ui.js';
import { createAppeal, getEvaluation } from '../api.js';

const MAX = 4000;
const ptsText = (c, pts) => (c.type === 'flag' || pts == null ? '' : `${+Number(pts).toFixed(2)} из ${c.weight}`);

function formBody(box, { evaluation, criterion: c, onSaved, onCancel, inline }) {
  let busy = false;
  const err = h('div', { class: 'cqa-apf__err', role: 'alert', hidden: true });
  const fieldErr = h('div', { class: 'cqa-fielderr', hidden: true });
  const area = h('textarea', { class: 'cqa-input cqa-textarea', id: 'cqa-apf-comment', rows: 5, maxlength: MAX, 'aria-describedby': 'cqa-apf-hint',
    placeholder: 'Например: оператор назвал имя во второй реплике (m5) — по чек-листу это «Да».',
    oninput: () => { fieldErr.hidden = true; area.removeAttribute('aria-invalid'); count.textContent = `${area.value.length} / ${MAX}`; },
    onkeydown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } } });
  const count = h('span', { class: 'cqa-faint' }, `0 / ${MAX}`);
  const btn = h('button', { type: 'submit', class: 'cqa-btn cqa-btn--primary', id: 'cqa-apf-submit' }, 'Отправить апелляцию');
  const decided = (c.appeal_history || []).filter((a) => a.status !== 'open');

  async function submit() {
    if (busy) return;
    const comment = area.value.trim();
    err.hidden = true;
    if (!comment) { showField('Напишите комментарий: что не так с оценкой и почему.'); return; }
    busy = true; btn.disabled = true; btn.textContent = 'Отправляем…';
    try {
      const a = await createAppeal({ evaluation_id: evaluation.id, criterion_key: c.key, comment });
      onSaved?.(a);
    } catch (e) {
      busy = false; btn.disabled = false; btn.textContent = 'Отправить апелляцию';
      const fe = (e.errors || []).find((x) => x.path === 'comment');
      if (fe) showField(fe.message);
      else { err.hidden = false; clear(err).append(h('b', null, e.status === 409 ? 'Апелляция уже есть. ' : 'Не отправлено. '), e.detail || e.message); }
    }
  }
  function showField(text) {
    fieldErr.hidden = false; fieldErr.textContent = text;
    area.setAttribute('aria-invalid', 'true'); area.focus();
  }

  clear(box).append(
    h('div', { class: 'cqa-modal__head' },
      h('h2', { class: 'cqa-h2', id: 'cqa-apf-title' }, `Оспорить критерий ${c.key}`),
      inline ? null : h('button', { type: 'button', class: 'cqa-modal__x', 'aria-label': 'Закрыть', onclick: onCancel }, '×')),
    h('div', { class: 'cqa-apf__crit' },
      h('div', { class: 'cqa-apf__title' }, h('span', { class: 'cqa-code' }, c.key), h('b', null, c.title)),
      h('div', { class: 'cqa-apf__ans' }, h('span', { class: 'cqa-faint' }, 'Ответ AI'), answerBadge(c, c.ai_answer, { words: true }), h('span', { class: 'cqa-faint' }, ptsText(c, c.ai_points)),
        c.overridden ? [h('span', { class: 'cqa-faint' }, '· сейчас'), answerBadge(c, c.final_answer)] : null),
      c.reasoning ? h('div', { class: 'cqa-apf__why' }, c.reasoning) : null,
      decided.length ? h('div', { class: 'cqa-faint cqa-apf__prev' }, `По критерию уже ${decided.length === 1 ? 'была апелляция' : `было апелляций: ${decided.length}`} — новая пойдёт проверяющему повторно.`) : null),
    h('form', { class: 'cqa-apf', onsubmit: (e) => { e.preventDefault(); submit(); } },
      h('label', { class: 'cqa-field' }, h('span', { class: 'cqa-field__label' }, 'Комментарий для проверяющего'), area,
        h('span', { class: 'cqa-field__hint cqa-apf__hint', id: 'cqa-apf-hint' },
          h('span', null, 'Что не так и на какую реплику или правило чек-листа опираетесь. Оценка AI не изменится: решение примет проверяющий.'), count),
        fieldErr),
      err,
      h('div', { class: 'cqa-modal__foot' },
        inline ? null : h('button', { type: 'button', class: 'cqa-btn', onclick: onCancel }, 'Отмена'),
        btn)));
  return { focus: () => area.focus({ preventScroll: true }) };
}

/** Модальное окно апелляции. */
export function openAppealForm(host, { evaluation, criterion, onSaved } = {}) {
  const box = h('div', { class: 'cqa-modal__box cqa-apf-box', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cqa-apf-title' });
  const overlay = h('div', { class: 'cqa-modal', onmousedown: (e) => { if (e.target === overlay) close(); } }, box);
  const prevFocus = document.activeElement;
  const onKey = (e) => { if (e.key === 'Escape' && overlay.isConnected) { e.stopPropagation(); close(); } };
  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    if (prevFocus?.isConnected) prevFocus.focus?.({ preventScroll: true });
  }
  const f = formBody(box, { evaluation, criterion, onCancel: close,
    onSaved: (a) => { close(); toast(host, `Апелляция №${a.id} по критерию ${criterion.key} отправлена проверяющему.`); onSaved?.(a); } });
  document.addEventListener('keydown', onKey, true);
  host.append(overlay);
  f.focus();
  return { close };
}

/** Встроенный вариант: params.evaluationId, params.criterionKey. */
export function mount(el, params = {}) {
  const box = h('div', { class: 'cqa-panel cqa-modal__box cqa-modal__box--inline' });
  el.append(box);
  let alive = true;
  async function load() {
    clear(box).append(skeletonRows(4));
    try {
      const ev = await getEvaluation(params.evaluationId);
      if (!alive) return;
      const c = ev.criteria.find((x) => x.key === params.criterionKey);
      if (!c) throw new Error(`В оценке #${ev.id} нет критерия ${params.criterionKey}.`);
      formBody(box, { evaluation: ev, criterion: c, inline: true,
        onSaved: (a) => clear(box).append(h('div', { class: 'cqa-banner cqa-banner--info' }, h('span', { class: 'cqa-banner__icon' }, '✓'),
          h('div', null, `Апелляция №${a.id} отправлена проверяющему.`))) });
    } catch (e) { if (alive) clear(box).append(errorState(e, load)); }
  }
  load();
  return { update() {}, unmount() { alive = false; box.remove(); } };
}
