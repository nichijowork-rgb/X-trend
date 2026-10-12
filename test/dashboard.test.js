// 静的ダッシュボード（index.html / assets/）の純粋関数テスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  formatCompact, formatExact, formatDateTime, formatDateTimeFull, parseTimestamp, dateKeyFromTs, addDays,
  normalizeDataset, filterPosts, sortPosts, parseKeywords, aggregate, mergeSummary, fillDays, chartDayRange,
  linkifySegments, isSafeHttpUrl, highlightSegments, serializeState, parseState, DEFAULT_STATE,
  categorySlot, hashString, KNOWN_CATEGORY_SLOTS, SPARE_SLOTS, isFilterActive, topAccounts, countByCategory,
  niceTicks, isAllowedMediaUrl, sanitizeMedia, bestMp4, embedTweetId, PERIODS, LEGACY_PERIOD_ALIASES,
  categoryMatcher, isUnclassified, inGroup, individualChipCategories, categoryLabel, normalizeCategorySelection, groupCategories,
  chooseRefTs, nextScheduledUpdate, isUpdateDelayed, viewsPerHour, formatPace, SORTS,
  normalizeReports, filterNightRising, pickReport, hitRateText, hitRatio, formatRisingPace, formatBeforeAfter, weekKey,
} from '../assets/js/core.js';
import { UPDATE_SCHEDULE, PACE_NOTE, REPORT_TEXT } from '../assets/js/config.js';

const ts = (iso) => Math.floor(Date.parse(iso) / 1000);

function rawPost(over = {}) {
  return {
    id: '1', url: 'https://x.com/sample_a/status/1', user: 'sample_a',
    created_jst: '2026-10-11T13:34:00+09:00', ts: ts('2026-10-11T13:34:00+09:00'),
    metrics: { impression_count: 100, like_count: 10, retweet_count: 1, reply_count: 0, quote_count: 0, bookmark_count: 2 },
    text: '【サンプル】本文', categories: ['ホスト'], matched_terms: ['ホスト'], is_watched: false,
    ...over,
  };
}

function dataset(posts, categories = ['ホスト', 'キャバクラ', 'その他'], generatedAt = '2026-10-11T18:41:00+09:00') {
  return normalizeDataset({ generated_at: generatedAt, categories, posts });
}

// ---------------------------------------------------------------- 数値

test('formatCompact: 万・億表記と 1万未満のカンマ区切り', () => {
  assert.equal(formatCompact(1155424), '115.5万');
  assert.equal(formatCompact(123456789), '1.2億');
  assert.equal(formatCompact(0), '0');
  assert.equal(formatCompact(9999), '9,999');
  assert.equal(formatCompact(10000), '1万');
  assert.equal(formatCompact(12345), '1.2万');
  assert.equal(formatCompact(99999999), '1億'); // 繰り上がりで 10000万 にならない
  assert.equal(formatCompact(100000000), '1億');
  assert.equal(formatCompact(1234567890123), '12,345.7億');
});

test('formatCompact / formatExact: 欠損は「不明」で 0 扱いしない', () => {
  assert.equal(formatCompact(null), '不明');
  assert.equal(formatCompact(undefined), '不明');
  assert.equal(formatCompact(NaN), '不明');
  assert.equal(formatExact(null), '不明');
  assert.equal(formatExact(1155424), '1,155,424');
});

// ---------------------------------------------------------------- 日時

test('formatDateTime: 「10/11 13:34」形式（created_jst 優先、無ければ ts を JST で）', () => {
  assert.equal(formatDateTime('2026-10-11T13:34:05+09:00', null), '10/11 13:34');
  assert.equal(formatDateTime('2026-01-02 03:04', null), '1/2 03:04');
  // created_jst が null → ts（UTC 04:34 = JST 13:34）
  assert.equal(formatDateTime(null, ts('2026-10-11T04:34:00Z')), '10/11 13:34');
  // 年が違う場合のみ年を付ける
  assert.equal(formatDateTime('2016-03-04T10:00:00+09:00', null, 2026), '2016/3/4 10:00');
  assert.equal(formatDateTime('2026-03-04T10:00:00+09:00', null, 2026), '3/4 10:00');
  assert.equal(formatDateTime(null, null), '不明');
  assert.equal(formatDateTimeFull(null, ts('2026-10-11T04:34:00Z')), '2026/10/11 13:34 JST');
});

test('parseTimestamp / dateKeyFromTs / addDays', () => {
  assert.equal(parseTimestamp('2026-10-11T18:41:00+09:00'), ts('2026-10-11T09:41:00Z'));
  assert.equal(parseTimestamp('2026-10-11 18:41'), ts('2026-10-11T09:41:00Z')); // TZ 無しは JST
  assert.equal(parseTimestamp(''), null);
  assert.equal(dateKeyFromTs(ts('2026-10-10T15:30:00Z')), '2026-10-11'); // JST では翌日
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

// ---------------------------------------------------------------- 正規化

test('normalizeDataset: id は文字列・指標欠損は null・カテゴリは動的生成', () => {
  const ds = dataset([
    rawPost({ id: 1844674407370955161n.toString() }),
    rawPost({ id: 42, categories: ['テスト新カテゴリ'], metrics: { like_count: 3 } }),
    rawPost({ id: '3', metrics: undefined, categories: [] }),
  ]);
  assert.equal(ds.posts.length, 3);
  for (const p of ds.posts) assert.equal(typeof p.id, 'string');
  assert.deepEqual(ds.categories, ['ホスト', 'キャバクラ', 'その他', 'テスト新カテゴリ']);
  const p42 = ds.posts.find((p) => p.id === '42');
  assert.equal(p42.metrics.impression_count, null);
  assert.equal(p42.metrics.like_count, 3);
  const p3 = ds.posts.find((p) => p.id === '3');
  assert.deepEqual(p3.categories, ['その他']); // カテゴリ空は「その他」
  assert.equal(p3.metrics.like_count, null);
});

test('normalizeDataset: 不正な形式は例外', () => {
  assert.throws(() => normalizeDataset(null));
  assert.throws(() => normalizeDataset({}));
  assert.throws(() => normalizeDataset([]));
  assert.throws(() => normalizeDataset({ posts: 'x' }));
  const empty = normalizeDataset({ posts: [] });
  assert.equal(empty.posts.length, 0);
  assert.equal(empty.refTs, null);
});

// ---------------------------------------------------------------- フィルタ・並べ替え

const REF = ts('2026-10-11T18:00:00+09:00');
function sampleSet() {
  return dataset([
    rawPost({ id: '1', ts: REF, text: '【サンプル】歌舞伎町で指名の話', categories: ['ホスト'], user: 'sample_a', metrics: { impression_count: 500, like_count: 5, bookmark_count: 1 } }),
    rawPost({ id: '2', ts: REF - 3600 * 30, text: '【サンプル】キャバクラ 同伴', categories: ['キャバクラ'], user: 'sample_b', is_watched: true, metrics: { impression_count: null, like_count: 50, bookmark_count: null } }),
    rawPost({ id: '3', ts: REF - 86400 * 10, text: '【サンプル】ホストとキャバクラ　指名', categories: ['ホスト', 'キャバクラ'], user: 'Sample_C', metrics: { impression_count: 2000, like_count: 1 } }),
    rawPost({ id: '4', ts: ts('2016-03-04T10:00:00+09:00'), text: '【サンプル】昔の投稿', categories: ['その他'], user: 'sample_a', metrics: { impression_count: 10 } }),
  ], undefined, null); // generated_at なし → 最新投稿の ts が基準
}

test('filterPosts: generated_at が無ければ最新投稿時刻が基準', () => {
  const ds = sampleSet();
  assert.equal(ds.refTs, REF);
  assert.equal(ds.refSource, 'latest_post');
  const ids = (st) => filterPosts(ds.posts, st, ds.refTs).map((p) => p.id);
  assert.deepEqual(ids({ period: '24h' }), ['1']);
  assert.deepEqual(ids({ period: '7d' }), ['1', '2']);
  assert.deepEqual(ids({ period: '30d' }), ['1', '2', '3']);
  assert.deepEqual(ids({ period: '3d' }), ['1', '2']);
  assert.deepEqual(ids({}), ['1', '2', '3', '4']); // 期間を省略したときは絞らない（内部用）
});

test('filterPosts: カテゴリ OR・キーワード AND（全角スペース可）・アカウント・監視のみ', () => {
  const ds = sampleSet();
  const ids = (st) => filterPosts(ds.posts, st, ds.refTs).map((p) => p.id);
  assert.deepEqual(ids({ cats: ['ホスト'] }), ['1', '3']);
  assert.deepEqual(ids({ cats: ['ホスト', 'キャバクラ'] }), ['1', '2', '3']);
  assert.deepEqual(ids({ q: '指名' }), ['1', '3']);
  assert.deepEqual(ids({ q: '指名　キャバクラ' }), ['3']);
  assert.deepEqual(ids({ q: 'ｷｬﾊﾞｸﾗ' }), ['2', '3']); // NFKC で半角カナも一致
  assert.deepEqual(ids({ user: 'sample_c' }), ['3']); // 大文字小文字を無視
  assert.deepEqual(ids({ user: '@sample_a' }), ['1', '4']);
  assert.deepEqual(ids({ watched: true }), ['2']);
  assert.deepEqual(filterPosts(ds.posts, { cats: ['ホスト'] }, ds.refTs, { ignoreCategories: true }).length, 4);
  assert.deepEqual(parseKeywords(' a  B　c '), ['a', 'b', 'c']);
});

test('sortPosts: 欠損指標は末尾・同値は新しい順', () => {
  const ds = sampleSet();
  assert.deepEqual(sortPosts(ds.posts, 'new').map((p) => p.id), ['1', '2', '3', '4']);
  assert.deepEqual(sortPosts(ds.posts, 'imp').map((p) => p.id), ['3', '1', '4', '2']);
  assert.deepEqual(sortPosts(ds.posts, 'like').map((p) => p.id), ['2', '1', '3', '4']);
  // bookmark: 1 のみ既知、他は null（新しい順で末尾）
  assert.deepEqual(sortPosts(ds.posts, 'bookmark').map((p) => p.id), ['1', '2', '3', '4']);
  // 元配列は変更しない
  assert.deepEqual(ds.posts.map((p) => p.id), ['1', '2', '3', '4']);
});

// ---------------------------------------------------------------- 集計

test('aggregate: 既知値のみ合計し、欠損件数を数える', () => {
  const ds = sampleSet();
  const agg = aggregate(ds.posts, ds.categories);
  assert.equal(agg.totalPosts, 4);
  assert.equal(agg.totalAccounts, 3);
  assert.deepEqual(agg.impressions, { sum: 2510, unknown: 1 });
  assert.equal(agg.maxImp.id, '3');
  const host = agg.byCategory.find((c) => c.name === 'ホスト');
  assert.equal(host.posts, 2);
  assert.deepEqual(host.impressions, { sum: 2500, unknown: 0 });
  const caba = agg.byCategory.find((c) => c.name === 'キャバクラ');
  assert.deepEqual(caba.impressions, { sum: 2000, unknown: 1 });
  assert.equal(agg.byDay[0].date, '2016-03-04');
  assert.equal(countByCategory(ds.posts).get('キャバクラ'), 2);
  const top = topAccounts(agg.byAccount, 'posts');
  assert.equal(top[0].user, 'sample_a');
  assert.equal(topAccounts(agg.byAccount, 'imp')[0].user, 'Sample_C');
});

test('aggregate: 0 件でも落ちない', () => {
  const agg = aggregate([], ['ホスト']);
  assert.equal(agg.totalPosts, 0);
  assert.equal(agg.maxImp, null);
  assert.deepEqual(agg.byCategory[0], { name: 'ホスト', posts: 0, impressions: { sum: 0, unknown: 0 }, likes: { sum: 0, unknown: 0 } });
});

test('mergeSummary: 件数が一致する summary だけ使い、不一致や不正なら投稿から集計', () => {
  const ds = sampleSet();
  const client = aggregate(ds.posts, ds.categories);
  const byId = new Map(ds.posts.map((p) => [p.id, p]));
  const summary = {
    total_posts: 4, total_accounts: 3,
    by_category: { 'ホスト': { posts: 2, impressions: 2500, likes: 6 } },
    by_account: [{ user: 'sample_a', is_watched: false, posts: 2, impressions: 510, likes: 5 }],
    by_day: [{ date: '2026-10-11', posts: 1, impressions: 500, likes: 5, categories: { 'ホスト': 1 } }],
    top_posts: { by_impressions: [{ id: '3' }] },
  };
  const merged = mergeSummary(client, summary, byId);
  assert.equal(merged.source, 'summary');
  assert.equal(merged.maxImp.id, '3');
  assert.equal(merged.impressions.unknown, 1); // 不明件数は投稿から
  assert.equal(mergeSummary(client, { ...summary, total_posts: 99 }, byId).source, 'client');
  assert.equal(mergeSummary(client, null, byId).source, 'client');
  assert.equal(mergeSummary(client, { total_posts: 4 }, byId).source, 'client');
});

test('fillDays: 投稿のない日を 0 埋め、範囲外は捨てる', () => {
  const days = fillDays([
    { date: '2026-10-09', posts: 2, impressions: 10, likes: 1, categories: { 'ホスト': 2 } },
    { date: '2026-10-11', posts: 1, impressions: 5, likes: 0, categories: { 'その他': 1 } },
    { date: '2016-01-01', posts: 9, impressions: 0, likes: 0, categories: {} },
  ], '2026-10-08', '2026-10-11');
  assert.deepEqual(days.map((d) => [d.date, d.posts]), [['2026-10-08', 0], ['2026-10-09', 2], ['2026-10-10', 0], ['2026-10-11', 1]]);
  assert.deepEqual(days[2].categories, {});
});

test('chartDayRange: 期間に合わせる（最大 30 日）', () => {
  const ref = ts('2026-10-11T18:00:00+09:00');
  assert.deepEqual(chartDayRange('30d', ref), { startKey: '2026-09-11', endKey: '2026-10-11' });
  assert.deepEqual(chartDayRange('7d', ref), { startKey: '2026-10-04', endKey: '2026-10-11' });
  assert.deepEqual(chartDayRange('3d', ref), { startKey: '2026-10-08', endKey: '2026-10-11' });
  assert.deepEqual(chartDayRange('24h', ref), { startKey: '2026-10-10', endKey: '2026-10-11' });
  assert.deepEqual(chartDayRange('all', ref), chartDayRange('30d', ref)); // 不明な値は 30 日
  assert.equal(chartDayRange('30d', null), null);
});

test('期間: 24時間／3日（72時間）／7日／30日。「すべて」は無く、旧 period=all は 30 日として扱う', () => {
  assert.deepEqual(PERIODS.map((p) => [p.key, p.label, p.seconds]), [['24h', '24時間', 86400], ['3d', '3日', 259200], ['7d', '7日', 604800], ['30d', '30日', 2592000]]);
  assert.equal(LEGACY_PERIOD_ALIASES.all, '30d');
  assert.equal(parseState('period=all').period, '30d');
  assert.equal(parseState('#period=all&sort=new').period, '30d');
  assert.equal(serializeState(parseState('period=all')), 'period=30d'); // all は書き出さない
  assert.equal(parseState('period=3d').period, '3d');
  // 3日の境界: 基準時刻からちょうど 72 時間前は含まない（24時間等と同じく「より新しい」）、72 時間未満は含む
  const ref = ts('2026-10-11T23:59:00+09:00');
  const ds = dataset([
    rawPost({ id: 'in', ts: ref - 72 * 3600 + 1 }),
    rawPost({ id: 'edge', ts: ref - 72 * 3600 }),
    rawPost({ id: 'out', ts: ref - 72 * 3600 - 1 }),
  ], undefined, '2026-10-11T23:59:00+09:00');
  assert.deepEqual(filterPosts(ds.posts, { period: '3d' }, ds.refTs).map((p) => p.id), ['in']);
});

test('niceTicks: 0 を含む切りのよい目盛り', () => {
  assert.deepEqual(niceTicks(37, 4), [0, 10, 20, 30, 40]);
  assert.deepEqual(niceTicks(0), [0, 1]);
  assert.ok(niceTicks(3, 4).every((v) => Number.isInteger(v)));
});

// ---------------------------------------------------------------- 本文

test('linkifySegments: http(s) のみ URL、末尾の句読点は含めない', () => {
  const segs = linkifySegments('見て https://t.co/AbC123。\njavascript:alert(1) と http://example.com/a?b=1).');
  assert.deepEqual(segs, [
    { type: 'text', value: '見て ' },
    { type: 'url', value: 'https://t.co/AbC123' },
    { type: 'text', value: '。\njavascript:alert(1) と ' },
    { type: 'url', value: 'http://example.com/a?b=1' },
    { type: 'text', value: ').' },
  ]);
  assert.deepEqual(linkifySegments('<script>alert(1)</script>'), [{ type: 'text', value: '<script>alert(1)</script>' }]);
  assert.deepEqual(linkifySegments(''), []);
  assert.equal(isSafeHttpUrl('https://x.com/a'), true);
  assert.equal(isSafeHttpUrl('javascript:alert(1)'), false);
  assert.equal(isSafeHttpUrl('data:text/html,1'), false);
});

test('highlightSegments: 大文字小文字無視・長い語優先・重なりなし', () => {
  const segs = highlightSegments('Host ホストクラブのホスト', [{ kind: 'term', terms: ['ホスト', 'ホストクラブ'] }, { kind: 'q', terms: ['host'] }]);
  assert.deepEqual(segs, [
    { text: 'Host', hit: true, kind: 'q' },
    { text: ' ', hit: false },
    { text: 'ホストクラブ', hit: true, kind: 'term' },
    { text: 'の', hit: false },
    { text: 'ホスト', hit: true, kind: 'term' },
  ]);
  // HTML はそのまま文字列として返る（DOM 側で textContent として挿入）
  assert.deepEqual(highlightSegments('<b>x</b>', [{ kind: 'term', terms: ['x'] }]).map((s) => s.text).join(''), '<b>x</b>');
  assert.deepEqual(highlightSegments('abc', []), [{ text: 'abc', hit: false }]);
});

// ---------------------------------------------------------------- URL 状態

test('serializeState / parseState: 往復で一致し、既定値は省略', () => {
  assert.equal(serializeState(DEFAULT_STATE), '');
  const st = { cats: ['ホスト', 'テスト,カンマ'], group: 'night', period: '7d', user: 'sample_a', q: '指名 歌舞伎町', watched: true, sort: 'imp', acct: 'imp', view: 'embed', rdate: '2026-10-12', rweek: '2026-10-10_2026-10-17', rclosed: ['daily', 'weekly'], panel: true, rising: true, rsdate: '2026-10-12' };
  const s = serializeState(st);
  assert.deepEqual(parseState('#' + s), st);
  assert.deepEqual(parseState('?' + s), st);
  assert.deepEqual(parseState('period=xx&sort=yy&view=zz'), { ...DEFAULT_STATE, cats: [] });
  assert.equal(parseState('', 'embed').view, 'embed'); // URL に無ければ保存値
  assert.equal(parseState('view=card', 'embed').view, 'card'); // URL が優先
  assert.equal(parseState('', null, true).panel, true); // 詳細パネル: URL に無ければ保存値
  assert.equal(parseState('panel=0', null, true).panel, false);
  assert.equal(parseState('', null, null, true).rising, true); // 伸びている投稿パネル: URL に無ければ保存値
  assert.equal(parseState('rising=0', null, null, true).rising, false);
  assert.equal(parseState('rsdate=10/11').rsdate, '');
  // isFilterActive はアカウント・キーワード・監視のみを見る（期間・カテゴリは常に掛かるので件数で判定）
  assert.equal(isFilterActive(DEFAULT_STATE), false);
  assert.equal(isFilterActive({ period: '30d', rising: true, panel: true, view: 'embed' }), false);
  assert.equal(isFilterActive({ q: '  ' }), false);
  assert.equal(isFilterActive({ q: '指名' }), true);
  assert.equal(isFilterActive({ user: 'a' }), true);
  assert.equal(isFilterActive({ watched: true }), true);
});

// ---------------------------------------------------------------- カテゴリ色

test('categorySlot: 既知は固定、未知はハッシュで決定的に予備スロットへ', () => {
  // アクセントの赤と紛れないよう、既知カテゴリは赤・ピンク系スロット（6=オレンジ, 7=ピンク）を使わない
  for (const slot of Object.values(KNOWN_CATEGORY_SLOTS)) assert.ok(!SPARE_SLOTS.includes(slot));
  for (const [name, slot] of Object.entries(KNOWN_CATEGORY_SLOTS)) assert.equal(categorySlot(name), slot);
  const a = categorySlot('テスト新カテゴリ');
  assert.ok(SPARE_SLOTS.includes(a));
  assert.equal(categorySlot('テスト新カテゴリ'), a);
  assert.equal(hashString('abc'), hashString('abc'));
  assert.notEqual(hashString('abc'), hashString('abd'));
});

// ---------------------------------------------------------------- メディア・埋め込み

test('isAllowedMediaUrl: https の pbs/video.twimg.com のみ', () => {
  assert.equal(isAllowedMediaUrl('https://pbs.twimg.com/media/a.jpg'), true);
  assert.equal(isAllowedMediaUrl('https://video.twimg.com/a.mp4'), true);
  assert.equal(isAllowedMediaUrl('http://pbs.twimg.com/media/a.jpg'), false);
  assert.equal(isAllowedMediaUrl('https://evil.example.com/a.jpg'), false);
  assert.equal(isAllowedMediaUrl('https://pbs.twimg.com.evil.example/a.jpg'), false);
  assert.equal(isAllowedMediaUrl('https://user@pbs.twimg.com/a.jpg'), false);
  assert.equal(isAllowedMediaUrl('javascript:alert(1)'), false);
  assert.equal(isAllowedMediaUrl(null), false);
});

test('sanitizeMedia / bestMp4: 許可外を捨て、mp4 の最高 bit_rate を選ぶ', () => {
  const v = [
    { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/p.m3u8' },
    { content_type: 'video/mp4', bit_rate: 800, url: 'https://video.twimg.com/low.mp4' },
    { content_type: 'video/mp4', bit_rate: 2000, url: 'https://video.twimg.com/high.mp4' },
    { content_type: 'video/mp4', bit_rate: 9999, url: 'https://evil.example.com/x.mp4' },
  ];
  assert.equal(bestMp4(v), 'https://video.twimg.com/high.mp4');
  assert.equal(bestMp4([v[0]]), null);
  const m = sanitizeMedia([
    { type: 'photo', url: 'https://pbs.twimg.com/1.jpg', alt_text: 'a', width: 10, height: 5 },
    { type: 'photo', url: 'https://evil.example.com/2.jpg' },
    { type: 'video', preview_image_url: 'https://pbs.twimg.com/t.jpg', variants: v },
    { type: 'animated_gif', preview_image_url: 'javascript:alert(1)', variants: [] },
    { type: 'unknown', url: 'https://pbs.twimg.com/x.jpg' },
    null,
  ]);
  assert.deepEqual(m, [
    { type: 'photo', url: 'https://pbs.twimg.com/1.jpg', width: 10, height: 5, alt: 'a' },
    { type: 'video', preview: 'https://pbs.twimg.com/t.jpg', video: 'https://video.twimg.com/high.mp4', width: null, height: null, alt: '' },
  ]);
  const five = Array.from({ length: 5 }, (_, i) => ({ type: 'photo', url: `https://pbs.twimg.com/${i}.jpg` }));
  assert.equal(sanitizeMedia(five).length, 4);
  assert.deepEqual(sanitizeMedia(undefined), []);
  assert.deepEqual(sanitizeMedia('x'), []);
});

test('embedTweetId: 数字の id を優先し、無ければ URL から', () => {
  assert.equal(embedTweetId({ id: '1844674407370955161' }), '1844674407370955161');
  assert.equal(embedTweetId({ id: 'abc', url: 'https://x.com/a/status/123?s=20' }), '123');
  assert.equal(embedTweetId({ id: 'abc', url: 'https://x.com/a' }), null);
});

// ---------------------------------------------------------------- サンプルデータ

test('sample/posts.json: 仕様どおりで検証ケースを含む', () => {
  const raw = JSON.parse(readFileSync(new URL('../sample/posts.json', import.meta.url), 'utf8'));
  const summary = JSON.parse(readFileSync(new URL('../sample/summary.json', import.meta.url), 'utf8'));
  const ds = normalizeDataset(raw);
  assert.ok(ds.posts.length >= 1400 && ds.posts.length <= 1600);
  assert.ok(ds.categories.includes('テスト新カテゴリ'));
  assert.ok(raw.posts.every((p) => typeof p.id === 'string' && p.user.startsWith('sample_') && p.text.startsWith('【サンプル】')));
  assert.ok(raw.posts.some((p) => p.is_watched));
  assert.ok(raw.posts.some((p) => /^【サンプル】\s*https:\/\/t\.co\/\S+$/.test(p.text) && p.categories.includes('その他')));
  assert.ok(raw.posts.some((p) => p.created_jst && p.created_jst.startsWith('2016')));
  assert.ok(raw.posts.some((p) => p.text.includes('<script>')));
  assert.ok(raw.posts.some((p) => p.text.includes('onerror')));
  assert.ok(raw.posts.some((p) => p.metrics && p.metrics.impression_count === null));
  assert.ok(raw.posts.some((p) => !p.metrics || !('bookmark_count' in p.metrics)));
  assert.ok(raw.posts.some((p) => Array.isArray(p.media) && p.media.some((m) => m.type === 'video')));
  assert.equal(summary.total_posts, raw.posts.length);
  // summary の件数とクライアント集計が一致
  const agg = aggregate(ds.posts, ds.categories);
  for (const c of agg.byCategory) assert.equal(summary.by_category[c.name].posts, c.posts, c.name);
  assert.equal(summary.total_accounts, agg.totalAccounts);
});

// ---------------------------------------------------------------- 基準時刻・更新スケジュール・伸びペース

test('chooseRefTs / normalizeDataset: generated_at を優先し、無ければ最新投稿', () => {
  assert.deepEqual(chooseRefTs('2026-10-11T23:59:00+09:00', 100), { refTs: ts('2026-10-11T23:59:00+09:00'), refSource: 'generated_at' });
  assert.deepEqual(chooseRefTs(null, 100), { refTs: 100, refSource: 'latest_post' });
  assert.deepEqual(chooseRefTs('壊れた値', 100), { refTs: 100, refSource: 'latest_post' });
  assert.deepEqual(chooseRefTs(null, null), { refTs: null, refSource: null });
  // 前日 23:59 更新のデータは、日中に見ても 23:59 基準で 24 時間を切る
  const gen = '2026-10-11T23:59:00+09:00';
  const ds = dataset([
    rawPost({ id: '1', ts: ts('2026-10-11T12:00:00+09:00') }),
    rawPost({ id: '2', ts: ts('2026-10-10T23:00:00+09:00') }),
  ], undefined, gen);
  assert.equal(ds.refTs, ts(gen));
  assert.equal(ds.refSource, 'generated_at');
  assert.equal(ds.latestPostTs, ts('2026-10-11T12:00:00+09:00'));
  assert.deepEqual(filterPosts(ds.posts, { period: '24h' }, ds.refTs).map((p) => p.id), ['1']);
});

test('nextScheduledUpdate: generated_at の次の 23:59 JST（定時直前の生成はその回とみなす）', () => {
  const d = UPDATE_SCHEDULE.daily;
  assert.equal(nextScheduledUpdate(ts('2026-10-11T18:41:00+09:00'), d), ts('2026-10-11T23:59:00+09:00'));
  assert.equal(nextScheduledUpdate(ts('2026-10-11T23:59:00+09:00'), d), ts('2026-10-12T23:59:00+09:00'));
  assert.equal(nextScheduledUpdate(ts('2026-10-11T23:59:40+09:00'), d), ts('2026-10-12T23:59:00+09:00'));
  assert.equal(nextScheduledUpdate(ts('2026-10-11T23:45:00+09:00'), d), ts('2026-10-12T23:59:00+09:00'));
  assert.equal(nextScheduledUpdate(ts('2026-10-12T00:05:00+09:00'), d), ts('2026-10-12T23:59:00+09:00'));
  assert.equal(nextScheduledUpdate(null, d), null);
});

test('isUpdateDelayed: 次の 23:59 から猶予 2 時間を過ぎたら true', () => {
  const g = ts('2026-10-11T23:59:00+09:00');
  assert.equal(isUpdateDelayed(g, ts('2026-10-12T15:00:00+09:00'), UPDATE_SCHEDULE), false);
  assert.equal(isUpdateDelayed(g, ts('2026-10-13T01:59:00+09:00'), UPDATE_SCHEDULE), false);
  assert.equal(isUpdateDelayed(g, ts('2026-10-13T02:00:00+09:00'), UPDATE_SCHEDULE), true);
  assert.equal(isUpdateDelayed(null, ts('2026-10-13T02:00:00+09:00'), UPDATE_SCHEDULE), false);
  assert.equal(UPDATE_SCHEDULE.dailyLabel, '毎日23:59（JST）');
});

test('viewsPerHour / formatPace: 表示 ÷ 経過時間（1時間未満は1時間）、不明は「不明」', () => {
  const ref = ts('2026-10-11T23:59:00+09:00');
  const p = { ts: ref - 3 * 3600, metrics: { impression_count: 382000 } };
  assert.deepEqual(viewsPerHour(p, ref), { hours: 3, views: 382000, perHour: 382000 / 3 });
  assert.equal(formatPace(p, ref), '投稿から3時間で38.2万表示（1時間あたり12.7万）');
  const fresh = { ts: ref - 600, metrics: { impression_count: 5000 } };
  assert.equal(viewsPerHour(fresh, ref).perHour, 5000);
  assert.equal(formatPace(fresh, ref), '投稿から1時間未満で5,000表示（1時間あたり5,000）');
  assert.equal(formatPace({ ts: ref - 5 * 86400, metrics: { impression_count: 120000 } }, ref), '投稿から5日で12万表示（1時間あたり1,000）');
  assert.equal(viewsPerHour({ ts: ref, metrics: { impression_count: null } }, ref), null);
  assert.equal(formatPace({ ts: ref, metrics: { impression_count: null } }, ref), '伸びペース：不明');
  assert.ok(PACE_NOTE.includes('予測ではありません'));
});

test('sortPosts(pace): 1時間あたり表示の降順、不明は末尾', () => {
  const ref = ts('2026-10-11T23:59:00+09:00');
  const ds = dataset([
    rawPost({ id: 'a', ts: ref - 2 * 3600, metrics: { impression_count: 100000 } }), // 5万/h
    rawPost({ id: 'b', ts: ref - 10 * 3600, metrics: { impression_count: 600000 } }), // 6万/h
    rawPost({ id: 'c', ts: ref - 1800, metrics: { impression_count: 30000 } }), // 3万/h（1時間扱い）
    rawPost({ id: 'd', ts: ref - 3600, metrics: { impression_count: null } }),
  ], undefined, '2026-10-11T23:59:00+09:00');
  assert.ok(SORTS.some((s) => s.key === 'pace'));
  assert.deepEqual(sortPosts(ds.posts, 'pace', ds.refTs).map((p) => p.id), ['b', 'a', 'c', 'd']);
});

// ---------------------------------------------------------------- レポート（reports.json）

test('normalizeReports: 不正は null、未知フィールドは無視、型違いは null（不明）', () => {
  assert.equal(normalizeReports(null), null);
  assert.equal(normalizeReports([]), null);
  assert.equal(normalizeReports('x'), null);
  assert.deepEqual(normalizeReports({}), { generated_at: null, daily: [], weekly: [] });
  assert.deepEqual(normalizeReports({ daily: 'x', weekly: null }), { generated_at: null, daily: [], weekly: [] });
  const r = normalizeReports({
    generated_at: '2026-10-12T23:59:00+09:00',
    unknown_top: 1,
    daily: [
      { date: '2026-10-11', rising: [], review: [], hit_rate: [] },
      { date: '2026-10-12', extra: true,
        rising: [{ id: 123, views: 382000, hours_since_post: 3, views_per_hour: 127333, condition_label: '<b>条件</b>' }, { id: '9', views: 'abc', hours_since_post: null, condition_label: 5 }, 'bad'],
        review: [{ id: '1', before_views: 382000, after_views: 625000, crossed_500k: true }, { id: '2', before_views: '1', after_views: 2, crossed_500k: 'yes' }],
        hit_rate: [{ condition_label: 'A', total: 4, crossed: 3 }, { condition_label: 'B', total: '4', crossed: 1 }] },
      { date: '10/12', rising: [] },
      { date: '2026-10-12', rising: [] }, // 重複は先勝ち
    ],
    weekly: [
      { period: { from: '2026-10-03', to: '2026-10-10' }, hit_rate_by_pace: [{ pace_label: '速', total: 2, crossed: 1 }], threshold_proposal: 'a\nb', watch_candidates: [{ user: '@u1', reason: 'r' }, { user: '' }, { reason: 'x' }] },
      { period: { from: '2026-10-10', to: '2026-10-17' } },
      { period: { from: 'x' } },
    ],
  });
  assert.deepEqual(r.daily.map((d) => d.date), ['2026-10-12', '2026-10-11']);
  const d = r.daily[0];
  assert.deepEqual(d.rising, [
    { id: '123', views: 382000, hours: 3, perHour: 127333, label: '<b>条件</b>' },
    { id: '9', views: null, hours: null, perHour: null, label: null },
  ]);
  assert.deepEqual(d.review[1], { id: '2', before: null, after: 2, crossed: null });
  assert.deepEqual(d.hitRate[1], { label: 'B', total: null, crossed: 1 });
  assert.deepEqual(r.weekly.map((w) => w.key), ['2026-10-10_2026-10-17', '2026-10-03_2026-10-10']);
  const w = r.weekly[1];
  assert.deepEqual(w.byPace, [{ label: '速', total: 2, crossed: 1 }]);
  assert.equal(w.proposal, 'a\nb');
  assert.deepEqual(w.candidates, [{ user: 'u1', reason: 'r' }]);
  assert.deepEqual(r.weekly[0].byCondition, []);
  assert.equal(r.weekly[0].proposal, null);
});

test('pickReport / weekKey: 選択が無い・一覧に無ければ最新', () => {
  const list = [{ date: '2026-10-12' }, { date: '2026-10-11' }];
  assert.equal(pickReport(list, '2026-10-11', (x) => x.date).date, '2026-10-11');
  assert.equal(pickReport(list, '', (x) => x.date).date, '2026-10-12');
  assert.equal(pickReport(list, '2020-01-01', (x) => x.date).date, '2026-10-12');
  assert.equal(pickReport([], 'x', (x) => x.date), null);
  assert.equal(weekKey({ from: '2026-10-10', to: '2026-10-17' }), '2026-10-10_2026-10-17');
  assert.equal(weekKey({ from: '10/10' }), null);
});

test('hitRateText / hitRatio: n件中m件（xx%）、total=0 は「対象なし」、欠損は「不明」', () => {
  assert.equal(hitRateText(4, 3), '4件中3件（75%）');
  assert.equal(hitRateText(3, 1), '3件中1件（33%）');
  assert.equal(hitRateText(0, 0), '対象なし');
  assert.equal(hitRateText(null, 1), '不明');
  assert.equal(hitRateText(4, -1), '不明');
  assert.equal(hitRatio(4, 3), 0.75);
  assert.equal(hitRatio(0, 0), null);
  assert.equal(hitRatio(2, 5), 1);
});

test('formatRisingPace / formatBeforeAfter: views と hours_since_post から表示', () => {
  assert.equal(formatRisingPace(382000, 3, 127333), '投稿から3時間で38.2万表示（1時間あたり12.7万）');
  assert.equal(formatRisingPace(382000, 3, null), '投稿から3時間で38.2万表示（1時間あたり12.7万）');
  assert.equal(formatRisingPace(50000, 0.5, null), '投稿から1時間未満で5万表示（1時間あたり5万）');
  assert.equal(formatRisingPace(null, 3, 1), '伸びペース：不明');
  assert.equal(formatBeforeAfter(382000, 625000), '38.2万→62.5万');
  assert.equal(formatBeforeAfter(null, 625000), '不明→62.5万');
  assert.ok(REPORT_TEXT.dailyEmpty.length > 0 && REPORT_TEXT.weeklyEmpty.length > 0);
});

test('sample/reports.json: posts の id を参照し、posts に無い id・型違い・XSS 文字列を含む', () => {
  const raw = JSON.parse(readFileSync(new URL('../sample/reports.json', import.meta.url), 'utf8'));
  const posts = JSON.parse(readFileSync(new URL('../sample/posts.json', import.meta.url), 'utf8')).posts;
  const ids = new Set(posts.map((p) => p.id));
  const r = normalizeReports(raw);
  assert.ok(r.daily.length >= 2 && r.weekly.length >= 1);
  const rising = r.daily[0].rising;
  assert.ok(rising.some((x) => ids.has(x.id)));
  assert.ok(rising.some((x) => !ids.has(x.id)));
  assert.ok(rising.some((x) => /<img/.test(x.label || '')));
  assert.ok(r.daily[0].review.some((x) => x.crossed === null));
  assert.ok(r.weekly[0].proposal.includes('<script>'));
});

// ---------------------------------------------------------------- カテゴリのグループ・初期状態

test('初期状態: 24時間・夜職すべて・インプレッションが多い順。URL には既定と違うものだけ', () => {
  assert.equal(DEFAULT_STATE.period, '24h');
  assert.equal(DEFAULT_STATE.group, 'night');
  assert.equal(DEFAULT_STATE.sort, 'imp');
  assert.equal(SORTS.find((x) => x.key === 'imp').label, 'インプレッションが多い順');
  assert.equal(serializeState(DEFAULT_STATE), '');
  assert.equal(serializeState({ group: 'general' }), 'group=general');
  assert.equal(serializeState({ period: '30d', sort: 'new' }), 'period=30d&sort=new');
  assert.deepEqual(parseState(''), { ...DEFAULT_STATE, cats: [], rclosed: [] });
  assert.equal(parseState('group=general').group, 'general');
  assert.equal(parseState('group=zzz').group, 'night');
});

test('グループ: 夜職すべて＝夜職4カテゴリ、一般のバズ＝その他、話題カテゴリなしはどちらにも入らない', () => {
  assert.deepEqual(groupCategories('night'), ['ホスト', 'キャバクラ', '歌舞伎町', '夜職その他']);
  assert.deepEqual(groupCategories('general'), ['その他']);
  const ds = dataset([
    rawPost({ id: '1', categories: ['ホスト'] }),
    rawPost({ id: '2', categories: ['監視アカウント'] }), // 話題カテゴリなし → どちらにも入らない
    rawPost({ id: '3', categories: ['その他'] }),
    rawPost({ id: '4', categories: ['テスト新カテゴリ'] }), // 未知のみ → どちらにも入らない
    rawPost({ id: '5', categories: ['ホスト', '監視アカウント'] }), // 監視＋ホスト → 夜職のみ
    rawPost({ id: '6', categories: ['監視アカウント', 'その他'] }), // 監視＋その他 → 一般のみ
    rawPost({ id: '7', categories: ['キャバクラ', 'その他'] }), // 両方 → 両方
  ], ['ホスト', 'キャバクラ', '歌舞伎町', '夜職その他', '監視アカウント', 'その他']);
  const ids = (st) => filterPosts(ds.posts, st, ds.refTs).map((p) => p.id).sort();
  assert.deepEqual(ids({ group: 'night' }), ['1', '5', '7']);
  assert.deepEqual(ids({ group: 'general' }), ['3', '6', '7']);
  assert.deepEqual(ids({ group: 'night', cats: ['テスト新カテゴリ'] }), ['4']); // 個別選択が優先
  assert.deepEqual(ids({}), ['1', '2', '3', '4', '5', '6', '7']); // 省略時は絞らない
  const byId = (id) => ds.posts.find((p) => p.id === id);
  assert.equal(inGroup(byId('6'), 'night'), false); // 監視＋その他 → 一般のみ
  assert.equal(inGroup(byId('6'), 'general'), true);
  assert.equal(inGroup(byId('5'), 'night'), true); // 監視＋ホスト → 夜職のみ
  assert.equal(inGroup(byId('5'), 'general'), false);
  assert.equal(inGroup(byId('2'), 'night') || inGroup(byId('2'), 'general'), false); // 話題カテゴリなし
  assert.deepEqual(ds.posts.filter(isUnclassified).map((p) => p.id).sort(), ['2', '4']);
  assert.equal(categoryMatcher({ cats: [], group: '' }), null);
  // 個別チップ: 夜職4つ＋未知カテゴリ（監視・その他は出さない）
  assert.deepEqual(individualChipCategories(ds.categories), ['ホスト', 'キャバクラ', '歌舞伎町', '夜職その他', 'テスト新カテゴリ']);
  assert.equal(categoryLabel('その他'), '一般のバズ');
  assert.equal(categoryLabel('ホスト'), 'ホスト');
});

test('normalizeCategorySelection: モード（夜職／一般）と個別選択。旧 URL の cat=… / group=… も解釈', () => {
  const cats = ['ホスト', 'キャバクラ', '歌舞伎町', '夜職その他', '監視アカウント', 'その他', '新カテゴリ'];
  assert.deepEqual(normalizeCategorySelection({ cats: ['ホスト', 'その他'], group: 'night' }, cats), { cats: ['ホスト'], group: 'night' });
  assert.deepEqual(normalizeCategorySelection({ cats: ['その他'], group: 'night' }, cats), { cats: [], group: 'general' });
  assert.deepEqual(normalizeCategorySelection({ cats: ['監視アカウント'], group: 'night' }, cats), { cats: [], group: 'night' });
  assert.deepEqual(normalizeCategorySelection({ cats: ['存在しない'], group: 'general' }, cats), { cats: [], group: 'general' });
  assert.deepEqual(normalizeCategorySelection({ cats: [], group: '' }, cats), { cats: [], group: 'night' });
  assert.deepEqual(normalizeCategorySelection({ cats: ['新カテゴリ'], group: 'night' }, cats), { cats: ['新カテゴリ'], group: 'night' });
  // 一般のバズモードでは夜職の個別選択は外れ、未知カテゴリだけ選べる
  assert.deepEqual(normalizeCategorySelection({ cats: ['ホスト', '新カテゴリ'], group: 'general' }, cats), { cats: ['新カテゴリ'], group: 'general' });
  assert.equal(serializeState({ group: 'general', cats: ['新カテゴリ'] }), 'cat=%E6%96%B0%E3%82%AB%E3%83%86%E3%82%B4%E3%83%AA&group=general');
});

test('rising_watch（任意）と、伸びている投稿の夜職のみフィルタ（一般のバズのみは除外・posts に無い id は残す）', () => {
  const r = normalizeReports({ daily: [
    { date: '2026-10-12', rising: [{ id: '1' }],
      rising_watch: [{ id: '2', views: 150000, hours_since_post: 2, views_per_hour: 75000, condition_label: '10万〜20万表示・伸び始め', reason: '<b>補足</b>', extra: 1 }, 'bad'] },
    { date: '2026-10-11', rising: [] },
  ] });
  assert.deepEqual(r.daily[0].risingWatch, [{ id: '2', views: 150000, hours: 2, perHour: 75000, label: '10万〜20万表示・伸び始め', reason: '<b>補足</b>' }]);
  assert.deepEqual(r.daily[1].risingWatch, []); // フィールドが無ければ空
  const ds = dataset([
    rawPost({ id: '1', categories: ['ホスト'] }),
    rawPost({ id: '2', categories: ['その他'] }), // 一般のバズのみ → 除外
    rawPost({ id: '3', categories: ['その他', 'キャバクラ'] }), // 夜職も持つ → 残す
    rawPost({ id: '4', categories: ['監視アカウント', 'その他'] }), // 夜職を持たない → 除外
  ], ['ホスト', 'キャバクラ', 'その他', '監視アカウント']);
  const byId = new Map(ds.posts.map((p) => [p.id, p]));
  const items = ['1', '2', '3', '4', '999'].map((id) => ({ id }));
  const out = filterNightRising(items, byId);
  assert.deepEqual(out.items.map((x) => x.id), ['1', '3', '999']); // 999 は posts に無いので判定できず残す（データ側の並び順のまま）
  assert.equal(out.excluded, 2);
  assert.deepEqual(filterNightRising(undefined, byId), { items: [], excluded: 0 });
});

test('sizedImageUrl: pbs.twimg.com の画像だけサイズ指定 URL に変える', async () => {
  globalThis.document ??= undefined;
  const { sizedImageUrl } = await import('../assets/js/media.js');
  assert.equal(sizedImageUrl('https://pbs.twimg.com/media/ABC.jpg', 'small'), 'https://pbs.twimg.com/media/ABC?format=jpg&name=small');
  assert.equal(sizedImageUrl('https://pbs.twimg.com/media/ABC?format=png&name=orig', 'large'), 'https://pbs.twimg.com/media/ABC?format=png&name=large');
  assert.equal(sizedImageUrl('https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/X.jpeg', 'small'), 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/X?format=jpg&name=small');
  assert.equal(sizedImageUrl('https://video.twimg.com/a.mp4', 'small'), 'https://video.twimg.com/a.mp4');
  assert.equal(sizedImageUrl('not a url', 'small'), 'not a url');
});
