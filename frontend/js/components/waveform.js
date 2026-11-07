// Волна записи звонка по дорожкам говорящих (клиент, оператор, бот) для плеера (audio-player.js).
// Амплитуда — из самой записи (Web Audio, декодирование в браузере), кто говорит — из транскрипта:
// отрезок от начала реплики до начала следующей. Пока запись не декодирована (или не загрузилась),
// дорожки показывают только, кто и когда говорит, — по транскрипту.

const LANES = [
  { role: 'client', label: 'Клиент' },
  { role: 'operator', label: 'Оператор' },
  { role: 'bot', label: 'Бот' },
];
const BUCKETS = 2400;
const peaksCache = new Map(); // url -> Promise<{peaks: Float32Array, duration}>

/** Пики записи: BUCKETS значений 0..1 на всю длину. Декодирование с частотой 8 кГц — меньше памяти. */
export function loadPeaks(url) {
  if (!peaksCache.has(url)) {
    const job = (async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`запись ${res.status}`);
      const buf = await res.arrayBuffer();
      const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!Ctx) throw new Error('Web Audio недоступен');
      const ctx = new Ctx(1, 2, 8000);
      const ab = await new Promise((ok, bad) => { const p = ctx.decodeAudioData(buf, ok, bad); p?.catch?.(bad); });
      const ch = ab.getChannelData(0);
      const peaks = new Float32Array(BUCKETS);
      const step = ch.length / BUCKETS;
      for (let b = 0; b < BUCKETS; b++) {
        const a = Math.floor(b * step), z = Math.min(ch.length, Math.floor((b + 1) * step));
        let sum = 0;
        for (let i = a; i < z; i++) sum += ch[i] * ch[i];
        peaks[b] = z > a ? Math.sqrt(sum / (z - a)) : 0; // RMS: громкость речи, а не щелчки
      }
      const sorted = Array.from(peaks).sort((x, y) => x - y);
      const top = sorted[Math.floor(sorted.length * 0.985)] || 1;
      for (let b = 0; b < BUCKETS; b++) peaks[b] = Math.min(1, peaks[b] / top);
      return { peaks, duration: ab.duration };
    })();
    job.catch(() => peaksCache.delete(url)); // ошибку можно повторить
    peaksCache.set(url, job);
  }
  return peaksCache.get(url);
}

/**
 * Рисовальщик волны. opts.speakerAt(t) -> role | null; opts.region() -> [a, b] | null — выделенная реплика;
 * opts.dur() и opts.pos() — длина и позиция записи, с.
 */
export function createWave(box, opts) {
  const canvas = document.createElement('canvas');
  canvas.className = 'cqa-ap__canvas';
  canvas.setAttribute('aria-hidden', 'true');
  const labels = document.createElement('div');
  labels.className = 'cqa-ap__lanes';
  box.append(canvas, labels);
  let peaks = null, lanes = [], w = 0, hgt = 0, ro = null;

  function setLanes(roles) {
    lanes = LANES.filter((l) => roles.has(l.role));
    if (!lanes.length) lanes = [LANES[1]];
    labels.replaceChildren(...lanes.map((l) => {
      const s = document.createElement('span');
      s.className = `cqa-ap__lane cqa-ap__lane--${l.role}`;
      s.textContent = l.label;
      return s;
    }));
    box.style.setProperty('--lanes', String(lanes.length));
    resize();
  }

  function resize() {
    const r = box.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    w = Math.max(1, Math.round(r.width));
    hgt = Math.max(1, Math.round(r.height));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${hgt}px`;
    canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function amp(t0, t1, d) {
    if (!peaks) return null;
    const a = Math.max(0, Math.floor((t0 / d) * BUCKETS)), z = Math.min(BUCKETS, Math.max(a + 1, Math.ceil((t1 / d) * BUCKETS)));
    let m = 0;
    for (let i = a; i < z; i++) if (peaks[i] > m) m = peaks[i];
    return m;
  }

  function draw() {
    const ctx = canvas.getContext('2d');
    if (!ctx || !w) return;
    const cs = getComputedStyle(box);
    const col = (n, f) => cs.getPropertyValue(n).trim() || f;
    ctx.clearRect(0, 0, w, hgt);
    const d = opts.dur(), pos = opts.pos();
    const laneH = hgt / lanes.length;
    // Выделенная (звучащая) реплика — рамка через все дорожки.
    const reg = opts.region();
    if (reg) {
      const x0 = (reg[0] / d) * w, x1 = Math.max(x0 + 2, (reg[1] / d) * w);
      ctx.fillStyle = col('--cqa-ap-region', 'rgba(224,160,48,.16)');
      ctx.fillRect(x0, 0, x1 - x0, hgt);
      ctx.fillStyle = col('--cqa-warn-line', '#e0a030');
      ctx.fillRect(x0, 0, 1, hgt);
      ctx.fillRect(x1 - 1, 0, 1, hgt);
    }
    const bar = 2, gap = 1, n = Math.floor(w / (bar + gap));
    const colors = lanes.map((l) => col(`--cqa-role-${l.role}`, '#03532e'));
    const muted = col('--cqa-border-strong', '#c8d0cb');
    for (let j = 0; j < n; j++) {
      const x = j * (bar + gap);
      const t0 = (x / w) * d, t1 = ((x + bar + gap) / w) * d, tm = (t0 + t1) / 2;
      const who = opts.speakerAt(tm);
      const a = amp(t0, t1, d);
      const played = tm <= pos;
      lanes.forEach((l, k) => {
        const mid = laneH * k + laneH / 2;
        const own = who === l.role;
        let hh;
        if (own) hh = a == null ? laneH * 0.28 : Math.max(2, a * (laneH - 8));
        else hh = 1.5;
        ctx.globalAlpha = own ? (played ? 1 : 0.42) : 0.7;
        ctx.fillStyle = own ? colors[k] : muted;
        ctx.fillRect(x, mid - hh / 2, bar, hh);
      });
    }
    ctx.globalAlpha = 1;
    // Курсор воспроизведения.
    const px = Math.round((Math.min(d, Math.max(0, pos)) / d) * w);
    ctx.fillStyle = col('--cqa-accent', '#03532e');
    ctx.fillRect(px - 1, 0, 2, hgt);
  }

  if ('ResizeObserver' in window) { ro = new ResizeObserver(() => resize()); ro.observe(box); }

  return {
    setLanes,
    setPeaks(p) { peaks = p; draw(); },
    draw,
    /** Секунда записи по координате X события. */
    timeAt(clientX) {
      const r = box.getBoundingClientRect();
      return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * opts.dur();
    },
    destroy() { ro?.disconnect(); canvas.remove(); labels.remove(); },
  };
}
