// 保存（localStorage）と、ほかのタブ（映す用など）への同期（BroadcastChannel ＋ storage イベント）。
// localStorage が使えない・一杯・壊れた値でも画面は動く（try/catch）。
import { STORAGE_KEY, CHANNEL_NAME, KEEP_WEEKS_ON_QUOTA } from './config.js';
import { parseSaved, serializeSaved, pruneWeeks, defaultSaved } from './logic.js';

const TAB_ID = Math.random().toString(36).slice(2);

/** 読み込み。返り値: { state, note }（note は画面に出す注意。無ければ null） */
export function loadSaved() {
  let raw = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return { state: defaultSaved(), note: 'このブラウザでは自動保存が使えません（書き出しで保存してください）' };
  }
  if (raw == null) return { state: defaultSaved(), note: null };
  const r = parseSaved(raw);
  if (!r.ok) return { state: defaultSaved(), note: `保存データを読めなかったため、最初の状態で始めます（${r.reason}）` };
  return { state: r.state, note: r.reason || null };
}

/**
 * 保存。容量不足なら古い番組週を消して再試行。
 * 返り値: { ok, pruned?: boolean, error?: string, state }
 */
export function saveState(state, keepWeekKey) {
  const now = Date.now();
  const write = (s) => window.localStorage.setItem(STORAGE_KEY, serializeSaved(s, now));
  try {
    write(state);
    return { ok: true, state: { ...state, savedAt: now } };
  } catch (err) {
    const quota = err && (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014);
    if (quota) {
      const smaller = pruneWeeks(state, KEEP_WEEKS_ON_QUOTA, keepWeekKey);
      try {
        write(smaller);
        return { ok: true, pruned: true, state: { ...smaller, savedAt: now } };
      } catch { /* 下へ */ }
      return { ok: false, error: '保存容量が一杯で保存できませんでした。「書き出し」でファイルに保存してください', state };
    }
    return { ok: false, error: '自動保存できませんでした（ブラウザの設定で保存が止められている可能性があります）', state };
  }
}

/**
 * 同期チャンネル。onState(state) はほかのタブで変更があったときに呼ばれる。
 * 返り値: { post(state) }
 */
export function openSync(onState) {
  let bc = null;
  try {
    if ('BroadcastChannel' in window) {
      bc = new BroadcastChannel(CHANNEL_NAME);
      bc.onmessage = (e) => {
        const d = e.data;
        if (!d || d.type !== 'state' || d.from === TAB_ID) return;
        const r = parseSaved(d.state);
        if (r.ok) onState(r.state);
      };
    }
  } catch { bc = null; }
  // BroadcastChannel が無い環境向け（localStorage の変更はほかのタブに storage イベントで届く）
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY || bc || e.newValue == null) return;
    const r = parseSaved(e.newValue);
    if (r.ok) onState(r.state);
  });
  return {
    post(state) {
      if (!bc) return;
      try { bc.postMessage({ type: 'state', from: TAB_ID, state: JSON.parse(serializeSaved(state)) }); } catch { /* 無視 */ }
    },
  };
}
