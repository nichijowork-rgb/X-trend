import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { dueSlots, nextRuns, localParts, zonedToUtc } from '../src/scheduler.js';
import { defaultSettings, mergeSettings } from '../src/settings.js';
import { clusterPosts } from '../src/topics.js';

const NOW = new Date('2026-10-10T03:00:00.000Z'); // JST 12:00 (土)
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'xtrend-'));
const dirs = [];

async function mk({ dataDir, env = {}, integrations, now = NOW } = {}) {
  const dir = dataDir ?? tmp();
  if (!dataDir) dirs.push(dir);
  const clock = { t: new Date(now) };
  const app = createApp({ dataDir: dir, env, integrations, now: () => clock.t });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const addr = app.server.address();
  const base = `http://127.0.0.1:${addr.port}`;
  const api = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非JSON */
    }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { app, api, base, clock, dir, close: () => app.close() };
}

const NULLM = { views: null, likes: null, reposts: null, replies: null, bookmarks: null };
const post = (id, o = {}) => ({
  postId: String(id),
  url: null,
  authorHandle: o.handle ?? 'tester',
  authorName: null,
  text: o.text ?? `ホストの話題 ${id} について`,
  postedAt: o.postedAt ?? '2026-10-10T01:00:00.000Z',
  metrics: { ...NULLM, ...(o.metrics ?? {}) },
  metricsFetchedAt: o.metrics ? '2026-10-10T02:00:00.000Z' : null,
  source: o.source ?? { type: 'import_json', detail: 'a.json' },
  genreHint: o.hint ?? 'nightlife',
  matchedKeywords: [],
  lang: 'ja',
  raw: null,
});

test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test('サンプル自動ロードと削除後の空データで全APIが正常応答', async () => {
  const t = await mk();
  let st = (await t.api('GET', '/api/status')).json;
  assert.equal(st.sampleMode, true);
  assert.ok(st.samplePostCount >= 35);
  const posts = (await t.api('GET', '/api/posts?limit=200')).json;
  assert.ok(posts.items.every((p) => p.isSample));
  assert.ok(posts.items.some((p) => p.metrics.likes === null));
  assert.ok(posts.items.every((p) => p.authorHandle.startsWith('sample_')));
  assert.equal(posts.rankingNote, '取得した候補内の順位です（X全体の順位ではありません）');

  assert.equal((await t.api('DELETE', '/api/sample')).status, 200);
  st = (await t.api('GET', '/api/status')).json;
  assert.equal(st.sampleMode, false);
  assert.equal(st.samplePostCount, 0);
  for (const p of ['/api/posts', '/api/topics', '/api/digests', '/api/dismissals', '/api/runs', '/api/settings', '/api/backups', '/api/backup', '/api/share', '/api/bookmarklet']) {
    const r = await t.api('GET', p);
    assert.ok(r.status === 200 || (p === '/api/bookmarklet' && r.status === 501), `${p} -> ${r.status}`);
  }
  assert.deepEqual((await t.api('GET', '/api/posts')).json.items, []);
  // 再起動してもサンプルは復活しない
  await t.close();
  const t2 = await mk({ dataDir: t.dir });
  assert.equal((await t2.api('GET', '/api/status')).json.samplePostCount, 0);
  await t2.close();
});

test('実データが入るとサンプルは既定で除外される', async () => {
  const t = await mk();
  t.app.store.upsertPosts([post(1001, { metrics: { likes: 5 } })]);
  const st = (await t.api('GET', '/api/status')).json;
  assert.equal(st.sampleMode, false);
  assert.equal(st.realPostCount, 1);
  assert.ok(st.samplePostCount > 0);
  const r = (await t.api('GET', '/api/posts')).json;
  assert.equal(r.total, 1);
  assert.equal(r.items[0].isSample, false);
  await t.close();
});

test('不明指標は null のまま、並べ替えで末尾', async () => {
  const t = await mk();
  await t.api('DELETE', '/api/sample');
  t.app.store.upsertPosts([
    post(1, { metrics: { likes: 10, views: 100 } }),
    post(2),
    post(3, { metrics: { likes: 500 } }),
    post(4, { metrics: { likes: 0 } }),
  ]);
  for (const sort of ['likes', 'views']) {
    const r = (await t.api('GET', `/api/posts?sort=${sort}`)).json;
    const vals = r.items.map((p) => p.metrics[sort]);
    const firstNull = vals.indexOf(null);
    assert.ok(firstNull >= 0 && vals.slice(firstNull).every((v) => v === null), `${sort}: ${vals}`);
  }
  const likes = (await t.api('GET', '/api/posts?sort=likes')).json.items;
  assert.deepEqual(likes.map((p) => p.postId), ['3', '1', '4', '2']);
  assert.equal(likes[3].metrics.likes, null);
  assert.equal(likes[3].metrics.views, null);
  assert.deepEqual(likes.map((p) => p.rank), [1, 2, 3, 4]);
  await t.close();
});

test('重複統合：sources追記・mergedCount・非null優先・指標を消さない', async () => {
  const t = await mk();
  await t.api('DELETE', '/api/sample');
  const { store } = t.app;
  store.upsertPosts([post(77, { text: '最初の本文 ホスト', metrics: { likes: 10, views: 200 }, source: { type: 'import_json', detail: 'a.json' } })]);
  store.upsertPosts([{ ...post(77, { source: { type: 'url', detail: 'https://x.com/i/web/status/77' } }), text: null, authorHandle: null }]);
  store.upsertPosts([post(77, { text: '最初の本文 ホスト', metrics: { likes: 10, views: 200 }, source: { type: 'import_json', detail: 'a.json' } })]);
  const p = store.getPost('77');
  assert.equal(p.mergedCount, 3);
  assert.equal(p.sources.length, 2);
  assert.equal(p.text, '最初の本文 ホスト');
  assert.equal(p.authorHandle, 'tester');
  assert.equal(p.metrics.likes, 10);
  assert.equal(p.metrics.views, 200);
  // 新しい指標で更新、一部のみnullでも最新スナップショットを表示
  t.clock.t = new Date('2026-10-10T05:00:00.000Z');
  store.upsertPosts([{ ...post(77, { metrics: { likes: 99 } }), metricsFetchedAt: '2026-10-10T04:00:00.000Z' }]);
  assert.equal(store.getPost('77').metrics.likes, 99);
  assert.equal(store.queryPosts({}).total, 1);
  await t.close();
});

test('繰り返し操作の冪等性（URL保存・興味なし登録・restore）', async () => {
  const integrations = {
    url: {
      parsePostUrl: (s) => {
        const m = String(s).match(/status\/(\d+)/);
        return m ? { postId: m[1], authorHandle: 'abc', url: `https://x.com/abc/status/${m[1]}` } : null;
      },
      fetchOEmbed: async () => ({ authorName: '名前', authorHandle: 'abc', text: 'oEmbed本文', postedAt: '2026-10-10T00:00:00.000Z' }),
    },
  };
  const t = await mk({ integrations });
  await t.api('DELETE', '/api/sample');
  const u = 'https://x.com/abc/status/555';
  const a = (await t.api('POST', '/api/posts/url', { url: u })).json;
  const b = (await t.api('POST', '/api/posts/url', { url: u })).json;
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(b.post.text, 'oEmbed本文');
  assert.equal((await t.api('GET', '/api/posts')).json.total, 1);
  assert.equal((await t.api('POST', '/api/posts/url', { url: 'https://example.com/' })).status, 400);

  const d1 = (await t.api('POST', '/api/dismissals', { scope: 'author', value: '@ABC', reasonCode: 'off_topic' })).json.dismissal;
  const d2 = (await t.api('POST', '/api/dismissals', { scope: 'author', value: 'abc', reasonCode: 'off_topic' })).json.dismissal;
  assert.equal(d1.id, d2.id);
  assert.equal((await t.api('GET', '/api/dismissals')).json.items.length, 1);
  assert.equal(d1.matchCount, 1);
  await t.api('POST', `/api/dismissals/${d1.id}/revoke`);
  const r1 = await t.api('POST', `/api/dismissals/${d1.id}/revoke`);
  assert.ok(r1.json.dismissal.revokedAt);
  const x = await t.api('POST', `/api/dismissals/${d1.id}/restore`);
  const y = await t.api('POST', `/api/dismissals/${d1.id}/restore`);
  assert.equal(x.json.dismissal.revokedAt, null);
  assert.equal(y.json.dismissal.id, d1.id);
  assert.equal((await t.api('GET', '/api/dismissals?includeRevoked=1')).json.items.length, 1);
  assert.equal((await t.api('POST', '/api/dismissals', { scope: 'bogus', value: 'x' })).status, 400);
  await t.close();
});

test('興味なし：登録で非表示、取消で再表示、demoteは順位に反映', async () => {
  const t = await mk();
  await t.api('DELETE', '/api/sample');
  t.app.store.upsertPosts([
    post(11, { handle: 'alice', text: 'ホスト 通常の投稿 A', metrics: { likes: 1000, views: 50000 } }),
    post(12, { handle: 'bob', text: 'ホスト VTuber 配信まとめ', metrics: { likes: 5000, views: 90000 } }),
    post(13, { handle: 'carol', text: 'ホスト 別の通常投稿 C', metrics: { likes: 300, views: 9000 } }),
  ]);
  const order = async () => (await t.api('GET', '/api/posts?sort=score')).json.items.map((p) => p.postId);
  assert.deepEqual(await order(), ['12', '11', '13']);

  const dem = (await t.api('POST', '/api/dismissals', { scope: 'keyword', value: 'vtuber', reasonCode: 'vtuber', effect: 'demote' })).json.dismissal;
  assert.equal(dem.matchCount, 1);
  const demoted = (await t.api('GET', '/api/posts?sort=score')).json.items;
  assert.deepEqual(demoted.map((p) => p.postId), ['11', '13', '12']);
  assert.equal(demoted[2].demoted, true);
  assert.equal(demoted[2].matchedDismissals[0].reasonCode, 'vtuber');
  assert.equal(demoted[2].rank, 3);
  await t.api('POST', `/api/dismissals/${dem.id}/revoke`);
  assert.deepEqual(await order(), ['12', '11', '13']);

  const hide = (await t.api('POST', '/api/dismissals', { scope: 'post', value: '11', reasonCode: 'staged' })).json.dismissal;
  const hidden = (await t.api('GET', '/api/posts')).json;
  assert.equal(hidden.total, 2);
  assert.equal(hidden.hiddenCount, 1);
  assert.ok(!hidden.items.some((p) => p.postId === '11'));
  const inc = (await t.api('GET', '/api/posts?includeHidden=1')).json;
  assert.equal(inc.items.find((p) => p.postId === '11').hidden, true);
  await t.api('POST', `/api/dismissals/${hide.id}/revoke`);
  assert.equal((await t.api('GET', '/api/posts')).json.total, 3);
  await t.api('POST', `/api/dismissals/${hide.id}/restore`);
  assert.equal((await t.api('GET', '/api/posts')).json.total, 2);
  await t.close();
});

test('保存→アプリ再生成→復元（永続化）', async () => {
  const t = await mk();
  await t.api('DELETE', '/api/sample');
  t.app.store.upsertPosts([post(21, { metrics: { likes: 7 } })]);
  await t.api('POST', '/api/dismissals', { scope: 'author', value: 'zzz' });
  await t.api('PUT', '/api/settings', { settings: { keywords: { general: ['天気'] } } });
  const share = t.app.auth.shareUrl('http://x');
  await t.close();
  const t2 = await mk({ dataDir: t.dir });
  assert.equal((await t2.api('GET', '/api/posts')).json.items[0].metrics.likes, 7);
  assert.equal((await t2.api('GET', '/api/dismissals')).json.items.length, 1);
  assert.deepEqual((await t2.api('GET', '/api/settings')).json.settings.keywords.general, ['天気']);
  assert.equal(share, null);
  await t2.close();
});

test('バックアップ→replaceリストア／mergeリストア', async () => {
  const t = await mk();
  await t.api('DELETE', '/api/sample');
  t.app.store.upsertPosts([post(31, { metrics: { likes: 3 } }), post(32)]);
  await t.api('POST', '/api/dismissals', { scope: 'keyword', value: 'テスト' });
  await t.api('POST', '/api/jobs/run', { job: 'daily_digest' });
  const resp = await t.api('GET', '/api/backup');
  assert.match(resp.headers.get('content-disposition'), /attachment/);
  const backup = resp.json;
  assert.equal(backup.posts.length, 2);

  t.app.store.upsertPosts([post(33)]);
  await t.api('POST', '/api/dismissals', { scope: 'author', value: 'later' });
  const rep = (await t.api('POST', '/api/restore', { backup, mode: 'replace' })).json;
  assert.equal(rep.restored.posts, 2);
  assert.equal((await t.api('GET', '/api/posts')).json.total, 2);
  assert.equal((await t.api('GET', '/api/dismissals')).json.items.length, 1);
  assert.equal((await t.api('GET', '/api/posts?sort=likes')).json.items[0].metrics.likes, 3);
  assert.equal((await t.api('GET', '/api/digests')).json.items.length, 1);

  t.app.store.upsertPosts([post(34)]);
  await t.api('POST', '/api/restore', { backup, mode: 'merge' });
  await t.api('POST', '/api/restore', { backup, mode: 'merge' });
  assert.equal((await t.api('GET', '/api/posts')).json.total, 3);
  assert.equal((await t.api('GET', '/api/dismissals')).json.items.length, 1);
  assert.equal((await t.api('GET', '/api/digests')).json.items.length, 1);
  assert.equal(t.app.store.getPost('31').mergedCount, 1);
  assert.equal((await t.api('POST', '/api/restore', { backup: { format: 'x' }, mode: 'replace' })).status, 400);

  // 自動バックアップと世代管理
  for (let i = 0; i < 4; i++) {
    t.app.settings.update({ schedule: { autoBackup: { keep: 2 } } });
    const run = (await t.api('POST', '/api/jobs/run', { job: 'backup' })).json.run;
    assert.equal(run.status, 'ok', run.message);
  }
  const list = (await t.api('GET', '/api/backups')).json.items;
  assert.equal(list.length, 2);
  assert.deepEqual(readdirSync(path.join(t.dir, 'backups')).length, 2);
  const re = await t.api('POST', `/api/backups/${list[0].name}/restore`, { mode: 'replace' });
  assert.equal(re.status, 200);
  assert.equal((await t.api('POST', '/api/backups/..%2Fx.json/restore', {})).status, 400);
  await t.close();
});

test('認証：ADMIN_TOKEN設定時の 401/403 と共有トークン', async () => {
  const t = await mk({ env: { ADMIN_TOKEN: 'secret-admin' } });
  const st = await t.api('GET', '/api/status');
  assert.equal(st.status, 200);
  assert.equal(st.json.authRequired, true);
  assert.equal(st.json.sampleMode, undefined);
  assert.equal((await t.api('GET', '/api/posts')).status, 401);
  assert.equal((await t.api('GET', '/api/posts', undefined, { 'X-Admin-Token': 'wrong' })).status, 401);
  assert.equal((await t.api('POST', '/api/dismissals', { scope: 'author', value: 'a' })).status, 401);

  const admin = { 'X-Admin-Token': 'secret-admin' };
  assert.equal((await t.api('GET', '/api/posts', undefined, admin)).status, 200);
  const share = (await t.api('GET', '/api/share', undefined, admin)).json;
  assert.ok(share.authRequired);
  const token = new URL(share.shareUrl).searchParams.get('share');
  assert.equal(new URL(share.shareUrl).host, new URL(t.base).host);
  const viewer = { 'X-Share-Token': token };
  const vs = await t.api('GET', '/api/status', undefined, viewer);
  assert.equal(vs.json.role, 'viewer');
  assert.equal((await t.api('GET', '/api/posts', undefined, viewer)).status, 200);
  assert.equal((await t.api('POST', '/api/dismissals', { scope: 'author', value: 'a' }, viewer)).status, 403);
  assert.equal((await t.api('GET', '/api/share', undefined, viewer)).status, 403);
  assert.equal((await t.api('GET', '/api/backup', undefined, viewer)).status, 403);
  assert.equal((await t.api('DELETE', '/api/sample', undefined, viewer)).status, 403);
  assert.equal((await t.api('POST', '/api/dismissals', { scope: 'author', value: 'a' }, admin)).status, 200);

  const rot = (await t.api('POST', '/api/share/rotate', {}, admin)).json;
  assert.notEqual(new URL(rot.shareUrl).searchParams.get('share'), token);
  assert.equal((await t.api('GET', '/api/posts', undefined, viewer)).status, 401);
  assert.ok(!JSON.stringify((await t.api('GET', '/api/settings', undefined, viewer)).json).includes('secret-admin'));
  await t.close();
});

test('ローカルモードでは role=admin でトークン不要', async () => {
  const t = await mk();
  const st = (await t.api('GET', '/api/status')).json;
  assert.equal(st.role, 'admin');
  assert.equal(st.authRequired, false);
  assert.equal((await t.api('GET', '/api/share')).json.shareUrl, null);
  await t.close();
});

test('スケジューラ：曜日・時刻・TZ・窓', () => {
  const s = defaultSettings();
  const jst = (iso) => new Date(iso);
  // JST 09:05 土曜(2026-10-10) = 00:05Z
  let slots = dueSlots(s, jst('2026-10-10T00:05:00Z'));
  assert.deepEqual(slots.map((x) => x.slot), ['collect:2026-10-10T09:00']);
  // 窓を過ぎたら実行しない
  assert.deepEqual(dueSlots(s, jst('2026-10-10T01:00:00Z')), []);
  // 月曜 10:00 JST に週次
  slots = dueSlots(s, jst('2026-10-12T01:00:00Z'));
  assert.deepEqual(slots.map((x) => x.job).sort(), ['weekly_digest']);
  // 土曜 10:00 JST に週次は出ない
  assert.ok(!dueSlots(s, jst('2026-10-10T01:00:00Z')).some((x) => x.job === 'weekly_digest'));
  // 04:00 バックアップ・23:30 日次
  assert.deepEqual(dueSlots(s, jst('2026-10-09T19:01:00Z')).map((x) => x.job), ['backup']);
  assert.deepEqual(dueSlots(s, jst('2026-10-10T14:31:00Z')).map((x) => x.job), ['daily_digest']);
  // タイムゾーン変更：New York の 09:00 = 13:00Z (EDT)
  const ny = mergeSettings(s, { schedule: { timezone: 'America/New_York' } });
  assert.deepEqual(dueSlots(ny, jst('2026-10-10T13:02:00Z')).map((x) => x.slot), ['collect:2026-10-10T09:00']);
  assert.deepEqual(dueSlots(ny, jst('2026-10-10T00:05:00Z')), []);
  // 曜日はTZ基準：UTC日曜 15:30 は JST 月曜 00:30
  assert.equal(localParts(jst('2026-10-11T15:30:00Z'), 'Asia/Tokyo').weekday, 1);
  assert.equal(zonedToUtc(2026, 10, 10, 9, 0, 'Asia/Tokyo').toISOString(), '2026-10-10T00:00:00.000Z');
  const next = nextRuns(s, jst('2026-10-10T03:00:00Z'));
  assert.equal(next.find((x) => x.job === 'weekly_digest').at, '2026-10-12T01:00:00.000Z');
  assert.equal(next.find((x) => x.job === 'collect').at, '2026-10-10T12:00:00.000Z');
});

test('スケジューラ：二重実行防止（再起動後も）', async () => {
  const t = await mk({ now: '2026-10-10T00:05:00Z' });
  const first = await t.app.scheduler.tick();
  assert.deepEqual(first.map((r) => r.job), ['collect']);
  assert.equal(first[0].status, 'skipped');
  assert.deepEqual(await t.app.scheduler.tick(), []);
  await t.close();
  const t2 = await mk({ dataDir: t.dir, now: '2026-10-10T00:10:00Z' });
  assert.deepEqual(await t2.app.scheduler.tick(), []);
  assert.equal((await t2.api('GET', '/api/runs')).json.items.length, 1);
  t2.clock.t = new Date('2026-10-10T12:03:00Z'); // JST 21:03
  assert.deepEqual((await t2.app.scheduler.tick()).map((r) => r.job), ['collect']);
  await t2.close();
});

test('収集ジョブ：未接続はskipped、接続時は夜職の1日上限を守る', async () => {
  const t = await mk();
  const r = (await t.api('POST', '/api/jobs/run', { job: 'collect' })).json.run;
  assert.equal(r.status, 'skipped');
  assert.match(r.message, /未接続/);
  await t.close();

  let n = 100000;
  const mkPosts = (count, q) =>
    Array.from({ length: count }, () => {
      n += 1;
      return post(n, { text: `${q} の投稿 ${n}`, source: { type: 'x_api_search', detail: q } });
    });
  const calls = [];
  const xapi = {
    isConfigured: () => ({ search: true, home: false }),
    searchRecent: async ({ query }) => {
      calls.push(query);
      return { posts: mkPosts(30, 'ホスト') };
    },
    homeTimeline: async () => ({ posts: [] }),
  };
  const grok = {
    isConfigured: () => true,
    searchX: async ({ query }) => ({ posts: mkPosts(5, query) }),
    suggestTopics: async () => ({ topics: [{ label: '話題A', query: 'A' }, { label: '話題B', query: 'B' }] }),
    summarize: async () => ({ text: 'Grok要約テキスト' }),
  };
  const t2 = await mk({ integrations: { xapi, grok } });
  await t2.api('DELETE', '/api/sample');
  t2.app.settings.update({ targets: { nightlifePerDay: { min: 5, max: 40 }, generalTopicsPerDay: 2, generalPostsPerTopic: 3 } });
  const run = (await t2.api('POST', '/api/jobs/run', { job: 'collect' })).json.run;
  assert.equal(run.status, 'ok', run.message);
  const night = t2.app.store.queryPosts({ genre: 'nightlife', limit: 200 });
  assert.equal(night.total, 40);
  assert.equal(run.counts.generalTopics, 2);
  const gen = t2.app.store.queryPosts({ genre: 'general', limit: 200 });
  assert.equal(gen.total, 6);
  assert.ok(gen.items.every((p) => p.topicLabel === '話題A' || p.topicLabel === '話題B'));
  // 同日の再実行は夜職上限により追加されず、一般トピックも追加しない
  const run2 = (await t2.api('POST', '/api/jobs/run', { job: 'collect' })).json.run;
  assert.equal(run2.counts.nightlifeAdded, 0);
  assert.equal(run2.counts.generalTopics, 0);
  assert.equal(t2.app.store.queryPosts({ genre: 'nightlife', limit: 200 }).total, 40);
  // Grok要約が使われる
  const dg = (await t2.api('POST', '/api/jobs/run', { job: 'daily_digest' })).json.run;
  assert.equal(dg.status, 'ok');
  const d = (await t2.api('GET', '/api/digests')).json.items[0];
  assert.equal(d.summaryBy, 'grok');
  const full = (await t2.api('GET', `/api/digests/${d.id}`)).json.digest;
  assert.equal(full.summaryText, 'Grok要約テキスト');
  assert.ok(full.sections.length >= 1 && full.sections[0].topics[0].posts[0].postId);
  await t2.close();
});

test('まとめ：ルールベース要約とWebhook配信', async () => {
  const sent = [];
  const t = await mk();
  t.app.digest; // 生成済み
  await t.api('DELETE', '/api/sample');
  t.app.store.upsertPosts([post(41, { metrics: { likes: 10 }, postedAt: '2026-10-10T01:00:00.000Z' })]);
  const run = (await t.api('POST', '/api/jobs/run', { job: 'weekly_digest' })).json.run;
  assert.equal(run.status, 'ok');
  const list = (await t.api('GET', '/api/digests?kind=weekly')).json.items;
  assert.equal(list.length, 1);
  assert.equal(list[0].summaryBy, 'rule');
  const d = (await t.api('GET', `/api/digests/${list[0].id}`)).json.digest;
  assert.match(d.summaryText, /候補内/);
  assert.equal((await t.api('GET', '/api/digests/9999')).status, 404);
  await t.close();

  const dir = tmp();
  dirs.push(dir);
  const app = createApp({ dataDir: dir, env: {}, now: () => NOW });
  app.store.deleteSamples();
  app.store.upsertPosts([post(42)]);
  app.settings.update({ delivery: { method: 'webhook', webhookUrl: 'https://hooks.example.test/x' } });
  const app2 = createApp({ dataDir: dir, env: {}, now: () => NOW, fetchImpl: async (url, init) => (sent.push({ url, body: JSON.parse(init.body) }), { ok: true, status: 200 }) });
  const r = await app2.jobs.run('daily_digest');
  assert.equal(r.status, 'ok');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.kind, 'daily');
  await app.close();
  await app2.close();
});

test('設定の検証と部分更新', async () => {
  const t = await mk();
  const base = (await t.api('GET', '/api/settings')).json.settings;
  assert.deepEqual(base.excludeTerms, ['ロイヤルホスト']);
  const up = await t.api('PUT', '/api/settings', { settings: { schedule: { weeklyDigest: { weekday: 3 } } } });
  assert.equal(up.json.settings.schedule.weeklyDigest.weekday, 3);
  assert.equal(up.json.settings.schedule.weeklyDigest.time, '10:00');
  for (const bad of [{ schedule: { collectTimes: ['25:00'] } }, { schedule: { timezone: 'Mars/Base' } }, { targets: { nightlifePerDay: { min: 60, max: 50 } } }, { delivery: { method: 'webhook' } }]) {
    assert.equal((await t.api('PUT', '/api/settings', { settings: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await t.api('GET', '/api/settings')).json.settings.schedule.weeklyDigest.weekday, 3);
  await t.close();
});

test('話題クラスタリングは決定的で、除外ワードがジャンル分類に効く', async () => {
  const posts = [
    { postId: '2', text: '歌舞伎町の夜景がきれい #散歩コース' },
    { postId: '1', text: '歌舞伎町の夜景がきれいです #散歩コース' },
    { postId: '3', text: '全然関係ない天気の話' },
  ];
  const a = clusterPosts(posts);
  const b = clusterPosts([...posts].reverse());
  assert.deepEqual(a, b);
  assert.ok(a.some((c) => c.postIds.length === 2));

  const t = await mk();
  await t.api('DELETE', '/api/sample');
  t.app.store.upsertPosts([post(61, { text: 'ロイヤルホストでパフェ', hint: 'none' }), post(62, { text: 'ホストクラブの話', hint: 'none' })]);
  assert.equal(t.app.store.getPost('61').genre, 'unknown');
  assert.equal(t.app.store.getPost('62').genre, 'nightlife');
  await t.close();
});

test('静的配信：SPAフォールバック・パストラバーサル防止・MIME・no-store', async () => {
  const t = await mk();
  const idx = await t.api('GET', '/');
  assert.equal(idx.status, 200);
  assert.match(idx.headers.get('content-type'), /text\/html/);
  const spa = await t.api('GET', '/some/deep/route');
  assert.equal(spa.status, 200);
  assert.match(spa.headers.get('content-type'), /text\/html/);
  const trav = await fetch(`${t.base}/..%2f..%2fpackage.json`);
  assert.ok(trav.status === 404 || trav.status === 400 || (await trav.clone().text()).includes('<html'));
  assert.ok(!(await trav.text()).includes('"x-trend"'));
  const raw = await new Promise((resolve) => {
    import('node:net').then(({ default: net }) => {
      const s = net.connect(new URL(t.base).port, '127.0.0.1', () => s.write('GET /../package.json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      let buf = '';
      s.on('data', (d) => (buf += d));
      s.on('end', () => resolve(buf));
    });
  });
  assert.ok(!raw.includes('"name": "x-trend"'));
  const api = await t.api('GET', '/api/status');
  assert.equal(api.headers.get('cache-control'), 'no-store');
  assert.equal((await t.api('GET', '/api/nope')).status, 404);
  const big = await fetch(`${t.base}/api/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'x'.repeat(11 * 1024 * 1024) }) }).catch(() => ({ status: 413 }));
  assert.equal(big.status, 413);
  await t.close();
});

test('バックアップ出力に秘密値が含まれない', async () => {
  const t = await mk({ env: { ADMIN_TOKEN: 'tok-abc-123', XAI_API_KEY: 'xai-secret-777' } });
  const admin = { 'X-Admin-Token': 'tok-abc-123' };
  const share = (await t.api('GET', '/api/share', undefined, admin)).json.shareUrl;
  const tokenValue = new URL(share).searchParams.get('share');
  const text = (await t.api('GET', '/api/backup', undefined, admin)).text + (await t.api('GET', '/api/status', undefined, admin)).text;
  for (const secret of ['tok-abc-123', 'xai-secret-777', tokenValue]) assert.ok(!text.includes(secret));
  assert.ok(existsSync(t.dir));
  await t.close();
});
