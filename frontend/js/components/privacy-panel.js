// Персональные данные: что система скрыла перед отправкой диалога во внешнюю модель (backend services/pii.py).
// Данные — поле `privacy` из GET /conversations/{id}: {enabled, masked_total, unique_values, by_kind, masked_messages}.
// Сворачиваемый блок рядом с транскриптом; номер реплики — переход к ней (cqa:evidence-click).
import { h, clear, emit } from '../ui.js';
import { plural } from './viz.js';

export function mount(el, props = {}) {
  const root = h('div', { class: 'cqa-privacy' });
  el.append(root);
  let p = { ...props };
  let open = false;

  const ref = (id) => h('button', { type: 'button', class: 'cqa-chip cqa-tip', 'data-tip': 'Показать реплику',
    onclick: () => emit(root, 'cqa:evidence-click', { msg_ids: [id], source: 'privacy' }) }, id);

  // Метки [CARD_1] — отдельным стилем, чтобы было видно, что ушло в модель вместо данных.
  function maskedText(text) {
    const out = [];
    let pos = 0;
    for (const m of String(text).matchAll(/\[[A-Z]+_\d+\]/g)) {
      out.push(text.slice(pos, m.index), h('mark', { class: 'cqa-privacy__tag' }, m[0]));
      pos = m.index + m[0].length;
    }
    out.push(text.slice(pos));
    return out;
  }

  function render() {
    clear(root);
    const pr = p.privacy;
    if (!pr) return;
    if (!pr.enabled) {
      root.append(h('div', { class: 'cqa-panel cqa-privacy__line cqa-faint' }, 'Маскирование персональных данных выключено (PII_MASKING=false): диалог уходит в модель как есть.'));
      return;
    }
    const n = pr.masked_total || 0;
    if (!n) {
      root.append(h('div', { class: 'cqa-panel cqa-privacy__line' },
        h('span', { class: 'cqa-privacy__icon', 'aria-hidden': 'true' }, 'PII'),
        h('span', null, 'Персональные данные: '),
        h('span', { class: 'cqa-faint' }, 'номеров карт, ИИН, телефонов, email и кодов не найдено. Если появятся, система скроет их до отправки в модель.')));
      return;
    }
    const details = h('details', { class: 'cqa-panel cqa-facts cqa-privacy__box', open, ontoggle: (e) => { open = e.target.open; } });
    details.append(h('summary', { class: 'cqa-facts__sum' },
      h('span', { class: 'cqa-facts__title' }, 'Персональные данные скрыты'),
      h('span', { class: 'cqa-chip' }, String(n)),
      h('span', { class: 'cqa-facts__head' }, (pr.by_kind || []).map((k) => `${k.label} ×${k.count}`).join(' · '))));
    const ids = Object.keys(pr.masked_messages || {}).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    details.append(h('div', { class: 'cqa-facts__body' },
      h('div', { class: 'cqa-facts__hint' },
        `Перед отправкой в модель ${n} ${plural(n, 'место заменено', 'места заменены', 'мест заменено')} метками. `
        + 'Модель видит, что данные были названы, но не видит их. Оригинал хранится только в нашей базе, цитаты в карточке показаны по нему.'),
      h('div', { class: 'cqa-facts__group' },
        h('div', { class: 'cqa-facts__gtitle' }, 'Так эти реплики видит модель'),
        ids.map((id) => h('div', { class: 'cqa-facts__row' },
          h('div', { class: 'cqa-facts__label' }, ref(id)),
          h('div', { class: 'cqa-facts__val cqa-privacy__text' }, maskedText(pr.masked_messages[id])))))));
    root.append(details);
  }

  render();
  return {
    update(np) { p = { ...p, ...np }; render(); },
    unmount() { root.remove(); },
  };
}
