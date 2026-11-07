// Единственное место с fetch. Режим ?mock=1 читает фикстуры из frontend/fixtures/.

export class ApiError extends Error {
  constructor(message, status) { super(message); this.name = 'ApiError'; this.status = status; }
}

const search = () => new URLSearchParams(window.location.search);
export const isMock = () => search().get('mock') === '1';
export function apiBase() {
  const b = search().get('api') || window.CQA_API_BASE || '';
  return b.replace(/\/+$/, '') + '/api';
}

async function http(path, params) {
  const url = new URL(apiBase() + path, window.location.href);
  for (const [k, v] of Object.entries(params || {})) if (v !== '' && v != null) url.searchParams.set(k, v);
  let res;
  try { res = await fetch(url); }
  catch { throw new ApiError('Нет связи с сервером. Проверьте, что бэкенд запущен, или откройте страницу с ?mock=1.', 0); }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).detail; } catch { /* тело не JSON */ }
    const text = res.status === 404 ? 'Не найдено' : res.status >= 500 ? 'Ошибка сервера' : 'Запрос отклонён';
    throw new ApiError(`${text}${detail ? ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''} (${res.status})`, res.status);
  }
  return res.json();
}

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

export async function listChecklists() {
  if (isMock()) return fixture('checklists');
  return http('/checklists');
}

export async function getChecklist(versionId) {
  if (isMock()) return fixture(`checklist-${versionId}`);
  return http(`/checklists/${encodeURIComponent(versionId)}`);
}

// ---------- Проверка gold (только DEV; без mock-режима: файлы разметки живут на бэкенде) ----------
export async function listGold() { return http('/gold'); }
export async function getGold(conversationId) { return http(`/gold/${encodeURIComponent(conversationId)}`); }
export async function putGold(conversationId, body) {
  let res;
  try {
    res = await fetch(new URL(apiBase() + `/gold/${encodeURIComponent(conversationId)}`, window.location.href), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch { throw new ApiError('Нет связи с сервером: разметка не сохранена.', 0); }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).detail; } catch { /* тело не JSON */ }
    throw new ApiError(`Не сохранено${detail ? ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''} (${res.status})`, res.status);
  }
  return res.json();
}
