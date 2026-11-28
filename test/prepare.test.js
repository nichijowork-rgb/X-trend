// 「整理開始」と GitHub を通したボットへのお願い（show/js/prepare.js）の単体テスト:
// お願い・取り消しの形・待っているお願い・見に行く間隔・status.json・どうするか・下書き・投稿を足す。GitHub の読み書き（feedback.js）も
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PREPARE, isoJst, newRequestId, genrePriorityNames, toBotTopicId, buildPrepareRequest, cancelRequest, parsePending, tooSoonMinutes, pollDelay,
  parseStatus, decide, autoFinished, statusLine, busyText, errorText, hhmm, normalizeDraft, parseDraftFile, draftToPlan, mergePosts,
} from '../show/js/prepare.js';
import { putGitHubFile, getGitHubFile, saveFeedbackToGitHub } from '../show/js/feedback.js';
import { parseTimestamp } from '../assets/js/core.js';
import { defaultWeek } from '../show/js/logic.js';
import { BOARD } from '../show/js/config.js';

const sec = (iso) => Date.parse(iso) / 1000;

test('お願い（feedback/prepare-request.json）: 週・対象期間・決まり・決めたもの・修正の generated_at。取り消しは同じ id で cancel', () => {
  assert.equal(isoJst(sec('2026-11-22T01:00:00+09:00')), '2026-11-22T01:00:00+09:00');
  assert.equal(isoJst(sec('2026-12-31T23:59:59Z')), '2027-01-01T08:59:59+09:00');
  assert.match(newRequestId(Date.UTC(2026, 10, 28, 10, 10), () => 0.5), /^p-20261128-1910-[0-9a-z]{4}$/);
  assert.deepEqual(genrePriorityNames('kyaba'), ['キャバクラ', 'ホスト', '歌舞伎町', '夜職その他']);
  assert.deepEqual(genrePriorityNames('none'), ['ホスト', 'キャバクラ', '歌舞伎町', '夜職その他']);
  assert.equal(toBotTopicId('g:host-call'), 'host-call');
  assert.equal(toBotTopicId('m:abc'), 'm:abc');
  const now = Date.parse('2026-11-28T19:10:00+09:00');
  const req = buildPrepareRequest({
    id: 'p-20261128-1910-ab12', nowMs: now, force: true,
    week: { key: '2026-11-28', start: sec('2026-11-22T01:00:00+09:00'), end: sec('2026-11-29T01:00:00+09:00') },
    range: { start: sec('2026-11-22T01:00:00+09:00'), end: sec('2026-11-28T19:10:00+09:00') },
    priorityGenre: 'host', placedIds: ['g:host-call-2026w48', 'm:abc', 'p:123', 'g:host-call-2026w48'],
    manualTopics: [{ id: 'm:abc', name: '担当との別れ話', postIds: ['11111', '22222'] }], feedbackGeneratedAt: '2026-11-28T19:09:58+09:00',
  });
  assert.deepEqual(req, {
    app: 'xtrend-prepare', v: 1, id: 'p-20261128-1910-ab12', requested_at: '2026-11-28T19:10:00+09:00', force: true, cancel: false,
    week: { key: '2026-11-28', from: '2026-11-22T01:00:00+09:00', to: '2026-11-29T01:00:00+09:00' },
    range: { from: '2026-11-22T01:00:00+09:00', to: '2026-11-28T19:10:00+09:00' },
    rules: { main_slots: 3, main_night_only: true, genre_priority: ['ホスト', 'キャバクラ', '歌舞伎町', '夜職その他'], category_count: BOARD.draftCategory, chat_count: BOARD.draftChat, min_posts_for_main: 2 },
    keep: { placed_topic_ids: ['host-call-2026w48', 'm:abc', 'p:123'], manual_topics: [{ id: 'm:abc', name: '担当との別れ話', post_ids: ['11111', '22222'] }] },
    feedback_generated_at: '2026-11-28T19:09:58+09:00',
  });
  assert.deepEqual(Object.keys(req).slice(0, 7), ['app', 'v', 'id', 'requested_at', 'force', 'cancel', 'week']);
  const c = cancelRequest(req, now + 60000);
  assert.deepEqual([c.id, c.cancel, c.cancelled_at, c.week], [req.id, true, '2026-11-28T19:11:00+09:00', req.week]);
  assert.equal(req.cancel, false, '元は書き換えない');
  assert.equal(buildPrepareRequest({ id: 'x', nowMs: now, week: { key: 'k', start: 0, end: 1 }, range: { start: 0, end: 1 } }).force, false);
});

test('待っているお願い・10 分以内のもう一度・見に行く間隔（30 秒 → 10 分すぎたら 60 秒 → 3 時間であきらめる）', () => {
  assert.equal(parsePending(null), null);
  assert.equal(parsePending('{壊れた'), null);
  assert.equal(parsePending({ id: 'x', requestedAt: 1 }), null);
  assert.deepEqual(parsePending(JSON.stringify({ id: 'p-20261128-1910-ab12', requestedAt: 5, force: true, request: { a: 1 } })), { id: 'p-20261128-1910-ab12', requestedAt: 5, force: true, request: { a: 1 } });
  const t = 1_800_000_000_000;
  assert.equal(tooSoonMinutes(t, t + 60_000), 9);
  assert.equal(tooSoonMinutes(t, t + 10 * 60_000), 0);
  assert.equal(tooSoonMinutes(null, t), 0);
  assert.equal(tooSoonMinutes(t + 60 * 60_000, t), 0, '時計がずれている');
  assert.equal(pollDelay(0), 30_000);
  assert.equal(pollDelay(9 * 60_000), 30_000);
  assert.equal(pollDelay(10 * 60_000), 60_000);
  assert.equal(pollDelay(3 * 3600_000 - 1), 60_000);
  assert.equal(pollDelay(3 * 3600_000), null);
  assert.equal(pollDelay(0, { first: 200, giveUp: -1 }), 200, '確認用の上書き（正の数だけ）');
});

const ST = (extra) => ({ app: 'xtrend-prepare-status', v: 1, request_id: 'p-20261128-1910-ab12', state: 'running', stage: 'group', message: 'Grok がまとまりを作っています（412 件）', updated_at: '2026-11-28T19:42:00+09:00', eta_min: 15, result: null, error: null, ...extra });

test('status.json を読む: 形の確かめ・文字の掃除・result（commit）・error・busy', () => {
  assert.equal(parseStatus(null), null);
  assert.equal(parseStatus({ ...ST(), app: 'x' }), null);
  assert.equal(parseStatus({ ...ST(), v: 2 }), null);
  assert.equal(parseStatus(ST({ state: 'weird' })), null);
  const s = parseStatus(ST({ message: 'まとめ\u0007中', stage: 'hack', eta_min: -5 }));
  assert.deepEqual([s.requestId, s.state, s.stage, s.message, s.etaMin, s.updatedAt], ['p-20261128-1910-ab12', 'running', null, 'まとめ 中', 0, '2026-11-28T19:42:00+09:00']);
  const d = parseStatus(ST({ state: 'done', result: { commit: 'abc1234def', data_generated_at: '2026-11-28T20:01:00+09:00', new_posts: 86, topics: 74 } }));
  assert.deepEqual(d.result, { commit: 'abc1234def', dataGeneratedAt: '2026-11-28T20:01:00+09:00', newPosts: 86, topics: 74 });
  assert.equal(parseStatus(ST({ state: 'done', result: { commit: '../../etc' } })).result.commit, null, 'commit の形が違えば使わない');
  const e = parseStatus(ST({ state: 'busy', error: { code: 'too_soon', message: '少し前に実行しました', retry_after_min: 7 } }));
  assert.deepEqual(e.error, { code: 'too_soon', message: '少し前に実行しました', retryAfterMin: 7 });
  assert.equal(busyText(e), '少し前に実行しました（あと7分）');
  assert.equal(busyText(parseStatus(ST({ state: 'busy', error: { code: 'running' } }))), 'ボットはほかの整理をしています');
  assert.equal(errorText(parseStatus(ST({ state: 'error', error: { code: 'x_rate_limited', message: 'X の上限に達しました', retry_after_min: 15 } }))), 'X の上限に達しました（15分後にもう一度できます）');
  assert.equal(errorText(parseStatus(ST({ state: 'error' }))), 'ボットでエラーが起きました');
});

test('どうするか: 自分の id だけ見る・ほかの整理は知らせだけ・10 分返事が無ければ聞く（待ち続けるなら聞かない）・done／error／busy／cancelled・3 時間であきらめる', () => {
  const pending = { id: 'p-20261128-1910-ab12', requestedAt: 0 };
  const st = (x) => parseStatus(ST(x));
  assert.deepEqual(decide(null, pending, 60_000), { action: 'wait', ours: false, other: false });
  assert.deepEqual(decide(st({ request_id: 'auto-20261128-1800' }), pending, 60_000), { action: 'wait', ours: false, other: true });
  assert.deepEqual(decide(st({ request_id: 'auto-20261128-1800', state: 'done' }), pending, 60_000), { action: 'wait', ours: false, other: false });
  assert.equal(decide(null, pending, 10 * 60_000).action, 'noreply');
  assert.equal(decide(st({ request_id: 'p-other' }), pending, 11 * 60_000).action, 'noreply');
  assert.equal(decide(null, pending, 11 * 60_000, { keepWaiting: true }).action, 'wait');
  assert.equal(decide(st({ state: 'queued' }), pending, 11 * 60_000).action, 'wait', '自分の知らせがあれば待つ');
  assert.deepEqual(decide(st({}), pending, 60_000), { action: 'wait', ours: true, other: false });
  for (const [state, action] of [['done', 'done'], ['error', 'error'], ['busy', 'busy'], ['cancelled', 'cancelled']]) assert.equal(decide(st({ state }), pending, 60_000).action, action);
  assert.equal(decide(st({}), pending, 3 * 3600_000).action, 'giveup');
  assert.equal(decide(st({}), null, 0).action, 'wait');
  assert.equal(decide(null, pending, 1000, { delays: { noReply: 500 } }).action, 'noreply', '確認用の上書き');
});

test('ボットの自動整理（auto-…）が終わった知らせ・板の上の一文', () => {
  const done = parseStatus(ST({ request_id: 'auto-20261128-1800', state: 'done', finished_at: '2026-11-28T18:40:00+09:00', result: { commit: 'abc1234' } }));
  assert.equal(autoFinished(done, null), true);
  assert.equal(autoFinished(done, 'auto-20261128-1800'), false, '反映した・見送ったもの');
  assert.equal(autoFinished(parseStatus(ST({ state: 'done', result: { commit: 'abc1234' } })), null), false, '自分のお願い');
  assert.equal(autoFinished(parseStatus(ST({ request_id: 'auto-1', state: 'running' })), null), false);
  assert.equal(autoFinished(null, null), false);
  assert.equal(hhmm('2026-11-28T18:40:00+09:00', parseTimestamp), '18:40');
  assert.equal(hhmm(null, parseTimestamp), '');
  assert.equal(statusLine(parseStatus(ST()), { parseTs: parseTimestamp }), 'ボットが整理中：Grok がまとまりを作っています（412 件）（19:42 更新・あと 15分ほど）');
  assert.equal(statusLine(parseStatus(ST({ message: '', eta_min: null })), { parseTs: parseTimestamp }), 'ボットが整理中：まとまりを作っています（19:42 更新）');
  assert.equal(statusLine(parseStatus(ST({ state: 'queued', message: '' })), { parseTs: parseTimestamp }), 'ボットが受け付けました（順番を待っています）（19:42 更新）');
  assert.equal(statusLine(parseStatus(ST({ request_id: 'auto-1' })), { ours: false, parseTs: parseTimestamp }), 'ボットがほかの整理をしています：Grok がまとまりを作っています（412 件）（19:42 更新・あと 15分ほど）');
  assert.equal(statusLine(null), 'ボットにお願いしました（受け付けを待っています）');
});

test('GitHub の読み書き: 書くのは feedback/ だけ（ぶつかったら 1 回やり直す）・読むのは raw で ref つき・失敗は日本語', async () => {
  const calls = [];
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body });
  let conflict = true;
  const fetchImpl = async (url, o) => {
    calls.push({ url, method: o.method, headers: o.headers, body: o.body ? JSON.parse(o.body) : null });
    if (o.method === 'GET') return url.includes('prepare-request') ? res(200, { sha: 'old' }) : res(404, {});
    if (conflict) { conflict = false; return res(409, {}); }
    return res(201, { commit: { html_url: 'https://github.com/o/r/commit/1' } });
  };
  const r = await putGitHubFile({ fetchImpl, repo: 'o/r', branch: 'b', token: 't', path: PREPARE.requestPath, content: '{"a":"あ"}', message: 'prepare: request p-1' });
  assert.deepEqual([r.ok, r.created], [true, true]);
  const puts = calls.filter((c) => c.method === 'PUT');
  assert.equal(puts.length, 2);
  assert.deepEqual([puts[1].body.message, puts[1].body.branch, puts[1].body.sha, Buffer.from(puts[1].body.content, 'base64').toString('utf8')], ['prepare: request p-1', 'b', 'old', '{"a":"あ"}']);
  assert.equal(puts[0].url, 'https://api.github.com/repos/o/r/contents/feedback/prepare-request.json');
  for (const path of ['data/posts.json', 'feedback/../data/x.json', 'feedback/a/b.json', 'feedback/x.txt']) {
    assert.equal((await putGitHubFile({ fetchImpl, repo: 'o/r', branch: 'b', token: 't', path, content: '{}', message: 'm' })).ok, false, path);
  }
  const fb = await saveFeedbackToGitHub({ fetchImpl, repo: 'o/r', branch: 'b', token: 't', content: '{}', nowMs: 0 });
  assert.equal(fb.ok, true);
  assert.ok(calls.at(-1).url.endsWith('/contents/feedback/show-feedback.json') && calls.at(-1).body.message.startsWith('feedback: show edits'));
  // 読む
  const got = [];
  const getImpl = async (url, o) => { got.push({ url, o }); return url.includes('status') ? res(200, ST()) : res(404, {}); };
  let g = await getGitHubFile({ fetchImpl: getImpl, repo: 'o/r', ref: 'claude/x-y', token: 't', path: PREPARE.statusPath });
  assert.deepEqual([g.ok, g.json.state], [true, 'running']);
  assert.equal(got[0].url, 'https://api.github.com/repos/o/r/contents/data/show/status.json?ref=claude%2Fx-y');
  assert.deepEqual([got[0].o.headers.Accept, got[0].o.headers.Authorization, got[0].o.cache], ['application/vnd.github.raw+json', 'Bearer t', 'no-store']);
  g = await getGitHubFile({ fetchImpl: getImpl, repo: 'o/r', ref: 'abc1234', token: 't', path: PREPARE.postsPath });
  assert.deepEqual([g.ok, g.status], [false, 404]);
  assert.ok(got.at(-1).url.endsWith('/contents/data/posts.json?ref=abc1234'));
  for (const [ref, path] of [['bad ref', PREPARE.statusPath], ['main', '../x.json'], ['main', 'show/x.json'], ['main', 'data/../feedback/x.json']]) {
    assert.equal((await getGitHubFile({ fetchImpl: getImpl, repo: 'o/r', ref, token: 't', path })).ok, false, `${ref} ${path}`);
  }
  g = await getGitHubFile({ fetchImpl: async () => { throw new Error('offline'); }, repo: 'o/r', ref: 'main', token: 't', path: PREPARE.statusPath });
  assert.match(g.message, /通信できませんでした/);
});

// ---------------------------------------------------------------- 下書き

test('下書きファイル: 形・番組週・12 時間以内だけ使う。最大数で切る・同じ id は 1 回', () => {
  const now = Date.parse('2026-12-04T20:00:00+09:00');
  const raw = {
    generated_at: '2026-12-04T19:14:02+09:00', week: '2026-12-05', request_id: 'p-1',
    main: [{ topic_id: 'a', reason: '一番' }, { topic_id: 'a' }, { topic_id: 'b' }, { topic_id: 'c' }, { topic_id: 'd' }],
    category: Array.from({ length: 10 }, (_, i) => ({ topic_id: `k${i}` })), chat: [{ topic_id: 'z' }, { nope: 1 }, 'x'],
  };
  const d = normalizeDraft(raw);
  assert.deepEqual(d.main, [{ id: 'a', reason: '一番' }, { id: 'b', reason: null }, { id: 'c', reason: null }]);
  assert.equal(d.category.length, BOARD.draftCategory);
  assert.deepEqual(d.chat, [{ id: 'z', reason: null }]);
  assert.equal(normalizeDraft({ week: 'x' }), null);
  assert.equal(normalizeDraft([]), null);
  const opt = { weekKey: '2026-12-05', nowMs: now, parseTs: parseTimestamp };
  assert.equal(parseDraftFile(raw, opt).ok, true);
  assert.equal(parseDraftFile({ ...raw, week: '2026-11-28' }, opt).reason, 'week');
  assert.equal(parseDraftFile({ ...raw, generated_at: '2026-12-04T07:00:00+09:00' }, opt).reason, 'stale', '13 時間前');
  assert.equal(parseDraftFile({ ...raw, generated_at: null }, opt).reason, 'stale');
  assert.equal(parseDraftFile({ ...raw, generated_at: '2026-12-05T09:00:00+09:00' }, opt).reason, 'stale', '未来すぎ');
  assert.equal(parseDraftFile('x', opt).reason, 'shape');
  // 自分のお願いの結果（request_id が同じ）なら古さは見ない
  assert.equal(parseDraftFile({ ...raw, generated_at: '2026-12-01T07:00:00+09:00' }, { ...opt, requestId: 'p-1' }).ok, true);
  assert.equal(parseDraftFile({ ...raw, generated_at: '2026-12-01T07:00:00+09:00' }, { ...opt, requestId: 'p-2' }).reason, 'stale');
});

test('下書き → 番組の流れ: g:<id> にして空いている所だけ。無い・使えない・入っている・決まりに合わないものは飛ばす', () => {
  const T = (id, genre) => ({ id, genre, postIds: ['1', '2'], stats: { count: 2 } });
  const topics = [T('g:h1', 'host'), T('g:h2', 'host'), T('g:k1', 'kyaba'), T('g:gen', 'general'), T('g:held', 'host'), T('g:b1', 'kabuki'), T('g:n1', 'night'), T('g:g2', 'general'), T('m:own', 'host')];
  const topicsById = new Map(topics.map((t) => [t.id, t]));
  const visibleIds = new Set(topics.filter((t) => t.id !== 'g:held').map((t) => t.id));
  const week = defaultWeek();
  week.rundown.corners[0].items = [null, 'm:own', null]; // 番組オーナーが入れたメイン2
  const draft = normalizeDraft({
    main: [{ topic_id: 'nope' }, { topic_id: 'gen' }, { topic_id: 'h1', reason: '一番' }],
    category: [{ topic_id: 'held' }, { topic_id: 'h1' }, { topic_id: 'h2' }, { topic_id: 'g2' }, { topic_id: 'b1' }, { topic_id: 'n1' }],
    chat: [{ topic_id: 'n1' }, { topic_id: 'g2' }, { topic_id: 'gen' }],
  });
  let plan = draftToPlan(draft, { week, topicsById, visibleIds });
  assert.deepEqual(plan.main, [{ slot: 0, id: 'g:h1' }], '無いもの・一般はメインに入れない・メイン2 は動かさない');
  assert.deepEqual(plan.category, ['g:h2', 'g:b1', 'g:n1'], '保留・メインに使ったもの・一般は飛ばす');
  assert.deepEqual(plan.chat, ['g:g2', 'g:gen'], '夜職は雑談に入れない');
  assert.equal(plan.skipped, 6);
  assert.equal(plan.reasons.get('g:h1'), '一番');
  // 入っているコーナーには足さない・メインが埋まっていれば入れない
  week.rundown.corners[0].items = ['m:own', 'g:h2', 'g:b1'];
  week.rundown.corners[1].items = ['g:n1'];
  plan = draftToPlan(draft, { week, topicsById, visibleIds });
  assert.deepEqual([plan.main, plan.category, plan.chat], [[], [], ['g:g2', 'g:gen']]);
  assert.deepEqual(plan.empty, { main: 0, category: false, chat: true });
  assert.deepEqual(draftToPlan(null, { week, topicsById }).main, []);
});

test('届いた投稿を足す: 同じ id は新しいほうに置きかえ・ほかはそのまま・形の違うものは捨てる・generated_at は新しいときだけ進める', () => {
  const base = { generated_at: '2026-12-04T06:41:00+09:00', categories: ['ホスト'], posts: [{ id: '11111', text: 'old', metrics: { impression_count: 1 } }, { id: '22222', text: 'keep' }] };
  const r = mergePosts(base, [{ id: '11111', text: 'new', metrics: { impression_count: 9 } }, { id: 33333, text: 'added' }, { id: 'abc' }, null, ['x'], { id: '44444', text: 'added2' }], '2026-12-04T19:14:02+09:00', parseTimestamp);
  assert.deepEqual([r.added, r.replaced], [2, 1]);
  assert.deepEqual(r.raw.posts.map((p) => [p.id, p.text]), [['11111', 'new'], ['22222', 'keep'], ['33333', 'added'], ['44444', 'added2']]);
  assert.equal(r.raw.generated_at, '2026-12-04T19:14:02+09:00');
  assert.deepEqual(r.raw.categories, ['ホスト']);
  assert.equal(base.posts[0].text, 'old', '元は書き換えない');
  assert.equal(mergePosts(base, [], '2026-12-01T00:00:00+09:00', parseTimestamp).raw.generated_at, base.generated_at, '古ければそのまま');
  assert.equal(mergePosts(null, [{ id: '55555' }]).raw.posts.length, 1);
});
