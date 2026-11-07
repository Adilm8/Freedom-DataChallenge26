// Демо-режим (?mock=1) для апелляций, очереди «требует проверки», нового диалога, экспорта и групп.
// Состояние живёт в памяти вкладки поверх фикстур frontend/fixtures/*.json (формат CONTRACTS.md v0.5).
// Пересчёт итога после решения по апелляции — та же формула, что в scoring.py: N/A вне расчёта, вес перераспределяется.
// Оценка нового диалога в демо-режиме не выполняется: модели здесь нет.
import { ApiError } from './api.js';
import { parseTranscript, clockSec } from './transcript-parse.js';

const fx = async (name) => {
  const res = await fetch(new URL(`../fixtures/${name}.json`, import.meta.url));
  if (!res.ok) throw new ApiError('В демо-данных нет такой записи.', res.status);
  return res.json();
};
const clone = (x) => structuredClone(x);
const now = () => new Date().toISOString();
const invalid = (path, message) => new ApiError(`Данные не прошли проверку: ${message} (422)`, 422, { detail: message, errors: [{ path, message }] });
const notFound = (detail) => new ApiError(`Не найдено: ${detail} (404)`, 404, { detail });
const conflict = (detail) => new ApiError(`Конфликт: ${detail} (409)`, 409, { detail });

const st = { rows: null, appeals: null, evals: new Map(), convs: new Map(), manual: [], seq: 1000, apSeq: 0 };

async function rows() {
  st.rows ||= await fx('conversations');
  return st.rows;
}
async function appealsAll() {
  if (!st.appeals) {
    st.appeals = await fx('appeals');
    st.apSeq = Math.max(0, ...st.appeals.map((a) => a.id));
  }
  return st.appeals;
}
const appealOnly = ({ conversation, evaluation, criterion, fragment, ...a }) => a; // AppealRow → Appeal

export async function conversation(id) {
  const n = Number(id);
  const m = st.manual.find((c) => c.id === n);
  if (m) return clone(m);
  if (!st.convs.has(n)) st.convs.set(n, await fx(`conversation-${n}`));
  return clone(st.convs.get(n));
}

/** Оценка с апелляциями из состояния вкладки (созданные и решённые здесь же). */
async function evalObj(id) {
  const n = Number(id);
  if (!st.evals.has(n)) {
    const ev = await fx(`evaluation-${n}`);
    const aps = (await appealsAll()).filter((a) => a.evaluation_id === n);
    for (const c of ev.criteria) {
      const hist = aps.filter((a) => a.criterion_key === c.key).sort((a, b) => a.id - b.id).map(appealOnly);
      c.appeal_history = hist;
      c.appeal = hist[hist.length - 1] || null;
    }
    ev.open_appeals = aps.filter((a) => a.status === 'open').length;
    st.evals.set(n, ev);
  }
  return st.evals.get(n);
}
export async function evaluation(id) { return clone(await evalObj(id)); }

export async function conversations(params = {}) {
  const base = await rows();
  const out = [];
  for (const r0 of [...base, ...st.manual.map(rowOf)]) {
    const r = clone(r0);
    if (r.latest && st.evals.has(r.latest.evaluation_id)) {
      const ev = st.evals.get(r.latest.evaluation_id);
      Object.assign(r.latest, { ai_total: ev.ai_score.total, final_total: ev.final_score.total, critical: !!ev.final_score.critical?.length,
        open_appeals: ev.open_appeals, appeals: ev.criteria.reduce((s, c) => s + (c.appeal_history?.length || 0), 0) });
    }
    out.push(r);
  }
  return out.filter((r) => (!params.group_id || r.group_id === params.group_id)
    && (!params.appeal || (params.appeal === 'open' ? r.latest?.open_appeals > 0 : params.appeal === 'any' ? r.latest?.appeals > 0 : !r.latest?.appeals)));
}

export async function groups() {
  const counts = new Map();
  for (const r of await conversations()) counts.set(r.group_id, (counts.get(r.group_id) || 0) + 1);
  return [...counts].map(([group_id, count]) => ({ group_id, count, default: group_id === 'DEV' }));
}

// ---------- Апелляции ----------
export async function listAppeals(params = {}) {
  const all = await appealsAll();
  return clone(all.filter((a) => (!params.status || (params.status === 'closed' ? a.status !== 'open' : a.status === params.status))
    && (!params.group_id || a.conversation.group_id === params.group_id)
    && (!params.evaluation_id || a.evaluation_id === Number(params.evaluation_id))
    && (!params.conversation_id || a.conversation.id === Number(params.conversation_id))));
}

function fragment(messages, evidence, range, ctx = 2) {
  const pos = new Map(messages.map((m, i) => [m.msg_id, i]));
  const quotes = new Map();
  for (const e of evidence || []) if (pos.has(e.msg_id)) quotes.set(e.msg_id, [...(quotes.get(e.msg_id) || []), e.quote || '']);
  const picked = new Set();
  for (const id of quotes.keys()) { const i = pos.get(id); for (let k = Math.max(0, i - ctx); k <= Math.min(messages.length - 1, i + ctx); k++) picked.add(k); }
  if (!picked.size && range && pos.has(range.from) && pos.has(range.to)) {
    const a = Math.min(pos.get(range.from), pos.get(range.to)), b = Math.max(pos.get(range.from), pos.get(range.to));
    for (let k = a; k <= b; k++) if (b - a + 1 <= 10 || k < a + 4 || k > b - 4) picked.add(k);
  }
  let prev = null;
  return [...picked].sort((x, y) => x - y).map((i) => {
    const m = messages[i];
    const out = { ...m, is_evidence: quotes.has(m.msg_id), quotes: quotes.get(m.msg_id) || [], gap_before: prev === null ? i > 0 : i !== prev + 1 };
    prev = i;
    return out;
  });
}

function criterionBlock(c, scale) {
  const pick = ['key', 'title', 'type', 'weight', 'allowed_answers', 'ai_answer', 'ai_points', 'final_answer', 'final_points', 'overridden',
    'reasoning', 'confidence', 'na_reason', 'advice', 'evidence', 'checked_range', 'issues'];
  return { ...Object.fromEntries(pick.map((k) => [k, clone(c[k] ?? null)])), scale_max: c.scale_max ?? c.weight, scale };
}
const evalBlock = (ev) => ({ id: ev.id, model: ev.model, checklist_version_id: ev.checklist_version_id, status: ev.status,
  ai_total: ev.ai_score.total, final_total: ev.final_score.total, critical: !!ev.final_score.critical?.length, created_at: ev.created_at });

export async function createAppeal(body) {
  const ev = await evalObj(body.evaluation_id).catch(() => { throw notFound('оценка не найдена'); });
  const c = ev.criteria.find((x) => x.key === String(body.criterion_key || '').trim());
  if (!c) throw notFound(`в оценке нет результата по критерию «${body.criterion_key}»`);
  const text = String(body.comment || '').trim();
  if (!text) throw invalid('comment', 'напишите комментарий: что не так с оценкой');
  const all = await appealsAll();
  const dup = all.find((a) => a.evaluation_id === ev.id && a.criterion_key === c.key && a.status === 'open');
  if (dup) throw conflict(`по критерию ${c.key} уже есть открытая апелляция №${dup.id}`);
  const conv = await conversation(ev.conversation_id);
  const chk = await fx(`checklist-${ev.checklist_version_id}`).catch(() => null);
  const scale = chk?.body?.criteria?.find((x) => x.key === c.key)?.scale || null;
  const a = { id: ++st.apSeq, evaluation_id: ev.id, criterion_key: c.key, comment: text, status: 'open', ai_answer_snapshot: c.ai_answer,
    decision_answer: null, decision_reason: null, created_at: now(), decided_at: null };
  all.unshift({ ...a, conversation: { id: conv.id, conversation_id: conv.conversation_id, group_id: conv.group_id, channel: conv.channel, language: conv.language },
    evaluation: evalBlock(ev), criterion: criterionBlock(c, scale), fragment: fragment(conv.messages, c.evidence, c.checked_range) });
  c.appeal_history = [...(c.appeal_history || []), a];
  c.appeal = a;
  ev.open_appeals += 1;
  return clone(a);
}

/** Баллы и итог по финальным ответам (как scoring.compute): N/A вне расчёта, шкала — ступень × вес / максимум. */
function rescore(ev) {
  const fs = ev.final_score;
  let sum = 0, aw = 0;
  const secs = new Map((fs.sections || []).map((s) => [s.id, { ...s, points: 0, applicable_weight: 0 }]));
  const critical = [];
  fs.criteria = {};
  for (const c of ev.criteria) {
    const a = c.final_answer;
    if (c.type === 'flag') { if (a === 'yes') critical.push(c.key); c.final_points = null; continue; }
    if (a == null || a === 'na') { c.final_points = a === 'na' ? null : c.final_points; continue; }
    const pts = c.type === 'scale' ? (Number(a) * c.weight) / (c.scale_max || c.weight) : a === 'yes' ? c.weight : 0;
    c.final_points = +pts.toFixed(2);
    sum += pts; aw += c.weight;
    const s = secs.get(c.section);
    if (s) { s.points += pts; s.applicable_weight += c.weight; }
    fs.criteria[c.key] = { points: c.final_points, contribution: c.final_points };
  }
  for (const c of ev.criteria) c.overridden = String(c.final_answer) !== String(c.ai_answer);
  fs.points_sum = +sum.toFixed(2);
  fs.applicable_weight = aw;
  fs.total = aw ? +((sum / aw) * 100).toFixed(2) : null;
  fs.sections = [...secs.values()].map((s) => ({ ...s, points: +s.points.toFixed(2), pct: s.applicable_weight ? +((s.points / s.applicable_weight) * 100).toFixed(2) : null }));
  fs.critical = critical;
}

export async function decideAppeal(id, body) {
  const all = await appealsAll();
  const row = all.find((a) => a.id === Number(id));
  if (!row) throw notFound('апелляция не найдена');
  if (row.status !== 'open') throw conflict(`апелляция №${row.id} уже рассмотрена`);
  const action = String(body.action || '').trim().toLowerCase();
  if (!['confirm', 'change'].includes(action)) throw invalid('action', 'решение: confirm (подтвердить оценку) или change (изменить ответ)');
  const why = String(body.reason || '').trim();
  if (!why) throw invalid('reason', 'укажите причину решения');
  const ev = await evalObj(row.evaluation_id);
  const c = ev.criteria.find((x) => x.key === row.criterion_key);
  if (action === 'confirm') {
    row.status = 'confirmed'; row.decision_answer = c.final_answer;
  } else {
    if (body.answer == null || body.answer === '') throw invalid('answer', `выберите новый ответ: ${c.allowed_answers.join(', ')}`);
    const ans = c.allowed_answers.find((x) => String(x) === String(body.answer));
    if (ans === undefined) throw invalid('answer', `ответ ${body.answer} не подходит критерию ${c.key}: ${c.allowed_answers.join(', ')}`);
    if (String(ans) === String(c.final_answer)) throw invalid('answer', 'ответ совпадает с текущим: выберите другой или подтвердите оценку');
    c.final_answer = ans;
    rescore(ev);
    row.status = 'changed'; row.decision_answer = ans;
  }
  row.decision_reason = why; row.decided_at = now();
  row.evaluation = evalBlock(ev);
  row.criterion = { ...row.criterion, final_answer: c.final_answer, final_points: c.final_points, overridden: c.overridden };
  const a = appealOnly(row);
  c.appeal_history = (c.appeal_history || []).map((x) => (x.id === a.id ? a : x));
  c.appeal = c.appeal_history[c.appeal_history.length - 1];
  ev.open_appeals = all.filter((x) => x.evaluation_id === ev.id && x.status === 'open').length;
  return { appeal: clone(a), evaluation: clone(ev) };
}

// ---------- Очередь «требует проверки»: фикстура + апелляции этой вкладки ----------
export async function reviewQueue(params = {}) {
  const items = (await fx('review-queue')).filter((x) => !params.group_id || x.group_id === params.group_id);
  const all = await appealsAll();
  const out = [];
  for (const it of items) {
    const ev = st.evals.get(it.evaluation_id);
    const c = ev?.criteria.find((x) => x.key === it.criterion_key);
    if (c) {
      const open = (c.appeal_history || []).find((a) => a.status === 'open');
      const decided = (c.appeal_history || []).some((a) => a.status !== 'open');
      it.reasons = it.reasons.filter((r) => (r === 'appeal' ? !!open : !decided));
      it.appeal_id = open?.id ?? null;
      if (!it.reasons.length) continue;
      it.reason = it.reasons[0];
      it.final_answer = c.final_answer;
    }
    out.push(it);
  }
  const SEV = { failed: 100, missing: 90, appeal: 80, guard: 70, validator: 60, low_confidence: 50 };
  for (const a of all.filter((x) => x.status === 'open' && (!params.group_id || x.conversation.group_id === params.group_id))) {
    const msg = `Апелляция №${a.id}: ${a.comment}`;
    const it = out.find((x) => x.evaluation_id === a.evaluation_id && x.criterion_key === a.criterion_key);
    if (it) { if (!it.reasons.includes('appeal')) it.reasons.unshift('appeal'); Object.assign(it, { reason: 'appeal', message: msg, appeal_id: a.id }); continue; }
    out.push({ evaluation_id: a.evaluation_id, conversation_id: a.conversation.id, conversation_code: a.conversation.conversation_id, group_id: a.conversation.group_id,
      channel: a.conversation.channel, language: a.conversation.language, criterion_key: a.criterion_key, criterion_title: a.criterion.title,
      reason: 'appeal', reasons: ['appeal'], severity: 80, message: msg, messages: [msg], issues: a.criterion.issues || [], confidence: a.criterion.confidence,
      ai_answer: a.criterion.ai_answer, final_answer: a.criterion.final_answer, appeal_id: a.id });
  }
  for (const it of out) it.severity = SEV[it.reason];
  return out.sort((x, y) => y.severity - x.severity || x.conversation_code.localeCompare(y.conversation_code));
}

// ---------- Новый диалог ----------
function rowOf(c) {
  return { id: c.id, conversation_id: c.conversation_id, group_id: c.group_id, channel: c.channel, language: c.language, source: 'manual', latest: null };
}
const LANG = { ru: 'RU', kz: 'KZ', kk: 'KZ', en: 'EN' };
function guessLanguage(msgs) {
  const t = msgs.filter((m) => m.speaker === 'client').map((m) => m.text).join(' ') || msgs.map((m) => m.text).join(' ');
  if (/[әғқңөұүһі]/i.test(t)) return 'KZ';
  return (t.match(/[a-z]/gi) || []).length > (t.match(/[а-яё]/gi) || []).length ? 'EN' : 'RU';
}

export async function createConversation(body) {
  const tr = body.transcript;
  const parsed = Array.isArray(tr) ? parseTranscript(JSON.stringify(tr)) : parseTranscript(String(tr ?? ''));
  if (!String(Array.isArray(tr) ? 'x' : tr ?? '').trim()) throw invalid('transcript', 'транскрипт — массив реплик или текст «роль: текст»');
  if (parsed.errors.length) {
    const errors = parsed.errors.map((e) => ({ path: e.index != null ? `transcript.${e.index}` : 'transcript', message: e.message }));
    throw new ApiError(`Данные не прошли проверку: ${errors[0].message} (422)`, 422, { detail: 'диалог не прошёл проверку', errors });
  }
  const meta = { ...parsed.meta, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v != null && v !== '')) };
  const group = String(meta.group_id || '').trim() || 'MANUAL';
  const taken = new Set((await conversations({ group_id: group })).map((r) => r.conversation_id));
  let cid = String(meta.conversation_id || '').trim();
  if (cid && taken.has(cid)) throw conflict(`в группе ${group} уже есть диалог ${cid}`);
  if (!cid) { let n = 1; while (taken.has(`manual-${String(n).padStart(3, '0')}`)) n++; cid = `manual-${String(n).padStart(3, '0')}`; }
  const warnings = [...parsed.warnings];
  let language = LANG[String(meta.language || '').toLowerCase()] || String(meta.language || '').toUpperCase();
  if (!language) { language = guessLanguage(parsed.messages); warnings.push(`язык не указан, определён по репликам клиента: ${language}`); }
  const ch = String(meta.channel || '').toLowerCase();
  const channel = ['voice call', 'call', 'звонок', 'voice'].includes(ch) ? 'voice call' : 'agent chat';
  const t0 = clockSec(parsed.messages.find((m) => m.timestamp)?.timestamp);
  const messages = parsed.messages.map((m, i) => {
    const s = clockSec(m.timestamp);
    return { msg_id: `m${i}`, idx: i, speaker: m.speaker, text: m.text, timestamp: m.timestamp, t_sec: s == null || t0 == null ? null : s - t0,
      audio_offset_sec: null, internal: false, event: null };
  });
  const c = { id: ++st.seq, conversation_id: cid, group_id: group, channel, language, source: 'manual', has_audio: false, audio_url: null,
    audio_offset_fix_sec: 0, imported_at: now(), messages, segments: [], events: [], warnings, evaluations: [], latest: null };
  st.manual.push(c);
  return clone(c);
}

// ---------- Экспорт ----------
const num = (v) => (v == null ? '' : String(v).replace('.', ','));
export async function exportFile(path, params = {}) {
  const group = params.group_id || 'DEV';
  const list = await conversations({ group_id: group });
  const evs = await Promise.all(list.map((r) => (r.latest ? evaluation(r.latest.evaluation_id) : null)));
  if (path === '/export/results') {
    const results = list.map((r, i) => (evs[i]
      ? { conversation_id: r.conversation_id, status: 'ok', criteria: evs[i].criteria.map((c) => ({ criterion_id: c.key, value: c.ai_answer === 'na' ? null : c.ai_answer, rationale: c.reasoning, evidence_turns: (c.evidence || []).map((e) => Number(e.msg_id.slice(1)) + 1) })),
        score: { final_score: evs[i].ai_score.total, critical_flag: !!evs[i].ai_score.critical?.length } }
      : { conversation_id: r.conversation_id, status: 'error', criteria: [], score: null, error: 'нет оценки' }));
    const doc = { schema_version: '1.0', team_name: 'демо', model: { mode: 'external_api', name: 'demo/fixture-model' }, results };
    return { blob: new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }), filename: `results-${group}.json`, validationErrors: 0 };
  }
  const recs = list.map((r, i) => {
    const ev = evs[i];
    const rec = { conversation_id: r.conversation_id, channel: r.channel, language: r.language, model: ev?.model ?? null, status: ev?.status ?? 'not_evaluated' };
    for (const c of ev?.criteria || []) { rec[`c${c.key}_answer`] = c.final_answer; rec[`c${c.key}_points`] = c.final_points; }
    return Object.assign(rec, { ai_total: ev?.ai_score.total ?? null, final_total: ev?.final_score.total ?? null, critical: !!r.latest?.critical,
      overridden: (ev?.criteria || []).filter((c) => c.overridden).map((c) => c.key).join(','), open_appeals: r.latest?.open_appeals ?? 0, evaluation_id: ev?.id ?? null });
  });
  if (params.format === 'json') return { blob: new Blob([JSON.stringify(recs, null, 2)], { type: 'application/json' }), filename: `cqa-${group}-demo.json`, validationErrors: null };
  const cols = [...new Set(recs.flatMap((r) => Object.keys(r)))];
  const cell = (v) => (typeof v === 'number' ? num(v) : typeof v === 'boolean' ? (v ? 'yes' : 'no') : v == null ? '' : /[;"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = '﻿' + [cols.join(';'), ...recs.map((r) => cols.map((k) => cell(r[k])).join(';'))].join('\r\n') + '\r\n';
  return { blob: new Blob([csv], { type: 'text/csv;charset=utf-8' }), filename: `cqa-${group}-demo.csv`, validationErrors: null };
}
