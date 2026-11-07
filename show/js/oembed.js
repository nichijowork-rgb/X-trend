// URL で追加した（台本で入れた）「データに無い投稿」の本文・投稿者を X の oEmbed から補う。
// 取り出し・ジャンル推定は DOM 非依存（node:test から import される）。取得（fetch → だめなら JSONP）はブラウザのみ。
// oEmbed の html は使わず（innerHTML に入れない）、文字だけ取り出して textContent で表示する。

import { NIGHT_KEYWORDS } from './config.js';
import { normalizeForMatch, containsWord, prepareDictEntry, dictHits } from './logic.js';

export const OEMBED_GAP_MS = 500;

/** oEmbed の URL（投稿 id から） */
export function oembedUrl(id) {
  const target = `https://twitter.com/i/status/${encodeURIComponent(String(id))}`;
  return `https://publish.twitter.com/oembed?url=${encodeURIComponent(target)}&omit_script=true&dnt=true&lang=ja`;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
/** HTML の文字だけ（タグを外して文字参照を戻す。<br> は改行） */
export function htmlText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
      }
      return ENT[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/**
 * oEmbed の JSON → { author, handle, text, date }。読めなければ null。
 * text は blockquote の最初の <p> の中身、date は blockquote の最後のリンクの文字（「2026年11月7日」など）
 */
export function parseOembed(json) {
  if (!json || typeof json !== 'object' || typeof json.html !== 'string') return null;
  const html = json.html;
  const p = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html);
  const links = [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)];
  const last = links.length ? htmlText(links[links.length - 1][1]) : '';
  const handleM = /^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]{1,30})\/?$/i.exec(String(json.author_url || ''));
  const text = p ? htmlText(p[1]).replace(/\s*pic\.twitter\.com\/\S+$/i, '').slice(0, 600) : '';
  return {
    author: htmlText(json.author_name || '').slice(0, 80),
    handle: handleM ? handleM[1] : '',
    text,
    date: /\d{4}|\d+月|\d+日|20\d\d/.test(last) ? last.slice(0, 40) : '',
  };
}

/**
 * ジャンルの推定（話題辞書 → 夜職の言葉 → 保留する言葉（一般のバズ））。分からなければ null。
 * 返り値: { genre, via: 'dict'|'keyword'|'hold' }
 */
export function estimateGenre(text, { dict = [], holdTerms = [] } = {}) {
  const s = normalizeForMatch(text || '');
  if (!s) return null;
  const info = { text: s, terms: '', termWords: [], tags: [], user: '', mentions: [], night: true };
  let best = null;
  let bestHits = 0;
  for (const e of dict) {
    const hgt = dictHits(prepareDictEntry(e), info);
    if (hgt > bestHits) { best = e; bestHits = hgt; }
  }
  if (best && best.genre) return { genre: best.genre, via: 'dict' };
  let kw = null;
  let kwHits = 0;
  for (const [g, words] of Object.entries(NIGHT_KEYWORDS)) {
    const n = words.filter((w) => containsWord(s, normalizeForMatch(w))).length;
    if (n > kwHits) { kw = g; kwHits = n; }
  }
  if (kw) return { genre: kw, via: 'keyword' };
  if (holdTerms.some((w) => w && containsWord(s, normalizeForMatch(w)))) return { genre: 'general', via: 'hold' };
  return null;
}

/** 保存する形（長さを切る） */
export function sanitizeLinkMeta(o) {
  if (!o || typeof o !== 'object') return null;
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  return {
    author: str(o.author, 80), handle: /^[A-Za-z0-9_]{0,30}$/.test(o.handle || '') ? (o.handle || '') : '', text: str(o.text, 600), date: str(o.date, 40),
    fetchedAt: Number.isFinite(o.fetchedAt) ? o.fetchedAt : null, error: o.error ? str(String(o.error), 120) : null,
  };
}

// ---------------------------------------------------------------- 取得（ブラウザ）

let jsonpSeq = 0;
function jsonp(url, ms = 8000) {
  return new Promise((resolve, reject) => {
    const name = `__xtOembed${Date.now().toString(36)}${++jsonpSeq}`;
    const s = document.createElement('script');
    const done = (fn, v) => { clearTimeout(t); delete window[name]; s.remove(); fn(v); };
    const t = setTimeout(() => done(reject, new Error('時間切れ')), ms);
    window[name] = (data) => done(resolve, data);
    s.onerror = () => done(reject, new Error('読み込めませんでした'));
    s.src = `${url}&callback=${name}`;
    document.head.append(s);
  });
}

/** oEmbed を取る（fetch。CORS で通らなければ JSONP）。返り値: parseOembed の結果。失敗は例外 */
export async function fetchOembed(id, { fetchImpl = globalThis.fetch } = {}) {
  const url = oembedUrl(id);
  let json = null;
  try {
    const res = await fetchImpl(url, { cache: 'no-store', credentials: 'omit' });
    if (res.status === 404 || res.status === 403) throw Object.assign(new Error('削除されたか、非公開の投稿です'), { final: true });
    if (!res.ok) throw new Error(`取得できませんでした（${res.status}）`);
    json = await res.json();
  } catch (err) {
    if (err && err.final) throw err;
    if (typeof document === 'undefined') throw err;
    json = await jsonp(url);
  }
  const m = parseOembed(json);
  if (!m) throw new Error('本文を読み取れませんでした');
  return m;
}
