// Синтетическая запись звонка для ?mock=1: WAV в памяти — тишина и короткий тон в начале каждой реплики.
// Ничего не скачивается и не лежит в репозитории; перемотку и поправку смещения можно проверить без сети и на слух
// (оператор — тон выше, клиент — ниже).
const PITCH = { operator: 660, client: 440, bot: 520, system: 880 };

function ascii(view, at, s) { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); }

/** messages: [{audio_offset_sec, speaker}] → Blob audio/wav (8 кГц, 8 бит, моно). */
export function makeMockWav(messages, { rate = 8000, tail = 4 } = {}) {
  const offs = messages.map((m) => m.audio_offset_sec).filter((v) => v != null);
  const dur = Math.max(5, (offs.length ? Math.max(...offs) : 0) + tail);
  const n = Math.ceil(dur * rate);
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  ascii(v, 0, 'RIFF'); v.setUint32(4, 36 + n, true); ascii(v, 8, 'WAVE');
  ascii(v, 12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  ascii(v, 36, 'data'); v.setUint32(40, n, true);
  const pcm = new Uint8Array(buf, 44);
  pcm.fill(128);
  const len = Math.floor(0.2 * rate);
  for (const m of messages) {
    if (m.audio_offset_sec == null) continue;
    const f = PITCH[m.speaker] || 600;
    const s0 = Math.floor(m.audio_offset_sec * rate);
    for (let i = 0; i < len && s0 + i < n; i++) {
      pcm[s0 + i] = 128 + Math.round(36 * Math.sin((Math.PI * i) / len) * Math.sin((2 * Math.PI * f * i) / rate));
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}
