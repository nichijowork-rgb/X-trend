// 公式 X API v2 クライアント。fetchImpl 注入可。例外は投げず { posts, error?, rateLimit? } を返す。
import { buildPostUrl, isValidHandle } from './url.js';

const API_BASE = 'https://api.x.com';
const TWEET_FIELDS = 'created_at,public_metrics,lang,author_id';
const USER_FIELDS = 'username,name';
const HOME_DETAIL = '逆時系列（おすすめ欄ではありません）';

const clamp = (n, lo, hi, dflt) => {
  const v = Math.trunc(Number(n));
  if (!Number.isFinite(v)) return dflt;
  return Math.min(hi, Math.max(lo, v));
};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

function readRateLimit(res) {
  try {
    const h = res?.headers;
    if (!h || typeof h.get !== 'function') return undefined;
    const rem = h.get('x-rate-limit-remaining');
    const reset = h.get('x-rate-limit-reset');
    if (rem === null && reset === null) return undefined;
    const remaining = rem !== null && rem !== '' && Number.isFinite(Number(rem)) ? Number(rem) : null;
    const resetAt = reset !== null && reset !== '' && Number.isFinite(Number(reset))
      ? new Date(Number(reset) * 1000).toISOString() : null;
    return { remaining, resetAt };
  } catch {
    return undefined;
  }
}

function httpError(status, rateLimit) {
  if (status === 401) return 'X APIの認証に失敗しました（トークンが無効、または期限切れです）。';
  if (status === 402) return 'X APIの利用枠（クレジット）が不足しています。';
  if (status === 403) return 'X APIへのアクセスが許可されていません（プランや権限、ユーザーアクセストークンのスコープを確認してください）。';
  if (status === 429) {
    const when = rateLimit?.resetAt ? `${rateLimit.resetAt} 以降に` : 'しばらく待ってから';
    return `X APIのレート制限に達しました。${when}再試行してください。`;
  }
  if (status >= 500) return `X API側でエラーが発生しました（HTTP ${status}）。時間をおいて再試行してください。`;
  return `X APIがエラーを返しました（HTTP ${status}）。`;
}

export function mapTweet(t, users, sourceType, detail, nowIso) {
  if (!t || !/^\d+$/.test(String(t.id ?? ''))) return null;
  const pm = t.public_metrics && typeof t.public_metrics === 'object' ? t.public_metrics : {};
  const metrics = {
    views: num(pm.impression_count),
    likes: num(pm.like_count),
    reposts: num(pm.retweet_count),
    replies: num(pm.reply_count),
    bookmarks: num(pm.bookmark_count),
  };
  const has = Object.values(metrics).some((v) => v !== null);
  const u = t.author_id !== undefined ? users.get(String(t.author_id)) : null;
  const handle = isValidHandle(u?.username) ? u.username : null;
  let postedAt = null;
  if (typeof t.created_at === 'string') {
    const d = new Date(t.created_at);
    if (!Number.isNaN(d.getTime())) postedAt = d.toISOString();
  }
  return {
    postId: String(t.id),
    url: buildPostUrl(String(t.id), handle),
    authorHandle: handle,
    authorName: typeof u?.name === 'string' && u.name ? u.name : null,
    text: typeof t.text === 'string' && t.text ? t.text : null,
    postedAt,
    metrics,
    metricsFetchedAt: has ? nowIso : null,
    source: { type: sourceType, detail },
    genreHint: null,
    matchedKeywords: [],
    lang: typeof t.lang === 'string' && t.lang ? t.lang : null,
    raw: null,
  };
}

export function createXApi({ bearerToken, userAccessToken, userId, fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  const hasUserId = typeof userId === 'string' ? /^\d+$/.test(userId.trim()) : typeof userId === 'number';
  const searchOk = Boolean(bearerToken);
  const homeOk = Boolean(userAccessToken) && hasUserId;

  /** 共通リクエスト。{ ok, json, rateLimit, error } を返す（例外なし）。 */
  async function request(token, path, params) {
    if (typeof fetchImpl !== 'function') return { ok: false, error: 'この環境ではネットワークアクセスを利用できません。' };
    const qs = new URLSearchParams(params).toString();
    let res;
    try {
      res = await fetchImpl(`${API_BASE}${path}?${qs}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      return { ok: false, error: 'X APIに接続できませんでした（ネットワークエラーまたはタイムアウト）。' };
    }
    const rateLimit = readRateLimit(res);
    if (!res.ok) return { ok: false, rateLimit, error: httpError(res.status, rateLimit) };
    let json;
    try {
      json = await res.json();
    } catch {
      return { ok: false, rateLimit, error: 'X APIの応答を解釈できませんでした。' };
    }
    return { ok: true, json, rateLimit };
  }

  function toPosts(json, sourceType, detail) {
    const users = new Map((json?.includes?.users ?? []).filter((u) => u?.id).map((u) => [String(u.id), u]));
    const nowIso = now().toISOString();
    const list = Array.isArray(json?.data) ? json.data : json?.data && typeof json.data === 'object' ? [json.data] : [];
    return list.map((t) => mapTweet(t, users, sourceType, detail, nowIso)).filter(Boolean);
  }
  const withRate = (out, rateLimit) => (rateLimit ? { ...out, rateLimit } : out);

  return {
    isConfigured() {
      return { search: searchOk, home: homeOk };
    },

    async searchRecent({ query, maxResults = 10 } = {}) {
      if (!searchOk) return { posts: [], error: 'X_BEARER_TOKEN が設定されていません。' };
      const q = typeof query === 'string' ? query.trim() : '';
      if (!q) return { posts: [], error: '検索クエリが空です。' };
      const r = await request(bearerToken, '/2/tweets/search/recent', {
        query: q,
        max_results: String(clamp(maxResults, 10, 100, 10)),
        'tweet.fields': TWEET_FIELDS,
        expansions: 'author_id',
        'user.fields': USER_FIELDS,
      });
      if (!r.ok) return withRate({ posts: [], error: r.error }, r.rateLimit);
      return withRate({ posts: toPosts(r.json, 'x_api_search', q) }, r.rateLimit);
    },

    async homeTimeline({ maxResults = 50 } = {}) {
      if (!homeOk) return { posts: [], error: 'X_USER_ACCESS_TOKEN と X_USER_ID が設定されていません（ホームタイムラインにはユーザーアクセストークンが必要です）。' };
      const r = await request(userAccessToken, `/2/users/${encodeURIComponent(String(userId).trim())}/timelines/reverse_chronological`, {
        max_results: String(clamp(maxResults, 1, 100, 50)),
        'tweet.fields': TWEET_FIELDS,
        expansions: 'author_id',
        'user.fields': USER_FIELDS,
      });
      if (!r.ok) return withRate({ posts: [], error: r.error }, r.rateLimit);
      return withRate({ posts: toPosts(r.json, 'x_api_home', HOME_DETAIL) }, r.rateLimit);
    },

    async lookup(ids) {
      const token = bearerToken || userAccessToken;
      if (!token) return { posts: [], error: 'X_BEARER_TOKEN が設定されていません。' };
      const list = [...new Set((Array.isArray(ids) ? ids : [ids]).map((x) => String(x ?? '').trim()).filter((x) => /^\d{1,25}$/.test(x)))];
      if (!list.length) return { posts: [], error: '有効な投稿IDがありません。' };
      const posts = [];
      let rateLimit;
      for (let i = 0; i < list.length; i += 100) {
        const r = await request(token, '/2/tweets', {
          ids: list.slice(i, i + 100).join(','),
          'tweet.fields': TWEET_FIELDS,
          expansions: 'author_id',
          'user.fields': USER_FIELDS,
        });
        if (r.rateLimit) rateLimit = r.rateLimit;
        if (!r.ok) return withRate({ posts, error: r.error }, rateLimit);
        posts.push(...toPosts(r.json, 'x_api_search', '投稿ID参照（lookup）'));
      }
      return withRate({ posts }, rateLimit);
    },
  };
}
