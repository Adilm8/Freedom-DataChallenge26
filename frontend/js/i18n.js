// Язык интерфейса: RU (по умолчанию), EN, KZ. Компоненты пишут строки по-русски, а этот модуль
// переводит готовый DOM по словарю i18n-dict.js: текстовые узлы и атрибуты title / placeholder /
// aria-label / alt / data-tip. Для RU модуль ничего не делает и словарь не загружает.
// Переводится только интерфейс: реплики диалогов, цитаты и обоснования модели остаются как есть —
// узел переводится, только если его текст целиком совпал со строкой интерфейса или её шаблоном.
// Выбор: ?lang=en|kk|ru в адресе (для веб-ресурсов Dynamics 365) или переключатель в меню (localStorage).

export const LANGS = [['ru', 'RU', 'Русский'], ['en', 'EN', 'English'], ['kk', 'KZ', 'Қазақша']];
const KEY = 'cqa.lang';
const IDX = { en: 0, kk: 1 };
const ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'data-tip'];
const SKIP = 'script,style,textarea,pre,code,[data-i18n-skip],[contenteditable="true"]';
const CYR = /[А-Яа-яЁё]/;

function readLang() {
  const q = new URLSearchParams(location.search).get('lang');
  let v = q;
  if (!v) { try { v = localStorage.getItem(KEY); } catch { /* недоступно */ } }
  return LANGS.some(([id]) => id === v) ? v : 'ru';
}
const lang = readLang();
export const getLang = () => lang;

/** Сменить язык: запоминаем и перезагружаем страницу (экраны перерисуются уже на новом языке). */
export function setLang(next) {
  try { localStorage.setItem(KEY, next); } catch { /* недоступно */ }
  const url = new URL(location.href);
  if (url.searchParams.has('lang')) { url.searchParams.set('lang', next); location.replace(url.toString()); } else location.reload();
}

let exact = null; // Map: русская строка → перевод
let nums = null; // Map: строка с {n} вместо единственного числа → перевод
let templates = []; // [{ re, out, slots, anchor }]
const cache = new Map();
const NUM = /\d+(?:[.,]\d+)?/g;

function build(dict) {
  exact = new Map(); nums = new Map();
  const i = IDX[lang];
  for (const [ru, tr] of Object.entries(dict)) {
    const out = tr[i];
    if (!out) continue;
    if (ru.includes('{n}')) nums.set(ru, out);
    else if (/\{\d+\}/.test(ru)) {
      const parts = ru.split(/\{(\d+)\}/); // чётные — текст, нечётные — номера подстановок
      const statics = parts.filter((_, k) => !(k % 2));
      const slots = parts.filter((_, k) => k % 2).map(Number);
      const anchor = statics.reduce((x, y) => (y.length > x.length ? y : x), '');
      if (!CYR.test(anchor)) continue; // шаблон без русского текста слишком общий
      templates.push({ statics, slots, out, anchor, weight: statics.join('').length });
    } else exact.set(ru, out);
  }
  templates.sort((x, y) => y.weight - x.weight); // сначала более конкретные
}

/** Перевод строки целиком или null. Подстановки шаблона тоже должны переводиться (или не содержать
 *  русского текста) — иначе это не строка интерфейса, а содержимое, и оно остаётся как есть. */
const memo = new Map();
function tr(s, depth = 0) {
  if (!CYR.test(s)) return s;
  if (memo.has(s)) return memo.get(s);
  const r = trCore(s, depth);
  if (r != null || depth === 0) memo.set(s, r); // «нет» на глубине мог дать предел рекурсии, его не запоминаем
  return r;
}
function trCore(s, depth) {
  let hit = exact.get(s);
  if (hit !== undefined) return hit;
  // «частично» при ключе «Частично» и наоборот: регистр первой буквы переносим в перевод.
  const flip = s[0] === s[0].toLowerCase() ? s[0].toUpperCase() + s.slice(1) : s[0].toLowerCase() + s.slice(1);
  hit = exact.get(flip);
  if (hit !== undefined && hit) return (s[0] === s[0].toLowerCase() ? hit[0].toLowerCase() : hit[0].toUpperCase()) + hit.slice(1);
  const found = s.match(NUM);
  if (found && found.length === 1) {
    const t = nums.get(s.replace(NUM, '{n}'));
    if (t) return t.replace('{n}', found[0]);
  }
  if (depth > 6) return null;
  for (const t of templates) {
    if (!s.includes(t.anchor) || !s.startsWith(t.statics[0]) || !s.endsWith(t.statics[t.statics.length - 1])) continue;
    const vals = fill(s, t, depth + 1);
    if (vals) return t.out.replace(/\{(\d+)\}/g, (_, n) => vals[n] ?? '');
  }
  return compose(s, depth);
}

/** Подбор подстановок шаблона с возвратом: каждая подстановка должна перевестись. */
function fill(s, t, d) {
  const { statics, slots } = t;
  const vals = [];
  const conv = (v) => {
    const core = v.trim();
    if (!core) return v;
    const x = tr(core, d);
    return x == null ? null : v.slice(0, v.indexOf(core)) + x + v.slice(v.indexOf(core) + core.length);
  };
  const go = (pos, k) => {
    if (k === slots.length) return pos === s.length;
    const next = statics[k + 1];
    const last = k + 1 === slots.length;
    if (next === '' && !last) { // две подстановки подряд: первая — значение без пробелов и русских букв
      const m = s.slice(pos).match(/^[^\s\u0400-\u04FF]*/)[0];
      for (let len = m.length; len >= 0; len--) { vals[slots[k]] = m.slice(0, len); if (go(pos + len, k + 1)) return true; }
      if (s.length > 120) return false;
      for (let j = pos + m.length + 1; j < s.length; j++) { // значение с русским текстом — перебор границы
        const x = conv(s.slice(pos, j));
        if (x == null) continue;
        vals[slots[k]] = x;
        if (go(j, k + 1)) return true;
      }
      return false;
    }
    const ends = [];
    if (last) { if (s.length - next.length >= pos) ends.push(s.length - next.length); }
    else for (let j = s.indexOf(next, pos); j !== -1; j = s.indexOf(next, j + 1)) ends.push(j);
    for (const j of ends) {
      const x = conv(s.slice(pos, j));
      if (x == null) continue;
      vals[slots[k]] = x;
      if (go(j + next.length, k + 1)) return true;
    }
    return false;
  };
  return go(statics[0].length, 0) ? vals : null;
}

// Строки, склеенные из нескольких строк интерфейса: «01 · выполнен», «решён:», «04 Завершение — 56%»,
// «· «Чек-лист качества чатов» v1». Каждая часть обязана перевестись, иначе строка остаётся как есть.
const QUOTE = lang === 'en' ? ['“', '”'] : ['«', '»'];
const SEPS = [' · ', '; ', ' — ', '. ', ', ', ': '];
function compose(s, depth) {
  if (s.length > 240) return null; // длинный текст — это содержимое, а не подпись интерфейса
  const d = depth + 1;
  const end = s.match(/^(.+?)([:.]|\s→|\s↓)$/); // хвостовая пунктуация
  if (end) { const x = tr(end[1], d); if (x != null) return x + end[2]; }
  const pre = s.match(/^([^\s\u0400-\u04FF]+\s+)(.+)$/s); // «04 …», «· …», «+ …»
  if (pre) { const x = tr(pre[2], d); if (x != null) return pre[1] + x; }
  const post = s.match(/^(.+?)(\s+[^\s\u0400-\u04FF]+)$/s); // «… v1», «… 56%»
  if (post) { const x = tr(post[1], d); if (x != null) return x + post[2]; }
  if (s.includes('«')) {
    let ok = true;
    const q = s.replace(/«([^«»]+)»/g, (m, inner) => { const x = tr(inner, d); if (x == null) { ok = false; return m; } return QUOTE[0] + x + QUOTE[1]; });
    if (ok && q !== s) {
      // Остаток без кавычек тоже должен быть строкой интерфейса (или без русского текста).
      const rest = s.replace(/«[^«»]+»/g, '\uE000');
      const x = rest === '\uE000' ? '\uE000' : tr(rest, d);
      if (x != null) { const vals = [...q.matchAll(new RegExp(QUOTE[0] + '[^' + QUOTE[1] + ']*' + QUOTE[1], 'g'))].map((m) => m[0]); let i = 0; return x.replace(/\uE000/g, () => vals[i++] ?? ''); }
    }
  }
  for (const sep of SEPS) {
    if (!s.includes(sep)) continue;
    const parts = [];
    for (const p of s.split(sep)) { const x = p ? tr(p, d) : p; if (x == null) break; parts.push(x); }
    if (parts.length === s.split(sep).length) return parts.join(sep);
  }
  return null;
}

export function t(s) {
  if (lang === 'ru' || !exact || s == null) return s;
  const str = String(s);
  const key = str.trim();
  if (!key) return str;
  let r = cache.get(key);
  if (r === undefined) { r = tr(key); cache.set(key, r); }
  return r == null ? str : str.replace(key, () => r);
}

const done = new WeakMap(); // узел → текст, который мы туда записали (чтобы не переводить повторно)
function translateText(n) {
  const v = n.nodeValue;
  if (!v || !CYR.test(v) || done.get(n) === v) return;
  const p = n.parentElement;
  if (p && p.closest(SKIP)) return;
  const out = t(v);
  done.set(n, out);
  if (out !== v) n.nodeValue = out;
}
function translateAttrs(el) {
  if (el.closest?.(SKIP)) return;
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (v && CYR.test(v)) { const out = t(v); if (out !== v) el.setAttribute(a, out); }
  }
}
function translateTree(root) {
  if (root.nodeType === 3) { translateText(root); return; }
  if (root.nodeType !== 1 && root.nodeType !== 11) return;
  if (root.nodeType === 1) translateAttrs(root);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = w.nextNode(); n; n = w.nextNode()) n.nodeType === 3 ? translateText(n) : translateAttrs(n);
}

async function start() {
  const root = document.documentElement;
  root.lang = lang === 'kk' ? 'kk' : lang;
  if (lang === 'ru') return;
  // Пока грузится словарь, страницу не показываем (без мигания русского), но не дольше 1,5 с.
  root.style.visibility = 'hidden';
  const reveal = () => { root.style.visibility = ''; };
  const timer = setTimeout(reveal, 1500);
  try {
    build((await import('./i18n-dict.js')).default);
    const run = () => {
      translateTree(document.body);
      new MutationObserver((list) => {
        for (const m of list) {
          if (m.type === 'characterData') translateText(m.target);
          else if (m.type === 'attributes') translateAttrs(m.target);
          else m.addedNodes.forEach(translateTree);
        }
      }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
      if (CYR.test(document.title)) document.title = t(document.title);
    };
    if (document.body) run(); else document.addEventListener('DOMContentLoaded', run, { once: true });
  } catch (e) { console.warn('i18n: словарь не загружен, интерфейс остаётся по-русски', e); }
  clearTimeout(timer); reveal();
}
start();
