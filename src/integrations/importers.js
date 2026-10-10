// JSON / CSV / ブックマークレット payload を NormalizedPost に正規化する。依存なし。
import { parsePostUrl, buildPostUrl, isValidHandle } from './url.js';

const METRIC_KEYS = ['views', 'likes', 'reposts', 'replies', 'bookmarks'];
const MAX_TEXT = 10000;

/** ヘッダ/キー名の正規化（小文字・全角半角統一・空白/_/-除去） */
function nk(k) {
  return String(k).normalize('NFKC').toLowerCase().replace(/[\s_\-.　]/g, '');
}

const ALIASES = {
  id: ['id', 'idstr', 'tweetid', 'postid', 'statusid', 'restid', '投稿id', 'ツイートid', 'ポストid'],
  url: ['url', 'link', 'tweeturl', 'posturl', 'permalink', 'statusurl', '投稿url', 'ツイートurl', 'ポストurl', 'リンク'],
  text: ['text', 'fulltext', 'content', 'body', 'tweet', 'message', '本文', '内容', '投稿内容', 'ツイート本文', 'ポスト本文', 'ツイート', 'ポスト', '投稿'],
  postedAt: ['createdat', 'postedat', 'date', 'datetime', 'time', 'timestamp', 'created', '投稿日時', '投稿日', '日時', '日付', '作成日時'],
  handle: ['screenname', 'username', 'handle', 'authorhandle', 'authorusername', 'author', 'ハンドル', 'アカウント', 'アカウントid', 'ユーザーid', 'ユーザー名', 'ユーザーネーム'],
  name: ['name', 'displayname', 'authorname', '表示名', '名前', '投稿者', '投稿者名', '著者'],
  lang: ['lang', 'language', '言語'],
  fetchedAt: ['metricsfetchedat', 'fetchedat', 'scrapedat', 'capturedat', 'retrievedat', 'collectedat', '取得日時', '指標取得日時', '収集日時', '取得時刻'],
  views: ['viewcount', 'views', 'impressioncount', 'impressions', 'view', 'impression', '表示回数', '閲覧数', '表示数', 'インプレッション', 'インプレッション数', 'ビュー'],
  likes: ['likecount', 'likes', 'favoritecount', 'favouritecount', 'favorites', 'like', 'favorite', 'いいね', 'いいね数', 'お気に入り'],
  reposts: ['retweetcount', 'repostcount', 'retweets', 'reposts', 'retweet', 'repost', 'rt', 'リポスト', 'リポスト数', 'リツイート', 'リツイート数'],
  replies: ['replycount', 'replies', 'reply', 'コメント', '返信', '返信数', 'リプライ', 'リプライ数'],
  bookmarks: ['bookmarkcount', 'bookmarks', 'bookmark', 'ブックマーク', 'ブックマーク数'],
};
const ALIAS_INDEX = new Map();
for (const [field, names] of Object.entries(ALIASES)) for (const n of names) ALIAS_INDEX.set(nk(n), field);

/** 取得できるフィールドを {field: value} に集約（先勝ち・空は無視） */
function collectFields(obj) {
  const out = {};
  const sources = [obj];
  for (const k of ['public_metrics', 'metrics', 'organic_metrics', 'non_public_metrics', 'legacy']) {
    if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k])) sources.push(obj[k]);
  }
  for (const src of sources) {
    for (const [k, v] of Object.entries(src)) {
      const f = ALIAS_INDEX.get(nk(k));
      if (!f || out[f] !== undefined) continue;
      if (v === null || v === undefined || v === '') continue;
      if (typeof v === 'object' && !(f === 'views')) continue; // views は {count} 形式があり得る
      out[f] = v;
    }
  }
  return out;
}

/** "1.2万" "3.4K" "1,234" 等を数値に。数値化できなければ null。0 は 0。 */
export function parseCount(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
  if (typeof v === 'object') return v && 'count' in v ? parseCount(v.count) : null;
  let s = String(v).normalize('NFKC').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/[,\s]/g, '').replace(/(件|回|views?|likes?|impressions?)$/i, '');
  const m = s.match(/^(\d+(?:\.\d+)?|\.\d+)(万|億|千|k|m|b)?$/);
  if (!m) return null;
  const mult = { 万: 1e4, 億: 1e8, 千: 1e3, k: 1e3, m: 1e6, b: 1e9 }[m[2]] ?? 1;
  const n = Math.round(parseFloat(m[1]) * mult);
  return Number.isFinite(n) ? n : null;
}

/** 各種日時表記を ISO8601(UTC) に。タイムゾーン無しの表記は日本時間として扱う。不明は null。 */
export function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null;
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const s = String(v).normalize('NFKC').trim();
  if (!s) return null;
  if (/^\d{10,13}$/.test(s)) return parseDate(Number(s));
  const m = s.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (m) {
    const p = (n, w = 2) => String(n).padStart(w, '0');
    let tz = m[7];
    if (!tz) tz = '+09:00';
    else if (/^z$/i.test(tz)) tz = 'Z';
    else if (!tz.includes(':')) tz = `${tz.slice(0, 3)}:${tz.slice(3)}`;
    const iso = `${m[1]}-${p(m[2])}-${p(m[3])}T${p(m[4] ?? 0)}:${m[5] ?? '00'}:${m[6] ?? '00'}${tz}`;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function cleanHandle(h) {
  if (typeof h !== 'string') return null;
  const s = h.trim().replace(/^@/, '').replace(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i, '').split(/[/?#]/)[0];
  return isValidHandle(s) ? s : null;
}
function str(v, max = 500) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

/**
 * 1件のレコードを NormalizedPost に。投稿IDもURLも特定できなければ null。
 * ctx: { users: Map(id -> {username,name}), fetchedAt: ISO, now: () => ISO }
 */
export function normalizeRecord(input, sourceType, sourceDetail = null, ctx = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  let obj = input;
  if (obj.tweet && typeof obj.tweet === 'object') obj = obj.tweet; // X公式アーカイブ形式
  const f = collectFields(obj);

  // URL / ID
  const urlInfo = parsePostUrl(typeof f.url === 'string' ? f.url : null);
  let postId = null;
  for (const c of [f.id, obj.rest_id]) {
    const s = c === undefined || c === null ? '' : String(c).trim();
    if (/^\d{1,25}$/.test(s)) { postId = s; break; }
  }
  if (!postId && urlInfo) postId = urlInfo.postId;
  if (!postId && typeof f.id === 'string') postId = parsePostUrl(f.id)?.postId ?? null;
  if (!postId) return null;

  // 投稿者
  let handleRaw = typeof f.handle === 'string' ? f.handle : null;
  let name = str(f.name, 200);
  const userObj = [obj.user, obj.author, obj.account].find((u) => u && typeof u === 'object');
  if (userObj) {
    const uf = collectFields(userObj);
    handleRaw = handleRaw ?? uf.handle ?? null;
    name = name ?? str(uf.name, 200);
  } else if (typeof obj.author === 'string' && !handleRaw) {
    handleRaw = obj.author;
  }
  const authorId = obj.author_id ?? obj.user_id_str ?? obj.user_id;
  const u2 = authorId !== undefined && ctx.users ? ctx.users.get(String(authorId)) : null;
  if (u2) {
    handleRaw = handleRaw ?? u2.username ?? null;
    name = name ?? str(u2.name, 200);
  }
  let authorHandle = cleanHandle(handleRaw);
  if (!authorHandle && handleRaw && !name) name = str(handleRaw, 200); // 「ユーザー名」列が表示名だった場合
  if (!authorHandle && urlInfo?.authorHandle && urlInfo.postId === postId) authorHandle = urlInfo.authorHandle;

  const url = urlInfo && urlInfo.postId === postId && (urlInfo.authorHandle || !authorHandle)
    ? urlInfo.url
    : buildPostUrl(postId, authorHandle);

  const metrics = {};
  for (const k of METRIC_KEYS) metrics[k] = parseCount(f[k]);
  const hasMetric = METRIC_KEYS.some((k) => metrics[k] !== null);
  const nowIso = typeof ctx.now === 'function' ? ctx.now() : new Date().toISOString();
  let metricsFetchedAt = null;
  if (hasMetric) metricsFetchedAt = parseDate(f.fetchedAt) ?? parseDate(ctx.fetchedAt) ?? nowIso;

  let text = typeof f.text === 'string' ? f.text.replace(/\r\n?/g, '\n').trim() : null;
  if (text) text = text.slice(0, MAX_TEXT); else text = null;

  return {
    postId,
    url,
    authorHandle,
    authorName: name,
    text,
    postedAt: parseDate(f.postedAt),
    metrics,
    metricsFetchedAt,
    source: { type: sourceType, detail: sourceDetail ?? null },
    genreHint: null,
    matchedKeywords: [],
    lang: str(f.lang, 20),
    raw: input,
  };
}

function finish(records, sourceType, sourceDetail, ctx, indexOf = (i) => i) {
  const posts = [];
  const errors = [];
  records.forEach((r, i) => {
    const p = normalizeRecord(r, sourceType, sourceDetail, ctx);
    if (p) posts.push(p);
    else errors.push({ index: indexOf(i), message: '投稿IDまたは投稿URLを特定できないためスキップしました' });
  });
  return { posts, errors };
}

function stripBom(s) {
  return String(s ?? '').replace(/^﻿/, '');
}

/** JSON（配列 / {data} / {posts} / X公式アーカイブ / X API v2 レスポンス / NDJSON） */
export function parseJSON(text, { sourceDetail = null, sourceType = 'import_json' } = {}) {
  let s = stripBom(text).trim();
  if (!s) return { posts: [], errors: [{ index: 0, message: 'ファイルが空です' }] };
  s = s.replace(/^window\.YTD\.[\w.$]+\s*=\s*/, '').replace(/;\s*$/, '');
  let data;
  try {
    data = JSON.parse(s);
  } catch {
    const lines = s.split(/\r?\n/).filter((l) => l.trim());
    try {
      if (lines.length < 2) throw new Error('x');
      data = lines.map((l) => JSON.parse(l));
    } catch {
      return { posts: [], errors: [{ index: 0, message: 'JSONとして読み取れませんでした（形式を確認してください）' }] };
    }
  }
  const ctx = {};
  const includes = data && typeof data === 'object' ? data.includes : null;
  if (includes && Array.isArray(includes.users)) {
    ctx.users = new Map(includes.users.filter((u) => u && u.id).map((u) => [String(u.id), u]));
  }
  let items;
  if (Array.isArray(data)) items = data;
  else if (data && typeof data === 'object') {
    const arr = ['data', 'posts', 'tweets', 'items', 'results', 'statuses'].map((k) => data[k]).find(Array.isArray);
    if (arr) items = arr;
    else if (data.data && typeof data.data === 'object') items = [data.data];
    else items = [data];
  } else {
    return { posts: [], errors: [{ index: 0, message: '投稿の配列またはオブジェクトではありません' }] };
  }
  return finish(items, sourceType, sourceDetail, ctx);
}

/** RFC4180 準拠の CSV パーサ。戻り値: [{ cells, line }] */
function parseCsvRows(text, delim) {
  const rows = [];
  let cells = [];
  let cell = '';
  let inQ = false;
  let line = 1;
  let rowLine = 1;
  let touched = false;
  const endCell = () => { cells.push(cell); cell = ''; };
  const endRow = () => {
    endCell();
    rows.push({ cells, line: rowLine });
    cells = [];
    touched = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false;
      } else {
        if (c === '\n') line++;
        cell += c;
      }
      continue;
    }
    if (!touched) rowLine = line;
    if (c === '"' && cell === '') { inQ = true; touched = true; }
    else if (c === delim) { endCell(); touched = true; }
    else if (c === '\r') { /* 次の \n で処理 */ if (text[i + 1] !== '\n') { endRow(); line++; } }
    else if (c === '\n') { endRow(); line++; }
    else { cell += c; touched = true; }
  }
  if (touched || cell !== '' || cells.length) endRow();
  return rows;
}

function detectDelimiter(text) {
  let inQ = false;
  let comma = 0;
  let tab = 0;
  for (const c of text) {
    if (c === '"') inQ = !inQ;
    else if (!inQ) {
      if (c === '\n') break;
      if (c === ',') comma++;
      else if (c === '\t') tab++;
    }
  }
  return tab > comma ? '\t' : ',';
}

/** CSV（引用符・セル内改行・BOM・カンマ/タブ自動判定・日本語ヘッダ・URL列のみ対応）。errors.index は行番号（1始まり）。 */
export function parseCSV(text, { sourceDetail = null } = {}) {
  const s = stripBom(text);
  if (!s.trim()) return { posts: [], errors: [{ index: 1, message: 'ファイルが空です' }] };
  const rows = parseCsvRows(s, detectDelimiter(s)).filter((r) => r.cells.some((c) => c.trim() !== ''));
  if (!rows.length) return { posts: [], errors: [{ index: 1, message: 'データ行がありません' }] };
  const first = rows[0].cells.map((c) => c.trim());
  const headerless = first.every((c) => c === '' || parsePostUrl(c));
  const posts = [];
  const errors = [];
  const push = (obj, line) => {
    const p = normalizeRecord(obj, 'import_csv', sourceDetail, {});
    if (p) posts.push(p);
    else errors.push({ index: line, message: '投稿IDまたは投稿URLを特定できないためスキップしました' });
  };
  if (headerless) {
    for (const r of rows) push({ url: r.cells[0].trim() }, r.line);
    return { posts, errors };
  }
  const header = first.map((h) => h.replace(/^﻿/, ''));
  for (const r of rows.slice(1)) {
    const obj = {};
    header.forEach((h, i) => {
      if (!h) return;
      const v = r.cells[i];
      if (v === undefined) return;
      if (obj[h] === undefined || obj[h] === '') obj[h] = v;
    });
    push(obj, r.line);
  }
  return { posts, errors };
}

const PAGE_LABEL = {
  foryou: 'おすすめ画面（ブックマークレット）',
  following: 'フォロー中タブ（ブックマークレット）',
  search: '検索画面（ブックマークレット）',
  other: 'その他の画面（ブックマークレット）',
};

/** ブックマークレット payload (v1) の検証と正規化。source.type は常に foryou_capture。 */
export function normalizeCapture(payload) {
  const fail = (message) => ({ posts: [], errors: [{ index: 0, message }] });
  if (!payload || typeof payload !== 'object') return fail('取り込みデータが不正です');
  if (payload.v !== 1) return fail('取り込みデータのバージョンに対応していません');
  if (!Array.isArray(payload.posts)) return fail('取り込みデータに投稿一覧がありません');
  const page = Object.hasOwn(PAGE_LABEL, payload.page) ? payload.page : 'other';
  const capturedAt = parseDate(payload.capturedAt);
  const detail = PAGE_LABEL[page];
  const items = payload.posts.slice(0, 1000);
  const res = finish(items, 'foryou_capture', detail, { fetchedAt: capturedAt ?? undefined });
  const seen = new Set();
  res.posts = res.posts.filter((p) => (seen.has(p.postId) ? false : seen.add(p.postId)));
  if (payload.posts.length > items.length) res.errors.push({ index: items.length, message: '1000件を超える分は取り込みませんでした' });
  return res;
}
