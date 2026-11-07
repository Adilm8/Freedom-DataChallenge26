// Факты, которые код посчитал по транскрипту до вызова модели: {имя: {value, msg_ids, note}}.
// Сворачиваемый блок рядом с транскриптом; номера реплик кликабельны (событие cqa:evidence-click {msg_ids}).
// Подписи — из реестра бэкенда (GET /meta/facts, services/facts), запасной вариант — FACT_LABELS ниже;
// неизвестный факт показывается по имени, ничего не теряется.
import { h, clear, emit, EVENT_LABEL, LANG } from '../ui.js';
import { getFactLabels } from '../api.js';

export const FACT_LABELS = {
  has_operator: 'Оператор отвечал клиенту',
  is_voice: 'Звонок (расшифровка устной речи)',
  operator_turns: 'Реплик оператора клиенту',
  client_turns: 'Реплик клиента',
  internal_turns: 'Внутренних реплик оператора (клиент их не слышит)',
  bot_turns: 'Реплик бота',
  system_events: 'Системные события',
  identity_verified_at: 'Подтверждение личности системным сообщением',
  identity_verified: 'Личность подтверждена системным сообщением',
  escalation_at: 'Переход к оператору',
  first_operator_msg: 'Первая реплика оператора клиенту',
  first_response_delay_sec: 'Задержка первого ответа оператора',
  first_response_slow: 'Первый ответ позже порога',
  long_gaps: 'Долгие паузы оператора',
  long_gap_without_warning: 'Долгая пауза без предупреждения об ожидании',
  client_language: 'Язык клиента',
  operator_first_msg_language: 'Язык первой реплики оператора',
  first_msg_language_matches_client: 'Язык первой реплики совпадает с языком клиента',
  greeting_in_first_msg: 'Приветствие в первой реплике оператора',
  intro_in_first_msg: 'Представление (имя) в первой реплике оператора',
  first_greeting_msg: 'Первое приветствие оператора',
  first_intro_msg: 'Первое представление оператора',
  last_operator_msg: 'Последняя реплика оператора',
  farewell_in_last_msg: 'Прощание в последней реплике оператора',
  help_offer_in_closing: 'Предложение дальнейшей помощи в конце',
  ended_by: 'Как закончился диалог',
  ended_abruptly: 'Диалог оборвался до прощания оператора',
  risk_terms: 'Слова-подсказки о грубых нарушениях',
  empathy_phrases: 'Фразы сочувствия или извинения оператора',
};

const GROUPS = [
  ['Участники', ['has_operator', 'is_voice', 'operator_turns', 'client_turns', 'internal_turns', 'bot_turns']],
  ['События и идентификация', ['system_events', 'escalation_at', 'identity_verified', 'identity_verified_at']],
  ['Скорость ответа', ['first_operator_msg', 'first_response_delay_sec', 'first_response_slow', 'long_gaps', 'long_gap_without_warning']],
  ['Язык', ['client_language', 'operator_first_msg_language', 'first_msg_language_matches_client']],
  ['Приветствие', ['greeting_in_first_msg', 'intro_in_first_msg', 'first_greeting_msg', 'first_intro_msg']],
  ['Завершение', ['last_operator_msg', 'farewell_in_last_msg', 'help_offer_in_closing', 'ended_by', 'ended_abruptly']],
  ['Тон и риски', ['empathy_phrases', 'risk_terms']],
];

const ENDED_BY = {
  normal: 'обычно: последняя реплика за оператором', unknown: 'не определено',
  operator_closed: 'оператор закрыл чат', client_left: 'клиент покинул чат', client_ended: 'клиент завершил разговор',
  connection_lost: 'соединение прервано', session_timeout: 'сессия закрыта по таймауту',
};
const RISK = { risk_insult: 'оскорбление', risk_paid_bypass: 'платная услуга в обход компании', risk_confidential: 'раскрытие данных' };
const WAITING = { client: 'ждал клиент', operator: 'ждал оператор' };

const humanize = (k) => k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const trunc = (s, n = 90) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

export function fmtSec(v) {
  const s = Math.round(Number(v));
  if (!isFinite(s)) return String(v);
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `${m} мин ${r} с` : `${m} мин`;
}
function fmtClock(t) {
  if (t == null) return null;
  const s = Math.round(t), m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Компактная сводка для заголовка свёрнутого блока. */
function headline(facts) {
  const out = [];
  const v = (k) => facts[k]?.value;
  if (v('first_response_delay_sec') != null) out.push(`первый ответ ${fmtSec(v('first_response_delay_sec'))}`);
  if (v('identity_verified') === true) out.push('личность подтверждена');
  if (Array.isArray(v('long_gaps')) && v('long_gaps').length) out.push(`долгих пауз: ${v('long_gaps').length}`);
  if (Array.isArray(v('risk_terms')) && v('risk_terms').length) out.push(`риск-слов: ${v('risk_terms').length}`);
  if (v('ended_by')) out.push(ENDED_BY[v('ended_by')] || v('ended_by'));
  return out.slice(0, 3).join(' · ');
}

export function mount(el, params = {}) {
  let p = { ...params };
  const root = h('div', { class: 'cqa-facts-root' });
  el.append(root);
  let open = !!p.open;
  let labels = FACT_LABELS, alive = true;
  getFactLabels().then((r) => {
    if (!alive || !r?.labels || !Object.keys(r.labels).length) return;
    labels = { ...FACT_LABELS, ...r.labels };
    render();
  }).catch(() => { /* остаются встроенные подписи */ });

  const ref = (id) => h('button', { type: 'button', class: 'cqa-chip cqa-tip', 'data-tip': 'Показать реплику', onclick: () => emit(root, 'cqa:evidence-click', { msg_ids: [id], source: 'facts' }) }, id);

  function item(name, x) {
    if (x == null || typeof x !== 'object') return h('span', null, String(x));
    const parts = [];
    if (x.type) parts.push(h('span', null, EVENT_LABEL[x.type] || x.type));
    if (x.category) parts.push(h('span', { class: 'cqa-badge cqa-badge--muted' }, RISK[x.category] || x.category.replace(/^risk_/, '')));
    if (x.sec != null) parts.push(h('b', null, fmtSec(x.sec)));
    if (x.from_msg_id && x.to_msg_id) parts.push(ref(x.from_msg_id), '→', ref(x.to_msg_id));
    if (x.msg_id) parts.push(ref(x.msg_id));
    if (x.t_sec != null && !x.sec) parts.push(h('span', { class: 'cqa-mono cqa-faint' }, fmtClock(x.t_sec)));
    if (x.phrase) parts.push(h('span', { class: 'cqa-facts__quote' }, trunc(x.phrase)));
    if (x.text) parts.push(h('span', { class: 'cqa-facts__quote' }, trunc(x.text)));
    if (x.waiting) parts.push(h('span', { class: 'cqa-faint' }, WAITING[x.waiting] || x.waiting));
    if ('warned' in x) parts.push(h('span', { class: x.warned ? 'cqa-faint' : 'cqa-facts__warn' }, x.warned ? 'с предупреждением' : 'без предупреждения'));
    if (x.on_hold) parts.push(h('span', { class: 'cqa-faint' }, 'на удержании'));
    if (x.internal) parts.push(h('span', { class: 'cqa-badge cqa-badge--warn' }, 'внутренняя'));
    const known = new Set(['type', 'category', 'sec', 'from_msg_id', 'to_msg_id', 'msg_id', 't_sec', 'phrase', 'text', 'waiting', 'warned',
      'on_hold', 'internal', 'timestamp', 'lang', 'source', 'warning_msg_id', 'warning']);
    for (const [k, v] of Object.entries(x)) {
      if (known.has(k) || v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
      parts.push(h('span', { class: 'cqa-faint' }, `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`));
    }
    return h('span', { class: 'cqa-facts__item' }, parts);
  }

  function value(name, v) {
    if (v === null || v === undefined) return h('span', { class: 'cqa-facts__none' }, 'нет данных');
    if (typeof v === 'boolean') return h('span', { class: `cqa-facts__bool cqa-facts__bool--${v ? 'yes' : 'no'}` }, v ? 'да' : 'нет');
    if (typeof v === 'number') return h('b', { class: 'cqa-facts__num' }, name.endsWith('_sec') ? fmtSec(v) : String(v));
    if (typeof v === 'string') {
      if (name === 'ended_by') return h('span', null, ENDED_BY[v] || EVENT_LABEL[v] || v);
      if (name.includes('language')) return h('span', { class: 'cqa-chip' }, LANG[v.toLowerCase()] || v.toUpperCase());
      return h('span', null, v);
    }
    if (Array.isArray(v)) {
      if (!v.length) return h('span', { class: 'cqa-facts__none' }, 'нет');
      return h('ul', { class: 'cqa-facts__list' }, v.slice(0, 12).map((x) => h('li', null, item(name, x))),
        v.length > 12 ? h('li', { class: 'cqa-faint' }, `…ещё ${v.length - 12}`) : null);
    }
    return item(name, v);
  }

  function row(name, f) {
    const fact = f && typeof f === 'object' && 'value' in f ? f : { value: f, msg_ids: [], note: null };
    const shown = new Set(JSON.stringify(fact.value ?? null).match(/m\d+/g) || []);
    const extra = (fact.msg_ids || []).filter((id) => !shown.has(id));
    return h('div', { class: 'cqa-facts__row', dataset: { fact: name } },
      h('div', { class: 'cqa-facts__label' }, labels[name] || humanize(name)),
      h('div', { class: 'cqa-facts__val' },
        value(name, fact.value),
        extra.length ? h('span', { class: 'cqa-facts__refs' }, extra.map(ref)) : null,
        fact.note ? h('div', { class: 'cqa-facts__note' }, fact.note) : null));
  }

  function render() {
    clear(root);
    const facts = p.facts && typeof p.facts === 'object' ? p.facts : null;
    const names = facts ? Object.keys(facts) : [];
    const details = h('details', { class: 'cqa-panel cqa-facts', open,
      ontoggle: (e) => { open = e.target.open; } });
    const summary = h('summary', { class: 'cqa-facts__sum' },
      h('span', { class: 'cqa-facts__title' }, 'Факты системы'),
      h('span', { class: 'cqa-chip' }, String(names.length)),
      h('span', { class: 'cqa-facts__head' }, facts ? headline(facts) || 'что код посчитал до вызова модели' : 'появятся после оценки'));
    details.append(summary);
    if (!names.length) {
      details.append(h('div', { class: 'cqa-facts__empty' }, facts ? 'Факты не вычислены для этой оценки.' : 'Факты считаются при оценке диалога: время ответа, события, приветствие, завершение, слова-подсказки.'));
      root.append(details);
      return;
    }
    const body = h('div', { class: 'cqa-facts__body' },
      h('div', { class: 'cqa-facts__hint' }, 'Подсказки кода, а не вердикт: модель сверяет их с репликами. Номер реплики — переход к ней.'));
    const used = new Set();
    for (const [title, keys] of GROUPS) {
      const present = keys.filter((k) => k in facts);
      if (!present.length) continue;
      present.forEach((k) => used.add(k));
      body.append(h('div', { class: 'cqa-facts__group' }, h('div', { class: 'cqa-facts__gtitle' }, title), present.map((k) => row(k, facts[k]))));
    }
    const rest = names.filter((k) => !used.has(k));
    if (rest.length) body.append(h('div', { class: 'cqa-facts__group' }, h('div', { class: 'cqa-facts__gtitle' }, 'Другие факты'), rest.map((k) => row(k, facts[k]))));
    details.append(body);
    root.append(details);
  }

  render();
  return {
    update(np) { p = { ...p, ...np }; render(); },
    unmount() { alive = false; root.remove(); },
  };
}
