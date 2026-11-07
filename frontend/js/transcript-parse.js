// Разбор вставленного диалога для предпросмотра (FR-DATA-07). Те же правила, что у бэкенда
// (backend/app/services/manual.py): текст «[MM:SS] роль: текст» по строке или JSON в формате API организаторов.
// Окончательный разбор и проверку делает бэкенд; здесь — только чтобы показать, как будет понят текст.

const ROLE_ALIASES = {
  client: 'client', 'клиент': 'client', customer: 'client', user: 'client', 'пользователь': 'client', 'к': 'client', k: 'client',
  operator: 'operator', 'оператор': 'operator', agent: 'operator', 'агент': 'operator', 'менеджер': 'operator', 'специалист': 'operator',
  'о': 'operator', o: 'operator',
  bot: 'bot', 'бот': 'bot',
  system: 'system', 'система': 'system', 'системное': 'system',
};
const LINE_RE = /^\s*(?:\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*[-–—]?\s*)?([^\s:：\[\]]{1,24})\s*[:：]\s?(.*)$/u;
const ROLE_HINT = 'роли client, operator, bot, system (или клиент, оператор, бот, система, К, О)';

export const roleOf = (raw) => ROLE_ALIASES[String(raw ?? '').trim().toLowerCase().replace(/\.$/, '')] || null;

/** Похоже ли на JSON (бэкенд тоже смотрит на первую скобку). */
export const looksLikeJson = (text) => /^\s*[[{]/.test(text || '');

/** Текст по строкам → {messages: [{timestamp, speaker, text, line}], errors: [{line, message}], warnings: [str]}. */
export function parseText(text) {
  const messages = [], errors = [], warnings = [];
  String(text || '').split(/\r?\n/).forEach((line, i) => {
    const n = i + 1;
    if (!line.trim()) return;
    const m = LINE_RE.exec(line);
    const role = m ? roleOf(m[2]) : null;
    if (role) {
      const body = m[3].trim();
      if (!body) { warnings.push(`строка ${n}: пустая реплика пропущена`); return; }
      messages.push({ timestamp: m[1] || '', speaker: role, text: body, line: n });
    } else if (messages.length) {
      if (m && !m[1] && m[2].length <= 12) warnings.push(`строка ${n}: «${m[2]}» — не роль, строка добавлена к предыдущей реплике`);
      messages[messages.length - 1].text += '\n' + line.trim();
    } else {
      errors.push({ line: n, message: `строка ${n}: не указана роль — нужно «роль: текст», ${ROLE_HINT}` });
    }
  });
  if (messages.length && !messages.some((m) => m.timestamp)) warnings.push('в тексте нет времени реплик: задержки ответа и паузы не оцениваются');
  return { messages, errors, warnings };
}

/** JSON: массив реплик, запись {conversation_id, channel, language, transcript} или набор с одной записью. */
export function parseJson(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { return { messages: [], errors: [{ message: `JSON не читается: ${e.message}` }], warnings: [], meta: {} }; }
  let meta = {};
  if (data && !Array.isArray(data) && typeof data === 'object') {
    const inner = data.data && typeof data.data === 'object' ? data.data : data;
    if (Array.isArray(inner.records)) {
      if (inner.records.length !== 1) return { messages: [], errors: [{ message: `в наборе ${inner.records.length} записей: вставьте одну или загрузите файл набора` }], warnings: [], meta };
      data = inner.records[0];
    }
    if (data && typeof data === 'object' && 'transcript' in data) {
      for (const k of ['conversation_id', 'channel', 'language']) if (data[k]) meta[k] = data[k];
      data = data.transcript;
    }
  }
  if (!Array.isArray(data)) return { messages: [], errors: [{ message: 'нужен массив реплик [{timestamp, speaker, text}] или запись с полем transcript' }], warnings: [], meta };
  const messages = [], errors = [];
  data.forEach((m, i) => {
    if (!m || typeof m !== 'object') { errors.push({ index: i, message: `реплика ${i + 1}: нужен объект {timestamp, speaker, text}` }); return; }
    const role = roleOf(m.speaker);
    if (!role) errors.push({ index: i, message: `реплика ${i + 1}: неизвестная роль «${m.speaker ?? ''}» — client, operator, bot или system` });
    const ok = typeof m.text === 'string' && m.text.trim();
    if (!ok) errors.push({ index: i, message: `реплика ${i + 1}: пустой текст` });
    if (role && ok) messages.push({ timestamp: m.timestamp == null ? '' : String(m.timestamp), speaker: role, text: m.text, index: i });
  });
  return { messages, errors, warnings: [], meta };
}

/** Общий вход: определяет формат сам. Возвращает {format: 'text' | 'json', messages, errors, warnings, meta}. */
export function parseTranscript(text) {
  const json = looksLikeJson(text);
  const r = json ? parseJson(text) : parseText(text);
  // Текст в скобках, который не JSON, бэкенд читает как обычный текст — повторяем это.
  if (json && r.errors.length && /JSON не читается/.test(r.errors[0].message)) {
    const t = parseText(text);
    if (t.messages.length && !t.errors.length) return { format: 'text', meta: {}, ...t };
  }
  const out = { format: json ? 'json' : 'text', meta: {}, ...r };
  if (!out.errors.length && !out.messages.length && String(text || '').trim()) out.errors.push({ message: 'в диалоге нет ни одной реплики' });
  if (out.messages.length && !out.messages.some((m) => m.speaker === 'operator')) out.warnings.push('нет ни одной реплики оператора: оценивать будет нечего');
  return out;
}

/** «MM:SS» / «HH:MM:SS» / ISO → секунды или null. */
export function clockSec(ts) {
  const s = String(ts || '');
  if (s.includes('T')) { const d = Date.parse(s); return isNaN(d) ? null : d / 1000; }
  const parts = s.split(':').map(Number);
  if (!s || parts.some((x) => isNaN(x))) return null;
  return parts.reduce((a, x) => a * 60 + x, 0);
}
