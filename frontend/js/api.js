// Единственное место с fetch. Режим ?mock=1 читает фикстуры из frontend/fixtures/.

/** Ошибка API: `message` — текст для человека, `detail` — сырой detail, `errors` — [{path, message}] (422). */
export class ApiError extends Error {
  constructor(message, status, { detail = null, errors = [] } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
    this.errors = errors;
  }
}

const search = () => new URLSearchParams(window.location.search);
export const isMock = () => search().get('mock') === '1';
export function apiBase() {
  const b = search().get('api') || window.CQA_API_BASE || '';
  return b.replace(/\/+$/, '') + '/api';
}

const STATUS_TEXT = { 400: 'Запрос отклонён', 404: 'Не найдено', 409: 'Конфликт', 422: 'Данные не прошли проверку' };

// Тело ошибки бэкенда: {detail: str} (400, 404), {detail, errors: [{path, message}]} (422 чек-листа)
// или {detail: [{loc, msg}]} (422 валидации тела FastAPI).
function parseErrorBody(body) {
  let detail = body?.detail ?? null;
  let errors = Array.isArray(body?.errors) ? body.errors.map((e) => ({ path: String(e.path ?? ''), message: String(e.message ?? e.msg ?? '') })) : [];
  if (Array.isArray(detail)) {
    errors = errors.concat(detail.map((e) => ({ path: (e.loc || []).filter((x) => x !== 'body').join('.'), message: String(e.msg ?? JSON.stringify(e)) })));
    detail = null;
  } else if (detail != null && typeof detail !== 'string') detail = JSON.stringify(detail);
  return { detail, errors };
}

async function request(method, path, { params, body, failText, netText } = {}) {
  const url = new URL(apiBase() + path, window.location.href);
  for (const [k, v] of Object.entries(params || {})) if (v !== '' && v != null) url.searchParams.set(k, v);
  const init = { method };
  if (body !== undefined) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(url, init); }
  catch { throw new ApiError(netText || 'Нет связи с сервером. Проверьте, что бэкенд запущен, или откройте страницу с ?mock=1.', 0); }
  if (!res.ok) {
    let parsed = { detail: null, errors: [] };
    try { parsed = parseErrorBody(await res.json()); } catch { /* тело не JSON */ }
    const head = failText || (res.status >= 500 ? 'Ошибка сервера' : STATUS_TEXT[res.status] || 'Запрос отклонён');
    const tail = parsed.detail || (parsed.errors.length ? parsed.errors.map((e) => (e.path ? `${e.path}: ` : '') + e.message).join('; ') : '');
    throw new ApiError(`${head}${tail ? ': ' + tail : ''} (${res.status})`, res.status, parsed);
  }
  return res.status === 204 ? null : res.json();
}
const http = (path, params) => request('GET', path, { params });

async function fixture(name) {
  let res;
  try { res = await fetch(new URL(`../fixtures/${name}.json`, import.meta.url)); }
  catch { throw new ApiError('Не удалось прочитать демо-данные.', 0); }
  if (!res.ok) throw new ApiError('В демо-данных нет такой записи.', res.status);
  return res.json();
}

export async function getHealth() {
  if (isMock()) return { status: 'ok', provider: 'mock', model: 'fixtures', group_id: 'DEV', mock: true };
  return http('/health');
}

export async function listConversations(params = {}) {
  if (isMock()) return fixture('conversations');
  return http('/conversations', params);
}

export async function getConversation(id) {
  if (isMock()) return fixture(`conversation-${id}`);
  return http(`/conversations/${encodeURIComponent(id)}`);
}

export async function getEvaluation(id) {
  if (isMock()) return fixture(`evaluation-${id}`);
  return http(`/evaluations/${encodeURIComponent(id)}`);
}

/** Вызовы LLM оценки с сырыми ответами: [{id, criteria_keys, attempt, request, response_raw, finish_reason, error, ...}]. */
export async function getEvaluationCalls(id) {
  if (isMock()) return fixture(`evaluation-${id}-calls`).catch(() => []);
  return http(`/evaluations/${encodeURIComponent(id)}/calls`);
}

/** Настроенные провайдеры и модели: {models: [{provider, model, paid, voice_allowed?}], default_provider, default_strategy, strategies}. */
export async function getMetaModels() {
  if (isMock()) return fixture('meta-models');
  return http('/meta/models');
}

export async function listChecklists() {
  if (isMock()) return fixture('checklists');
  return http('/checklists');
}

export async function getChecklist(versionId) {
  if (isMock()) return fixture(`checklist-${versionId}`);
  return http(`/checklists/${encodeURIComponent(versionId)}`);
}

// ---------- Прогоны оценки ----------
// В mock-режиме прогон имитируется в памяти: «оценивается» один диалог в 0,7 с, без вызовов LLM.
const mockRuns = new Map();
let mockRunSeq = 900;

/** POST /runs → {run_id} (202). body: {conversation_ids? | group_id, checklist_version_id?, provider?, model?, strategy?, reuse?}. */
export async function createRun(body) {
  if (isMock()) {
    const total = body.conversation_ids?.length || (await fixture('conversations')).filter((r) => !body.group_id || r.group_id === body.group_id).length;
    if (!total) throw new ApiError('Запрос отклонён: нет диалогов для оценки (400)', 400, { detail: 'нет диалогов для оценки' });
    const id = ++mockRunSeq;
    mockRuns.set(id, { id, total, t0: Date.now(), provider: body.provider || 'mock', model: body.model || 'fixtures', strategy: body.strategy || 'grouped' });
    return { run_id: id };
  }
  return request('POST', '/runs', { body, failText: 'Оценка не запущена', netText: 'Нет связи с сервером: оценка не запущена.' });
}

/** GET /runs/{id} → {status, total, done, failed, cost_usd, started_at, finished_at, ...}. */
export async function getRun(id) {
  if (isMock()) {
    const r = mockRuns.get(Number(id));
    if (!r) throw new ApiError('Не найдено: прогон не найден (404)', 404, { detail: 'прогон не найден' });
    const done = Math.min(r.total, Math.floor((Date.now() - r.t0) / 700));
    const fin = done >= r.total;
    return { run_id: r.id, status: fin ? 'done' : done ? 'running' : 'queued', total: r.total, done, failed: 0,
      cost_usd: done * 0.0021, provider: r.provider, model: r.model, strategy: r.strategy,
      started_at: new Date(r.t0).toISOString(), finished_at: fin ? new Date().toISOString() : null };
  }
  return http(`/runs/${encodeURIComponent(id)}`);
}

// ---------- Проверка gold (только DEV; без mock-режима: файлы разметки живут на бэкенде) ----------
export async function listGold() { return http('/gold'); }
export async function getGold(conversationId) { return http(`/gold/${encodeURIComponent(conversationId)}`); }
export async function putGold(conversationId, body) {
  return request('PUT', `/gold/${encodeURIComponent(conversationId)}`, { body, failText: 'Не сохранено', netText: 'Нет связи с сервером: разметка не сохранена.' });
}
