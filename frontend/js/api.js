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
  if (isMock()) return (await mockStore()).conversations(params);
  return http('/conversations', params);
}

export async function getConversation(id) {
  if (isMock()) return (await mockStore()).conversation(id);
  return http(`/conversations/${encodeURIComponent(id)}`);
}

// ---------- Запись звонка ----------
/** Источник для <audio>: {url, mock, revoke()} или null. Запись идёт через прокси бэкенда (`conv.audio_url`
 *  = `/api/conversations/{id}/audio`), подписанная ссылка в браузер не попадает. В mock-режиме — синтетический WAV в памяти. */
export async function audioSource(conv) {
  if (isMock()) {
    const { makeMockWav } = await import('./mock-audio.js');
    const url = URL.createObjectURL(makeMockWav(conv.messages || []));
    return { url, mock: true, revoke: () => URL.revokeObjectURL(url) };
  }
  if (!conv.audio_url) return null;
  const url = new URL(apiBase() + conv.audio_url.replace(/^\/api(?=\/)/, ''), window.location.href).href;
  return { url, mock: false, revoke() {} };
}

/** Причина, по которой <audio> не открыл запись: {ok, status, message}. Запрашивает первый байт через прокси. */
export async function probeAudio(url) {
  let res;
  try { res = await fetch(url, { headers: { Range: 'bytes=0-0' } }); }
  catch { return { ok: false, status: 0, message: 'нет связи с сервером' }; }
  if (res.ok) {
    try { await res.body?.cancel(); } catch { /* уже закрыт */ }
    return { ok: true, status: res.status, message: '' };
  }
  let detail = '';
  try { detail = (await res.json()).detail || ''; } catch { /* тело не JSON */ }
  return { ok: false, status: res.status, message: `${detail || (res.status === 404 ? 'запись не найдена' : 'ошибка сервера')} (${res.status})` };
}

export async function getEvaluation(id) {
  if (isMock()) return (await mockStore()).evaluation(id);
  return http(`/evaluations/${encodeURIComponent(id)}`);
}

/** Вызовы LLM оценки с сырыми ответами: [{id, criteria_keys, attempt, request, response_raw, finish_reason, error, ...}]. */
export async function getEvaluationCalls(id) {
  if (isMock()) return fixture(`evaluation-${id}-calls`).catch(() => []);
  return http(`/evaluations/${encodeURIComponent(id)}/calls`);
}

/** GET /evaluations/{id}/compare?other= → {a, b, criteria: [{key, title, status: same|changed|added|removed, a, b, points_delta}],
 *  changed, common, total_delta, same_config, config_diff}. `a` — оценка id, `b` — other или предыдущая неупавшая оценка диалога
 *  (null, если сравнивать не с чем); 422 — оценки разных диалогов. В mock-режиме разница считается в браузере по фикстурам. */
export async function compareEvaluations(id, other) {
  if (isMock()) return (await mockStore()).compare(id, other);
  return request('GET', `/evaluations/${encodeURIComponent(id)}/compare`, { params: { other }, failText: 'Сравнение недоступно' });
}

/** Настроенные провайдеры и модели: {models: [{provider, model, paid, voice_allowed?}], default_provider, default_strategy, strategies}. */
export async function getMetaModels() {
  if (isMock()) return fixture('meta-models');
  return http('/meta/models');
}

// ---------- Чек-листы (версии неизменяемы: сохранение = новая версия) ----------
// В mock-режиме сохранённые версии живут в памяти вкладки поверх фикстур checklists.json / checklist-<id>.json.
const mockChk = { list: null, bodies: new Map() };
async function mockChecklists() {
  if (!mockChk.list) mockChk.list = (await fixture('checklists')).map((v) => ({ parent_id: null, ...v }));
  return mockChk.list;
}
function mockWarnings(body) {
  const total = (body.criteria || []).filter((c) => c.enabled !== false && c.type !== 'flag').reduce((s, c) => s + Number(c.weight || 0), 0);
  return Math.abs(total - 100) > 1e-9 ? [`сумма весов ${+total.toFixed(4)}, а не 100: итог всё равно нормируется к 100`] : [];
}

/** GET /checklists → [{id, key, version, name, note, is_active, parent_id, created_at}] (новые версии первыми). */
export async function listChecklists() {
  if (isMock()) return (await mockChecklists()).slice().sort((a, b) => b.version - a.version);
  return http('/checklists');
}

/** GET /checklists/{id} → версия с телом `body` (формат CONTRACTS.md §1). */
export async function getChecklist(versionId) {
  if (isMock()) {
    const id = Number(versionId);
    if (mockChk.bodies.has(id)) return structuredClone(mockChk.bodies.get(id));
    const v = await fixture(`checklist-${id}`);
    const meta = (await mockChecklists()).find((x) => x.id === id);
    return meta ? { ...v, ...meta } : v;
  }
  return http(`/checklists/${encodeURIComponent(versionId)}`);
}

/** POST /checklists {body, note, parent_id?, activate?} → версия + `warnings`; 422 → ApiError с errors [{path, message}]. */
export async function createChecklist(payload) {
  if (isMock()) {
    const list = await mockChecklists();
    const body = structuredClone(payload.body);
    const id = Math.max(0, ...list.map((v) => v.id)) + 1;
    const version = Math.max(0, ...list.filter((v) => v.key === body.key).map((v) => v.version)) + 1;
    const meta = { id, key: body.key, version, name: body.name, note: payload.note || '', is_active: false, parent_id: payload.parent_id ?? null, created_at: new Date().toISOString() };
    list.push(meta);
    mockChk.bodies.set(id, { ...meta, body });
    if (payload.activate) await activateChecklist(id);
    return { ...(await getChecklist(id)), warnings: mockWarnings(body) };
  }
  return request('POST', '/checklists', { body: payload, failText: 'Версия не сохранена', netText: 'Нет связи с сервером: версия не сохранена.' });
}

/** POST /checklists/{id}/activate → версия. Активная версия одна на систему: по ней идут прогоны и файл сдачи. */
export async function activateChecklist(versionId) {
  if (isMock()) {
    const list = await mockChecklists();
    const id = Number(versionId);
    if (!list.some((v) => v.id === id)) throw new ApiError('Не найдено: версия чек-листа не найдена (404)', 404, { detail: 'версия чек-листа не найдена' });
    list.forEach((v) => { v.is_active = v.id === id; });
    for (const b of mockChk.bodies.values()) b.is_active = b.id === id;
    return getChecklist(id);
  }
  return request('POST', `/checklists/${encodeURIComponent(versionId)}/activate`, { failText: 'Версия не активирована', netText: 'Нет связи с сервером: версия не активирована.' });
}

/** Подписи фактов {labels: {имя: подпись}} из реестра бэкенда; один запрос на вкладку. */
let factLabels = null;
export function getFactLabels() {
  if (isMock()) return Promise.resolve({ labels: {} });
  factLabels ||= http('/meta/facts').catch((e) => { factLabels = null; throw e; });
  return factLabels;
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

/** POST /runs/estimate (тело как у POST /runs, без вызовов LLM) →
 * {dialogs, dialogs_with_calls, calls, tokens_in, tokens_out, cost_usd | null, seconds, cost_source: history | pricing | unknown}. */
export async function estimateRun(body) {
  if (isMock()) {
    const n = body.conversation_ids?.length || (await fixture('conversations')).filter((r) => !body.group_id || r.group_id === body.group_id).length;
    const per = body.reuse === 'auto' ? 1 : body.strategy === 'single' ? 1 : body.strategy === 'per_criterion' ? 8 : 4;
    const calls = n * per;
    return { dialogs: n, dialogs_with_calls: n, calls, tokens_in: calls * 5200, tokens_out: calls * 700,
      cost_usd: +(calls * 0.0021).toFixed(4), seconds: Math.ceil(n / 4) * 8, cost_source: 'history' };
  }
  return request('POST', '/runs/estimate', { body, failText: 'Оценка стоимости недоступна', netText: 'Нет связи с сервером: оценка стоимости недоступна.' });
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

// ---------- Дашборд и качество (FR-ANL-01, FR-OPS-05) ----------
/** GET /analytics?group_id&checklist_version_id → Analytics (CONTRACTS.md §3). В mock-режиме — фикстура analytics.json. */
export async function getAnalytics(params = {}) {
  if (isMock()) return fixture('analytics');
  return http('/analytics', params);
}

/** GET /quality/runs → {dir, runs: [RunSummary]}: прогоны run_eval.py, новые сверху.
 *  В mock-режиме — вымышленные прогоны из фикстур (`mock: true`; экран помечает их как демо-данные). */
export async function listQualityRuns() {
  if (isMock()) return { ...(await fixture('quality-runs')), mock: true };
  return http('/quality/runs');
}

/** GET /quality/runs/{name} → RunSummary + {criteria, total, by_language, by_channel, calibration, cost, languages}. */
export async function getQualityRun(name) {
  if (isMock()) return { ...(await fixture(`quality-run-${name}`)), mock: true };
  return http(`/quality/runs/${encodeURIComponent(name)}`);
}

// ---------- Проверка gold (только DEV; без mock-режима: файлы разметки живут на бэкенде) ----------
export async function listGold() { return http('/gold'); }
export async function getGold(conversationId) { return http(`/gold/${encodeURIComponent(conversationId)}`); }
export async function putGold(conversationId, body) {
  return request('PUT', `/gold/${encodeURIComponent(conversationId)}`, { body, failText: 'Не сохранено', netText: 'Нет связи с сервером: разметка не сохранена.' });
}

// ---------- Апелляции, «требует проверки», новый диалог, экспорт, группы (этап 4) ----------
// В mock-режиме состояние живёт в памяти вкладки: js/mock-store.js поверх фикстур appeals.json, review-queue.json.
const mockStore = () => import('./mock-store.js');

/** GET /appeals → [AppealRow] (новые сверху). params: {status: open|confirmed|changed|closed, group_id, evaluation_id, conversation_id}. */
export async function listAppeals(params = {}) {
  if (isMock()) return (await mockStore()).listAppeals(params);
  return http('/appeals', params);
}
/** POST /appeals {evaluation_id, criterion_key, comment} → Appeal (201); 409 — открытая уже есть; 422 с errors. */
export async function createAppeal(body) {
  if (isMock()) return (await mockStore()).createAppeal(body);
  return request('POST', '/appeals', { body, failText: 'Апелляция не сохранена', netText: 'Нет связи с сервером: апелляция не сохранена.' });
}
/** POST /appeals/{id}/decision {action: confirm|change, answer?, reason} → {appeal, evaluation}. */
export async function decideAppeal(id, body) {
  if (isMock()) return (await mockStore()).decideAppeal(id, body);
  return request('POST', `/appeals/${encodeURIComponent(id)}/decision`, { body, failText: 'Решение не сохранено', netText: 'Нет связи с сервером: решение не сохранено.' });
}
/** GET /review-queue → [ReviewItem], важные сверху. */
export async function getReviewQueue(params = {}) {
  if (isMock()) return (await mockStore()).reviewQueue(params);
  return http('/review-queue', params);
}
/** POST /conversations {group_id?, conversation_id?, channel?, language?, transcript: [] | text} → ConversationDetail (201); 409; 422 с errors. */
export async function createConversation(body) {
  if (isMock()) return (await mockStore()).createConversation(body);
  return request('POST', '/conversations', { body, failText: 'Диалог не сохранён', netText: 'Нет связи с сервером: диалог не сохранён.' });
}
/** Группы с диалогами [{group_id, count, default}]: по списку диалогов + группа по умолчанию из /health (даже пустая). */
export async function listGroups() {
  if (isMock()) return (await mockStore()).groups();
  const [rows, hl] = await Promise.all([http('/conversations'), getHealth().catch(() => null)]);
  const counts = new Map(hl?.group_id ? [[hl.group_id, 0]] : []);
  for (const r of rows) counts.set(r.group_id, (counts.get(r.group_id) || 0) + 1);
  return [...counts].map(([group_id, count]) => ({ group_id, count, default: group_id === hl?.group_id }));
}
/** Файл выгрузки: path '/export' ({group_id, format: csv|json}) или '/export/results' ({group_id}).
 *  → {blob, filename, validationErrors} (число ошибок проверки формата из X-Validation-Errors или null). */
export async function downloadExport(path, params = {}) {
  if (isMock()) return (await mockStore()).exportFile(path, params);
  const url = new URL(apiBase() + path, window.location.href);
  for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) url.searchParams.set(k, v);
  let res;
  try { res = await fetch(url); } catch { throw new ApiError('Нет связи с сервером: файл не скачан.', 0); }
  if (!res.ok) {
    let parsed = { detail: null, errors: [] };
    try { parsed = parseErrorBody(await res.json()); } catch { /* тело не JSON */ }
    throw new ApiError(`Файл не выгружен${parsed.detail ? ': ' + parsed.detail : ''} (${res.status})`, res.status, parsed);
  }
  const name = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(res.headers.get('Content-Disposition') || '')?.[1];
  const v = res.headers.get('X-Validation-Errors');
  return { blob: await res.blob(), filename: name ? decodeURIComponent(name) : path.endsWith('results') ? 'results.json' : `export.${params.format || 'csv'}`,
    validationErrors: v == null || v === '' ? null : Number(v) };
}
