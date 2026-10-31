// 配信番組サイト（/show/）の純粋関数テスト（show/js/logic.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeDataset } from '../assets/js/core.js';
import { DEFAULT_DICT, SCHEMA_VERSION, CORNERS } from '../show/js/config.js';
import {
  showWeekOf, weekByKey, shiftWeekKey, listWeeks, postsInWeek, weekLabel,
  extractStatusIds, normalizeForMatch, containsWord, cleanTerms, dictHits, prepareDictEntry, bigrams, jaccard, similarClusters,
  buildTopics, topicStats, topicScore, sortTopics, suggestMain, leadText, autoTitle,
  defaultRundown, assignTopic, removeTopic, moveInCorner, replaceTopicId, buildCues, defaultLive, liveReduce, carriedTopicIds,
  cueStates, computeTimer, formatClock, recordCheckpoint, newSince, defaultWeek, defaultSaved, parseSaved, serializeSaved,
  pruneWeeks, syncCarriedOut, togglePlanCarry, isCarriedOut, reviewLists, scriptText, indexTopics, compareIds, pickWeeklyReport,
  bookmarkList, usedPostIdsOf, pastUsedIds, topicPhrase, isGroupedTopic, scorePoints, canBeMain,
  shelveTopic, unshelveTopic, trashTopic, restoreTrash, isTrashed, partitionTopics, hidePost, unhidePost, restoreToCorner,
} from '../show/js/logic.js';

const ts = (iso) => Math.floor(Date.parse(iso) / 1000);
let seq = 0;
function post(over = {}) {
  seq++;
  const t = over.ts ?? ts('2026-10-14T12:00:00+09:00');
  return {
    id: String(2110000000000000000n + BigInt(seq)), url: '', user: `sample_u${seq}`, created_jst: null, ts: t,
    metrics: { impression_count: 1000, like_count: 1, retweet_count: 0, reply_count: 0, quote_count: 0, bookmark_count: 0 },
    text: '本文', categories: ['ホスト'], matched_terms: [], is_watched: false,
    ...over,
  };
}
const ds = (posts, generatedAt = '2026-10-16T00:09:00+09:00') => normalizeDataset({ generated_at: generatedAt, posts });

// ---------------------------------------------------------------- 番組週

test('番組週: 前週 土 1:00 以上〜今回 土 1:00 未満（基準はデータの時刻）', () => {
  const w = showWeekOf(ts('2026-10-16T00:09:00+09:00')); // 金
  assert.equal(w.key, '2026-10-17');
  assert.equal(w.start, ts('2026-10-10T01:00:00+09:00'));
  assert.equal(w.end, ts('2026-10-17T01:00:00+09:00'));
  assert.equal(weekLabel(w), '10/10(土) 1:00 〜 10/17(土) 1:00');
  // 土 0:59 はその週、土 1:00 ちょうどは次の週
  assert.equal(showWeekOf(ts('2026-10-17T00:59:59+09:00')).key, '2026-10-17');
  assert.equal(showWeekOf(ts('2026-10-17T01:00:00+09:00')).key, '2026-10-24');
  assert.equal(showWeekOf(ts('2026-10-10T01:00:00+09:00')).key, '2026-10-17');
  assert.equal(showWeekOf(ts('2026-10-10T00:30:00+09:00')).key, '2026-10-10');
  // 日曜・UTC で日付がずれる時間帯
  assert.equal(showWeekOf(ts('2026-10-11T08:00:00+09:00')).key, '2026-10-17');
  assert.equal(showWeekOf(ts('2026-10-16T23:30:00+09:00')).key, '2026-10-17');
  assert.equal(showWeekOf(null), null);
});

test('番組週: キー・前後・一覧・切り出し', () => {
  assert.deepEqual(weekByKey('2026-10-17'), showWeekOf(ts('2026-10-12T00:00:00+09:00')));
  assert.equal(weekByKey('2026-10-16'), null, '土曜以外は不正');
  assert.equal(weekByKey('bad'), null);
  assert.equal(shiftWeekKey('2026-10-17', 1), '2026-10-24');
  assert.equal(shiftWeekKey('2026-10-17', -1), '2026-10-10');
  const ws = listWeeks(ts('2026-10-16T00:09:00+09:00'), ts('2026-09-30T00:00:00+09:00'), 8);
  assert.deepEqual(ws.map((w) => w.key), ['2026-10-17', '2026-10-10', '2026-10-03']);
  const w = weekByKey('2026-10-17');
  const ps = [
    post({ ts: w.start - 1 }), post({ ts: w.start }), post({ ts: w.end - 1 }), post({ ts: w.end }), post({ ts: null }),
  ];
  assert.equal(postsInWeek(ps, w).length, 2);
});

// ---------------------------------------------------------------- URL → id

test('URL から投稿 id を取り出す（x.com / twitter.com / 複数行・重複・不正）', () => {
  const r = extractStatusIds(`https://x.com/abc/status/2110759592615682271
https://twitter.com/abc_def/status/2110759592615682272?s=20
  https://mobile.twitter.com/x/statuses/2110759592615682273
https://x.com/i/web/status/2110759592615682274
https://x.com/abc/status/2110759592615682271
2110759592615682275
https://example.com/abc/status/1234567890123
javascript:alert(1)
https://x.com/abc`);
  assert.deepEqual(r.ids.map((x) => x.id), ['2110759592615682271', '2110759592615682272', '2110759592615682273', '2110759592615682274', '2110759592615682275']);
  assert.equal(r.ids[1].url, 'https://twitter.com/abc_def/status/2110759592615682272');
  assert.equal(r.ids[4].url, 'https://x.com/i/web/status/2110759592615682275');
  assert.deepEqual(r.invalid, ['https://example.com/abc/status/1234567890123', 'javascript:alert(1)', 'https://x.com/abc']);
  assert.deepEqual(extractStatusIds('').ids, []);
  assert.deepEqual(extractStatusIds(null).ids, []);
});

// ---------------------------------------------------------------- 言葉の一致

test('言葉の一致: カタカナの続きは別の言葉（アルコール≠コール）・NFKC', () => {
  assert.equal(containsWord(normalizeForMatch('アルコール消毒'), 'コール'), false);
  assert.equal(containsWord(normalizeForMatch('コールしてもらった'), 'コール'), true);
  assert.equal(containsWord(normalizeForMatch('シャンパンコール！'), 'シャンパンコール'), true);
  assert.equal(containsWord(normalizeForMatch('ｼｬﾝﾊﾟﾝｺｰﾙ'), normalizeForMatch('シャンパンコール')), true, '半角カナ');
  assert.equal(containsWord(normalizeForMatch('マイクロソフト'), 'マイク'), false);
  assert.equal(containsWord(normalizeForMatch('売掛が'), '売掛'), true);
});

test('matched_terms の整理: topic: は話題名、quote: は外す、report:/manual/inherit: は使わない', () => {
  const r = cleanTerms(['report:ホスト', 'quote:キャバ嬢', 'topic:平良さんの引退', 'manual', 'inherit:ref', 'ホストコール', 'ホストコール', 1]);
  assert.deepEqual(r.words, ['キャバ嬢', 'ホストコール']);
  assert.deepEqual(r.topics, ['平良さんの引退']);
});

test('辞書の一致数: 言葉1・関係者2（@アカウント・店名）', () => {
  const e = prepareDictEntry({ id: 'x', name: 'X', genre: 'host', words: ['ラスソン', 'マイク'], people: ['@club_x', 'クラブサンプル'] });
  const info = (p) => ({ text: normalizeForMatch(p.text), terms: '', user: p.user, mentions: [...normalizeForMatch(p.text).matchAll(/@([a-z0-9_]{1,15})/g)].map((m) => m[1]) });
  assert.equal(dictHits(e, info({ text: 'ラスソンでマイク', user: 'a' })), 2);
  assert.equal(dictHits(e, info({ text: '今日は普通', user: 'club_x' })), 2);
  assert.equal(dictHits(e, info({ text: '@club_x さんへ', user: 'b' })), 2);
  assert.equal(dictHits(e, info({ text: 'クラブサンプルに行った', user: 'b' })), 2);
  assert.equal(dictHits(e, info({ text: '関係ない', user: 'b' })), 0);
});

test('類似度: bigram と Jaccard', () => {
  const a = bigrams('ホストコール https://t.co/xxx @someone');
  assert.ok(a.has('ホス') && !a.has('ht') && !a.has('so'));
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['c'])), 0);
  assert.equal(jaccard(new Set(), new Set(['c'])), 0);
});

// ---------------------------------------------------------------- 話題のまとめ

function weekData() {
  seq = 0;
  const posts = [
    // 辞書（ホストコール）
    post({ text: 'シャンパンコールの新曲が話題', metrics: { impression_count: 50000 } }),
    post({ text: 'ラスソン聴いてきた', metrics: { impression_count: 30000 } }),
    post({ text: 'アルコール消毒の話', categories: ['その他'], metrics: { impression_count: 10 } }),
    // データ側の話題名
    post({ text: 'サンプル王子が引退', matched_terms: ['topic:王子の引退'], metrics: { impression_count: 900000 } }),
    post({ text: '王子のラストイベント', matched_terms: ['topic:王子の引退'], metrics: { impression_count: 100000 } }),
    // 類似（辞書に無い）
    post({ text: '歌舞伎町の新しいラーメン店「麺屋サンプル」に深夜でも行列ができている', categories: ['歌舞伎町'] }),
    post({ text: '麺屋サンプルの深夜の行列がすごい、歌舞伎町の新しいラーメン店', categories: ['歌舞伎町'] }),
    // 同じアカウント（夜職）
    post({ user: 'sample_same', text: '今週の出勤は水木金です', categories: ['夜職その他'] }),
    post({ user: 'sample_same', text: '新しい名刺のデザインが届いた', categories: ['夜職その他'] }),
    // 同じアカウント（一般のバズ）はまとめない
    post({ user: 'sample_news', text: '台風が近づいています', categories: ['その他'] }),
    post({ user: 'sample_news', text: '新しい駅ビルが開業', categories: ['その他'] }),
    // 関係者（@言及）
    post({ user: 'sample_emi', text: '新しいお店を開店しました', categories: ['キャバクラ'] }),
    post({ user: 'sample_mio', text: '@sample_emi さんのお店に行った、照明が綺麗', categories: ['キャバクラ'] }),
    // 表示数不明
    post({ text: '数値が不明な投稿の本文です', categories: ['夜職その他'], metrics: { impression_count: null } }),
  ];
  return ds(posts);
}

test('話題のまとめ: 辞書・topic:・類似・同一アカウント（夜職のみ）・関係者', () => {
  const d = weekData();
  const topics = buildTopics({ posts: d.posts, dict: DEFAULT_DICT, refTs: d.refTs });
  const byName = (n) => topics.find((t) => t.name === n);
  const call = topics.find((t) => t.id === 'd:d-hostcall');
  assert.equal(call.postIds.length, 2, 'ホストコール 2件（アルコールは入らない）');
  assert.equal(call.genre, 'host');
  const tag = topics.find((t) => t.id === 't:王子の引退');
  assert.equal(tag.postIds.length, 2);
  assert.equal(tag.name, '王子の引退');
  const clusters = topics.filter((t) => t.kind === 'cluster');
  const reasons = clusters.map((t) => t.reasons[0]).sort();
  assert.deepEqual(reasons, ['related', 'same_user', 'similar']);
  assert.ok(clusters.every((t) => t.suggested), '類似まとめは「同じ話題かも？」');
  assert.equal(byName('@sample_same の話題').postIds.length, 2);
  assert.equal(topics.filter((t) => t.kind === 'single' && d.posts.find((p) => p.id === t.postIds[0]).user === 'sample_news').length, 2, '一般のバズの同一アカウントはまとめない');
  const rel = clusters.find((t) => t.reasons[0] === 'related');
  assert.equal(rel.genre, 'kyaba');
  // 全投稿がどれか 1 つの話題に入る
  const all = topics.flatMap((t) => t.postIds);
  assert.equal(all.length, d.posts.length);
  assert.equal(new Set(all).size, d.posts.length);
});

test('話題のまとめ: 採用・分割・移動・結合・名前とジャンルの変更', () => {
  const d = weekData();
  const base = buildTopics({ posts: d.posts, dict: DEFAULT_DICT, refTs: d.refTs });
  const sim = base.find((t) => t.reasons[0] === 'similar');
  const call = base.find((t) => t.id === 'd:d-hostcall');
  const tag = base.find((t) => t.id === 't:王子の引退');
  // 採用
  let t = buildTopics({ posts: d.posts, dict: DEFAULT_DICT, refTs: d.refTs, overrides: { accepted: [sim.id] } });
  assert.equal(t.find((x) => x.id === sim.id).suggested, false);
  // 分割
  t = buildTopics({ posts: d.posts, dict: DEFAULT_DICT, refTs: d.refTs, overrides: { split: [sim.id] } });
  assert.equal(t.find((x) => x.id === sim.id), undefined);
  assert.ok(sim.postIds.every((id) => t.find((x) => x.id === `p:${id}`)));
  // 投稿の移動（新しい話題として分ける・別の話題へ）
  const moved = call.postIds[0];
  t = buildTopics({ posts: d.posts, dict: DEFAULT_DICT, refTs: d.refTs, overrides: { moves: { [moved]: `p:${moved}`, [tag.postIds[0]]: call.id } } });
  assert.equal(t.find((x) => x.id === `p:${moved}`).postIds[0], moved);
  assert.equal(t.find((x) => x.id === call.id).postIds.length, 2);
  // 結合（連鎖・循環に耐える）
  t = buildTopics({ posts: d.posts, dict: DEFAULT_DICT, refTs: d.refTs, overrides: { merges: { [tag.id]: call.id, [call.id]: tag.id, [sim.id]: tag.id } } });
  const merged = t.filter((x) => [tag.id, call.id, sim.id].includes(x.id));
  assert.equal(merged.length, 1, '循環しても 1 つにまとまる');
  assert.equal(merged[0].postIds.length, 6);
  // 名前・ジャンル
  t = buildTopics({ posts: d.posts, dict: DEFAULT_DICT, refTs: d.refTs, overrides: { renames: { [call.id]: '  新名前 ' }, genres: { [call.id]: 'kabuki' } } });
  assert.equal(t.find((x) => x.id === call.id).name, '新名前');
  assert.equal(t.find((x) => x.id === call.id).genre, 'kabuki');
  assert.equal(t.find((x) => x.id === call.id).autoName, 'ホストコール');
});

test('話題のまとめ: 個人追加（週の外・データに無い）・ブクマ・持ち越し・手動の話題', () => {
  const d = weekData();
  const outside = normalizeDataset({ posts: [post({ ts: ts('2026-09-01T00:00:00+09:00'), text: '週の外の投稿' })] }).posts[0];
  const topics = buildTopics({
    posts: d.posts, extraPosts: [outside], missingIds: ['1999999999999999999'],
    personalIds: new Set([outside.id]), bookmarkIds: new Set(['1999999999999999999']),
    carried: [{ topicId: 'd:d-tower', name: 'シャンパンタワー', genre: 'host', postIds: [d.posts[0].id], fromWeek: '2026-10-10' }],
    postsById: new Map(d.posts.map((p) => [p.id, p])), dict: DEFAULT_DICT, refTs: d.refTs,
    overrides: { manual: [{ id: 'm:1', name: '手動の話題', genre: 'general' }] },
  });
  const me = topics.find((t) => t.postIds.includes(outside.id));
  assert.ok(me && me.personal);
  const link = topics.find((t) => t.id === 'x:1999999999999999999');
  assert.equal(link.kind, 'link');
  assert.ok(link.bookmark);
  assert.equal(link.stats.count, 0);
  assert.equal(link.score, null);
  const k = topics.find((t) => t.id === 'k:d:d-tower');
  assert.equal(k.kind, 'carried');
  assert.deepEqual(k.postIds, [d.posts[0].id], '持ち越し話題が投稿を優先して持つ');
  assert.ok(!topics.find((t) => t.id === 'd:d-hostcall').postIds.includes(d.posts[0].id));
  assert.equal(topics.find((t) => t.id === 'm:1').genre, 'general');
});

test('統計・スコア順（不明は末尾）・メイン候補', () => {
  const d = weekData();
  const st = topicStats([d.posts.find((p) => p.metrics.impression_count == null)], d.refTs);
  assert.equal(st.totalImp, null);
  assert.equal(st.unknownImp, 1);
  assert.equal(topicScore(st), null);
  const topics = buildTopics({ posts: d.posts, dict: DEFAULT_DICT, refTs: d.refTs });
  assert.equal(topics[0].id, 't:王子の引退', '合計表示が最大の話題が先頭');
  assert.equal(topics[topics.length - 1].score, null, 'スコア不明は末尾');
  for (let i = 1; i < topics.length; i++) {
    if (topics[i].score == null) continue;
    assert.ok(topics[i - 1].score >= topics[i].score);
  }
  const m = suggestMain(topics, ['t:王子の引退'], 3);
  assert.equal(m.length, 3);
  assert.ok(!m.some((t) => t.id === 't:王子の引退'));
  // 同点は最大表示 → id
  const s = sortTopics([{ id: 'b', score: 1, stats: { maxImp: 1 } }, { id: 'a', score: 1, stats: { maxImp: 1 } }, { id: 'c', score: null, stats: { maxImp: 9 } }]);
  assert.deepEqual(s.map((x) => x.id), ['a', 'b', 'c']);
  assert.ok(compareIds('9', '10') < 0);
});

test('リード文・自動タイトル', () => {
  const d = weekData();
  const topics = buildTopics({ posts: d.posts, dict: DEFAULT_DICT, refTs: d.refTs });
  const byId = new Map(d.posts.map((p) => [p.id, p]));
  const call = topics.find((t) => t.id === 'd:d-hostcall');
  const lead = leadText(call, byId, d.refTs);
  assert.match(lead, /^今週「ホストコール」が話題に。投稿2件、合計8万インプレ。いちばん伸びた投稿は投稿から\d+時間で5万表示（1時間あたり.+）。$/);
  const unk = topics.find((t) => t.stats.totalImp == null);
  assert.match(leadText(unk, byId, d.refTs), /合計インプレは不明/);
  assert.match(leadText({ name: 'リンク', stats: { count: 0 } }, byId, d.refTs), /不明/);
  assert.equal(autoTitle('週刊ヨルニュース', ['A', 'B', ' ', 'C']), '【週刊ヨルニュース】A／B／C');
  assert.equal(autoTitle('', []), '【週刊ヨルニュース】');
});

// ---------------------------------------------------------------- 構成・進行

test('構成: コーナーへ入れる（メインは3本まで）・外す・並べ替え・付け替え', () => {
  let r = defaultRundown();
  assert.deepEqual(r.corners.map((c) => c.key), CORNERS.map((c) => c.key));
  for (const id of ['a', 'b', 'c']) r = assignTopic(r, id, 'main');
  assert.equal(assignTopic(r, 'd', 'main'), null, 'メインは満杯');
  assert.equal(assignTopic(r, 'd', 'opening').corners[0].items.length, 3, '無いコーナーには入らない');
  r = assignTopic(r, 'a', 'category');
  assert.deepEqual(r.corners.find((c) => c.key === 'main').items, [null, 'b', 'c'], '他のコーナーから移動（メインは枠の位置を保つ）');
  r = moveInCorner(r, 'main', 'c', -1);
  assert.deepEqual(r.corners.find((c) => c.key === 'main').items, [null, 'c', 'b']);
  r = replaceTopicId(r, 'b', 'c');
  assert.deepEqual(r.corners.find((c) => c.key === 'main').items, [null, 'c']);
  r = assignTopic(r, 'x', 'main');
  assert.deepEqual(r.corners.find((c) => c.key === 'main').items, ['x', 'c'], '空き枠に入る');
  r = removeTopic(removeTopic(r, 'c'), 'x');
  assert.equal(r.corners.find((c) => c.key === 'main').items.length, 0);
});

function liveSetup() {
  let r = defaultRundown();
  r = assignTopic(r, 'A', 'main');
  r = assignTopic(r, 'B', 'main');
  r = assignTopic(r, 'C', 'category');
  const topics = new Map(['A', 'B', 'C'].map((id) => [id, { id }]));
  return { r, cues: buildCues(r, topics) };
}

test('進行の並び: 話題ごと・空のコーナーは「未設定」・消えた話題は飛ばす', () => {
  const { r, cues } = liveSetup();
  assert.deepEqual(cues.map((c) => c.id), ['main:A', 'main:B', 'category:C', 'chat']);
  assert.equal(cues.find((c) => c.id === 'chat').kind, 'empty');
  assert.equal(cues[0].n, 1);
  assert.equal(cues[0].of, 2);
  const cues2 = buildCues(r, new Map([['A', { id: 'A' }]]));
  assert.ok(!cues2.some((c) => c.id === 'main:B'));
});

test('進行の状態遷移: 読んだ・戻す・飛ばす・来週へ・移動・リセット', () => {
  const { cues } = liveSetup();
  let s = defaultLive();
  s = liveReduce(s, { type: 'start', now: 1000 }, cues);
  assert.equal(s.startedAt, 1000);
  assert.equal(s.enteredAt.main, 1000);
  s = liveReduce(s, { type: 'done', now: 2000 }, cues);
  assert.equal(s.status['main:A'], 'done');
  assert.equal(s.index, 1);
  s = liveReduce(s, { type: 'carry', now: 3000 }, cues);
  assert.equal(s.status['main:B'], 'carried');
  assert.deepEqual([...carriedTopicIds(s, cues)], ['B']);
  assert.equal(s.enteredAt.category, 3000);
  s = liveReduce(s, { type: 'skip', now: 4000 }, cues);
  assert.equal(s.status['category:C'], 'skipped');
  assert.equal(cues[s.index].id, 'chat');
  // 話題でないキュー（未設定のコーナー）は「来週へ」できない
  const same = liveReduce(s, { type: 'carry', now: 5000 }, cues);
  assert.deepEqual(same.status, s.status);
  assert.equal(same.index, s.index);
  // 戻す: 直前の操作を順に取り消す
  s = liveReduce(s, { type: 'back' }, cues);
  assert.equal(cues[s.index].id, 'category:C');
  assert.equal(s.status['category:C'], undefined);
  s = liveReduce(s, { type: 'back' }, cues);
  assert.equal(cues[s.index].id, 'main:B');
  assert.equal(carriedTopicIds(s, cues).size, 0, '戻すと来週へも取り消し');
  assert.deepEqual(cueStates(s, cues).slice(0, 3), ['done', 'current', 'todo']);
  // 移動と、済を飛ばして次の未処理へ
  s = liveReduce(s, { type: 'goto', index: 0, now: 6000 }, cues);
  assert.equal(s.index, 0);
  s = liveReduce(s, { type: 'done', now: 7000 }, cues);
  assert.equal(cues[s.index].id, 'main:B', '済のキューは飛ばす');
  // 最後まで
  for (let i = 0; i < 20; i++) s = liveReduce(s, { type: 'done', now: 8000 }, cues);
  assert.equal(s.index, cues.length);
  assert.equal(liveReduce(s, { type: 'done' }, cues).index, cues.length);
  s = liveReduce(s, { type: 'reset' }, cues);
  assert.deepEqual(s, defaultLive());
  // 履歴が空でも戻せる
  const g = liveReduce({ ...defaultLive(), index: 2 }, { type: 'back' }, cues);
  assert.equal(g.index, 1);
  // 壊れた live にも耐える
  assert.equal(liveReduce({ index: 999, status: null }, { type: 'back' }, cues).index, cues.length - 1);
});

test('タイマー: 経過・コーナー残り・押し/巻き（既定 45/30/15 分）', () => {
  const { r, cues } = liveSetup();
  assert.deepEqual(r.corners.map((c) => [c.key, c.min]), [['main', 45], ['category', 30], ['chat', 15]]);
  assert.equal(computeTimer(defaultLive(), r, cues, 0).state, 'idle');
  const t0 = 1_000_000;
  let s = liveReduce(defaultLive(), { type: 'start', now: t0 }, cues);
  let t = computeTimer(s, r, cues, t0 + 60_000);
  assert.equal(t.elapsedSec, 60);
  assert.equal(t.cornerRemainSec, 44 * 60);
  assert.equal(t.state, 'ok');
  // メイン（45分）を 48 分続けた → 押し 3 分
  t = computeTimer(s, r, cues, t0 + 48 * 60_000);
  assert.equal(t.driftSec, 180);
  assert.equal(t.state, 'over');
  assert.equal(t.cornerRemainSec, -180);
  // 40 分でカテゴリ別へ → 巻き 5 分
  s = liveReduce(s, { type: 'done', now: t0 + 20 * 60_000 }, cues);
  s = liveReduce(s, { type: 'done', now: t0 + 40 * 60_000 }, cues);
  t = computeTimer(s, r, cues, t0 + 40 * 60_000 + 1000);
  assert.equal(t.driftSec, -300);
  assert.equal(t.state, 'under');
  assert.equal(t.totalSec, 90 * 60);
  assert.equal(formatClock(65), '1:05');
  assert.equal(formatClock(-65), '-1:05');
  assert.equal(formatClock(3725), '1:02:05');
  assert.equal(formatClock(null), '--:--');
});

// ---------------------------------------------------------------- チェックポイント・持ち越し

test('チェックポイント: 以降の新規投稿・話題に NEW', () => {
  let w = defaultWeek();
  assert.equal(newSince(w, ['1'], []).since, null);
  w = recordCheckpoint(w, 'preview', '2026-10-16T00:09:00+09:00', ['1', '2'], ['d:a', 'p:2'], 5);
  w = recordCheckpoint(w, 'final', '2026-10-16T22:00:00+09:00', ['1', '2', '3'], ['d:a', 'p:2', 'p:3'], 6);
  assert.equal(w.checkpoints.length, 2);
  assert.equal(w.checkpoints[0].postIds, undefined, '古いチェックの id 一覧は捨てる');
  assert.equal(w.checkpoints[0].count, 2);
  const n = newSince(w, ['1', '2', '3', '4'], [{ id: 'd:a', postIds: ['1', '4'] }, { id: 'p:2', postIds: ['2'] }, { id: 'p:9', postIds: [] }]);
  assert.deepEqual([...n.posts], ['4']);
  assert.equal(n.topics.get('d:a'), 1);
  assert.equal(n.topics.has('p:2'), false);
  assert.equal(n.topics.get('p:9'), 0, '新しい話題');
});

test('来週に回す: 進行・編成からの反映と取り消し', () => {
  const t = { id: 'd:x', kind: 'dict', name: 'X', genre: 'host', postIds: ['1'] };
  const byId = indexTopics([t, { id: 'k:d:y', kind: 'carried', name: 'Y', genre: 'kabuki', postIds: [] }]);
  let list = syncCarriedOut([], byId, new Set(['d:x']), '2026-10-17', { 'd:x': { points: 'メモ' } });
  assert.equal(list.length, 1);
  assert.equal(list[0].via, 'live');
  assert.equal(list[0].points, 'メモ');
  list = togglePlanCarry(list, byId.get('k:d:y'), '2026-10-17', null);
  assert.equal(list[1].topicId, 'd:y', '持ち越しをさらに持ち越すと元の id');
  assert.ok(isCarriedOut(list, 'k:d:y'));
  list = syncCarriedOut(list, byId, new Set(), '2026-10-17');
  assert.deepEqual(list.map((c) => c.topicId), ['d:y'], '進行で戻したものだけ消える');
  list = togglePlanCarry(list, byId.get('k:d:y'), '2026-10-17', null);
  assert.equal(list.length, 0);
});

// ---------------------------------------------------------------- 保存データ

test('保存データ: 往復・版数・壊れた値・未知のフィールド', () => {
  const s = defaultSaved();
  s.showName = 'テスト番組';
  const w = defaultWeek();
  w.rundown = assignTopic(w.rundown, 'd:a', 'main');
  w.script['d:a'] = { lead: null, points: 'ポイント', question: '質問' };
  w.personal.push({ id: '2110000000000000001', url: 'https://x.com/a/status/2110000000000000001', addedAt: 1 });
  w.live = liveReduce(defaultLive(), { type: 'start', now: 1 }, buildCues(w.rundown, new Map([['d:a', {}]])));
  s.weeks['2026-10-17'] = w;
  s.activeWeek = '2026-10-17';
  const json = serializeSaved(s, 123);
  const obj = JSON.parse(json);
  assert.equal(obj.v, SCHEMA_VERSION);
  assert.equal(obj.app, 'xtrend-show');
  assert.equal(obj.savedAt, 123);
  const back = parseSaved(json);
  assert.ok(back.ok);
  assert.equal(back.state.showName, 'テスト番組');
  assert.deepEqual(back.state.weeks['2026-10-17'].rundown, w.rundown);
  assert.deepEqual(back.state.weeks['2026-10-17'].script, w.script);
  assert.equal(back.state.weeks['2026-10-17'].live.startedAt, 1);

  // 壊れた値
  for (const bad of ['{', 'null', '[]', '"str"', '42']) {
    const r = parseSaved(bad);
    assert.equal(r.ok, false, bad);
    assert.deepEqual(r.state, defaultSaved());
  }
  assert.equal(parseSaved({ app: 'other' }).ok, false);
  // 型違い・未知のフィールド・不正な週キー・__proto__
  const r = parseSaved(JSON.stringify({
    v: 99, unknown: 1, showName: 123, dict: [null, { name: '' }, { id: 'a', name: '辞書', genre: 'zzz', words: ['x', 2, 'x'], people: 'bad' }, { id: 'a', name: '重複' }],
    weeks: {
      'bad-key': {}, '2026-10-16': {},
      '2026-10-17': {
        title: 5, rundown: { corners: [{ key: 'main', min: 9999, items: ['a', 'b', 'c', 'd', 'a', 7] }, { key: 'zzz' }, { key: 'chat', min: 12, items: ['a', 'e'] }] },
        script: { x: 'bad', y: { lead: 1, points: 'p' }, __proto__: { polluted: true } },
        overrides: { renames: { a: 'A', b: 1 }, genres: { a: 'host', b: 'bad' }, moves: { notanid: 'x', 123: 'p:123' }, merges: { a: 'a', b: 'c' }, manual: [{ id: 'x' }, { id: 'm:1', name: 'M' }] },
        personal: [{ id: 'abc' }, { id: '2110000000000000001', url: 'javascript:alert(1)' }, { id: '2110000000000000001' }],
        checkpoints: [{ kind: 'bad' }, { kind: 'preview', dataAt: 'x', postIds: ['1', 2, 'a'] }],
        live: { startedAt: 'x', index: -5, status: { 'main:a': 'done', 'main:b': 'weird', 'opening': 'done' }, history: ['main:a', 'main:b', 'opening'], enteredAt: { main: 5, zzz: 1 } },
        carriedOut: [{ topicId: 'd:a', name: 'A', genre: 'x', postIds: ['1', 'x'], fromWeek: '2026-10-10', via: 'plan' }, { topicId: 'd:a' }, {}],
      },
    },
    activeWeek: '2026-10-16',
  }));
  assert.ok(r.ok);
  assert.match(r.reason, /新しい版/);
  const st = r.state;
  assert.equal(st.showName, '週刊ヨルニュース');
  assert.deepEqual(st.dict.map((e) => [e.id, e.genre, e.words, e.people]), [['a', 'night', ['x'], []]]);
  assert.deepEqual(Object.keys(st.weeks), ['2026-10-17']);
  assert.equal(st.activeWeek, null);
  const wk = st.weeks['2026-10-17'];
  assert.equal(wk.title, null);
  const main = wk.rundown.corners.find((c) => c.key === 'main');
  assert.equal(main.min, 45, '範囲外の分数は既定のまま');
  assert.deepEqual(main.items, ['a', 'b', 'c'], 'メインは3本まで・重複除去');
  assert.deepEqual(wk.rundown.corners.find((c) => c.key === 'chat').items, ['e'], 'コーナーをまたぐ重複も除去');
  assert.equal(wk.rundown.corners.length, CORNERS.length);
  assert.deepEqual(Object.keys(wk.script), ['y']);
  assert.equal(wk.script.y.lead, null);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(wk.overrides.renames, { a: 'A' });
  assert.deepEqual(wk.overrides.genres, { a: 'host' });
  assert.deepEqual(wk.overrides.moves, { 123: 'p:123' });
  assert.deepEqual(wk.overrides.merges, { b: 'c' });
  assert.deepEqual(wk.overrides.manual, [{ id: 'm:1', name: 'M', genre: 'night' }]);
  assert.equal(wk.personal.length, 1);
  assert.equal(wk.personal[0].url, 'https://x.com/i/web/status/2110000000000000001', '危険な URL は捨てる');
  assert.deepEqual(wk.checkpoints, [{ kind: 'preview', dataAt: 'x', recordedAt: null, count: null, postIds: ['1'] }]);
  assert.deepEqual(wk.live, { startedAt: null, index: 0, status: { 'main:a': 'done' }, history: ['main:a'], enteredAt: { main: 5 }, cardVisible: true });
  assert.equal(wk.carriedOut.length, 1);
  assert.deepEqual(wk.carriedOut[0].postIds, ['1']);
  assert.equal(wk.carriedOut[0].genre, 'night');
  assert.equal(wk.carriedOut[0].via, 'plan');
});

test('保存データ: 容量不足のとき古い週を整理', () => {
  const s = defaultSaved();
  for (const k of ['2026-09-19', '2026-09-26', '2026-10-03', '2026-10-10', '2026-10-17']) {
    s.weeks[k] = recordCheckpoint(defaultWeek(), 'preview', null, ['1'], ['a'], 1);
  }
  const p = pruneWeeks(s, 2, '2026-09-19');
  assert.deepEqual(Object.keys(p.weeks).sort(), ['2026-09-19', '2026-10-10', '2026-10-17']);
  assert.equal(p.weeks['2026-10-10'].checkpoints[0].postIds, undefined);
  assert.deepEqual(p.weeks['2026-09-19'].checkpoints[0].postIds, ['1']);
});

// ---------------------------------------------------------------- 振り返り・書き出し

test('振り返り一覧とテキスト書き出し（概要欄用はメモを含まない）', () => {
  const d = weekData();
  const topics = buildTopics({ posts: d.posts, dict: DEFAULT_DICT, refTs: d.refTs });
  const byId = indexTopics(topics);
  let r = defaultRundown();
  r = assignTopic(r, 'd:d-hostcall', 'main');
  r = assignTopic(r, 't:王子の引退', 'main');
  const cues = buildCues(r, byId);
  let live = liveReduce(defaultLive(), { type: 'done' }, cues);
  live = liveReduce(live, { type: 'carry' }, cues);
  live = liveReduce(live, { type: 'skip' }, cues);
  const lists = reviewLists(live, cues);
  assert.deepEqual(lists.done.map((c) => c.id), ['main:d:d-hostcall']);
  assert.deepEqual(lists.carried.map((c) => c.id), ['main:t:王子の引退']);
  assert.deepEqual(lists.skipped.map((c) => c.id), ['category']);
  assert.deepEqual(lists.todo.map((c) => c.id), ['chat']);
  const args = {
    title: '【T】ホストコール／王子の引退', week: weekByKey('2026-10-17'), rundown: r, topicsById: byId,
    script: { 'd:d-hostcall': { lead: null, points: '秘密のメモ', question: '質問？' } }, notes: { main: '内輪メモ' },
    postsById: new Map(d.posts.map((p) => [p.id, p])), refTs: d.refTs,
  };
  const pub = scriptText({ ...args, mode: 'public' });
  assert.match(pub, /^【T】ホストコール／王子の引退\n配信：10\/17\(土\) 1:00〜（約90分）/);
  assert.match(pub, /00:00 メイン3トピック\n45:00 カテゴリ別ニュース\n1:15:00 雑談（一般のバズ）\n/);
  assert.ok(!/オープニング|中休み|答え合わせ|エンディング/.test(pub), '旧コーナーは出ない');
  assert.match(pub, /1\. ホストコール\n {3}今週「ホストコール」が話題に。/);
  assert.match(pub, /https:\/\/x\.com\/i\/web\/status\/\d+/);
  assert.ok(!pub.includes('秘密のメモ') && !pub.includes('内輪メモ'));
  const full = scriptText({ ...args, mode: 'full' });
  assert.ok(full.includes('話すポイント：秘密のメモ') && full.includes('視聴者への質問：質問？') && full.includes('メモ：内輪メモ'));
});

test('答え合わせ: 番組週に重なる週間まとめを選ぶ', () => {
  const weekly = [{ from: '2026-10-17', to: '2026-10-23' }, { from: '2026-10-10', to: '2026-10-16' }];
  assert.equal(pickWeeklyReport(weekly, weekByKey('2026-10-17')).from, '2026-10-10');
  assert.equal(pickWeeklyReport(weekly, weekByKey('2026-12-05')).from, '2026-10-17');
  assert.equal(pickWeeklyReport([], null), null);
});

test('show 用サンプル: 最新の番組週に話題がまとまる', () => {
  const raw = JSON.parse(readFileSync(new URL('../sample/show/posts.json', import.meta.url), 'utf8'));
  const d = normalizeDataset(raw);
  const w = showWeekOf(d.refTs);
  const wp = postsInWeek(d.posts, w);
  assert.ok(wp.length >= 50);
  const topics = buildTopics({ posts: wp, dict: DEFAULT_DICT, refTs: d.refTs });
  const call = topics.find((t) => t.id === 'd:d-hostcall');
  assert.ok(call && call.postIds.length >= 5, 'ホストコールがまとまる');
  assert.ok(topics.some((t) => t.kind === 'tag'));
  assert.ok(topics.some((t) => t.kind === 'cluster'));
  assert.ok(wp.some((p) => p.text.includes('<img')), 'XSS 検証用の本文');
});

// ---------------------------------------------------------------- ブックマーク

test('ブックマーク枠: 今週（日時が週内／日時なしは投稿日時）・すべて・使用済みは下へ', () => {
  const w = weekByKey('2026-10-17');
  const inW = ts('2026-10-12T00:00:00+09:00');
  const out = ts('2026-10-05T00:00:00+09:00');
  const postsById = new Map([['1', { id: '1', ts: inW }], ['2', { id: '2', ts: out }], ['3', { id: '3', ts: inW }], ['4', { id: '4', ts: inW }]]);
  const bms = [
    { id: '1', ts: null }, // 日時なし・投稿は今週 → 今週
    { id: '2', ts: null }, // 日時なし・投稿は前週 → すべてだけ
    { id: '3', ts: out }, // 前週にブックマーク → すべてだけ
    { id: '4', ts: inW }, // 今週ブックマーク（使用済み）
    { id: '9', ts: inW }, // posts.json に無い
  ];
  const used = new Set(['4']);
  const wk = bookmarkList(bms, w, postsById, used, 'week');
  assert.deepEqual(wk.map((b) => b.id), ['1', '9', '4'], '使用済みは下へ・元の順は保つ');
  assert.equal(wk[2].used, true);
  assert.equal(wk[1].post, null);
  const all = bookmarkList(bms, w, postsById, used, 'all');
  assert.deepEqual(all.map((b) => b.id), ['1', '2', '3', '9', '4']);
  assert.deepEqual(bookmarkList(null, w, postsById), []);
});

test('ブックマーク: 話題に件数・スコアに少し加点・手入力と同じ id は 1 つ', () => {
  const d = weekData();
  const call = (bmIds, personal = new Set()) => buildTopics({ posts: d.posts, dict: DEFAULT_DICT, refTs: d.refTs, bookmarkIds: bmIds, personalIds: personal });
  const base = call(new Set()).find((t) => t.id === 'd:d-hostcall');
  const id0 = base.postIds[0];
  const withBm = call(new Set([id0]), new Set([id0]));
  const t = withBm.find((x) => x.id === 'd:d-hostcall');
  assert.equal(t.bookmarkCount, 1);
  assert.ok(t.bookmark && t.personal);
  assert.ok(t.score > base.score);
  assert.equal(withBm.flatMap((x) => x.postIds).filter((x) => x === id0).length, 1);
});

test('使用済み: 読んだ話題の投稿 id と、前の週までの集計', () => {
  const topics = indexTopics([{ id: 'A', postIds: ['1', '2'] }, { id: 'B', postIds: ['3'] }, { id: 'C', postIds: [], linkId: '9' }]);
  let r = defaultRundown();
  for (const id of ['A', 'B', 'C']) r = assignTopic(r, id, 'category');
  const cues = buildCues(r, topics);
  let live = liveReduce(defaultLive(), { type: 'goto', index: cues.findIndex((c) => c.topicId === 'A') }, cues);
  live = liveReduce(live, { type: 'done' }, cues);
  live = liveReduce(live, { type: 'skip' }, cues);
  live = liveReduce(live, { type: 'done' }, cues);
  assert.deepEqual(usedPostIdsOf(live, cues, topics), ['1', '2', '9']);
  const s = defaultSaved();
  s.weeks['2026-10-10'] = { ...defaultWeek(), usedPostIds: ['1'] };
  s.weeks['2026-10-17'] = { ...defaultWeek(), usedPostIds: ['2'] };
  assert.deepEqual([...pastUsedIds(s, '2026-10-17')], ['1']);
  const back = parseSaved(serializeSaved(s)).state;
  assert.deepEqual(back.weeks['2026-10-10'].usedPostIds, ['1']);
});

test('show 用サンプル: bookmarks.json と in_bookmarks / below_threshold', () => {
  const raw = JSON.parse(readFileSync(new URL('../sample/show/posts.json', import.meta.url), 'utf8'));
  const bm = JSON.parse(readFileSync(new URL('../sample/show/bookmarks.json', import.meta.url), 'utf8'));
  assert.ok(Array.isArray(bm.bookmarks) && bm.bookmarks.length >= 5);
  assert.ok(bm.bookmarks.some((b) => b.bookmarked_at === null));
  const flagged = raw.posts.filter((p) => p.in_bookmarks === true);
  assert.ok(flagged.length >= 4);
  assert.ok(flagged.some((p) => p.below_threshold === true));
});

// ---------------------------------------------------------------- 2026-10-16 調整（おすすめ・単発・話題名・辞書）

test('話題性スコアは対数: 単発の巨大インプレより、まとまった話題が勝つ', () => {
  const single = topicScore({ count: 1, totalImp: 60_000_000, maxPace: null });
  const group = topicScore({ count: 20, totalImp: 35_000_000, maxPace: null });
  assert.ok(group > single, `${group} > ${single}`);
  assert.ok(topicScore({ count: 2, totalImp: 1000 }) > topicScore({ count: 1, totalImp: 1000 }));
  assert.ok(topicScore({ count: 1, totalImp: 1000 }, undefined, 1) > topicScore({ count: 1, totalImp: 1000 }));
  assert.equal(scorePoints(9.74), 97);
  assert.equal(scorePoints(null), null);
});

test('メインのおすすめ: 夜職で2件以上 → 夜職の単発（一般のバズは出さない）', () => {
  const t = (id, genre, count, score) => ({ id, genre, score, stats: { count, maxImp: 0 }, postIds: [] });
  const topics = [t('g1', 'general', 1, 99), t('g2', 'general', 3, 98), t('n1', 'host', 1, 50), t('n2', 'kyaba', 2, 10), t('n3', 'night', 5, 20), t('x', 'host', 4, null)];
  assert.deepEqual(suggestMain(topics, [], 3).map((x) => x.id), ['n3', 'n2', 'n1']);
  assert.deepEqual(suggestMain(topics, ['n3', 'n2'], 3).map((x) => x.id), ['n1'], '一般のバズはおすすめしない');
  assert.equal(canBeMain({ genre: 'general' }), false);
  assert.equal(canBeMain({ genre: 'kabuki' }), true);
  assert.equal(canBeMain(null), false);
});

test('保存データの移行（版 1 → 2）: 旧コーナーを取り除き、時間は新しい既定、進行は最初から', () => {
  const v1 = {
    v: 1,
    weeks: {
      '2026-10-17': {
        rundown: { corners: [
          { key: 'opening', min: 5, items: [] }, { key: 'main', min: 35, items: ['a', 'g'] }, { key: 'break', min: 5 },
          { key: 'category', min: 25, items: ['b'] }, { key: 'chat', min: 10, items: ['c'] }, { key: 'review', min: 5 }, { key: 'ending', min: 5 },
        ] },
        notes: { opening: 'オープニングのメモ', main: 'メインのメモ' },
        live: { startedAt: 5, index: 4, status: { opening: 'done', 'main:a': 'done', break: 'skipped' }, history: ['opening', 'main:a', 'break'], enteredAt: { opening: 5, main: 6 } },
      },
    },
  };
  const st = parseSaved(JSON.stringify(v1)).state;
  const w = st.weeks['2026-10-17'];
  assert.deepEqual(w.rundown.corners.map((c) => [c.key, c.min, c.items]), [['main', 45, ['a', 'g']], ['category', 30, ['b']], ['chat', 15, ['c']]],
    'メインに入っていた一般のバズ（g）は自動では消さない');
  assert.deepEqual(w.notes, { main: 'メインのメモ' });
  assert.deepEqual(w.live.status, { 'main:a': 'done' });
  assert.deepEqual(w.live.history, ['main:a']);
  assert.equal(w.live.index, 0);
  assert.deepEqual(w.live.enteredAt, { main: 6 });
  assert.equal(JSON.parse(serializeSaved(st)).v, SCHEMA_VERSION);
});

test('まとまった話題（2件以上・持ち越し・手動・自分で貼った）と単発', () => {
  assert.equal(isGroupedTopic({ kind: 'single', stats: { count: 1 }, postIds: ['1'] }), false);
  assert.equal(isGroupedTopic({ kind: 'cluster', stats: { count: 2 }, postIds: ['1', '2'] }), true);
  assert.equal(isGroupedTopic({ kind: 'link', stats: { count: 0 }, postIds: [] }), true);
  assert.equal(isGroupedTopic({ kind: 'single', stats: { count: 1 }, postIds: ['1'], personalPaste: true }), true);
});

test('話題名: 先頭の【…】・URL・絵文字・記号を除いた最初の句（最大20字）', () => {
  assert.equal(topicPhrase('【害悪度S】\n医誠会国際総合病院 https://t.co/x'), '医誠会国際総合病院');
  assert.equal(topicPhrase('【害悪度S】 https://t.co/x'), '害悪度S');
  assert.equal(topicPhrase('【setlog流行 日常を切り取るリスク】\nhttps://t.co/e2'), 'setlog流行 日常を切り取るリスク');
  assert.equal(topicPhrase('43年ぶりにリニューアル❗️\nオリジナルチキン'), '43年ぶりにリニューアル');
  assert.equal(topicPhrase('『こころの余韻診断』を公開しました。'), 'こころの余韻診断を公開しました');
  assert.equal(topicPhrase('@abc お席どこかわかりますか？'), 'お席どこかわかりますか');
  assert.equal(topicPhrase('とても長い本文がここにずっと続いていて終わらない感じのテキストです'), 'とても長い本文がここにずっと続いていて終…');
  assert.equal(topicPhrase('💫 https://t.co/8n'), '（本文なし）');
  // 話題名は辞書・topic: が優先、本文が URL だけなら「@user の投稿（本文なし）」
  const d = ds([post({ user: 'sample_url', text: 'https://t.co/abc', categories: ['その他'] })]);
  const t = buildTopics({ posts: d.posts, dict: DEFAULT_DICT, refTs: d.refTs });
  assert.equal(t[0].name, '@sample_url の投稿（本文なし）');
});

test('辞書の「夜職のみ」: 一般のバズの「卒業」「引退」は入れない・旧保存値は初期値を引き継ぐ', () => {
  const d = ds([
    post({ text: 'キャバ嬢を卒業します', categories: ['キャバクラ'] }),
    post({ text: '大学を卒業しました', categories: ['その他'] }),
    post({ text: '野球選手が引退を発表', categories: ['その他'] }),
  ]);
  const topics = buildTopics({ posts: d.posts, dict: DEFAULT_DICT, refTs: d.refTs });
  assert.equal(topics.find((t) => t.id === 'd:d-retire').postIds.length, 1);
  const loose = DEFAULT_DICT.map((e) => ({ ...e, nightOnly: false }));
  assert.equal(buildTopics({ posts: d.posts, dict: loose, refTs: d.refTs }).find((t) => t.id === 'd:d-retire').postIds.length, 3);
  const old = parseSaved({ v: 1, dict: [{ id: 'd-retire', name: '卒業・引退', genre: 'night', words: ['卒業'] }, { id: 'u-1', name: '自作', words: ['x'] }] }).state;
  assert.equal(old.dict[0].nightOnly, true);
  assert.equal(old.dict[1].nightOnly, false);
});

// ---------------------------------------------------------------- 整理（片付け・削除）と元に戻す

test('片付け: 構成から外して覚え、戻すと元の枠へ（空きが無ければ候補に戻るだけ）', () => {
  const tA = { id: 'A', name: 'A', genre: 'host', postIds: ['1'] };
  let w = defaultWeek();
  for (const id of ['A', 'B', 'C']) w.rundown = assignTopic(w.rundown, id, 'main');
  w = shelveTopic(w, tA, 100);
  assert.deepEqual(w.rundown.corners[0].items, [null, 'B', 'C']);
  assert.deepEqual(w.shelved[0].corner, { key: 'main', index: 0 });
  assert.equal(shelveTopic(w, tA, 200).shelved.length, 1, '二重には片付けない');
  const back = unshelveTopic(w, 'A');
  assert.ok(back.placed);
  assert.deepEqual(back.week.rundown.corners[0].items, ['A', 'B', 'C'], '元の位置へ');
  assert.equal(back.week.shelved.length, 0);
  // 枠が埋まっていたら候補に戻るだけ
  let w2 = { ...w, rundown: assignTopic(w.rundown, 'D', 'main') };
  const full = unshelveTopic(w2, 'A');
  assert.equal(full.placed, false);
  assert.deepEqual(full.week.rundown.corners[0].items, ['D', 'B', 'C']);
  assert.equal(restoreToCorner(w.rundown, 'Z', null).placed, false);
  // 候補の振り分け
  const part = partitionTopics([tA, { id: 'B', postIds: ['2'] }], w, []);
  assert.deepEqual(part.shelved.map((t) => t.id), ['A']);
  assert.deepEqual(part.visible.map((t) => t.id), ['B']);
});

test('削除: ゴミ箱へ・翌週以降も同じ話題（辞書名・同じ投稿だけ）を出さない・戻すと元の枠へ', () => {
  let saved = defaultSaved();
  let w = defaultWeek();
  w.rundown = assignTopic(w.rundown, 'd:d-hostcall', 'category');
  const dictTopic = { id: 'd:d-hostcall', kind: 'dict', name: 'ホストコール', genre: 'host', postIds: ['1', '2'] };
  let r = trashTopic(saved, w, dictTopic, '2026-10-17', 1000);
  saved = r.saved; w = r.week;
  assert.equal(saved.trash.length, 1);
  assert.equal(w.rundown.corners[1].items.length, 0, '構成からも外す');
  // 翌週: 同じ辞書の話題（投稿は別）も出さない
  assert.ok(isTrashed({ id: 'd:d-hostcall', kind: 'dict', postIds: ['9'] }, saved.trash));
  // 投稿だけの話題: 同じ投稿の組なら出さない・新しい投稿が混じれば出す
  r = trashTopic(saved, w, { id: 'c:5', kind: 'cluster', name: 'X', genre: 'night', postIds: ['5', '6'] }, '2026-10-17', 2000);
  saved = r.saved;
  assert.ok(isTrashed({ id: 'p:5', kind: 'single', postIds: ['5'] }, saved.trash));
  assert.ok(isTrashed({ id: 'c:5', kind: 'cluster', postIds: ['5', '7'] }, saved.trash), '同じ id なら出さない');
  assert.ok(!isTrashed({ id: 'c:7', kind: 'cluster', postIds: ['5', '7'] }, saved.trash), '新しい投稿が混じれば出す');
  assert.ok(!isTrashed({ id: 'd:other', kind: 'dict', postIds: ['5'] }, saved.trash), '辞書の話題は id だけで判定');
  // 戻す（削除した週なら元の枠へ・別の週なら候補に戻るだけ）
  const id = saved.trash.find((x) => x.topicId === 'd:d-hostcall').id;
  const other = restoreTrash(saved, defaultWeek(), id, '2026-10-24');
  assert.equal(other.placed, false);
  const back = restoreTrash(saved, w, id, '2026-10-17');
  assert.ok(back.placed);
  assert.deepEqual(back.week.rundown.corners[1].items, ['d:d-hostcall']);
  assert.equal(back.saved.trash.length, 1);
  // 保存の往復（版 3）
  const st = parseSaved(serializeSaved({ ...saved, weeks: { '2026-10-17': shelveTopic(w, { id: 'A', name: 'A', genre: 'host', postIds: ['1'] }, 5) } })).state;
  assert.equal(st.trash.length, 2);
  assert.equal(st.weeks['2026-10-17'].shelved[0].topicId, 'A');
  assert.equal(parseSaved({ v: 2 }).state.trash.length, 0, '版 2 には無い → 空');
});

test('投稿の削除（非表示）: どの話題にも入れない・戻せる', () => {
  const d = weekData();
  const call = buildTopics({ posts: d.posts, dict: DEFAULT_DICT, refTs: d.refTs }).find((t) => t.id === 'd:d-hostcall');
  let saved = hidePost(defaultSaved(), call.postIds[0], '2026-10-17', 1, 'ホストコール');
  assert.equal(hidePost(saved, call.postIds[0], '2026-10-17', 2).hiddenPosts.length, 1);
  const t2 = buildTopics({ posts: d.posts, dict: DEFAULT_DICT, refTs: d.refTs, hiddenPostIds: new Set(saved.hiddenPosts.map((x) => x.id)) });
  assert.ok(!t2.some((t) => t.postIds.includes(call.postIds[0])));
  assert.equal(t2.find((t) => t.id === 'd:d-hostcall').postIds.length, 1);
  saved = unhidePost(saved, call.postIds[0]);
  assert.equal(saved.hiddenPosts.length, 0);
  assert.equal(parseSaved(serializeSaved(hidePost(defaultSaved(), '123', null, 1))).state.hiddenPosts[0].id, '123');
});

// ================================================================ v2 段階1（フォルダ型の編成）
import {
  isFolderTopic, postTopicMap, recommendGeneral, folderRows, buildTree, selectClick, toggleCheck, selectAllRows, pruneSelection,
  applyDrop, makeGroup, createEmptyGroup, renameTopic, createHistory, recordHistory, undoHistory, redoHistory,
  searchPosts, queryTokens, topicsOfRows, isDropTarget, placeOf, sortProgress, toggledGenre,
} from '../show/js/folders.js';
import { setMainSlot, mainSlots, moveToIndex, applyGenreOverrides, setPostGenre, genreOverrideList, postGenre, categoryOfGenre, usedTopicIds } from '../show/js/logic.js';
import { liveSnapshot, diffSnapshot, publishLiveState, onShowEvent, resetLiveEvents, eventLog } from '../show/js/events.js';

function v2World() {
  const d = weekData();
  const topics = buildTopics({ posts: d.posts, dict: DEFAULT_DICT, refTs: d.refTs });
  const week = defaultWeek();
  const saved = defaultSaved();
  const ctx = {
    week, saved, topics, topicsById: indexTopics(topics), postsById: new Map(d.posts.map((p) => [p.id, p])), weekPosts: d.posts,
    shelvedTopics: [], trashedTopics: [], newPostIds: new Set(), bookmarkPosts: [], pickIds: new Set(), generalAll: false, query: '',
    postTopic: postTopicMap(topics),
  };
  const dctx = { topicsById: ctx.topicsById, postTopic: ctx.postTopic, postsById: ctx.postsById, weekKey: '2026-10-17', now: 1000 };
  return { d, topics, week, saved, ctx, dctx };
}

test('v2 フォルダ: まとまり・受信箱の振り分け（受信箱は番組構成に入っていない単発）', () => {
  const { topics, ctx, week } = v2World();
  const call = topics.find((t) => t.id === 'd:d-hostcall');
  assert.ok(isFolderTopic(call));
  const single = topics.find((t) => t.kind === 'single');
  assert.ok(!isFolderTopic(single));
  const night = folderRows(ctx, 'group:night').rows.map((r) => r.id);
  assert.ok(night.includes('d:d-hostcall') && !night.includes(single.id));
  const inbox = folderRows(ctx, 'inbox').rows.map((r) => r.id);
  assert.ok(inbox.includes(single.postIds[0]));
  assert.ok(!inbox.includes(call.postIds[0]), 'まとまりの投稿は受信箱に出ない');
  // 番組構成に入れたら受信箱から消える
  week.rundown = assignTopic(week.rundown, single.id, 'category');
  assert.ok(!folderRows(ctx, 'inbox').rows.some((r) => r.id === single.postIds[0]));
  assert.deepEqual(folderRows(ctx, 'corner:category').rows.map((r) => r.id), [single.id]);
  assert.deepEqual(folderRows(ctx, `topic:${call.id}`).rows.map((r) => r.id), call.postIds);
  assert.deepEqual(placeOf(week, single.id), { key: 'corner:category', label: 'カテゴリ別' });
});

test('v2 フォルダの木: 番組構成（メイン1〜3・メイン候補・カテゴリ別・雑談）・まとまり・受信箱・件数', () => {
  const { ctx, week, topics } = v2World();
  const call = topics.find((t) => t.id === 'd:d-hostcall');
  week.rundown = setMainSlot(week.rundown, call.id, 1).rundown;
  const nodes = buildTree(ctx, new Set(['group:night']));
  const keys = nodes.map((n) => n.key);
  for (const k of ['slot:0', 'slot:1', 'slot:2', 'cand', 'corner:category', 'corner:chat', 'group:night', 'group:general', 'inbox', 'new', 'shelf', 'trash']) assert.ok(keys.includes(k), k);
  assert.equal(nodes.find((n) => n.key === 'slot:1').sub, call.name);
  assert.equal(nodes.find((n) => n.key === 'slot:0').sub, '空き');
  assert.ok(keys.includes(`topic:${call.id}`), '開いた夜職の下にまとまり');
  assert.ok(!buildTree(ctx, new Set()).some((n) => n.key === `topic:${call.id}`), '閉じていれば出さない');
  assert.equal(nodes.find((n) => n.key === 'group:night').drop, false);
  assert.equal(nodes.find((n) => n.key === 'inbox').count, folderRows(ctx, 'inbox').rows.length >= 0 ? nodes.find((n) => n.key === 'inbox').count : -1);
});

test('v2 一般のバズのおすすめ: 上位 N 件（スコア順）・show_pick は最優先・すべて表示', () => {
  const t = (id, score, posts = [id]) => ({ id, genre: 'general', score, postIds: posts, stats: { count: posts.length } });
  const topics = [t('a', 9), t('b', 8), t('c', 7), t('d', null), { id: 'n', genre: 'host', score: 99, postIds: ['n'], stats: { count: 1 } }];
  assert.deepEqual([...recommendGeneral(topics, 2)], ['a', 'b']);
  assert.deepEqual([...recommendGeneral(topics, 2, new Set(['c']))], ['c', 'a'], 'show_pick が最優先');
  assert.ok(!recommendGeneral(topics, 10).has('n'), '夜職は対象外');
  assert.deepEqual([...recommendGeneral(topics, 10)].slice(-1), ['d'], 'スコア不明は末尾');
});

test('v2 検索: 本文・@アカウント・話題名・matched_terms、スペース区切りで AND', () => {
  const posts = [
    { id: '1', text: 'シャンパンコールの新曲', user: 'host_a', matched_terms: ['quote:ラスソン'] },
    { id: '2', text: '別の話', user: 'kyaba_b', matched_terms: [] },
  ];
  assert.deepEqual(queryTokens('  ラスソン　host '), ['ラスソン', 'host']);
  assert.deepEqual(searchPosts(posts, 'シャンパン').map((p) => p.id), ['1']);
  assert.deepEqual(searchPosts(posts, '@kyaba').map((p) => p.id), ['2']);
  assert.deepEqual(searchPosts(posts, 'ラスソン host_a').map((p) => p.id), ['1'], 'AND・matched_terms');
  assert.deepEqual(searchPosts(posts, 'ラスソン kyaba').map((p) => p.id), []);
  assert.deepEqual(searchPosts(posts, 'まとまりの名前', (id) => (id === '2' ? 'まとまりの名前' : '')).map((p) => p.id), ['2'], '話題名');
  assert.deepEqual(searchPosts(posts, ''), []);
});

test('v2 複数選択: クリック・Ctrl・Shift・チェック・すべて選択・見えない行の掃除', () => {
  const rows = ['a', 'b', 'c', 'd', 'e'].map((k) => ({ key: k }));
  let s = { sel: new Set(), anchor: null };
  s = selectClick(s, rows, 1);
  assert.deepEqual([...s.sel], ['b']);
  s = selectClick(s, rows, 3, { ctrl: true });
  assert.deepEqual([...s.sel].sort(), ['b', 'd']);
  s = selectClick(s, rows, 3, { ctrl: true });
  assert.deepEqual([...s.sel], ['b'], 'Ctrl でもう一度押すと外れる');
  s = selectClick(s, rows, 1);
  s = selectClick(s, rows, 4, { shift: true });
  assert.deepEqual([...s.sel].sort(), ['b', 'c', 'd', 'e'], 'Shift で範囲');
  s = toggleCheck(s, rows, 0);
  assert.equal(s.sel.size, 5);
  s = selectAllRows(rows.slice(0, 2));
  assert.deepEqual([...s.sel], ['a', 'b']);
  s = pruneSelection({ sel: new Set(['a', 'z']), anchor: 9 }, rows);
  assert.deepEqual([...s.sel], ['a']);
  assert.equal(s.anchor, null);
});

test('v2 メインの枠: メイン1〜3（空き枠を保つ）・入れ替え・押し出し', () => {
  let r = defaultRundown();
  r = setMainSlot(r, 'A', 2).rundown;
  assert.deepEqual(mainSlots(r), [null, null, 'A']);
  let x = setMainSlot(r, 'B', 2);
  assert.equal(x.displaced, 'A', '入っていた話題は押し出される');
  x = setMainSlot(x.rundown, 'C', 0);
  assert.deepEqual(mainSlots(x.rundown), ['C', null, 'B']);
  const sw = setMainSlot(x.rundown, 'C', 2);
  assert.deepEqual(mainSlots(sw.rundown), ['B', null, 'C'], 'メインの中では入れ替え');
  assert.equal(sw.displaced, null);
  r = moveToIndex(assignTopic(assignTopic(assignTopic(defaultRundown(), 'p', 'category'), 'q', 'category'), 'r', 'category'), 'category', 'r', 0);
  assert.deepEqual(r.corners.find((c) => c.key === 'category').items, ['r', 'p', 'q']);
  r = moveToIndex(r, 'category', 'r', 3);
  assert.deepEqual(r.corners.find((c) => c.key === 'category').items, ['p', 'q', 'r']);
  assert.deepEqual(buildCues(sw.rundown, new Map([['B', {}], ['C', {}]])).map((c) => c.id), ['main:B', 'main:C', 'category', 'chat'], '空き枠は飛ばす');
});

test('v2 ドロップ: 投稿→まとまり（移動）・まとまり→まとまり（結合）・投稿→番組構成（入っている話題ごと）', () => {
  const { topics, week, saved, dctx } = v2World();
  const call = topics.find((t) => t.id === 'd:d-hostcall');
  const tag = topics.find((t) => t.id === 't:王子の引退');
  const single = topics.find((t) => t.kind === 'single' && t.genre !== 'general');
  // 投稿 → まとまり
  let r = applyDrop(week, saved, [{ type: 'post', id: single.postIds[0] }], `topic:${call.id}`, dctx);
  assert.ok(r.ok);
  assert.equal(week.overrides.moves[single.postIds[0]], call.id);
  // まとまり → まとまり（結合）。番組構成に入っていたら付け替え
  week.rundown = assignTopic(week.rundown, tag.id, 'category');
  r = applyDrop(week, saved, [{ type: 'topic', id: tag.id }], `topic:${call.id}`, dctx);
  assert.equal(week.overrides.merges[tag.id], call.id);
  assert.deepEqual(week.rundown.corners.find((c) => c.key === 'category').items, [call.id]);
  // 投稿（まとまりの中）→ メイン2: そのまとまりごと
  r = applyDrop(week, saved, [{ type: 'post', id: call.postIds[0] }], 'slot:1', dctx);
  assert.ok(r.ok, r.message);
  assert.deepEqual(mainSlots(week.rundown), [null, call.id, null]);
  assert.equal(week.rundown.corners.find((c) => c.key === 'category').items.length, 0, '他のコーナーから外れる');
});

test('v2 ドロップ: 一般のバズはメイン・メイン候補に入らない／メイン候補→メイン／押し出しはメイン候補へ', () => {
  const { topics, week, saved, dctx } = v2World();
  const gen = topics.find((t) => t.genre === 'general');
  const call = topics.find((t) => t.id === 'd:d-hostcall');
  const tag = topics.find((t) => t.id === 't:王子の引退');
  let r = applyDrop(week, saved, [{ type: 'topic', id: gen.id }], 'slot:0', dctx);
  assert.equal(r.ok, false);
  assert.match(r.message, /一般のバズ/);
  r = applyDrop(week, saved, [{ type: 'topic', id: gen.id }], 'cand', dctx);
  assert.equal(r.ok, false);
  r = applyDrop(week, saved, [{ type: 'topic', id: call.id }, { type: 'topic', id: tag.id }, { type: 'topic', id: gen.id }], 'cand', dctx);
  assert.deepEqual(week.mainCand, [call.id, tag.id]);
  r = applyDrop(week, saved, [{ type: 'topic', id: call.id }], 'slot:0', dctx);
  assert.deepEqual(week.mainCand, [tag.id], 'メインに入れたらメイン候補から外れる');
  r = applyDrop(week, saved, [{ type: 'topic', id: tag.id }], 'slot:0', dctx);
  assert.deepEqual(mainSlots(week.rundown), [tag.id, null, null]);
  assert.deepEqual(week.mainCand, [call.id], '押し出された話題はメイン候補へ');
  // 並べ替え（メイン候補の位置）
  applyDrop(week, saved, [{ type: 'topic', id: tag.id }], 'cand#0', dctx);
  assert.deepEqual(week.mainCand, [tag.id, call.id]);
});

test('v2 ドロップ: 受信箱へ（まとまりから外す・構成から外す）・片付け・ゴミ箱', () => {
  const { topics, week, saved, dctx } = v2World();
  const call = topics.find((t) => t.id === 'd:d-hostcall');
  const single = topics.find((t) => t.kind === 'single');
  week.rundown = assignTopic(week.rundown, single.id, 'chat');
  applyDrop(week, saved, [{ type: 'post', id: call.postIds[0] }, { type: 'post', id: single.postIds[0] }], 'inbox', dctx);
  assert.equal(week.overrides.moves[call.postIds[0]], `p:${call.postIds[0]}`);
  assert.ok(!usedTopicIds(week.rundown).includes(single.id));
  applyDrop(week, saved, [{ type: 'topic', id: call.id }], 'shelf', dctx);
  assert.equal(week.shelved[0].topicId, call.id);
  applyDrop(week, saved, [{ type: 'post', id: single.postIds[0] }], 'trash', dctx);
  assert.equal(saved.hiddenPosts[0].id, single.postIds[0]);
  const tag = topics.find((t) => t.id === 't:王子の引退');
  week.mainCand = [tag.id];
  applyDrop(week, saved, [{ type: 'topic', id: tag.id }], 'trash', dctx);
  assert.equal(saved.trash[0].topicId, tag.id);
  assert.deepEqual(week.mainCand, []);
  assert.equal(isDropTarget('group:night'), false);
  assert.equal(isDropTarget('corner:category#2'), true);
  assert.deepEqual(topicsOfRows([{ type: 'post', id: call.postIds[1] }, { type: 'topic', id: call.id }], postTopicMap(topics)), [call.id]);
});

test('v2 まとまりにする・空のまとまり・名前変更（buildTopics に反映）', () => {
  const { d, topics, week, dctx } = v2World();
  const singles = topics.filter((t) => t.kind === 'single').slice(0, 2);
  const id = makeGroup(week, singles.map((t) => ({ type: 'post', id: t.postIds[0] })), dctx, { name: '自作のまとまり', genre: 'kyaba' });
  const empty = createEmptyGroup(week, '空のフォルダ', 'host', 2000);
  let t2 = buildTopics({ posts: d.posts, dict: DEFAULT_DICT, refTs: d.refTs, overrides: week.overrides });
  const g = t2.find((t) => t.id === id);
  assert.equal(g.name, '自作のまとまり');
  assert.equal(g.genre, 'kyaba');
  assert.deepEqual([...g.postIds].sort(), singles.map((t) => t.postIds[0]).sort());
  assert.ok(isFolderTopic(g));
  const e = t2.find((t) => t.id === empty);
  assert.equal(e.postIds.length, 0);
  renameTopic(week, e, '名前を変えた');
  renameTopic(week, t2.find((t) => t.id === 'd:d-hostcall'), 'コールの話');
  t2 = buildTopics({ posts: d.posts, dict: DEFAULT_DICT, refTs: d.refTs, overrides: week.overrides });
  assert.equal(t2.find((t) => t.id === empty).name, '名前を変えた');
  assert.equal(t2.find((t) => t.id === 'd:d-hostcall').name, 'コールの話');
  renameTopic(week, t2.find((t) => t.id === 'd:d-hostcall'), '');
  assert.equal(week.overrides.renames['d:d-hostcall'], undefined, '空なら自動の名前に戻す');
});

test('v2 ジャンルの上書き: 投稿 id ごと・翌週以降も有効・元と同じなら消す・書き出しに含める', () => {
  const posts = normalizeDataset({ posts: [post({ id: '2110000000000000901', categories: ['ホスト'], text: 'a' }), post({ id: '2110000000000000902', categories: ['その他'], text: 'b' })] }).posts;
  const base = new Map(posts.map((p) => [p.id, p]));
  const orig = (id) => postGenre(base.get(id));
  let saved = defaultSaved();
  setPostGenre(saved, ['2110000000000000901'], 'general', 5, orig);
  setPostGenre(saved, ['2110000000000000902'], 'kabuki', 6, orig);
  assert.deepEqual(genreOverrideList(saved), [
    { id: '2110000000000000901', genre: 'general', from: 'host', at: 5 },
    { id: '2110000000000000902', genre: 'kabuki', from: 'general', at: 6 },
  ]);
  const applied = applyGenreOverrides(posts, saved.genreOverrides);
  assert.equal(postGenre(applied[0]), 'general');
  assert.deepEqual(applied[1].categories[0], categoryOfGenre('kabuki'));
  assert.equal(applied[0]._origCategories[0], 'ホスト');
  assert.ok(posts[0].categories.includes('ホスト'), '元の投稿は書き換えない');
  // 別の週の話題づくりにも効く（投稿 id で保存）
  const topics = buildTopics({ posts: applied, dict: [], refTs: posts[0].ts + 100 });
  assert.equal(topics.find((t) => t.postIds.includes('2110000000000000902')).genre, 'kabuki');
  // 保存の往復・元に戻すと消える
  saved = parseSaved(serializeSaved(saved)).state;
  assert.equal(saved.genreOverrides['2110000000000000901'].genre, 'general');
  setPostGenre(saved, ['2110000000000000901'], 'host', 7, orig);
  assert.equal(saved.genreOverrides['2110000000000000901'], undefined);
  assert.equal(toggledGenre('host'), 'general');
  assert.equal(toggledGenre('general', 'kyaba'), 'kyaba');
  assert.equal(toggledGenre('general'), 'night');
});

test('v2 元に戻す・やり直す: 履歴（上限つき）', () => {
  let h = createHistory(3);
  assert.equal(undoHistory(h, 'now'), null);
  h = recordHistory(h, '操作1', 's0');
  h = recordHistory(h, '操作2', 's1');
  let u = undoHistory(h, 's2');
  assert.equal(u.snap, 's1');
  assert.equal(u.label, '操作2');
  h = u.history;
  u = undoHistory(h, 's1');
  assert.equal(u.snap, 's0');
  h = u.history;
  let r = redoHistory(h, 's0');
  assert.equal(r.snap, 's1');
  h = r.history;
  r = redoHistory(h, 's1');
  assert.equal(r.snap, 's2');
  h = r.history;
  assert.equal(redoHistory(h, 's2'), null);
  h = recordHistory(h, '操作3', 's2');
  h = recordHistory(h, '操作4', 's3');
  h = recordHistory(h, '操作5', 's4');
  assert.equal(h.past.length, 3, '上限');
  h = recordHistory(undoHistory(h, 's5').history, '別の操作', 's4');
  assert.equal(h.future.length, 0, '新しい操作でやり直しは消える');
});

test('v2 保存データの移行（版 3 → 4）: メイン枠・メイン候補・ジャンル上書きの既定値', () => {
  const v3 = {
    v: 3, trash: [],
    weeks: { '2026-10-17': { rundown: { corners: [{ key: 'main', min: 45, items: ['a', 'b'] }, { key: 'category', min: 30, items: ['c'] }] }, live: { index: 1, status: {} } } },
  };
  const st = parseSaved(JSON.stringify(v3)).state;
  const w = st.weeks['2026-10-17'];
  assert.deepEqual(mainSlots(w.rundown), ['a', 'b', null]);
  assert.deepEqual(w.mainCand, []);
  assert.deepEqual(st.genreOverrides, {});
  assert.equal(w.live.cardVisible, true);
  // 版 4 の空き枠・メイン候補の往復（構成に入っているものはメイン候補から除く）
  const v4 = { v: 4, weeks: { '2026-10-17': { rundown: { corners: [{ key: 'main', min: 45, items: [null, 'x', null] }] }, mainCand: ['x', 'y', 'y', 5] } }, genreOverrides: { 123: { genre: 'host', at: 1 }, abc: { genre: 'host' }, 456: { genre: 'zzz' } } };
  const s4 = parseSaved(JSON.stringify(v4)).state;
  assert.deepEqual(s4.weeks['2026-10-17'].rundown.corners[0].items, [null, 'x']);
  assert.deepEqual(s4.weeks['2026-10-17'].mainCand, ['y']);
  assert.deepEqual(Object.keys(s4.genreOverrides), ['123']);
  assert.equal(JSON.parse(serializeSaved(s4)).v, SCHEMA_VERSION);
});

test('v2 仕分けの進み具合', () => {
  const items = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
  assert.deepEqual(sortProgress(items, new Map([['a', 'x']]), 1), { pos: 2, total: 3, done: 1, remaining: 2 });
  assert.deepEqual(sortProgress(items, new Map(), 5), { pos: 3, total: 3, done: 0, remaining: 3 });
});

test('v2 進行状態のイベント: 変わったときだけ 1 か所から発行（コーナー・話題・カード表示）', () => {
  resetLiveEvents();
  const topicsById = new Map([['A', { id: 'A', name: 'A', genre: 'host', stats: { topPostId: '1' } }], ['B', { id: 'B', name: 'B', genre: 'host', stats: { topPostId: '2' } }]]);
  let r = defaultRundown();
  r = assignTopic(assignTopic(r, 'A', 'main'), 'B', 'category');
  const cues = buildCues(r, topicsById);
  const got = [];
  const off = onShowEvent((e) => got.push(e));
  let live = defaultLive();
  const pub = () => publishLiveState({ weekKey: 'w', live, cues, topicsById });
  pub();
  assert.deepEqual(got[0].changed, ['corner', 'topic', 'card', 'progress']);
  assert.equal(got[0].state.topic.id, 'A');
  assert.equal(pub(), null, '変わらなければ発行しない');
  live = liveReduce(live, { type: 'done' }, cues);
  pub();
  assert.deepEqual(got[1].changed, ['corner', 'topic', 'card', 'progress']);
  assert.equal(got[1].state.corner.key, 'category');
  live = liveReduce(live, { type: 'toggleCard' }, cues);
  pub();
  assert.deepEqual(got[2].changed, ['card']);
  assert.equal(got[2].state.cardVisible, false);
  off();
  assert.equal(eventLog.length, 3);
  assert.deepEqual(diffSnapshot(liveSnapshot({ weekKey: 'w', live, cues, topicsById }), liveSnapshot({ weekKey: 'w', live, cues, topicsById })), []);
});
