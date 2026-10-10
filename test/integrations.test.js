import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { parsePostUrl, fetchOEmbed } from '../src/integrations/url.js';
import { parseJSON, parseCSV, normalizeCapture, normalizeRecord, parseCount } from '../src/integrations/importers.js';
import { createXApi } from '../src/integrations/xapi.js';
import { createGrok } from '../src/integrations/grok.js';
import {
  buildBookmarklet, buildBookmarkletSource, extractPosts, detectPage, parseMetricLabels, parseMetricNumber, toBase64Url,
} from '../src/integrations/bookmarklet.js';

const NULL_METRICS = { views: null, likes: null, reposts: null, replies: null, bookmarks: null };

function jsonRes(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  };
}
function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  f.calls = calls;
  return f;
}

// ---------------- url.js ----------------
test('parsePostUrl: 各種URL形式', () => {
  const ok = [
    ['https://x.com/foo/status/123', 'foo', '123'],
    ['https://twitter.com/foo_1/status/123?s=20&t=abc', 'foo_1', '123'],
    ['https://mobile.twitter.com/foo/status/123#x', 'foo', '123'],
    ['https://www.x.com/foo/statuses/123', 'foo', '123'],
    ['https://fxtwitter.com/foo/status/123', 'foo', '123'],
    ['https://vxtwitter.com/foo/status/123/photo/1', 'foo', '123'],
    ['https://fixupx.com/foo/status/123', 'foo', '123'],
    ['  x.com/foo/status/123  ', 'foo', '123'],
    ['https://x.com/i/web/status/123', null, '123'],
    ['12345678901234567890', null, '12345678901234567890'],
  ];
  for (const [input, handle, id] of ok) {
    const r = parsePostUrl(input);
    assert.ok(r, input);
    assert.equal(r.postId, id);
    assert.equal(r.authorHandle, handle);
    assert.equal(r.url, handle ? `https://x.com/${handle}/status/${id}` : `https://x.com/i/web/status/${id}`);
  }
  for (const bad of ['', null, undefined, 'hello', 'https://example.com/foo/status/123', 'https://x.com/foo', 'https://x.com/foo/status/abc', 'javascript:alert(1)', 'https://x.com.evil.com/foo/status/1']) {
    assert.equal(parsePostUrl(bad), null, String(bad));
  }
});

test('fetchOEmbed: 正常・失敗', async () => {
  const html = '<blockquote class="twitter-tweet"><p lang="ja" dir="ltr">歌舞伎町で &amp; 今日は<br>&lt;雨&gt;です &#x1F600; <a href="https://t.co/xyz">pic.twitter.com/xyz</a></p>&mdash; ホスト太郎 (@taro_h) <a href="https://twitter.com/taro_h/status/123?ref_src=twsrc%5Etfw">October 10, 2026</a></blockquote>\n';
  const f = fakeFetch(() => jsonRes({ html, author_name: 'ホスト太郎', author_url: 'https://twitter.com/taro_h' }));
  const r = await fetchOEmbed('https://x.com/taro_h/status/123', { fetchImpl: f });
  assert.equal(r.authorName, 'ホスト太郎');
  assert.equal(r.authorHandle, 'taro_h');
  assert.equal(r.text, '歌舞伎町で & 今日は\n<雨>です 😀 pic.twitter.com/xyz');
  assert.equal(r.postedAt, '2026-10-10T00:00:00.000Z');
  assert.match(f.calls[0].url, /^https:\/\/publish\.twitter\.com\/oembed\?url=.*&omit_script=1$/);
  assert.equal(await fetchOEmbed('https://x.com/a/status/1', { fetchImpl: fakeFetch(() => jsonRes({}, { status: 404 })) }), null);
  assert.equal(await fetchOEmbed('https://x.com/a/status/1', { fetchImpl: async () => { throw new Error('net'); } }), null);
  assert.equal(await fetchOEmbed('not a url', { fetchImpl: f }), null);
});

// ---------------- importers.js ----------------
test('parseCount: 略記数値', () => {
  assert.equal(parseCount('1.2万'), 12000);
  assert.equal(parseCount('3.4K'), 3400);
  assert.equal(parseCount('2M'), 2000000);
  assert.equal(parseCount('1,234'), 1234);
  assert.equal(parseCount('１２，３４５'), 12345);
  assert.equal(parseCount('0'), 0);
  assert.equal(parseCount(0), 0);
  assert.equal(parseCount('5000件'), 5000);
  for (const bad of ['', '-', '不明', 'abc', null, undefined, '1.2.3', -5, NaN]) assert.equal(parseCount(bad), null, String(bad));
});

test('parseJSON: 配列・日本語キー・略記数値', () => {
  const { posts, errors } = parseJSON(JSON.stringify([
    { id: '111', text: '本文', created_at: '2026-10-10T03:00:00Z', like_count: '1.2万', view_count: '3,400', retweet_count: 0, screen_name: '@abc' },
    { url: 'https://x.com/zzz/status/222' },
    { foo: 1 },
  ]), { sourceDetail: 'a.json' });
  assert.equal(posts.length, 2);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].index, 2);
  const p = posts[0];
  assert.equal(p.postId, '111');
  assert.equal(p.authorHandle, 'abc');
  assert.equal(p.url, 'https://x.com/abc/status/111');
  assert.deepEqual(p.metrics, { views: 3400, likes: 12000, reposts: 0, replies: null, bookmarks: null });
  assert.ok(p.metricsFetchedAt);
  assert.deepEqual(p.source, { type: 'import_json', detail: 'a.json' });
  assert.equal(p.postedAt, '2026-10-10T03:00:00.000Z');
  const q = posts[1];
  assert.equal(q.postId, '222');
  assert.equal(q.url, 'https://x.com/zzz/status/222');
  assert.deepEqual(q.metrics, NULL_METRICS);
  assert.equal(q.metricsFetchedAt, null);
  assert.equal(q.text, null);
});

test('parseJSON: {data}/{posts}/アーカイブ/API v2/取得日時優先', () => {
  assert.equal(parseJSON(JSON.stringify({ data: [{ id: '1' }] })).posts.length, 1);
  assert.equal(parseJSON(JSON.stringify({ posts: [{ id: '1' }, { id: '2' }] })).posts.length, 2);

  const archive = 'window.YTD.tweets.part0 = [ {"tweet":{"id_str":"900","full_text":"アーカイブ","created_at":"Wed Oct 07 12:00:00 +0000 2026","favorite_count":"15","retweet_count":"2"}} ];';
  const a = parseJSON(archive);
  assert.equal(a.posts.length, 1);
  assert.equal(a.posts[0].postId, '900');
  assert.equal(a.posts[0].text, 'アーカイブ');
  assert.equal(a.posts[0].postedAt, '2026-10-07T12:00:00.000Z');
  assert.equal(a.posts[0].metrics.likes, 15);
  assert.equal(a.posts[0].metrics.reposts, 2);
  assert.equal(a.posts[0].metrics.views, null);

  const v2 = {
    data: [{ id: '700', text: 'v2', author_id: 'u1', created_at: '2026-10-01T00:00:00.000Z', public_metrics: { like_count: 4, impression_count: 100, retweet_count: 1, reply_count: 0 } }],
    includes: { users: [{ id: 'u1', username: 'v2user', name: 'V2 名前' }] },
  };
  const b = parseJSON(JSON.stringify(v2));
  assert.equal(b.posts[0].authorHandle, 'v2user');
  assert.equal(b.posts[0].authorName, 'V2 名前');
  assert.equal(b.posts[0].url, 'https://x.com/v2user/status/700');
  assert.deepEqual(b.posts[0].metrics, { views: 100, likes: 4, reposts: 1, replies: 0, bookmarks: null });

  const c = parseJSON(JSON.stringify([{ id: '5', like_count: 3, metrics_fetched_at: '2026-10-09T10:00:00Z' }]));
  assert.equal(c.posts[0].metricsFetchedAt, '2026-10-09T10:00:00.000Z');
  const d = parseJSON(JSON.stringify([{ id: '5', fetched_at: '2026-10-09T10:00:00Z' }]));
  assert.equal(d.posts[0].metricsFetchedAt, null);

  const bad = parseJSON('{not json');
  assert.equal(bad.posts.length, 0);
  assert.equal(bad.errors.length, 1);
  assert.equal(parseJSON('﻿[{"id":"9"}]').posts.length, 1);
});

test('parseCSV: 英語ヘッダ・引用符・改行入りセル・BOM・CRLF', () => {
  const csv = '﻿id,text,created_at,likes,views,username\r\n'
    + '1001,"こんにちは, ""世界""\r\n2行目",2026-10-10 12:00,1.2万,"3,400",host1\r\n'
    + '1002,plain,,,,\r\n'
    + ',no id,,,,\r\n';
  const { posts, errors } = parseCSV(csv, { sourceDetail: 'x.csv' });
  assert.equal(posts.length, 2);
  assert.equal(posts[0].text, 'こんにちは, "世界"\n2行目');
  assert.equal(posts[0].metrics.likes, 12000);
  assert.equal(posts[0].metrics.views, 3400);
  assert.equal(posts[0].postedAt, '2026-10-10T03:00:00.000Z');
  assert.equal(posts[0].authorHandle, 'host1');
  assert.equal(posts[0].source.type, 'import_csv');
  assert.deepEqual(posts[1].metrics, NULL_METRICS);
  assert.equal(posts[1].metricsFetchedAt, null);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].index, 5);
});

test('parseCSV: 日本語ヘッダ・タブ区切り', () => {
  const tsv = '投稿ID\tURL\t本文\t投稿日時\tいいね\t表示回数\tリポスト\t返信\n'
    + '2001\thttps://x.com/abc/status/2001\t本文です\t2026/10/09 21:30\t1.5万\t12.3万\t300\t0\n';
  const { posts, errors } = parseCSV(tsv);
  assert.equal(errors.length, 0);
  const p = posts[0];
  assert.equal(p.postId, '2001');
  assert.equal(p.authorHandle, 'abc');
  assert.deepEqual(p.metrics, { views: 123000, likes: 15000, reposts: 300, replies: 0, bookmarks: null });
  assert.equal(p.postedAt, '2026-10-09T12:30:00.000Z');
});

test('parseCSV: URL列のみ（ヘッダ有り/無し）', () => {
  const a = parseCSV('url\nhttps://x.com/a/status/1\nhttps://twitter.com/b/status/2\n');
  assert.deepEqual(a.posts.map((p) => p.postId), ['1', '2']);
  const b = parseCSV('https://x.com/a/status/11\nhttps://x.com/b/status/22\n');
  assert.deepEqual(b.posts.map((p) => p.postId), ['11', '22']);
  assert.equal(b.posts[0].authorHandle, 'a');
});

test('normalizeRecord: 不明は null、ID/URL規則', () => {
  const p = normalizeRecord({ tweet_id: '42', full_text: 'hi', favorite_count: 0 }, 'import_json', 'd');
  assert.equal(p.url, 'https://x.com/i/web/status/42');
  assert.equal(p.metrics.likes, 0);
  assert.equal(p.metrics.views, null);
  assert.ok(p.metricsFetchedAt);
  assert.equal(normalizeRecord({ id: 'abc' }, 'import_json'), null);
  assert.equal(normalizeRecord(null, 'import_json'), null);
});

test('normalizeCapture: payload検証とページ種別', () => {
  const payload = {
    v: 1, capturedAt: '2026-10-10T01:00:00Z', page: 'following', pageUrl: 'https://x.com/home',
    posts: [
      { postId: '10', url: 'https://x.com/a/status/10', authorHandle: 'a', authorName: 'A', text: 't', postedAt: '2026-10-10T00:00:00Z', metrics: { views: 5, likes: null, reposts: 1, replies: null, bookmarks: null } },
      { postId: '10', text: 'dup' },
      { postId: '11', metrics: {} },
      { text: 'no id' },
    ],
  };
  const r = normalizeCapture(payload);
  assert.equal(r.posts.length, 2);
  assert.equal(r.errors.length, 1);
  assert.equal(r.posts[0].source.type, 'foryou_capture');
  assert.match(r.posts[0].source.detail, /フォロー中/);
  assert.deepEqual(r.posts[0].metrics, { views: 5, likes: null, reposts: 1, replies: null, bookmarks: null });
  assert.equal(r.posts[0].metricsFetchedAt, '2026-10-10T01:00:00.000Z');
  assert.equal(r.posts[1].metricsFetchedAt, null);
  assert.match(normalizeCapture({ ...payload, page: 'foryou' }).posts[0].source.detail, /おすすめ/);
  assert.equal(normalizeCapture({ v: 2, posts: [] }).posts.length, 0);
  assert.equal(normalizeCapture({ v: 2, posts: [] }).errors.length, 1);
  assert.equal(normalizeCapture(null).errors.length, 1);
});

// ---------------- xapi.js ----------------
const NOW = () => new Date('2026-10-10T12:00:00Z');

test('xapi.searchRecent: 正常・指標欠け・クランプ・rateLimit', async () => {
  const body = {
    data: [
      { id: '1', text: 'a', author_id: 'u1', created_at: '2026-10-10T00:00:00.000Z', lang: 'ja', public_metrics: { impression_count: 100, like_count: 5, retweet_count: 2, quote_count: 9, reply_count: 1, bookmark_count: 3 } },
      { id: '2', text: 'b', author_id: 'u2' },
      { id: '3', text: 'c', author_id: 'u1', public_metrics: { like_count: 0 } },
    ],
    includes: { users: [{ id: 'u1', username: 'alice', name: 'アリス' }] },
  };
  const f = fakeFetch(() => jsonRes(body, { headers: { 'x-rate-limit-remaining': '17', 'x-rate-limit-reset': '1790000000' } }));
  const x = createXApi({ bearerToken: 'SECRET-TOKEN', fetchImpl: f, now: NOW });
  assert.deepEqual(x.isConfigured(), { search: true, home: false });
  const r = await x.searchRecent({ query: 'ホスト -is:retweet', maxResults: 5 });
  const u = new URL(f.calls[0].url);
  assert.equal(u.pathname, '/2/tweets/search/recent');
  assert.equal(u.searchParams.get('query'), 'ホスト -is:retweet');
  assert.equal(u.searchParams.get('max_results'), '10');
  assert.equal(u.searchParams.get('tweet.fields'), 'created_at,public_metrics,lang,author_id');
  assert.equal(u.searchParams.get('expansions'), 'author_id');
  assert.equal(u.searchParams.get('user.fields'), 'username,name');
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer SECRET-TOKEN');
  assert.deepEqual(r.rateLimit, { remaining: 17, resetAt: new Date(1790000000 * 1000).toISOString() });
  assert.equal(r.posts.length, 3);
  const [a, b, c] = r.posts;
  assert.deepEqual(a.metrics, { views: 100, likes: 5, reposts: 2, replies: 1, bookmarks: 3 });
  assert.equal(a.metricsFetchedAt, '2026-10-10T12:00:00.000Z');
  assert.equal(a.url, 'https://x.com/alice/status/1');
  assert.equal(a.authorName, 'アリス');
  assert.equal(a.source.type, 'x_api_search');
  assert.equal(a.source.detail, 'ホスト -is:retweet');
  assert.deepEqual(b.metrics, NULL_METRICS);
  assert.equal(b.metricsFetchedAt, null);
  assert.equal(b.url, 'https://x.com/i/web/status/2');
  assert.equal(c.metrics.likes, 0);
  assert.equal(c.metrics.views, null);
  await x.searchRecent({ query: 'q', maxResults: 5000 });
  assert.equal(new URL(f.calls[1].url).searchParams.get('max_results'), '100');
});

test('xapi: 401/429/500/ネットワーク例外は例外を投げずエラー文字列、秘密値を含まない', async () => {
  for (const [status, re] of [[401, /認証/], [429, /レート制限/], [500, /エラー/], [403, /許可/]]) {
    const f = fakeFetch(() => jsonRes({ title: 'x' }, { status, headers: { 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': '1790000000' } }));
    const r = await createXApi({ bearerToken: 'SECRET-TOKEN', fetchImpl: f }).searchRecent({ query: 'q' });
    assert.deepEqual(r.posts, []);
    assert.match(r.error, re);
    assert.ok(!r.error.includes('SECRET-TOKEN'));
    if (status === 429) assert.equal(r.rateLimit.remaining, 0);
  }
  const r = await createXApi({ bearerToken: 'SECRET-TOKEN', fetchImpl: async () => { throw new Error('boom SECRET-TOKEN'); } }).searchRecent({ query: 'q' });
  assert.deepEqual(r.posts, []);
  assert.match(r.error, /接続/);
  assert.ok(!r.error.includes('SECRET'));
  const none = await createXApi({ fetchImpl: fakeFetch(() => jsonRes({})) }).searchRecent({ query: 'q' });
  assert.match(none.error, /X_BEARER_TOKEN/);
});

test('xapi.homeTimeline: ユーザートークン必須・source', async () => {
  const f = fakeFetch(() => jsonRes({ data: [{ id: '9', text: 'h', author_id: 'u' }], includes: { users: [{ id: 'u', username: 'bob', name: 'Bob' }] } }));
  const x = createXApi({ bearerToken: 'b', fetchImpl: f, now: NOW });
  assert.match((await x.homeTimeline({})).error, /X_USER_ACCESS_TOKEN/);
  assert.equal(f.calls.length, 0);
  const x2 = createXApi({ userAccessToken: 'ut', userId: '12345', fetchImpl: f, now: NOW });
  assert.deepEqual(x2.isConfigured(), { search: false, home: true });
  const r = await x2.homeTimeline({ maxResults: 20 });
  assert.equal(new URL(f.calls[0].url).pathname, '/2/users/12345/timelines/reverse_chronological');
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer ut');
  assert.equal(r.posts[0].source.type, 'x_api_home');
  assert.match(r.posts[0].source.detail, /逆時系列（おすすめ欄ではありません）/);
});

test('xapi.lookup: 100件ずつ分割', async () => {
  const f = fakeFetch((url) => {
    const ids = new URL(url).searchParams.get('ids').split(',');
    return jsonRes({ data: ids.map((id) => ({ id, text: 't', public_metrics: { like_count: 1 } })) });
  });
  const x = createXApi({ bearerToken: 'b', fetchImpl: f, now: NOW });
  const ids = Array.from({ length: 250 }, (_, i) => String(1000 + i));
  const r = await x.lookup([...ids, 'abc', ids[0]]);
  assert.equal(f.calls.length, 3);
  assert.equal(r.posts.length, 250);
  assert.equal(new URL(f.calls[0].url).pathname, '/2/tweets');
  assert.equal(r.posts[0].metrics.likes, 1);
  assert.match((await x.lookup([])).error, /投稿ID/);
});

// ---------------- grok.js ----------------
function grokResponse(textObj, citations) {
  return {
    output: [
      { type: 'x_search_call' },
      { type: 'message', content: [{ type: 'output_text', text: typeof textObj === 'string' ? textObj : JSON.stringify(textObj), annotations: citations.map((url) => ({ type: 'url_citation', url })) }] },
    ],
  };
}

test('grok.searchX: x_search ツール・引用と突き合わせ・指標はnull', async () => {
  const f = fakeFetch(() => jsonRes(grokResponse({
    posts: [
      { url: 'https://x.com/host_a/status/111', text: '本文A', postedAt: '2026-10-09T10:00:00Z', authorName: 'A', metrics: { likes: 99999 } },
      { url: 'https://x.com/fake/status/999', text: '引用に無い' },
      { url: 'https://twitter.com/host_b/status/222', text: '要約: まとめです' },
    ],
  }, ['https://x.com/host_a/status/111?s=20', 'https://x.com/host_b/status/222', 'https://x.com/host_c/status/333', 'https://example.com/page'])));
  const g = createGrok({ apiKey: 'XAI-SECRET', model: 'grok-test', fetchImpl: f, now: NOW });
  assert.equal(g.isConfigured(), true);
  const r = await g.searchX({ query: 'ホスト 歌舞伎町', maxResults: 10, fromDate: '2026-10-08', toDate: new Date('2026-10-10T00:00:00Z') });
  const call = f.calls[0];
  assert.equal(call.url, 'https://api.x.ai/v1/responses');
  assert.equal(call.init.headers.authorization, 'Bearer XAI-SECRET');
  const body = JSON.parse(call.init.body);
  assert.equal(body.model, 'grok-test');
  assert.deepEqual(body.tools, [{ type: 'x_search', from_date: '2026-10-08', to_date: '2026-10-10' }]);
  assert.equal(body.search_parameters, undefined);
  assert.deepEqual(r.posts.map((p) => p.postId), ['111', '222', '333']);
  const [a, b, c] = r.posts;
  assert.equal(a.text, '本文A');
  assert.equal(a.postedAt, '2026-10-09T10:00:00.000Z');
  assert.deepEqual(a.metrics, NULL_METRICS);
  assert.equal(a.metricsFetchedAt, null);
  assert.equal(a.url, 'https://x.com/host_a/status/111');
  assert.equal(a.source.type, 'grok_x_search');
  assert.equal(a.source.detail, 'ホスト 歌舞伎町');
  assert.equal(b.text, null);
  assert.equal(c.text, null);
  assert.equal(c.authorHandle, 'host_c');
  assert.match(r.note, /推測/);
  assert.match(r.note, /1 件/);
});

test('grok.searchX: 引用なしなら投稿を確定しない／エラー系', async () => {
  const noCite = createGrok({ apiKey: 'k', fetchImpl: fakeFetch(() => jsonRes(grokResponse({ posts: [{ url: 'https://x.com/a/status/1', text: 'x' }] }, []))) });
  const r = await noCite.searchX({ query: 'q' });
  assert.deepEqual(r.posts, []);
  assert.match(r.note, /引用/);

  const top = createGrok({ apiKey: 'k', fetchImpl: fakeFetch(() => jsonRes({ output_text: '```json\n{"posts":[]}\n```', citations: ['https://x.com/q/status/77'] })) });
  assert.deepEqual((await top.searchX({ query: 'q' })).posts.map((p) => p.postId), ['77']);

  for (const [status, re] of [[401, /認証/], [429, /レート制限/], [500, /エラー/], [400, /モデル/]]) {
    const g = createGrok({ apiKey: 'XAI-SECRET', fetchImpl: fakeFetch(() => jsonRes({ error: 'XAI-SECRET' }, { status })) });
    const e = await g.searchX({ query: 'q' });
    assert.deepEqual(e.posts, []);
    assert.match(e.error, re);
    assert.ok(!e.error.includes('XAI-SECRET'));
  }
  const net = await createGrok({ apiKey: 'k', fetchImpl: async () => { throw new Error('x'); } }).searchX({ query: 'q' });
  assert.match(net.error, /接続/);
  assert.match((await createGrok({ fetchImpl: fakeFetch(() => jsonRes({})) }).searchX({ query: 'q' })).error, /XAI_API_KEY/);
});

test('grok.summarize / suggestTopics', async () => {
  const f = fakeFetch(() => jsonRes({ output: [{ type: 'message', content: [{ type: 'output_text', text: '## 夜職の業界動向\n収集した候補内では…' }] }] }));
  const g = createGrok({ apiKey: 'k', fetchImpl: f });
  const s = await g.summarize({ kind: 'daily', periodLabel: '10/10', sections: [{ genre: 'nightlife', genreLabel: '夜職', topics: [{ label: 'T', posts: [{ text: 'x', url: 'https://x.com/a/status/1', metrics: { likes: null } }] }] }] });
  assert.match(s.text, /収集した候補内/);
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(body.tools, undefined);
  assert.match(body.input[0].content, /収集した候補内/);
  assert.match(body.input[0].content, /X全体/);
  assert.match((await g.summarize({ kind: 'daily', sections: [] })).error, /投稿がありません/);

  const t = createGrok({ apiKey: 'k', fetchImpl: fakeFetch(() => jsonRes(grokResponse({ topics: [{ label: '猛暑', query: '猛暑 昼' }, { label: '', query: 'x' }, { label: '台風', query: '台風' }, { label: '余り', query: 'z' }] }, []))), now: NOW });
  const r = await t.suggestTopics({ genre: 'general', count: 2 });
  assert.deepEqual(r.topics, [{ label: '猛暑', query: '猛暑 昼' }, { label: '台風', query: '台風' }]);
  const bad = await createGrok({ apiKey: 'k', fetchImpl: fakeFetch(() => jsonRes({}, { status: 429 })) }).suggestTopics({});
  assert.deepEqual(bad.topics, []);
  assert.match(bad.error, /レート制限/);
});

// ---------------- bookmarklet.js ----------------
test('buildBookmarklet: javascript: 1行・禁止語なし・構文OK', () => {
  const bm = buildBookmarklet('https://app.example.com/x-trend/');
  assert.ok(bm.startsWith('javascript:'));
  assert.ok(!/[\r\n]/.test(bm));
  const src = buildBookmarkletSource('https://app.example.com/x-trend/');
  assert.ok(src.includes('"https://app.example.com/x-trend"'));
  assert.equal(decodeURIComponent(bm.slice('javascript:'.length)), src);
  new vm.Script(src);
  for (const word of ['cookie', 'localStorage', 'sessionStorage', 'fetch', 'XMLHttpRequest', 'authorization', 'indexedDB', 'sendBeacon', 'WebSocket', 'click', 'submit', 'dispatchEvent']) {
    assert.ok(!src.toLowerCase().includes(word.toLowerCase()), `禁止語 ${word}`);
    assert.ok(!bm.toLowerCase().includes(word.toLowerCase()), `禁止語 ${word}（エンコード後）`);
  }
  assert.throws(() => buildBookmarklet('not a url'));
  assert.throws(() => buildBookmarklet('javascript:alert(1)'));
});

// 最小のフェイクDOM
class Node_ {
  constructor(tag, attrs = {}, children = []) {
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attrs = attrs; this.parentNode = null;
    this.childNodes = children.map((c) => { const n = typeof c === 'string' ? { nodeType: 3, data: c } : c; n.parentNode = this; return n; });
  }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  get textContent() { return this.childNodes.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join(''); }
  all() { return this.childNodes.filter((c) => c.nodeType === 1).flatMap((c) => [c, ...c.all()]); }
  closest(sel) { for (let n = this; n; n = n.parentNode) if (n.nodeType === 1 && matches(n, sel)) return n; return null; }
  querySelectorAll(sel) { return this.all().filter((n) => matches(n, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}
function matches(n, sel) {
  const m = sel.match(/^([a-z]*)((?:\[[^\]]+\])*)$/i);
  if (m[1] && n.tagName !== m[1].toUpperCase()) return false;
  for (const [, k, op, v] of m[2].matchAll(/\[([\w-]+)(?:(\*?=)"([^"]*)")?\]/g)) {
    const val = n.getAttribute(k);
    if (val === null) return false;
    if (op === '=' && val !== v) return false;
    if (op === '*=' && !val.includes(v)) return false;
  }
  return true;
}
const el = (tag, attrs, ...children) => new Node_(tag, attrs, children);

function tweet({ id, handle, name, text, labels = [], ad = false, extraBtns = [] }) {
  return el('article', { 'data-testid': 'tweet' },
    el('div', { 'data-testid': 'User-Name' },
      el('a', { href: `/${handle}` }, el('span', {}, name)),
      el('a', { href: `/${handle}` }, el('span', {}, `@${handle}`))),
    el('a', { href: `/${handle}/status/${id}` }, el('time', { datetime: '2026-10-10T01:02:03.000Z' }, '1時間')),
    el('div', { 'data-testid': 'tweetText' }, text, el('br', {}), el('img', { alt: '😀' })),
    ...(ad ? [el('span', {}, 'プロモーション')] : []),
    el('div', { role: 'group', 'aria-label': labels.join('、') }),
    ...extraBtns);
}

test('extractPosts: DOM抽出（日本語/英語aria-label・広告除外・null）', () => {
  const root = el('main', {},
    tweet({ id: '1001', handle: 'host_a', name: 'ホストA', text: '本文1', labels: ['5 件の返信', '1.2万 件のリポスト', '3,400 件のいいね', '2 件のブックマーク', '56789 件の表示'] }),
    tweet({ id: '1002', handle: 'en_user', name: 'EN User', text: 'english', labels: ['3 replies', '10 reposts', '1.5K Likes', '1M views'] }),
    tweet({ id: '1003', handle: 'bare', name: 'Bare', text: 'no metrics', labels: ['返信', 'リポスト'] }),
    tweet({ id: '1004', handle: 'adv', name: '広告主', text: 'ad', ad: true, labels: ['1 件のいいね'] }),
    tweet({ id: '1005', handle: 'btn', name: 'Btn', text: 'x', extraBtns: [el('button', { 'data-testid': 'like' }, el('span', {}, '7'))] }));
  const posts = extractPosts(root);
  assert.deepEqual(posts.map((p) => p.postId), ['1001', '1002', '1003', '1005']);
  const [a, b, c, d] = posts;
  assert.equal(a.url, 'https://x.com/host_a/status/1001');
  assert.equal(a.authorName, 'ホストA');
  assert.equal(a.authorHandle, 'host_a');
  assert.equal(a.text, '本文1\n😀');
  assert.equal(a.postedAt, '2026-10-10T01:02:03.000Z');
  assert.deepEqual(a.metrics, { views: 56789, likes: 3400, reposts: 12000, replies: 5, bookmarks: 2 });
  assert.deepEqual(b.metrics, { views: 1000000, likes: 1500, reposts: 10, replies: 3, bookmarks: null });
  assert.deepEqual(c.metrics, NULL_METRICS);
  assert.equal(d.metrics.likes, 7);
});

test('ブックマークレット補助: 数値/ページ種別/base64url', () => {
  assert.equal(parseMetricNumber('1.2万'), 12000);
  assert.equal(parseMetricNumber('x'), null);
  assert.deepEqual(parseMetricLabels('1,234 views. View post analytics'), { views: 1234 });
  assert.deepEqual(parseMetricLabels('1234 件の表示。ポストのアナリティクスを表示'), { views: 1234 });
  assert.deepEqual(parseMetricLabels('3 Bookmarks. Bookmark'), { bookmarks: 3 });
  const tabs = (sel) => el('div', {}, el('div', { role: 'tab', 'aria-selected': sel === 0 ? 'true' : 'false' }, 'おすすめ'), el('div', { role: 'tab', 'aria-selected': sel === 1 ? 'true' : 'false' }, 'フォロー中'));
  assert.equal(detectPage('/home', tabs(0)), 'foryou');
  assert.equal(detectPage('/home', tabs(1)), 'following');
  assert.equal(detectPage('/search', tabs(0)), 'search');
  assert.equal(detectPage('/someone', tabs(0)), 'other');
  const json = JSON.stringify({ a: '日本語🙂' });
  const decoded = JSON.parse(Buffer.from(toBase64Url(json), 'base64url').toString('utf8'));
  assert.equal(decoded.a, '日本語🙂');
  assert.ok(!/[+/=]/.test(toBase64Url('???>>>')));
});
