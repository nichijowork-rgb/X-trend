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
  bookmarkList, usedPostIdsOf, pastUsedIds,
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
  assert.equal(assignTopic(r, 'd', 'opening').corners[0].items.length, 0, 'トークのコーナーには入らない');
  r = assignTopic(r, 'a', 'category');
  assert.deepEqual(r.corners.find((c) => c.key === 'main').items, ['b', 'c'], '他のコーナーから移動');
  r = moveInCorner(r, 'main', 'c', -1);
  assert.deepEqual(r.corners.find((c) => c.key === 'main').items, ['c', 'b']);
  r = replaceTopicId(r, 'b', 'c');
  assert.deepEqual(r.corners.find((c) => c.key === 'main').items, ['c']);
  r = removeTopic(r, 'c');
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
  assert.deepEqual(cues.map((c) => c.id), ['opening', 'main:A', 'main:B', 'break', 'category:C', 'chat', 'review', 'ending']);
  assert.equal(cues.find((c) => c.id === 'chat').kind, 'empty');
  assert.equal(cues[1].n, 1);
  assert.equal(cues[1].of, 2);
  const cues2 = buildCues(r, new Map([['A', { id: 'A' }]]));
  assert.ok(!cues2.some((c) => c.id === 'main:B'));
});

test('進行の状態遷移: 読んだ・戻す・飛ばす・来週へ・移動・リセット', () => {
  const { cues } = liveSetup();
  let s = defaultLive();
  s = liveReduce(s, { type: 'start', now: 1000 }, cues);
  assert.equal(s.startedAt, 1000);
  assert.equal(s.enteredAt.opening, 1000);
  s = liveReduce(s, { type: 'done', now: 2000 }, cues);
  assert.equal(s.status.opening, 'done');
  assert.equal(s.index, 1);
  assert.equal(s.enteredAt.main, 2000);
  s = liveReduce(s, { type: 'carry', now: 3000 }, cues);
  assert.equal(s.status['main:A'], 'carried');
  assert.deepEqual([...carriedTopicIds(s, cues)], ['A']);
  s = liveReduce(s, { type: 'skip', now: 4000 }, cues);
  assert.equal(s.status['main:B'], 'skipped');
  assert.equal(cues[s.index].id, 'break');
  // 話題でないキューは「来週へ」できない
  const same = liveReduce(s, { type: 'carry', now: 5000 }, cues);
  assert.deepEqual(same.status, s.status);
  assert.equal(same.index, s.index);
  // 戻す: 直前の操作を順に取り消す
  s = liveReduce(s, { type: 'back' }, cues);
  assert.equal(cues[s.index].id, 'main:B');
  assert.equal(s.status['main:B'], undefined);
  s = liveReduce(s, { type: 'back' }, cues);
  assert.equal(cues[s.index].id, 'main:A');
  assert.equal(carriedTopicIds(s, cues).size, 0, '戻すと来週へも取り消し');
  assert.deepEqual(cueStates(s, cues).slice(0, 3), ['done', 'current', 'todo']);
  // 移動と、済を飛ばして次の未処理へ
  s = liveReduce(s, { type: 'goto', index: 0, now: 6000 }, cues);
  assert.equal(s.index, 0);
  s = liveReduce(s, { type: 'done', now: 7000 }, cues);
  assert.equal(cues[s.index].id, 'main:A', '済のキューは飛ばす');
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

test('タイマー: 経過・コーナー残り・押し/巻き', () => {
  const { r, cues } = liveSetup();
  assert.equal(computeTimer(defaultLive(), r, cues, 0).state, 'idle');
  const t0 = 1_000_000;
  let s = liveReduce(defaultLive(), { type: 'start', now: t0 }, cues);
  let t = computeTimer(s, r, cues, t0 + 60_000);
  assert.equal(t.elapsedSec, 60);
  assert.equal(t.cornerRemainSec, 4 * 60);
  assert.equal(t.state, 'ok');
  // オープニング（5分）を 8 分続けた → 押し 3 分
  t = computeTimer(s, r, cues, t0 + 8 * 60_000);
  assert.equal(t.driftSec, 180);
  assert.equal(t.state, 'over');
  assert.equal(t.cornerRemainSec, -180);
  // 1 分でメインへ → 巻き 4 分
  s = liveReduce(s, { type: 'done', now: t0 + 60_000 }, cues);
  t = computeTimer(s, r, cues, t0 + 61_000);
  assert.equal(t.driftSec, -240);
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
        live: { startedAt: 'x', index: -5, status: { a: 'done', b: 'weird' }, history: ['a', 'b'], enteredAt: { main: 5, zzz: 1 } },
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
  assert.equal(main.min, 35, '範囲外の分数は既定のまま');
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
  assert.deepEqual(wk.live, { startedAt: null, index: 0, status: { a: 'done' }, history: ['a'], enteredAt: { main: 5 } });
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
  live = liveReduce(live, { type: 'skip' }, cues);
  live = liveReduce(live, { type: 'carry' }, cues);
  const lists = reviewLists(live, cues);
  assert.deepEqual(lists.done.map((c) => c.id), ['opening']);
  assert.deepEqual(lists.skipped.map((c) => c.id), ['main:d:d-hostcall']);
  assert.deepEqual(lists.carried.map((c) => c.id), ['main:t:王子の引退']);
  const args = {
    title: '【T】ホストコール／王子の引退', week: weekByKey('2026-10-17'), rundown: r, topicsById: byId,
    script: { 'd:d-hostcall': { lead: null, points: '秘密のメモ', question: '質問？' } }, notes: { opening: '内輪メモ' },
    postsById: new Map(d.posts.map((p) => [p.id, p])), refTs: d.refTs,
  };
  const pub = scriptText({ ...args, mode: 'public' });
  assert.match(pub, /^【T】ホストコール／王子の引退\n配信：10\/17\(土\) 1:00〜（約90分）/);
  assert.match(pub, /00:00 オープニング\n05:00 メイン3トピック\n40:00 中休み/);
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
