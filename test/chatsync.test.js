// 複数ウィンドウの取りまとめ役（show/js/chatsync.js）の単体テスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLock, lockState, createLeaderLock, createSyncFilter, envelope, chatSnapshot, applySnapshot, isCollecting, LOCK_KEY, LOCK_TTL_MS, HEARTBEAT_MS, SYNC_VERSION } from '../show/js/chatsync.js';

/** 同じ localStorage を分け合う偽物 */
function memStorage() {
  const m = new Map();
  return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, String(v)), remove: (k) => m.delete(k), raw: m };
}

test('鍵の読み方・状態（自分／ほかが生きている／無い・失効）', () => {
  assert.equal(parseLock(null), null);
  assert.equal(parseLock('{broken'), null);
  assert.equal(parseLock('{"id":"","at":1}'), null);
  assert.deepEqual(parseLock('{"id":"a","at":5,"x":1}'), { id: 'a', at: 5 });
  assert.equal(lockState(null, 'me', 0), 'free');
  assert.equal(lockState({ id: 'me', at: 0 }, 'me', 999999), 'mine');
  assert.equal(lockState({ id: 'o', at: 1000 }, 'me', 1000 + LOCK_TTL_MS), 'held');
  assert.equal(lockState({ id: 'o', at: 1000 }, 'me', 1001 + LOCK_TTL_MS), 'free', '6 秒で失効');
  assert.equal(lockState({ id: 'o', at: 1e12 }, 'me', 1000), 'free', '時計が大きくずれた鍵も失効');
  assert.ok(HEARTBEAT_MS * 3 <= LOCK_TTL_MS, '2 回取りこぼしても失効しない');
});

test('取りまとめ役: 最初のウィンドウが取る・2 つ目はほか・鍵を 2 秒ごとに更新・止まったら引き継ぐ・閉じたらすぐ引き継げる・止まっていた方は降りる', () => {
  const st = memStorage();
  const A = createLeaderLock({ me: 'A', storage: st });
  const B = createLeaderLock({ me: 'B', storage: st });
  let r = A.tick(0);
  assert.deepEqual(r, { role: 'leader', changed: true, tookOver: false });
  assert.deepEqual(JSON.parse(st.get(LOCK_KEY)), { id: 'A', at: 0 });
  r = B.tick(100);
  assert.deepEqual(r, { role: 'follower', changed: false, tookOver: false });
  // A が 2 秒ごとに更新している間は B はほかのまま
  for (let t = 2000; t <= 20000; t += 2000) { A.tick(t); assert.equal(B.tick(t + 100).role, 'follower'); }
  assert.equal(JSON.parse(st.get(LOCK_KEY)).at, 20000);
  // A が止まる（更新しない）→ 6 秒をこえたら B が引き継ぐ
  assert.equal(B.tick(26000).role, 'follower');
  r = B.tick(26001);
  assert.deepEqual(r, { role: 'leader', changed: true, tookOver: true });
  assert.equal(JSON.parse(st.get(LOCK_KEY)).id, 'B');
  // 止まっていた A が動き出した: 鍵は B のもの → A は降りる
  r = A.tick(27000);
  assert.deepEqual(r, { role: 'follower', changed: true, tookOver: false });
  assert.equal(B.tick(28000).role, 'leader');
  // B が閉じる（release）→ A はすぐ取れる（引き継ぎ＝tookOver は鍵が消えたので false）
  B.release();
  assert.equal(st.get(LOCK_KEY), null);
  r = A.tick(28100);
  assert.deepEqual(r, { role: 'leader', changed: true, tookOver: false });
  // ほかの鍵を消さない
  B.release();
  assert.equal(JSON.parse(st.get(LOCK_KEY)).id, 'A');
  // 保存できない環境でも落ちない（ひとりで動く）
  const broken = { get: () => { throw new Error('denied'); }, set: () => { throw new Error('denied'); }, remove: () => {} };
  const solo = createLeaderLock({ me: 'S', storage: broken });
  assert.equal(solo.tick(0).role, 'leader');
});

test('メッセージ: 自分のもの・形の違うもの・同じ送り手の重複や古い seq は捨てる（開き直した送り手は受ける）', () => {
  const f = createSyncFilter('me');
  const m = (from, seq, at = 1000, type = 'state') => ({ ...envelope(from, seq, type), at });
  assert.equal(m('a', 1).v, SYNC_VERSION);
  assert.ok(f.accept(m('a', 1)));
  assert.ok(!f.accept(m('a', 1)), '重複');
  assert.ok(f.accept(m('a', 3)));
  assert.ok(!f.accept(m('a', 2)), '遅れて届いた古いもの');
  assert.ok(f.accept(m('b', 1)), '別の送り手');
  assert.ok(!f.accept(m('me', 9)), '自分');
  assert.ok(!f.accept({ v: 99, from: 'a', seq: 10, type: 'x' }), '版が違う');
  assert.ok(!f.accept({ v: SYNC_VERSION, from: 'a', type: 'x' }), 'seq なし');
  assert.ok(!f.accept(null));
  assert.ok(f.accept(m('a', 1, 999999)), '開き直した（seq 1 からで時刻が新しい）');
});

test('状態の配り方: 一覧・固定・画面から消した・BAN・使った量を 1 つにまとめ、受け手は壊れた値を無視して映す', () => {
  const chat = {
    status: 'running', reason: '', code: '', via: 'stream', fallback: '', videoId: 'dQw4w9WgXcQ', found: { title: 't', videoId: 'dQw4w9WgXcQ' }, count: 2,
    log: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }], hidden: new Set(['a']), banned: new Set(['UCx']), pin: { id: 'b' }, calls: { stream: 1 }, demoUntil: 5,
  };
  const snap = chatSnapshot(chat, { flow: false, previewObs: true });
  assert.deepEqual(snap.hidden, ['a']);
  assert.deepEqual(snap.banned, ['UCx']);
  assert.equal(snap.flow, false);
  assert.equal(snap.previewObs, true);
  assert.ok(!('demoUntil' in snap));
  const json = JSON.parse(JSON.stringify(snap)); // BroadcastChannel で運べる形
  const mine = { status: 'idle', log: [], hidden: new Set(), banned: new Set(), calls: { videos: 1 }, pin: null, demoUntil: 0 };
  const got = applySnapshot(mine, json);
  assert.equal(got.status, 'running');
  assert.deepEqual(got.log.map((x) => x.id), ['a', 'b']);
  assert.ok(got.hidden.has('a') && got.banned.has('UCx'));
  assert.equal(got.pin.id, 'b');
  assert.deepEqual(got.calls, { videos: 1, stream: 1 });
  assert.equal(applySnapshot(mine, null), mine);
  const bad = applySnapshot(mine, { log: [null, { id: 3 }, { id: 'ok' }], hidden: [1, 'h'] });
  assert.deepEqual(bad.log, [{ id: 'ok' }]);
  assert.deepEqual([...bad.hidden], ['h']);
  for (const s of ['starting', 'running', 'retrying', 'searching']) assert.ok(isCollecting(s), s);
  for (const s of ['idle', 'stopped', 'error', undefined]) assert.ok(!isCollecting(s), String(s));
});
