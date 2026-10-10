// 投稿URLの解析と oEmbed 取得。依存なし。

const HOSTS = new Set([
  'x.com', 'twitter.com', 'mobile.twitter.com', 'mobile.x.com',
  'fxtwitter.com', 'vxtwitter.com', 'fixupx.com', 'fixvx.com', 'api.fxtwitter.com',
]);
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

export function isValidHandle(h) {
  return typeof h === 'string' && HANDLE_RE.test(h);
}

export function buildPostUrl(postId, authorHandle) {
  if (!/^\d+$/.test(String(postId ?? ''))) return null;
  return isValidHandle(authorHandle)
    ? `https://x.com/${authorHandle}/status/${postId}`
    : `https://x.com/i/web/status/${postId}`;
}

/** 投稿URL / 数字ID を解析。不正は null。 */
export function parsePostUrl(input) {
  if (input === null || input === undefined) return null;
  const s = String(input).trim();
  if (!s) return null;
  if (/^\d{1,25}$/.test(s)) return { postId: s, authorHandle: null, url: buildPostUrl(s, null) };
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!HOSTS.has(host)) return null;
  const segs = u.pathname.split('/').filter(Boolean);
  let handle = null;
  let id = null;
  if (segs[0] === 'i' && segs[1] === 'web' && (segs[2] === 'status' || segs[2] === 'statuses')) {
    id = segs[3];
  } else if (segs[0] === 'i' && (segs[1] === 'status' || segs[1] === 'statuses')) {
    id = segs[2];
  } else if ((segs[1] === 'status' || segs[1] === 'statuses') && segs.length >= 3) {
    handle = segs[0];
    id = segs[2];
  } else {
    return null;
  }
  if (!id || !/^\d{1,25}$/.test(id)) return null;
  if (handle !== null && !isValidHandle(handle)) handle = null;
  return { postId: id, authorHandle: handle, url: buildPostUrl(id, handle) };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…' };

export function decodeEntities(str) {
  return String(str).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    const v = ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function htmlToText(html) {
  return decodeEntities(
    html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]*>/g, ''),
  ).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** oEmbed の日付リンク文字列（例: "October 10, 2026" / "2026年10月10日"）を ISO に。日付のみなので 00:00 UTC。 */
function parseOEmbedDate(t) {
  const s = decodeEntities(t).trim();
  let m = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toISOString();
  const ms = Date.parse(`${s} UTC`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** publish.twitter.com の oEmbed から本文等を取得。失敗は null。 */
export async function fetchOEmbed(url, { fetchImpl = globalThis.fetch } = {}) {
  try {
    const parsed = parsePostUrl(url);
    if (!parsed || typeof fetchImpl !== 'function') return null;
    const target = parsed.url.replace('/i/web/status/', '/i/status/');
    const endpoint = `https://publish.twitter.com/oembed?url=${encodeURIComponent(target)}&omit_script=1`;
    const res = await fetchImpl(endpoint, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!res || !res.ok) return null;
    const j = await res.json();
    const html = typeof j?.html === 'string' ? j.html : '';
    if (!html) return null;
    const p = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const text = p ? htmlToText(p[1]) : null;
    const links = [...html.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
    const dateLink = links.length ? links[links.length - 1] : null;
    const postedAt = dateLink && /\/status\/\d+/.test(dateLink[1]) ? parseOEmbedDate(htmlToText(dateLink[2])) : null;
    let authorHandle = null;
    if (typeof j.author_url === 'string') {
      const h = j.author_url.split('?')[0].split('/').filter(Boolean).pop();
      if (isValidHandle(h)) authorHandle = h;
    }
    if (!authorHandle) authorHandle = parsed.authorHandle;
    const authorName = typeof j.author_name === 'string' && j.author_name.trim() ? j.author_name.trim() : null;
    if (!text && !authorName) return null;
    return { authorName, authorHandle, text: text || null, postedAt };
  } catch {
    return null;
  }
}
