// コメントの取得を、同じブラウザの複数のウィンドウ（進行・コメント）で分け合う。DOM 非依存（node:test から import）。
// - 取得と OBS への送信をするウィンドウ（取りまとめ役＝leader）は 1 つだけ。localStorage の「鍵」に id と時刻を 2 秒ごとに書く（6 秒で失効）。
// - 取りまとめ役は状態（取得の状態・一覧・固定・流すか など）を BroadcastChannel で配り、ほかのウィンドウはそれを映す。
// - ほかのウィンドウの操作（開始・停止・固定・画面から消す・流す・レイアウト）は取りまとめ役へ送り、取りまとめ役が実行する。
// - 取りまとめ役が閉じた・止まった（鍵が失効）ら、ほかのウィンドウが引き継ぐ（取得中だったら取り直す）。

export const LOCK_KEY = 'xtrend-show-ytchat-lock';
export const SYNC_CHANNEL = 'xtrend-ytchat-sync';
export const HEARTBEAT_MS = 2000;
export const LOCK_TTL_MS = 6000;
export const SYNC_VERSION = 1;

/** 鍵（localStorage の文字列）を読む。壊れていれば null */
export function parseLock(raw) {
  let o = null;
  try { o = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { o = null; }
  if (!o || typeof o !== 'object' || typeof o.id !== 'string' || !o.id || !Number.isFinite(o.at)) return null;
  return { id: o.id, at: o.at };
}

/** 鍵の状態: mine（自分）／held（ほかのウィンドウが生きている）／free（無い・失効） */
export function lockState(lock, me, now, ttl = LOCK_TTL_MS) {
  if (!lock) return 'free';
  if (lock.id === me) return 'mine';
  // 未来の時刻（時計のずれ）も ttl を超えたら失効とみる
  return Math.abs(now - lock.at) <= ttl ? 'held' : 'free';
}

/**
 * 取りまとめ役の鍵。storage: { get(key) → string|null, set(key, value), remove(key) }
 * tick(now) → { role: 'leader'|'follower', changed（役が変わった）, tookOver（失効した鍵を引き継いだ）}
 * release()（閉じるとき。自分の鍵なら消す）
 */
export function createLeaderLock({ me, storage, ttl = LOCK_TTL_MS }) {
  let role = 'follower';
  const write = (now) => { try { storage.set(LOCK_KEY, JSON.stringify({ id: me, at: now })); } catch { /* 保存できない＝ひとりで動く */ } };
  return {
    get role() { return role; },
    tick(now) {
      let lock = null;
      try { lock = parseLock(storage.get(LOCK_KEY)); } catch { lock = null; }
      const st = lockState(lock, me, now, ttl);
      const was = role;
      let tookOver = false;
      if (st === 'mine') role = 'leader';
      else if (st === 'held') role = 'follower';
      else {
        tookOver = Boolean(lock && lock.id !== me);
        role = 'leader';
      }
      if (role === 'leader') write(now);
      return { role, changed: was !== role, tookOver: tookOver && was !== 'leader' };
    },
    release() {
      try { const lock = parseLock(storage.get(LOCK_KEY)); if (lock && lock.id === me) storage.remove(LOCK_KEY); } catch { /* 無視 */ }
      role = 'follower';
    },
  };
}

/** メッセージの封筒 */
export function envelope(from, seq, type, body = {}) {
  return { v: SYNC_VERSION, from, seq, at: Date.now(), type, ...body };
}

/**
 * 受け取ったメッセージを使うか: 形が正しい・自分のものでない・同じ送り手の同じか古い seq は捨てる（重複・遅れて届いたもの）。
 * 送り手が開き直した（seq が 1 から）ときは at が新しければ使う。
 */
export function createSyncFilter(me) {
  const last = new Map(); // from → { seq, at }
  return {
    accept(msg) {
      if (!msg || typeof msg !== 'object' || msg.v !== SYNC_VERSION || typeof msg.from !== 'string' || !msg.from || msg.from === me) return false;
      if (typeof msg.type !== 'string' || !Number.isFinite(msg.seq)) return false;
      const prev = last.get(msg.from);
      if (prev && msg.seq <= prev.seq && !(Number.isFinite(msg.at) && msg.at > prev.at + 1000 && msg.seq === 1)) return false;
      last.set(msg.from, { seq: msg.seq, at: Number(msg.at) || 0 });
      if (last.size > 50) last.delete(last.keys().next().value);
      return true;
    },
  };
}

/** ほかのウィンドウから送れる操作 */
export const SYNC_COMMANDS = Object.freeze(['start', 'stop', 'pin', 'unpin', 'hide', 'flow', 'layout', 'previewObs', 'demo', 'prefs']);

/** 取りまとめ役が配る状態（一覧を含む。新しく開いたウィンドウにもこれ 1 つで足りる） */
export function chatSnapshot(chat, extra = {}) {
  return {
    status: chat.status, reason: chat.reason, code: chat.code, via: chat.via || null, fallback: chat.fallback || '',
    videoId: chat.videoId || null, found: chat.found || null, count: chat.count || 0,
    log: Array.isArray(chat.log) ? chat.log : [], hidden: [...(chat.hidden || [])], banned: [...(chat.banned || [])],
    pin: chat.pin || null, calls: { ...(chat.calls || {}) },
    ...extra,
  };
}

/** 配られた状態を自分の chat に映す（一覧・固定・状態。壊れた値は前のまま） */
export function applySnapshot(chat, snap) {
  if (!snap || typeof snap !== 'object') return chat;
  const next = { ...chat };
  for (const k of ['status', 'reason', 'code', 'via', 'fallback', 'videoId', 'found', 'count', 'pin']) if (k in snap) next[k] = snap[k];
  if (Array.isArray(snap.log)) next.log = snap.log.filter((x) => x && typeof x.id === 'string').slice(-300);
  if (Array.isArray(snap.hidden)) next.hidden = new Set(snap.hidden.filter((x) => typeof x === 'string'));
  if (Array.isArray(snap.banned)) next.banned = new Set(snap.banned.filter((x) => typeof x === 'string'));
  if (snap.calls && typeof snap.calls === 'object') next.calls = { ...chat.calls, ...snap.calls };
  return next;
}

/** 取得中か（引き継いだときに取り直すかの判断） */
export function isCollecting(status) {
  return ['starting', 'running', 'retrying', 'searching'].includes(status);
}
