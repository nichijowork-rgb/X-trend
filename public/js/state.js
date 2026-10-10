// アプリ全体の状態（/api/status の結果など）
import { get } from './api.js';

export const state = {
  status: null,       // GET /api/status の応答
  statusError: null,  // 取得失敗時の ApiError
};

const listeners = new Set();
export function onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export async function refreshStatus() {
  try {
    state.status = await get('/status');
    state.statusError = null;
  } catch (err) {
    state.statusError = err;
  }
  for (const fn of listeners) { try { fn(state); } catch (e) { console.warn(e); } }
  return state.status;
}

/** 書き込みUIを出してよいか（viewer なら false） */
export function canWrite() {
  return !!state.status && state.status.role === 'admin';
}
/** 認証が必要なのに共有トークン/管理者トークンが無い（または無効） */
export function isUnauthenticated() {
  return !!state.status && state.status.authRequired === true && state.status.role !== 'admin' && state.status.role !== 'viewer';
}
export function isViewer() {
  return !!state.status && state.status.role === 'viewer';
}
/** integrations の値は boolean / { configured } どちらでも受ける */
export function isConfigured(v) {
  if (v && typeof v === 'object') return !!v.configured;
  return !!v;
}
