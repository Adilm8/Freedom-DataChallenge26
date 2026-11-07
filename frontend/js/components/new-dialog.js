// Новый диалог из интерфейса (FR-DATA-07). Маршрут #/new.
// Транскрипт текстом «[MM:SS] роль: текст» или JSON в формате API организаторов → предпросмотр разбора →
// «Сохранить и оценить»: POST /conversations, затем окно запуска оценки для этого диалога; по завершении — карточка.
// Ошибки 422 и 409 показываются у своих полей. Параметры: group, mode. Наружу: cqa:navigate, cqa:groups-changed.
import { h, clear, emit, ROLE, toast } from '../ui.js';
import { createConversation, isMock } from '../api.js';
import { openRunDialog, plural } from './run-dialog.js';
import { parseTranscript } from '../transcript-parse.js';

const EXAMPLE_TEXT = `[00:00] Клиент: Здравствуйте, не могу вывести деньги на карту, пишет «операция отклонена»
[00:04] Бот: Перевожу вас на специалиста, ожидайте, пожалуйста
[00:41] Оператор: Здравствуйте! Меня зовут Алия, помогу разобраться. Подскажите, карта оформлена на ваше имя?
[01:02] Клиент: Да, моя карта. Уже второй раз отказ, это очень неудобно
[01:20] Оператор: Понимаю, неприятная ситуация. Для проверки назовите, пожалуйста, ФИО и кодовое слово.
[01:45] Клиент: Иванов Иван Иванович, кодовое слово — Алматы
[01:47] Система: Личность клиента подтверждена
[02:30] Оператор: Спасибо, Иван Иванович. Вижу заявку: банк отклонил её, потому что по счёту ещё идут расчёты по сделке (T+1).
Завтра после 10:00 подайте заявку заново в разделе «Вывод средств» — она пройдёт.
[02:52] Клиент: Понятно, спасибо
[03:05] Оператор: Пожалуйста! Если появятся вопросы — пишите. Всего доброго!
[03:07] Система: Оператор закрыл чат`;

const EXAMPLE_JSON = JSON.stringify({
  conversation_id: 'demo-en-001', channel: 'agent chat', language: 'EN',
  transcript: [
    { timestamp: '00:00', speaker: 'client', text: 'Hi, how do I reset my trading password?' },
    { timestamp: '00:03', speaker: 'bot', text: 'Connecting you to an operator.' },
    { timestamp: '00:35', speaker: 'operator', text: 'Hello, my name is Daniyar. You can reset it in the app: Profile → Security → Reset password.' },
    { timestamp: '00:58', speaker: 'client', text: 'Got it, thanks!' },
    { timestamp: '01:05', speaker: 'operator', text: 'You are welcome. Have a nice day!' },
  ],
}, null, 2);

const LANGS = [['', 'Определить по тексту'], ['RU', 'Русский (RU)'], ['KZ', 'Қазақша (KZ)'], ['EN', 'English (EN)']];
const CHANNELS = [['agent chat', 'Чат'], ['voice call', 'Звонок']];

export function mount(el, params = {}) {
  const p = { ...params };
  const st = { channel: 'agent chat', language: '', cid: '', text: '', busy: false, errors: { transcript: [], conversation_id: null, general: null }, saved: null };
  const root = h('div', { class: 'cqa-page cqa-nd' });
  el.append(root);
  let alive = true, previewTimer = null, runDlg = null;

  const area = h('textarea', { class: 'cqa-input cqa-textarea cqa-nd__area', id: 'cqa-nd-text', rows: 16, spellcheck: 'false', 'aria-describedby': 'cqa-nd-format',
    placeholder: '[00:00] Клиент: Здравствуйте, как вывести деньги?\n[00:30] Оператор: Добрый день, меня зовут Анна…',
    oninput: (e) => { st.text = e.target.value; st.errors.transcript = []; st.errors.general = null; paintErrors(); schedulePreview(); } });
  const cidIn = h('input', { class: 'cqa-input', id: 'cqa-nd-cid', autocomplete: 'off', spellcheck: 'false', placeholder: 'manual-001 — присвоится сам',
    oninput: (e) => { st.cid = e.target.value.trim(); st.errors.conversation_id = null; paintErrors(); } });
  const cidErr = h('div', { class: 'cqa-fielderr', id: 'cqa-nd-cid-err', hidden: true });
  const textErr = h('div', { class: 'cqa-fielderr', id: 'cqa-nd-text-err', hidden: true });
  const generalErr = h('div', { class: 'cqa-banner cqa-banner--flag', role: 'alert', hidden: true });
  const formatEl = h('span', { class: 'cqa-badge cqa-badge--muted', id: 'cqa-nd-format-badge' }, 'формат определится сам');
  const preview = h('div', { class: 'cqa-nd__preview', id: 'cqa-nd-preview', 'aria-live': 'polite' });
  const savedEl = h('div', { hidden: true });
  const btnRun = h('button', { type: 'submit', class: 'cqa-btn cqa-btn--primary', id: 'cqa-nd-save-run' }, 'Сохранить и оценить');
  const btnSave = h('button', { type: 'button', class: 'cqa-btn', id: 'cqa-nd-save', onclick: () => save(false) }, 'Только сохранить');

  function seg(label, key, options) {
    return h('div', { class: 'cqa-field' }, h('div', { class: 'cqa-field__label' }, label),
      h('div', { class: 'cqa-seg', role: 'radiogroup', 'aria-label': label }, options.map(([v, t]) =>
        h('button', { type: 'button', class: 'cqa-seg__btn', role: 'radio', 'aria-checked': String(st[key] === v), 'aria-pressed': String(st[key] === v), dataset: { [key]: v },
          onclick: (e) => { st[key] = v; e.currentTarget.parentElement.querySelectorAll('button').forEach((b) => { const on = b === e.currentTarget; b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-checked', String(on)); }); schedulePreview(0); } }, t))));
  }

  function setText(t) {
    area.value = t; st.text = t;
    st.errors.transcript = []; st.errors.general = null;
    paintErrors(); schedulePreview(0);
    area.focus({ preventScroll: true });
  }

  function schedulePreview(ms = 200) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(paintPreview, ms);
  }

  function paintPreview() {
    if (!alive) return;
    clear(preview);
    const text = st.text;
    if (!text.trim()) {
      formatEl.textContent = 'формат определится сам';
      preview.append(h('div', { class: 'cqa-nd__empty' },
        h('div', { class: 'cqa-state__icon' }, '✎'),
        h('div', { class: 'cqa-state__title' }, 'Здесь будет предпросмотр'),
        h('div', { class: 'cqa-state__text' }, 'Вставьте переписку слева или нажмите «Вставить пример» — покажем, как система поняла реплики, роли и время.')));
      return;
    }
    const r = parseTranscript(text);
    formatEl.textContent = r.format === 'json' ? 'JSON' : 'текст по строкам';
    const counts = {};
    for (const m of r.messages) counts[m.speaker] = (counts[m.speaker] || 0) + 1;
    const metaNote = [];
    if (r.meta.conversation_id) metaNote.push(`id ${r.meta.conversation_id}`);
    if (r.meta.channel) metaNote.push(r.meta.channel === 'voice call' ? 'звонок' : 'чат');
    if (r.meta.language) metaNote.push(`язык ${String(r.meta.language).toUpperCase()}`);
    preview.append(...[
      h('div', { class: 'cqa-nd__stats' },
        h('b', { id: 'cqa-nd-count' }, `${r.messages.length} ${plural(r.messages.length, 'реплика', 'реплики', 'реплик')}`),
        Object.entries(counts).map(([k, n]) => h('span', { class: `cqa-nd__role cqa-nd__role--${k}` }, `${ROLE[k] || k}: ${n}`)),
        metaNote.length ? h('span', { class: 'cqa-faint' }, `из JSON: ${metaNote.join(', ')}`) : null),
      r.errors.length ? h('div', { class: 'cqa-nd__issues cqa-nd__issues--err', role: 'alert' }, h('b', null, 'Не разобрано'), h('ul', null, r.errors.map((e) => h('li', null, e.message)))) : null,
      r.warnings.length ? h('div', { class: 'cqa-nd__issues' }, h('b', null, 'Обратите внимание'), h('ul', null, r.warnings.map((w) => h('li', null, w)))) : null,
      r.messages.length ? h('div', { class: 'cqa-tr cqa-nd__msgs' }, r.messages.map((m, i) => h('div', { class: `cqa-msg cqa-msg--${m.speaker}` },
        h('div', { class: 'cqa-msg__meta' },
          h('span', { class: 'cqa-msg__role' }, ROLE[m.speaker] || m.speaker),
          h('span', { class: 'cqa-msg__time' }, m.timestamp || 'без времени'),
          h('span', { class: 'cqa-msg__id' }, `m${i}`),
          m.line ? h('span', { class: 'cqa-faint cqa-nd__line' }, `строка ${m.line}`) : null),
        h('div', { class: 'cqa-msg__text' }, m.text)))) : null].filter(Boolean));
  }

  function paintErrors() {
    const te = st.errors.transcript;
    textErr.hidden = !te.length;
    clear(textErr);
    if (te.length) textErr.append(h('ul', null, te.map((e) => h('li', null, e))));
    area.toggleAttribute('aria-invalid', te.length > 0);
    cidErr.hidden = !st.errors.conversation_id;
    cidErr.textContent = st.errors.conversation_id || '';
    cidIn.toggleAttribute('aria-invalid', !!st.errors.conversation_id);
    generalErr.hidden = !st.errors.general;
    clear(generalErr);
    if (st.errors.general) generalErr.append(h('span', { class: 'cqa-banner__icon' }, '!'), h('div', null, h('div', { class: 'cqa-banner__title' }, 'Диалог не сохранён'), st.errors.general));
    btnRun.disabled = btnSave.disabled = st.busy;
    btnRun.textContent = st.busy ? 'Сохраняем…' : 'Сохранить и оценить';
  }

  /** Ошибки бэкенда по полям: transcript / transcript.N.* — под текстом, 409 — у id диалога. */
  function applyError(e) {
    st.errors = { transcript: [], conversation_id: null, general: null };
    if (e.status === 409 && /уже есть диалог/.test(e.detail || '')) {
      st.errors.conversation_id = `${e.detail}. Укажите другой id или оставьте поле пустым.`; cidIn.focus(); return;
    }
    for (const x of e.errors || []) {
      const m = /^transcript(?:\.(\d+))?(?:\.(\w+))?$/.exec(x.path || '');
      if (m) st.errors.transcript.push(m[1] != null && !/^реплика/.test(x.message) ? `реплика ${Number(m[1]) + 1}: ${x.message}` : x.message);
      else if (x.path === 'conversation_id') st.errors.conversation_id = x.message;
      else st.errors.general = `${x.path ? x.path + ': ' : ''}${x.message}`;
    }
    if (!st.errors.transcript.length && !st.errors.conversation_id && !st.errors.general) st.errors.general = e.detail || e.message;
    if (st.errors.transcript.length) area.focus();
  }

  async function save(evaluate) {
    if (st.busy) return;
    if (!st.text.trim()) { st.errors.transcript = ['Вставьте транскрипт: текст «роль: текст» по строкам или JSON.']; paintErrors(); area.focus(); return; }
    st.busy = true; st.errors = { transcript: [], conversation_id: null, general: null }; paintErrors();
    const body = { group_id: 'MANUAL', channel: st.channel, transcript: st.text };
    if (st.language) body.language = st.language;
    if (st.cid) body.conversation_id = st.cid;
    try {
      const conv = await createConversation(body);
      if (!alive) return;
      st.saved = conv;
      emit(root, 'cqa:groups-changed', { select: conv.group_id });
      if (evaluate) startRun(conv);
      else emit(root, 'cqa:navigate', { to: `#/conversation/${conv.id}` });
    } catch (e) {
      if (alive) applyError(e);
    } finally {
      st.busy = false;
      if (alive) { paintErrors(); paintSaved(); }
    }
  }

  function startRun(conv) {
    const host = root.closest('.cqa-root') || document.body;
    const card = `#/conversation/${conv.id}`;
    runDlg = openRunDialog(host, {
      ids: [conv.id], group: conv.group_id, label: conv.conversation_id, channel: conv.channel, lockScope: true,
      title: `Оценить ${conv.conversation_id}`,
      intro: `Диалог сохранён в группе ${conv.group_id} (${conv.messages.length} реплик${conv.warnings?.length ? `; ${conv.warnings.join('; ')}` : ''}). Запустите оценку — по завершении откроется карточка.`,
      onFinished: (run) => {
        emit(host, 'cqa:counts-changed', {});
        if (isMock()) toast(host, 'Демо-режим: оценка имитируется, результата модели нет — карточка покажет «Не оценён».');
        host.dispatchEvent(new CustomEvent('cqa:navigate', { detail: { to: card }, bubbles: true }));
        const dlg = runDlg;
        if (run.status !== 'failed') setTimeout(() => dlg?.close(), 900);
      },
    });
  }

  function paintSaved() {
    const c = st.saved;
    savedEl.hidden = !c;
    clear(savedEl);
    if (!c) return;
    savedEl.append(h('div', { class: 'cqa-banner cqa-banner--info cqa-nd__saved', role: 'status' }, h('span', { class: 'cqa-banner__icon' }, '✓'),
      h('div', null, h('div', { class: 'cqa-banner__title' }, `Диалог ${c.conversation_id} сохранён в группе ${c.group_id}`),
        c.warnings?.length ? h('div', { class: 'cqa-faint' }, c.warnings.join('; ')) : null,
        h('div', { class: 'cqa-nd__savedacts' },
          h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm cqa-btn--primary', onclick: () => startRun(c) }, 'Оценить'),
          h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm', onclick: () => emit(root, 'cqa:navigate', { to: `#/conversation/${c.id}` }) }, 'Открыть карточку'),
          h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm cqa-btn--ghost', onclick: () => { st.saved = null; st.cid = ''; cidIn.value = ''; setText(''); paintSaved(); } }, 'Ещё один диалог')))));
  }

  const formatHelp = h('div', { class: 'cqa-nd__help', id: 'cqa-nd-format' },
    h('div', null, h('b', null, 'Текст: '), 'одна реплика — одна строка ', h('code', null, '[MM:SS] роль: текст'), '. Время необязательно (без него не считаются задержки).'),
    h('div', null, h('b', null, 'Роли: '), 'клиент, оператор, бот, система — или client, operator, bot, system, коротко К и О. Строка без роли продолжает предыдущую реплику.'),
    h('div', null, h('b', null, 'JSON: '), 'массив реплик ', h('code', null, '[{timestamp, speaker, text}]'), ' как в API организаторов или запись ', h('code', null, '{conversation_id, channel, language, transcript}'), '.'));

  root.append(
    h('div', { class: 'cqa-pagehead' },
      h('div', null, h('h1', { class: 'cqa-h1' }, 'Новый диалог'),
        h('div', { class: 'cqa-pagehead__sub' }, 'Вставьте переписку — система сохранит её в группе MANUAL и сразу оценит тем же конвейером, что и наборы организаторов.')),
      h('div', { class: 'cqa-pagehead__actions' }, h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm', onclick: () => emit(root, 'cqa:navigate', { to: '#/conversations' }) }, '← К списку'))),
    h('div', { class: 'cqa-nd__cols' },
      h('form', { class: 'cqa-panel cqa-nd__form', novalidate: true, onsubmit: (e) => { e.preventDefault(); save(true); } },
        h('div', { class: 'cqa-nd__row' },
          seg('Канал', 'channel', CHANNELS),
          h('label', { class: 'cqa-field' }, h('span', { class: 'cqa-field__label' }, 'Язык'),
            h('select', { class: 'cqa-select', id: 'cqa-nd-lang', onchange: (e) => { st.language = e.target.value; } }, LANGS.map(([v, t]) => h('option', { value: v }, t)))),
          h('label', { class: 'cqa-field cqa-nd__cid' }, h('span', { class: 'cqa-field__label' }, 'ID диалога · необязательно'), cidIn, cidErr)),
        h('div', { class: 'cqa-field' },
          h('div', { class: 'cqa-nd__texthead' },
            h('span', { class: 'cqa-field__label' }, 'Транскрипт'), formatEl,
            h('span', { class: 'cqa-toolbar__spacer' }),
            h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm', id: 'cqa-nd-example', onclick: () => setText(EXAMPLE_TEXT) }, 'Вставить пример'),
            h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm cqa-btn--ghost', id: 'cqa-nd-example-json', onclick: () => setText(EXAMPLE_JSON) }, 'Пример JSON'),
            h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm cqa-btn--ghost', onclick: () => setText('') }, 'Очистить')),
          area, textErr, formatHelp),
        generalErr,
        savedEl,
        h('div', { class: 'cqa-nd__foot' },
          h('span', { class: 'cqa-faint' }, 'Оценка — реальный вызов модели: перед запуском покажем цену и время.'),
          btnSave, btnRun)),
      h('div', { class: 'cqa-panel cqa-nd__side' },
        h('div', { class: 'cqa-panel__head' }, h('h3', { class: 'cqa-h3' }, 'Как система поняла текст')),
        preview)));
  paintPreview();
  paintErrors();

  return {
    update() {},
    unmount() { alive = false; clearTimeout(previewTimer); root.remove(); },
  };
}

