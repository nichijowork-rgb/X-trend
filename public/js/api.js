// HTTP API クライアント（docs/CONTRACT.md の /api/* に準拠）
const LS_ADMIN = 'xtrend.adminToken';
const LS_SHARE = 'xtrend.shareToken';

/** localStorage を安全に扱う（プライベートモード等で例外になっても落とさない） */
export const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 保存できなくても動作は継続 */ }
  },
  del(key) {
    try { localStorage.removeItem(key); } catch { /* noop */ }
  },
};

export const tokens = {
  get admin() { return store.get(LS_ADMIN, '') || ''; },
  set admin(v) { v ? store.set(LS_ADMIN, String(v)) : store.del(LS_ADMIN); },
  get share() { return store.get(LS_SHARE, '') || ''; },
  set share(v) { v ? store.set(LS_SHARE, String(v)) : store.del(LS_SHARE); },
};

export class ApiError extends Error {
  constructor(message, status = 0, data = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
  get isNetwork() { return this.status === 0; }
  get isAuth() { return this.status === 401 || this.status === 403; }
}

/** GET の 401 を通知（app.js が認証画面へ切り替える） */
export const apiEvents = new EventTarget();

function buildHeaders(hasBody) {
  const headers = { Accept: 'application/json' };
  if (hasBody) headers['Content-Type'] = 'application/json';
  if (tokens.admin) headers['X-Admin-Token'] = tokens.admin;
  if (tokens.share) headers['X-Share-Token'] = tokens.share;
  return headers;
}

function networkMessage() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'オフラインです。インターネット接続を確認してから、もう一度お試しください。';
  }
  return 'サーバーに接続できません。サーバーが起動しているか確認してから、もう一度お試しください。';
}

function statusMessage(status) {
  if (status === 401) return '閲覧には共有リンク、操作には管理者トークンが必要です。';
  if (status === 403) return 'この操作には管理者トークンが必要です（設定画面で入力できます）。';
  if (status === 404) return '見つかりませんでした。';
  if (status === 413) return 'データが大きすぎます。分割して取り込んでください。';
  if (status === 429) return 'リクエストが多すぎます。しばらく待ってからお試しください。';
  if (status >= 500) return `サーバーでエラーが発生しました（${status}）。時間をおいて再度お試しください。`;
  return `エラーが発生しました（${status}）。`;
}

/**
 * @param {string} path '/status' のように /api 以降
 * @param {{method?:string, body?:any, query?:object, raw?:boolean, signal?:AbortSignal}} opts
 */
export async function api(path, opts = {}) {
  const { method = 'GET', body, query, raw = false, signal } = opts;
  let url = '/api' + path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: buildHeaders(body !== undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
      cache: 'no-store',
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new ApiError(networkMessage(), 0);
  }
  if (raw && res.ok) return res;
  let data = null;
  const text = await res.text().catch(() => '');
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const msg = (data && typeof data.error === 'string' && data.error) || statusMessage(res.status);
    const err = new ApiError(msg, res.status, data);
    if (res.status === 401 && method === 'GET') {
      apiEvents.dispatchEvent(new CustomEvent('unauthorized', { detail: err }));
    }
    throw err;
  }
  if (data === null && text) {
    throw new ApiError('サーバーから想定外の応答がありました（JSON ではありません）。', res.status);
  }
  return data ?? {};
}

export const get = (path, query, opts = {}) => api(path, { ...opts, query });
export const post = (path, body = {}, opts = {}) => api(path, { ...opts, method: 'POST', body });
export const put = (path, body = {}, opts = {}) => api(path, { ...opts, method: 'PUT', body });
export const del = (path, opts = {}) => api(path, { ...opts, method: 'DELETE' });
