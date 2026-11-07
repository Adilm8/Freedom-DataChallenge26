// Плеер записи звонка (FR-CARD-04): <audio> и своя панель — воспроизведение, шкала с удержаниями, консультациями,
// паузами записи и метками доказательств, скорость, ручная поправка смещения (localStorage по диалогу).
// Над шкалой — волна записи по дорожкам говорящих (waveform.js): клик и протяжка по ней перематывают, рамка — звучащая реплика.
// Параметры: conversation (ConversationDetail) или id; evidence [{key, title, flag, msg_ids}] — метки на шкале.
// Внутрь (события на el): cqa:seek {msg_id, play} | {sec, play} — перейти к реплике или к секунде записи.
// Наружу (с корня, всплывают): cqa:audio-time {msg_id, t, playing, follow} — сменилась звучащая реплика;
//   cqa:audio-fix {fix} — изменилась поправка; клик по метке доказательства — cqa:evidence-click и cqa:criterion-click.
// Секунда реплики в записи = audio_offset_sec (бэкенд уже учёл начало записи и паузы) + поправка.
import { h, clear, emit, ROLE, skeletonRows, errorState } from '../ui.js';
import { getConversation, audioSource, probeAudio } from '../api.js';
import { createWave, loadPeaks } from './waveform.js';

const RATES = [1, 1.25, 1.5, 2];
const SEG_LABEL = { hold: 'Удержание', consult: 'Консультация с коллегой', recording_paused: 'Пауза записи' };
const FIX_LIMIT = 3600;
const SKIP = 3; // кнопки «−3 / +3»: время в расшифровке звонка бывает неточным на пару секунд
const SPEAKERS = new Set(['client', 'operator', 'bot']);
const OWN_MAX = 90; // дольше реплика на волне не тянется: дальше, скорее всего, удержание или тишина
const OWN_TAIL = 6;

function readStore(k) { try { return localStorage.getItem(k); } catch { return null; } }
function writeStore(k, v) { try { localStorage.setItem(k, String(v)); } catch { /* хранилище недоступно */ } }

/** Секунды → m:ss или h:mm:ss. */
export function fmtClock(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—:—';
  const s = Math.max(0, Math.floor(sec + 1e-6));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return `${hh ? `${hh}:${String(mm).padStart(2, '0')}` : mm}:${String(ss).padStart(2, '0')}`;
}
const fmtFix = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} с`;
const fixKey = (c) => `cqa.audioFix.${c.group_id || '-'}:${c.conversation_id || c.id}`;
const hasAudio = (c) => (c.has_audio ?? !!c.audio_url) === true;

const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/></svg>',
};
function icon(name) {
  const t = document.createElement('template');
  t.innerHTML = ICON[name]; // статическая строка, без данных
  return t.content.firstChild;
}

export function mount(el, params = {}) {
  let p = { ...params };
  const root = h('div', { class: 'cqa-ap' });
  el.append(root);

  let conv = null, src = null, audio = null, token = 0;
  let fix = 0, rate = 1, follow = true;
  let state = 'loading'; // none | loading | ready | error
  let raf = 0, pending = null, dragT = null, curId = undefined, selected = null;
  let timeline = [], owners = [], byId = new Map(), byIdx = new Map();
  let wave = null;
  let ui = {};
  let pulseTimer = null;
  let seen = null, inView = true, touched = false; // мини-панель, когда плеер ушёл из поля зрения (телефон)

  // ---------- данные ----------
  function index() {
    const msgs = conv.messages || [];
    byId = new Map(msgs.map((m) => [m.msg_id, m]));
    byIdx = new Map(msgs.map((m, i) => [m.idx ?? i, m]));
    timeline = msgs.filter((m) => m.audio_offset_sec != null)
      .map((m, i) => ({ id: m.msg_id, off: m.audio_offset_sec, i, sp: m.speaker }))
      .sort((a, b) => a.off - b.off || a.i - b.i);
    owners = timeline.filter((x) => SPEAKERS.has(x.sp));
  }
  // Кто говорит в секунду t: реплика длится до начала следующей (не дольше OWN_MAX).
  function ownerAt(t) {
    let k = -1;
    for (let i = 0; i < owners.length; i++) { if (owners[i].off + fix <= t) k = i; else break; }
    if (k < 0) return null;
    const end = k + 1 < owners.length ? owners[k + 1].off + fix : owners[k].off + fix + OWN_TAIL;
    return t < Math.min(end, owners[k].off + fix + OWN_MAX) ? owners[k] : null;
  }
  // Рамка на волне: звучащая реплика, а до воспроизведения — выбранная (клик по реплике или доказательству).
  function regionOf() {
    const id = curId || selected;
    const m = id ? byId.get(id) : null;
    if (!m || m.audio_offset_sec == null || !touched) return null;
    const a = m.audio_offset_sec;
    const next = owners.find((x) => x.off > a);
    const b = next ? next.off : a + OWN_TAIL;
    return [a + fix, Math.min(b, a + OWN_MAX) + fix];
  }
  const lastOff = () => (timeline.length ? timeline[timeline.length - 1].off : 0);
  function dur() {
    const d = audio?.duration;
    return Number.isFinite(d) && d > 0 ? d : Math.max(5, lastOff() + Math.max(0, fix) + 3);
  }
  const clampT = (t) => Math.min(Math.max(0, t), dur());
  const pos = () => (dragT ?? pending ?? audio?.currentTime ?? 0);
  function currentAt(t) {
    let id = null;
    for (const x of timeline) { if (x.off + fix <= t + 0.05) id = x.id; else break; }
    return id;
  }

  // ---------- отрисовка ----------
  function render() {
    clear(root);
    index();
    if (!hasAudio(conv)) {
      state = 'none';
      root.dataset.state = state;
      root.append(h('div', { class: 'cqa-ap__none' },
        h('span', { class: 'cqa-ap__noneicon', 'aria-hidden': 'true' }, icon('play')),
        h('div', null,
          h('div', { class: 'cqa-ap__title' }, 'Записи нет'),
          h('div', { class: 'cqa-faint cqa-ap__hint' }, 'В данных у звонка нет ссылки на аудио. Секунда каждой реплики в записи указана в транскрипте.'))));
      return;
    }
    const stored = parseFloat(readStore(fixKey(conv)));
    fix = Number.isFinite(stored) ? stored : Number(conv.audio_offset_fix_sec) || 0;
    const storedRate = parseFloat(readStore('cqa.audioRate'));
    rate = RATES.includes(storedRate) ? storedRate : 1;
    follow = readStore('cqa.audioFollow') !== '0';

    audio = h('audio', { preload: 'metadata', class: 'cqa-ap__audio' });
    for (const [ev, fn] of Object.entries(mediaHandlers)) audio.addEventListener(ev, fn);

    ui.play = h('button', { type: 'button', class: 'cqa-ap__play', 'aria-label': 'Воспроизвести', onclick: toggle }, icon('play'));
    const skip = (d) => h('button', { type: 'button', class: 'cqa-ap__skip', title: `${d < 0 ? 'Назад' : 'Вперёд'} на ${SKIP} с`,
      'aria-label': `${d < 0 ? 'Назад' : 'Вперёд'} на ${SKIP} секунды`, onclick: () => seekTo(pos() + d) }, `${d < 0 ? '−' : '+'}${SKIP}`);
    ui.skips = [skip(-SKIP), skip(SKIP)];
    ui.now = h('span', { class: 'cqa-ap__now' });
    ui.time = h('span', { class: 'cqa-ap__time' });
    ui.fixChip = h('button', { type: 'button', class: 'cqa-chip cqa-ap__fixchip cqa-tip', 'data-tip': 'Ручная поправка смещения: все реплики сдвинуты на это время. Нажмите, чтобы сбросить', onclick: () => setFix(0) });
    ui.segs = h('div', { class: 'cqa-ap__segs' });
    ui.fill = h('div', { class: 'cqa-ap__fill' });
    ui.thumb = h('div', { class: 'cqa-ap__thumb' });
    ui.marks = h('div', { class: 'cqa-ap__marks', 'aria-label': 'Метки доказательств' });
    ui.track = h('div', { class: 'cqa-ap__track', role: 'slider', tabindex: '0', 'aria-label': 'Позиция в записи', 'aria-valuemin': '0' },
      h('div', { class: 'cqa-ap__rail' }, ui.fill, ui.segs), ui.thumb);
    ui.rates = h('div', { class: 'cqa-seg cqa-ap__rates', role: 'group', 'aria-label': 'Скорость воспроизведения' },
      RATES.map((r) => h('button', { type: 'button', class: 'cqa-seg__btn', dataset: { rate: r }, 'aria-pressed': String(r === rate), onclick: () => setRate(r) },
        `${String(r).replace('.', ',')}×`)));
    ui.fixIn = h('input', { type: 'number', step: '0.1', class: 'cqa-input cqa-ap__fixin', 'aria-label': 'Поправка смещения, секунд', title: 'Поправка, с: плюс — реплики звучат позже, минус — раньше',
      onchange: (e) => setFix(parseFloat(String(e.target.value).replace(',', '.')) || 0) });
    const nudge = (d, label, tip) => h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm cqa-ap__nudge', title: tip, 'aria-label': tip, onclick: () => setFix(fix + d) }, label);
    ui.reset = h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm cqa-btn--ghost', title: 'Сбросить поправку', 'aria-label': 'Сбросить поправку', onclick: () => setFix(0) }, '↺');
    ui.anchor = h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm cqa-ap__anchor cqa-tip', onclick: anchorHere,
      'data-tip': 'Поставьте запись на паузу там, где на самом деле начинается выбранная реплика, и нажмите: поправка подстроится под все реплики' });
    ui.follow = h('label', { class: 'cqa-toggle cqa-ap__follow', title: 'Во время воспроизведения прокручивать транскрипт к звучащей реплике' },
      h('input', { type: 'checkbox', checked: follow, onchange: (e) => { follow = e.target.checked; writeStore('cqa.audioFollow', follow ? '1' : '0'); } }), 'Следить за текстом');
    ui.legend = h('div', { class: 'cqa-ap__legend' });
    ui.errText = h('div', { class: 'cqa-ap__errtext' });
    ui.err = h('div', { class: 'cqa-ap__err', role: 'alert', hidden: true },
      h('span', { class: 'cqa-banner__icon' }, '!'),
      h('div', { class: 'cqa-ap__errbody' },
        h('div', { class: 'cqa-banner__title' }, 'Запись не загрузилась'),
        ui.errText,
        h('div', { class: 'cqa-ap__hint' }, 'Секунда каждой реплики в записи указана в транскрипте (▶ 0:40) — по ней можно найти место вручную.'),
        h('div', { class: 'cqa-ap__erract' },
          h('button', { type: 'button', class: 'cqa-btn cqa-btn--sm', onclick: retry }, 'Повторить'),
          ui.open = h('a', { class: 'cqa-btn cqa-btn--sm', target: '_blank', rel: 'noopener', hidden: true }, 'Открыть запись ↗'))));

    ui.miniPlay = h('button', { type: 'button', class: 'cqa-ap__miniplay', 'aria-label': 'Воспроизвести', onclick: toggle }, icon('play'));
    ui.miniText = h('span', { class: 'cqa-ap__miniinfo' });
    ui.mini = h('div', { class: 'cqa-ap__mini', hidden: true, role: 'region', 'aria-label': 'Запись звонка' },
      ui.miniPlay,
      h('button', { type: 'button', class: 'cqa-ap__minigo', title: 'К плееру', onclick: () => ui.main.scrollIntoView({ behavior: 'smooth', block: 'center' }) }, ui.miniText));
    ui.hover = h('div', { class: 'cqa-ap__hover', hidden: true });
    ui.waveBox = h('div', { class: 'cqa-ap__wave', title: 'Волна записи: нажмите или протяните, чтобы перемотать' }, ui.hover);
    ui.main = h('div', { class: 'cqa-ap__main' },
        h('div', { class: 'cqa-ap__ctrl' }, ui.skips[0], ui.play, ui.skips[1]),
        h('div', { class: 'cqa-ap__mid' },
          h('div', { class: 'cqa-ap__top' },
            h('span', { class: 'cqa-ap__title' }, 'Запись звонка'), ui.now, ui.fixChip, ui.time),
          h('div', { class: 'cqa-ap__scale' }, ui.marks, ui.track)),
        ui.rates);
    root.append(audio, ui.main, ui.waveBox,
      h('div', { class: 'cqa-ap__sub' },
        ui.legend,
        // Ручная поправка смещения нужна редко — под раскрывашкой (сдвиг виден чипом рядом со временем).
        h('details', { class: 'cqa-ap__fixbox' },
          h('summary', { class: 'cqa-ap__fixsum', title: 'Если реплики звучат раньше или позже, чем показано в транскрипте' }, 'Поправка смещения'),
          h('div', { class: 'cqa-ap__fix', role: 'group', 'aria-label': 'Поправка смещения записи' },
            nudge(-5, '−5', 'Реплики раньше на 5 с'), nudge(-0.5, '−0,5', 'Реплики раньше на 0,5 с'),
            ui.fixIn, h('span', { class: 'cqa-faint' }, 'с'),
            nudge(0.5, '+0,5', 'Реплики позже на 0,5 с'), nudge(5, '+5', 'Реплики позже на 5 с'),
            ui.reset, ui.anchor)),
        ui.follow),
      ui.err, ui.mini);

    if ('IntersectionObserver' in window) {
      seen = new IntersectionObserver(([e]) => { inView = e.isIntersecting; syncMini(); });
      seen.observe(ui.main);
    }
    wave = createWave(ui.waveBox, { dur, pos, speakerAt: (t) => ownerAt(t)?.sp || null, region: regionOf });
    wave.setLanes(new Set(owners.map((x) => x.sp)));
    bindTrack();
    bindWave();
    setState('loading');
    setFix(fix, { persist: false, reseek: false });
    syncRate();
    attachSource();
  }

  async function attachSource() {
    const my = token;
    try {
      const s = await audioSource(conv);
      if (my !== token) { s?.revoke(); return; }
      src = s;
      if (!src) { fail('у звонка нет адреса записи'); return; }
      if (!src.mock) { ui.open.href = src.url; ui.open.hidden = false; }
      else ui.main.querySelector('.cqa-ap__title')?.after(h('span', { class: 'cqa-chip cqa-ap__demo cqa-tip',
        'data-tip': 'Демо-режим (?mock=1): вместо записи короткие сигналы в начале каждой реплики. Настоящие записи — без ?mock=1 в адресе' }, 'демо: сигналы вместо записи'));
      audio.src = src.url;
      loadPeaks(src.url).then((r) => { if (my === token) wave?.setPeaks(r.peaks); })
        .catch(() => { if (my === token && ui.waveBox) ui.waveBox.dataset.nopeaks = '1'; });
    } catch (e) {
      if (my === token) fail(e?.message || 'не удалось подготовить запись');
    }
  }

  function drawMarks() {
    if (!ui.segs) return;
    const d = dur();
    const at = (t) => `${Math.min(100, Math.max(0, (t / d) * 100))}%`;
    const offOf = (idx) => byIdx.get(idx)?.audio_offset_sec;
    const present = new Set();
    clear(ui.segs);
    for (const s of conv.segments || []) {
      const a = offOf(s.start_idx);
      if (a == null || !SEG_LABEL[s.type]) continue;
      present.add(s.type);
      if (s.type === 'recording_paused') {
        const cut = s.end_sec != null && s.start_sec != null ? s.end_sec - s.start_sec : null;
        ui.segs.append(h('span', { class: 'cqa-ap__pause', style: `left:${at(a + fix)}`,
          title: `Пауза записи${cut != null ? `: ${fmtClock(cut)} разговора не записано` : ''} — после этой точки запись продолжается с момента возобновления` }));
        continue;
      }
      const b = s.end_idx != null ? offOf(s.end_idx) : null;
      const end = b != null ? b + fix : d;
      const start = a + fix;
      ui.segs.append(h('span', { class: `cqa-ap__seg cqa-ap__seg--${s.type}`, style: `left:${at(start)};width:calc(${at(end)} - ${at(start)})`,
        title: `${SEG_LABEL[s.type]} ${fmtClock(start)}–${fmtClock(end)}: клиент не слышит разговор` }));
    }
    clear(ui.marks);
    const ev = new Map();
    for (const e of p.evidence || []) for (const id of e.msg_ids || []) {
      if (!byId.has(id) || byId.get(id).audio_offset_sec == null) continue;
      if (!ev.has(id)) ev.set(id, { keys: [], flag: false });
      const x = ev.get(id);
      if (!x.keys.includes(e.key)) x.keys.push(e.key);
      x.flag ||= !!e.flag;
    }
    for (const [id, x] of ev) {
      const t = byId.get(id).audio_offset_sec + fix;
      ui.marks.append(h('button', { type: 'button', class: `cqa-ap__ev ${x.flag ? 'cqa-ap__ev--flag' : ''}`, style: `left:${at(t)}`,
        title: `${id} · ${fmtClock(t)} — доказательство: ${x.keys.join(', ')}`, 'aria-label': `Доказательство ${x.keys.join(', ')}: реплика ${id}, ${fmtClock(t)}`,
        onclick: () => {
          seekMsg(id, { play: false });
          emit(root, 'cqa:evidence-click', { msg_id: id, key: x.keys[0] });
          emit(root, 'cqa:criterion-click', { key: x.keys[0], msg_id: id });
        } }));
    }
    if (ev.size) present.add('evidence');
    const L = { hold: ['hold', 'удержание'], consult: ['consult', 'консультация'], recording_paused: ['pause', 'пауза записи'], evidence: ['ev', 'доказательство'] };
    clear(ui.legend).append(...['hold', 'consult', 'recording_paused', 'evidence'].filter((k) => present.has(k))
      .map((k) => h('span', { class: 'cqa-ap__lg' }, h('i', { class: `cqa-ap__sw cqa-ap__sw--${L[k][0]}` }), L[k][1])));
    ui.legend.hidden = !present.size;
    wave?.draw();
  }

  function showNow() {
    if (!ui.now) return;
    if (state === 'error') { ui.now.textContent = ''; return; }
    if (state === 'loading' && pending == null && !curId) { ui.now.textContent = 'загрузка записи…'; return; }
    const m = curId ? byId.get(curId) : null;
    ui.now.textContent = m ? `${ROLE[m.speaker] || m.speaker} · ${m.msg_id}${m.internal ? ' · внутренний разговор' : ''}` : 'до первой реплики';
  }

  function sync(force = false) {
    if (!ui.track) return;
    const d = dur(), t = pos();
    const pct = Math.min(100, Math.max(0, (t / d) * 100));
    ui.fill.style.width = `${pct}%`;
    ui.thumb.style.left = `${pct}%`;
    ui.time.textContent = `${fmtClock(t)} / ${fmtClock(d)}`;
    if (!ui.mini.hidden) ui.miniText.textContent = `${fmtClock(t)}${curId ? ` · ${curId}` : ''}`;
    ui.track.setAttribute('aria-valuemax', d.toFixed(1));
    ui.track.setAttribute('aria-valuenow', t.toFixed(1));
    ui.track.setAttribute('aria-valuetext', `${fmtClock(t)} из ${fmtClock(d)}`);
    const id = currentAt(t);
    if (id !== curId || force || !audio?.paused || dragT != null) wave?.draw();
    if (id !== curId || force) {
      curId = id;
      showNow();
      // До первого касания плеера транскрипт не подсвечиваем: позиция 0:00 — ещё не выбор пользователя.
      emit(root, 'cqa:audio-time', { msg_id: touched ? id : null, t, playing: !!audio && !audio.paused, follow });
    }
  }

  function setState(s) {
    state = s;
    root.dataset.state = s;
    if (ui.err) ui.err.hidden = s !== 'error';
    const off = s === 'error';
    if (ui.play) ui.play.disabled = off;
    ui.skips?.forEach((b) => { b.disabled = off; });
    ui.rates?.querySelectorAll('button').forEach((b) => { b.disabled = off; });
    if (ui.track) ui.track.setAttribute('aria-disabled', String(off));
    if (ui.anchor) ui.anchor.disabled = off || !selected || s !== 'ready';
    showNow();
    syncMini();
  }

  // ---------- управление ----------
  function toggle() {
    if (!audio || state === 'error') return;
    if (audio.paused) audio.play().catch(() => { /* ошибку покажет событие error */ });
    else audio.pause();
  }

  function seekTo(sec, { play = false } = {}) {
    if (!audio) return;
    if (state === 'error') { pulseError(); return; }
    const t = clampT(sec);
    const first = !touched;
    touched = true;
    if (audio.readyState >= 1) { audio.currentTime = t; pending = null; } else pending = t;
    sync(first);
    if (play && audio.paused) audio.play().catch(() => {});
  }

  function seekMsg(id, opts = {}) {
    const m = byId.get(id);
    if (!m) return;
    selected = id;
    syncAnchor();
    if (m.audio_offset_sec == null) { flashNow('Реплика прозвучала до начала записи'); return; }
    seekTo(m.audio_offset_sec + fix, opts);
  }

  function setRate(r) {
    rate = r;
    writeStore('cqa.audioRate', r);
    syncRate();
  }
  function syncRate() {
    if (audio) { audio.defaultPlaybackRate = rate; audio.playbackRate = rate; }
    ui.rates?.querySelectorAll('[data-rate]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.rate) === rate)));
  }

  function setFix(v, { persist = true, reseek = true } = {}) {
    const next = Math.round(Math.min(FIX_LIMIT, Math.max(-FIX_LIMIT, Number(v) || 0)) * 10) / 10;
    fix = Object.is(next, -0) ? 0 : next;
    ui.fixIn.value = fix.toFixed(1);
    ui.reset.disabled = fix === 0;
    ui.fixChip.hidden = fix === 0;
    ui.fixChip.textContent = `поправка ${fmtFix(fix)}`;
    if (persist) writeStore(fixKey(conv), fix);
    drawMarks();
    emit(root, 'cqa:audio-fix', { fix });
    // Подбор поправки: после сдвига снова слушаем выбранную реплику с нового места.
    if (reseek && selected && byId.get(selected)?.audio_offset_sec != null) seekMsg(selected);
    else sync(true);
  }

  function anchorHere() {
    const m = selected ? byId.get(selected) : null;
    if (!m || m.audio_offset_sec == null || state !== 'ready') return;
    setFix(audio.currentTime - m.audio_offset_sec, { reseek: false });
    flashNow(`Поправка ${fmtFix(fix)}: ${m.msg_id} начинается с ${fmtClock(audio.currentTime)}`);
  }
  function syncAnchor() {
    if (!ui.anchor) return;
    ui.anchor.textContent = selected ? `Начало ${selected} здесь` : 'Начало реплики здесь';
    ui.anchor.disabled = !selected || state !== 'ready';
  }

  function flashNow(text) {
    if (!ui.now) return;
    ui.now.textContent = text;
    ui.now.classList.add('cqa-ap__now--flash');
    clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => { ui.now?.classList.remove('cqa-ap__now--flash'); showNow(); }, 2600);
  }
  function pulseError() {
    ui.err.classList.remove('cqa-ap__err--pulse');
    void ui.err.offsetWidth;
    ui.err.classList.add('cqa-ap__err--pulse');
  }

  function fail(reason) {
    setState('error');
    cancelAnimationFrame(raf);
    ui.errText.textContent = reason;
  }
  async function onError() {
    if (!audio.getAttribute('src')) return; // src сброшен при размонтировании
    const my = token;
    const code = audio.error?.code;
    fail('проверяем причину…');
    let reason = code === 2 ? 'обрыв сети при загрузке' : code === 3 ? 'файл записи не читается браузером' : 'браузер не смог открыть файл записи';
    if (src && !src.mock) {
      const pr = await probeAudio(src.url);
      if (my !== token) return;
      if (!pr.ok) reason = pr.message;
      else if (code === 4) reason = 'формат записи не поддерживается этим браузером';
    }
    ui.errText.textContent = reason.charAt(0).toUpperCase() + reason.slice(1) + '.';
  }
  function retry() {
    if (!src) { attachSource(); return; }
    setState('loading');
    audio.src = src.url;
    audio.load();
  }

  const mediaHandlers = {
    loadedmetadata: () => {
      setState('ready');
      syncRate();
      if (pending != null) { audio.currentTime = clampT(pending); pending = null; }
      syncAnchor();
      drawMarks();
      sync(true);
    },
    durationchange: () => { drawMarks(); sync(); },
    play: () => {
      touched = true;
      for (const b of [ui.play, ui.miniPlay]) { b.replaceChildren(icon('pause')); b.setAttribute('aria-label', 'Пауза'); }
      syncMini();
      root.classList.add('cqa-ap--playing');
      cancelAnimationFrame(raf);
      const loop = () => { sync(); raf = requestAnimationFrame(loop); };
      raf = requestAnimationFrame(loop);
      sync(true); // транскрипт сразу прокрутится к звучащей реплике
    },
    pause: () => stopLoop(),
    ended: () => stopLoop(),
    timeupdate: () => { if (audio.paused) sync(); },
    seeked: () => sync(),
    waiting: () => root.classList.add('cqa-ap--buffering'),
    playing: () => root.classList.remove('cqa-ap--buffering'),
    error: () => onError(),
  };
  function stopLoop() {
    cancelAnimationFrame(raf);
    for (const b of [ui.play, ui.miniPlay]) { b.replaceChildren(icon('play')); b.setAttribute('aria-label', 'Воспроизвести'); }
    root.classList.remove('cqa-ap--playing', 'cqa-ap--buffering');
    sync(true);
  }

  function syncMini() {
    if (!ui.mini) return;
    ui.mini.hidden = inView || !touched || state === 'error';
    if (!ui.mini.hidden) ui.miniText.textContent = `${fmtClock(pos())}${curId ? ` · ${curId}` : ''}`;
  }

  function bindTrack() {
    const tAt = (e) => {
      const r = ui.track.getBoundingClientRect();
      return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * dur();
    };
    ui.track.addEventListener('pointerdown', (e) => {
      if (state === 'error' || e.button > 0) return;
      ui.track.setPointerCapture?.(e.pointerId);
      dragT = tAt(e);
      root.classList.add('cqa-ap--drag');
      sync();
    });
    ui.track.addEventListener('pointermove', (e) => { if (dragT != null) { dragT = tAt(e); sync(); } });
    const end = () => {
      if (dragT == null) return;
      const t = dragT;
      dragT = null;
      root.classList.remove('cqa-ap--drag');
      seekTo(t);
    };
    ui.track.addEventListener('pointerup', end);
    ui.track.addEventListener('pointercancel', end);
    ui.track.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 1 : 5;
      const k = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }[e.key];
      if (k != null) { e.preventDefault(); seekTo(pos() + k); } else if (e.key === 'Home') { e.preventDefault(); seekTo(0); } else if (e.key === 'End') { e.preventDefault(); seekTo(dur()); } else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); }
    });
  }

  // Волна: нажать — перемотать, протянуть — скраб; при наведении — секунда и кто говорит.
  function bindWave() {
    const box = ui.waveBox;
    const hover = (e) => {
      const t = wave.timeAt(e.clientX);
      const o = ownerAt(t);
      const r = box.getBoundingClientRect();
      ui.hover.hidden = false;
      ui.hover.style.left = `${Math.min(r.width - 4, Math.max(4, e.clientX - r.left))}px`;
      ui.hover.textContent = `${fmtClock(t)}${o ? ` · ${ROLE[o.sp] || o.sp}` : ''}`;
    };
    box.addEventListener('pointerdown', (e) => {
      if (state === 'error' || e.button > 0) return;
      box.setPointerCapture?.(e.pointerId);
      dragT = wave.timeAt(e.clientX);
      root.classList.add('cqa-ap--drag');
      sync();
    });
    box.addEventListener('pointermove', (e) => {
      hover(e);
      if (dragT != null) { dragT = wave.timeAt(e.clientX); sync(); }
    });
    box.addEventListener('pointerleave', () => { if (dragT == null) ui.hover.hidden = true; });
    const end = () => {
      if (dragT == null) return;
      const t = dragT;
      dragT = null;
      root.classList.remove('cqa-ap--drag');
      selected = ownerAt(t)?.id || selected;
      syncAnchor();
      seekTo(t);
    };
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
  }

  // ---------- жизненный цикл ----------
  function teardown() {
    token++;
    seen?.disconnect();
    seen = null; inView = true; touched = false;
    cancelAnimationFrame(raf);
    clearTimeout(pulseTimer);
    wave?.destroy();
    wave = null;
    if (audio) {
      for (const [ev, fn] of Object.entries(mediaHandlers)) audio.removeEventListener(ev, fn);
      audio.pause();
      audio.removeAttribute('src');
      try { audio.load(); } catch { /* уже снят */ }
    }
    src?.revoke();
    src = null; audio = null; ui = {}; pending = null; dragT = null; curId = undefined; selected = null;
  }

  async function start() {
    teardown();
    const my = token;
    if (p.conversation) { conv = p.conversation; render(); return; }
    if (p.id == null) { clear(root).append(errorState(new Error('Укажите параметр id диалога.'))); return; }
    clear(root).append(skeletonRows(2));
    try {
      const c = await getConversation(p.id);
      if (my !== token) return;
      conv = c;
      render();
    } catch (e) {
      if (my === token) clear(root).append(errorState(e, start));
    }
  }

  const onSeek = (e) => {
    const d = e.detail || {};
    if (d.msg_id) seekMsg(d.msg_id, { play: !!d.play });
    else if (Number.isFinite(d.sec)) seekTo(d.sec, { play: !!d.play });
  };
  el.addEventListener('cqa:seek', onSeek);
  start();

  return {
    update(np) {
      const reload = (np.conversation && np.conversation !== p.conversation) || (np.id != null && np.id !== p.id);
      p = { ...p, ...np };
      if (reload) start(); else drawMarks();
    },
    seekMsg: (id, opts) => seekMsg(id, opts),
    unmount() { el.removeEventListener('cqa:seek', onSeek); teardown(); root.remove(); },
  };
}
