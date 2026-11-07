// ボットへの修正（feedback/show-feedback.json）の自動送信。DOM 非依存（node:test から import される）。
// - 編集のあと、最後の編集から 60 秒（URL で追加したときは 15 秒）で送る（その間の編集はまとめる）
// - 送信の間隔は最短 5 分（それ以内の変更は次の回にまとめる）
// - 中身（generated_at を除いた JSON）のハッシュが前回送ったものと同じなら送らない
// - 失敗したら 1 分・5 分・15 分と間を空けてやり直す。401/403（トークン違い・権限不足）は止めて案内
// 時間・タイマー・送信は外から渡す（テストで時間を進められる）

export const AUTOSEND = Object.freeze({
  editDelay: 60 * 1000,
  urlDelay: 15 * 1000,
  minInterval: 5 * 60 * 1000,
  backoff: Object.freeze([60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000]),
});

/** 中身のハッシュ（generated_at は見ない）。同じ修正なら同じ値 */
export function feedbackHash(content) {
  let o = content;
  if (typeof content === 'string') { try { o = JSON.parse(content); } catch { o = content; } }
  let s;
  if (typeof o === 'object' && o) { const { generated_at: _g, ...rest } = o; s = JSON.stringify(rest); } else s = String(o);
  let h1 = 0x811c9dc5;
  let h2 = 0x9747b28c;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0; h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0; }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * opts: { now(), setTimer(fn, ms), clearTimer(t), getContent() → 文字列, send(content) → Promise<{ ok, status, message }>,
 *         onState(state), delays（AUTOSEND を上書き）, enabled, restore: { lastSentAt, lastHash, pendingSince } }
 * state: { status: 'off'|'idle'|'pending'|'sending'|'done'|'error'|'stopped', lastSentAt, lastHash, pendingSince, nextAt, reason, failures }
 */
/** 待ち時間の上書き（確認用）。正の有限数だけ使い、それ以外は既定値 */
export function mergeDelays(o) {
  const ok = (v) => Number.isFinite(v) && v > 0;
  const src = o && typeof o === 'object' ? o : {};
  const out = { ...AUTOSEND };
  for (const k of ['editDelay', 'urlDelay', 'minInterval']) if (ok(src[k])) out[k] = src[k];
  if (Array.isArray(src.backoff) && src.backoff.length && src.backoff.every(ok)) out.backoff = src.backoff.slice(0, 10);
  return out;
}

export function createAutoSender(opts) {
  const d = mergeDelays(opts.delays);
  const now = opts.now || (() => Date.now());
  const setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer || ((t) => clearTimeout(t));
  const r = opts.restore || {};
  const st = {
    status: 'idle', lastSentAt: Number.isFinite(r.lastSentAt) ? r.lastSentAt : null, lastHash: typeof r.lastHash === 'string' ? r.lastHash : null,
    pendingSince: Number.isFinite(r.pendingSince) ? r.pendingSince : null, nextAt: null, reason: '', failures: 0, failedAt: null,
  };
  let enabled = opts.enabled !== false;
  let timer = null;
  let editAt = st.pendingSince;
  let delay = d.editDelay;
  let seq = 0; // 編集の通し番号（送っている間に編集があったか）
  const emit = () => { if (opts.onState) opts.onState({ ...st, enabled }); };
  if (!enabled) st.status = 'off';
  else if (st.pendingSince != null) st.status = 'pending';

  function schedule() {
    clearTimer(timer);
    timer = null;
    if (!enabled || st.status === 'stopped' || st.status === 'sending' || st.pendingSince == null) { emit(); return; }
    const t = now();
    let at = (editAt ?? t) + delay;
    if (st.lastSentAt != null) at = Math.max(at, st.lastSentAt + d.minInterval);
    if (st.failures > 0 && st.failedAt != null) at = Math.max(at, st.failedAt + d.backoff[Math.min(st.failures, d.backoff.length) - 1]);
    st.nextAt = at;
    if (st.status !== 'error') st.status = 'pending';
    timer = setTimer(fire, Math.max(0, at - t));
    emit();
  }

  async function fire() {
    timer = null;
    if (!enabled || st.status === 'sending' || st.status === 'stopped') return;
    let content = null;
    try { content = opts.getContent(); } catch { content = null; }
    if (content == null) { st.status = 'idle'; st.pendingSince = null; st.nextAt = null; emit(); return; }
    const hash = feedbackHash(content);
    if (hash === st.lastHash) {
      // 中身が前に送ったものと同じ（戻した・関係ない編集）→ 送らない
      st.status = st.lastSentAt != null ? 'done' : 'idle'; st.pendingSince = null; st.nextAt = null; st.failures = 0; st.reason = '';
      emit();
      return;
    }
    const seqAtSend = seq;
    st.status = 'sending';
    st.nextAt = null;
    emit();
    let res;
    try { res = await opts.send(content); } catch (err) { res = { ok: false, status: null, message: (err && err.message) || '送れませんでした' }; }
    if (res && res.ok) {
      st.lastSentAt = now();
      st.lastHash = hash;
      st.failures = 0;
      st.reason = '';
      st.status = 'done';
      if (seq > seqAtSend) schedule(); // 送っている間の編集は次の回に
      else { st.pendingSince = null; emit(); }
      return;
    }
    st.reason = (res && res.message) || '送れませんでした';
    if (res && (res.status === 401 || res.status === 403)) { st.status = 'stopped'; st.nextAt = null; emit(); return; }
    st.status = 'error';
    st.failures++;
    st.failedAt = now();
    schedule();
  }

  return {
    /** 編集があった（kind: 'url' なら最後の編集から 15 秒、それ以外は 60 秒） */
    notify(kind = 'edit') {
      seq++;
      editAt = now();
      delay = kind === 'url' ? d.urlDelay : d.editDelay;
      if (st.pendingSince == null) st.pendingSince = editAt;
      if (st.status === 'sending') return;
      if (st.status === 'done' || st.status === 'idle') st.status = 'pending';
      schedule();
    },
    /** やり直し（ボタン・次の編集）。force で最短間隔・失敗の間隔を無視して今すぐ */
    flush(force = false) {
      if (!enabled) return;
      if (st.status === 'stopped') { st.status = 'pending'; st.failures = 0; }
      if (st.pendingSince == null) st.pendingSince = now();
      if (force) { clearTimer(timer); timer = null; fire(); return; }
      editAt = now() - delay;
      schedule();
    },
    setEnabled(v) {
      enabled = Boolean(v);
      if (!enabled) { clearTimer(timer); timer = null; st.status = 'off'; st.nextAt = null; emit(); return; }
      if (st.status === 'off' || st.status === 'stopped') st.status = st.pendingSince != null ? 'pending' : 'idle';
      if (st.pendingSince != null) schedule(); else emit();
    },
    /** 手で送ったとき（同じ中身は自動では送らない。止まっていたら再開） */
    markSent(content) {
      st.lastHash = feedbackHash(content);
      st.lastSentAt = now();
      st.failures = 0;
      st.reason = '';
      st.pendingSince = null;
      st.nextAt = null;
      clearTimer(timer);
      timer = null;
      st.status = enabled ? 'done' : 'off';
      emit();
    },
    state() { return { ...st, enabled }; },
  };
}
