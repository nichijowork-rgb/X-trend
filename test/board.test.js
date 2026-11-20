// かんたん編成（show/js/board.js）の単体テスト: 素材の一覧・番組の流れ・置いた先 → すること・おまかせで下書き・足せる投稿
// ステップ①（投稿からまとまりを作る）: 投稿の一覧・まとまりの一覧・チェック・新しいまとまり／カードへ置く
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_CHIPS, boardChips, sanitizeChip, genreShort, materialList, flowSections, flowMinutes, formatHm, parseDropKey, resolveDrop, WHY_NOT,
  stepTarget, addTargets, autoDraftPlan, draftSummary, addablePosts, oldestFirst,
  postList, groupList, placedCount, toggleSelect, dragIds, groupDraft,
} from '../show/js/board.js';
import { applyDrop, recommendGeneral, rankGeneral } from '../show/js/folders.js';
import { defaultWeek, mainSlots } from '../show/js/logic.js';
import { BOARD } from '../show/js/config.js';

/** 話題（必要な項目だけ） */
const T = (id, genre, n = 2, score = 5, extra = {}) => ({
  id, name: extra.name || `話題${id}`, genre, kind: n >= 2 ? 'cluster' : 'single',
  postIds: extra.postIds || Array.from({ length: n }, (_, i) => `${id}-${i}`), stats: { count: n, totalImp: n * 10000 }, score, ...extra,
});
const P = (id, user, text, imp, cats = ['ホスト'], ts = 1000) => ({ id, user, text, ts, categories: cats, metrics: { impression_count: imp }, matched_terms: [] });

function world() {
  const topics = [
    T('h1', 'host', 5, 9, { name: 'ホストコール' }), T('k1', 'kyaba', 3, 8, { name: '生誕祭' }), T('h2', 'host', 2, 7, { name: '売掛の話' }),
    T('g1', 'general', 4, 6.5, { name: '新作ドラマ' }), T('b1', 'kabuki', 2, 6, { name: 'トー横' }), T('n1', 'night', 1, 5, { name: 'パパ活' }),
    T('g2', 'general', 1, 4, { name: 'セールの戦利品' }), T('g3', 'general', 1, 3, { name: '猫の動画' }), T('h3', 'host', 1, 2, { name: 'シャンパンタワー' }),
  ];
  const week = defaultWeek();
  const topicsById = new Map(topics.map((t) => [t.id, t]));
  const ctx = { week, topics, topicsById, recommended: recommendGeneral(topics, 2), pickIds: new Set(), bookmarkIds: new Set(), newTopics: new Map(), weekPosts: [], postTopic: new Map() };
  return { topics, week, topicsById, ctx };
}
const drop = (w, id, target) => applyDrop(w.week, { trash: [], hiddenPosts: [] }, [{ key: `t:${id}`, type: 'topic', id }], target, { topicsById: w.topicsById, postTopic: new Map(), postsById: new Map(), weekKey: '2026-11-21', now: 1 });
const ids = (r) => r.items.map((x) => x.id);

test('チップ: ★ブックマークは機能があるときだけ・NEW は新しい話題があるときだけ・無くなったチップは「おすすめ」に戻す', () => {
  assert.deepEqual(boardChips().map((c) => c.key), ['rec', 'host', 'kyaba', 'kabuki', 'night', 'general']);
  assert.deepEqual(boardChips({ hasBookmarks: true, newCount: 2 }).map((c) => c.key), BOARD_CHIPS.map((c) => c.key));
  assert.equal(sanitizeChip('new', boardChips()), 'rec');
  assert.equal(sanitizeChip('host', boardChips()), 'host');
  assert.equal(sanitizeChip(undefined), 'rec');
  assert.equal(genreShort('general'), '一般');
  assert.equal(genreShort('host'), 'ホスト');
});

test('素材: おすすめ＝夜職は全部・一般のバズはおすすめの上位だけ（並びはそのまま）／ジャンル／番組に入っている印／ページ分け', () => {
  const w = world();
  // おすすめ: 一般は上位 2 件（g1・g2）だけ。g3 は出ない
  assert.deepEqual(ids(materialList(w.ctx, { chip: 'rec' })), ['h1', 'k1', 'h2', 'g1', 'b1', 'n1', 'g2', 'h3']);
  assert.deepEqual(ids(materialList(w.ctx, { chip: 'host' })), ['h1', 'h2', 'h3']);
  assert.deepEqual(ids(materialList(w.ctx, { chip: 'general' })), ['g1', 'g2', 'g3'], '一般のチップは全部');
  // 雑談おすすめ（show_pick）を含む話題が先
  const pick = { ...w.ctx, pickIds: new Set(w.topicsById.get('g3').postIds) };
  assert.deepEqual(ids(materialList(pick, { chip: 'general' })), ['g3', 'g1', 'g2']);
  assert.deepEqual(ids(materialList({ ...w.ctx, recommended: recommendGeneral(w.topics, 2, pick.pickIds), pickIds: pick.pickIds }, { chip: 'rec' })).filter((x) => x.startsWith('g')), ['g1', 'g3']);
  // ★ブックマーク・NEW
  assert.deepEqual(ids(materialList({ ...w.ctx, bookmarkIds: new Set([w.topicsById.get('b1').postIds[0]]) }, { chip: 'bookmarks' })), ['b1']);
  assert.deepEqual(ids(materialList({ ...w.ctx, newTopics: new Map([['n1', 1], ['h3', 0]]) }, { chip: 'new' })), ['n1', 'h3']);
  // 番組に入っている話題は並びを変えずに used つき
  drop(w, 'h1', 'slot:1');
  drop(w, 'h2', 'cand');
  drop(w, 'k1', 'corner:category');
  drop(w, 'g1', 'corner:chat');
  const used = Object.fromEntries(materialList(w.ctx, { chip: 'rec' }).items.map((x) => [x.id, x.used ? x.used.label : null]));
  assert.deepEqual(used, { h1: 'メイン2', k1: 'カテゴリ別', h2: 'メイン候補', g1: '雑談', b1: null, n1: null, g2: null, h3: null });
  // ページ分け
  const page = materialList(w.ctx, { chip: 'rec', limit: 3 });
  assert.deepEqual([ids(page), page.total, page.more], [['h1', 'k1', 'h2'], 8, 5]);
  assert.equal(materialList(w.ctx, { chip: 'rec', limit: 100 }).more, 0);
  assert.equal(BOARD.pageSize, 40);
});

test('素材の検索: 話題名が合う話題 → 中の投稿（本文・@アカウント）が合う話題（最初の投稿と件数）。おすすめのチップは全部から・ジャンルのチップはその中だけ', () => {
  const w = world();
  const posts = [P('901', 'mio', 'ドラマの感想です', 100, ['その他']), P('902', 'ken', '猫がかわいい ドラマ', 50, ['その他']), P('903', 'ken', 'ドラマみたいな営業', 10), P('904', 'DRAMA_fan', '関係ない話', 5)];
  const postTopic = new Map([['901', 'g3'], ['902', 'g3'], ['903', 'h3'], ['904', 'h2']]);
  const ctx = { ...w.ctx, weekPosts: posts, postTopic };
  let r = materialList(ctx, { chip: 'rec', query: 'ドラマ' });
  assert.deepEqual(ids(r), ['g1', 'g3', 'h3'], '名前（新作ドラマ）→ 投稿が合う話題（話題性の順。おすすめ外の一般 g3 も探す）');
  assert.equal(r.items[0].match, null);
  assert.deepEqual(r.items[1].match, { postId: '901', count: 2 });
  assert.deepEqual(r.items[2].match, { postId: '903', count: 1 });
  r = materialList(ctx, { chip: 'host', query: 'ドラマ' });
  assert.deepEqual(ids(r), ['h3'], 'ジャンルのチップの中だけ');
  assert.deepEqual(ids(materialList(ctx, { chip: 'rec', query: '＠drama_FAN' })), ['h2'], '@アカウント・全角半角・大文字小文字');
  assert.deepEqual(ids(materialList(ctx, { chip: 'rec', query: 'ドラマ 猫' })), ['g3'], 'スペースで AND');
  assert.deepEqual(ids(materialList(ctx, { chip: 'rec', query: 'どこにもない言葉' })), []);
});

test('番組の流れ: メインは 3 枠（空きは null）・メイン候補・カテゴリ別・雑談。時間の目安（メインは 1 本ごと・ほかは入っていれば）', () => {
  const w = world();
  let s = flowSections(w.week);
  assert.deepEqual(s.map((x) => [x.key, x.slots, x.ids]), [['main', true, [null, null, null]], ['cand', false, []], ['category', false, []], ['chat', false, []]]);
  assert.equal(s[0].sub, '各 約15分・3本まで');
  assert.equal(s[2].sub, '約30分');
  assert.deepEqual(flowMinutes(w.week.rundown), { filled: 0, planned: 90 });
  drop(w, 'h1', 'slot:0');
  drop(w, 'h2', 'slot:2');
  drop(w, 'k1', 'corner:category');
  drop(w, 'b1', 'corner:category');
  drop(w, 'h3', 'cand');
  s = flowSections(w.week);
  assert.deepEqual(s.map((x) => x.ids), [['h1', null, 'h2'], ['h3'], ['k1', 'b1'], []]);
  assert.deepEqual(flowMinutes(w.week.rundown), { filled: 60, planned: 90 }, 'メイン 2 本＝30 分＋カテゴリ別 30 分');
  drop(w, 'g1', 'corner:chat');
  assert.equal(flowMinutes(w.week.rundown).filled, 75);
  assert.equal(formatHm(75), '1:15');
  assert.equal(formatHm(90), '1:30');
  assert.equal(formatHm(5), '0:05');
  assert.equal(formatHm(-3), '0:00');
});

test('置き場所のキーの読み方', () => {
  assert.deepEqual(parseDropKey('slot:2'), { zone: 'slot', slot: 2 });
  assert.deepEqual(parseDropKey('cand'), { zone: 'cand', index: null });
  assert.deepEqual(parseDropKey('cand#3'), { zone: 'cand', index: 3 });
  assert.deepEqual(parseDropKey('corner:chat#0'), { zone: 'corner', corner: 'chat', index: 0 });
  assert.deepEqual(parseDropKey('corner:category'), { zone: 'corner', corner: 'category', index: null });
  assert.deepEqual(parseDropKey('open#5'), { zone: 'open', index: 5 });
  assert.deepEqual(parseDropKey('material'), { zone: 'material' });
  assert.deepEqual(parseDropKey('topic:t:名前 に#記号'), { zone: 'topic', topicId: 't:名前 に#記号' });
  for (const k of ['slot:3', 'corner:main', 'inbox', '', null]) assert.equal(parseDropKey(k).zone, null, String(k));
});

test('話題を置く: メインの枠（空き・入れ替え・押し出しはメイン候補へ・一般のバズは断る）', () => {
  const w = world();
  const res = (id, key) => resolveDrop({ kind: 'topic', id }, key, { week: w.week, topicsById: w.topicsById });
  const run = (id, key) => { const r = res(id, key); assert.ok(r.ok, `${id}→${key}`); return drop(w, id, r.action.target); };
  let r = res('h1', 'slot:1');
  assert.deepEqual([r.ok, r.action, r.hint], [true, { type: 'place', topicId: 'h1', target: 'slot:1' }, 'メイン2 に入れる']);
  run('h1', 'slot:1');
  assert.deepEqual(mainSlots(w.week.rundown), [null, 'h1', null]);
  assert.deepEqual(res('h1', 'slot:1'), { ok: false, reason: null }, '同じ枠は何もしない');
  // 一般のバズはメイン・メイン候補に入れない（理由つき）
  assert.deepEqual(res('g1', 'slot:0'), { ok: false, reason: WHY_NOT.generalMain });
  assert.deepEqual(res('g1', 'cand'), { ok: false, reason: WHY_NOT.generalCand });
  // 入っている枠へ素材から: 前の話題はメイン候補へ
  r = res('h2', 'slot:1');
  assert.equal(r.hint, 'メイン2 に入れる（「ホストコール」はメイン候補へ）');
  run('h2', 'slot:1');
  assert.deepEqual([mainSlots(w.week.rundown), w.week.mainCand], [[null, 'h2', null], ['h1']]);
  // メイン候補 → 空き枠、メインどうしは入れ替え
  run('h1', 'slot:0');
  assert.deepEqual([mainSlots(w.week.rundown), w.week.mainCand], [['h1', 'h2', null], []]);
  assert.equal(res('h1', 'slot:1').hint, 'メイン2 と入れ替える');
  run('h1', 'slot:1');
  assert.deepEqual(mainSlots(w.week.rundown), ['h2', 'h1', null]);
  // メイン → 空き枠（動かすだけ）
  run('h2', 'slot:2');
  assert.deepEqual(mainSlots(w.week.rundown), [null, 'h1', 'h2']);
  assert.deepEqual(res('zzz', 'slot:0'), { ok: false, reason: null }, '無い話題');
});

test('話題を置く: メイン候補・コーナーの「入る位置」（並べ替えは自分の分をずらす・同じ場所は何もしない）・コーナーの間の移動・左へ戻すと外れる', () => {
  const w = world();
  const res = (id, key) => resolveDrop({ kind: 'topic', id }, key, { week: w.week, topicsById: w.topicsById });
  const run = (id, key) => { const r = res(id, key); assert.ok(r.ok, `${id}→${key}`); drop(w, id, r.action.target); };
  const cat = () => w.week.rundown.corners.find((c) => c.key === 'category').items;
  const chat = () => w.week.rundown.corners.find((c) => c.key === 'chat').items;
  // 末尾の置き場所（位置なし）→ 最後に
  run('k1', 'corner:category');
  run('b1', 'corner:category');
  run('n1', 'corner:category');
  assert.deepEqual(cat(), ['k1', 'b1', 'n1']);
  // 選んだ位置へ（素材から 2 番目へ）
  assert.equal(res('h3', 'corner:category#1').hint, 'カテゴリ別ニュースに入れる');
  run('h3', 'corner:category#1');
  assert.deepEqual(cat(), ['k1', 'h3', 'b1', 'n1']);
  // 並べ替え: 下へ（#4＝最後の後ろ）・上へ（#0）。自分の前後（#1・#2）は何もしない
  assert.deepEqual(res('h3', 'corner:category#1'), { ok: false, reason: null });
  assert.deepEqual(res('h3', 'corner:category#2'), { ok: false, reason: null });
  assert.equal(res('h3', 'corner:category#4').hint, '並べ替える');
  run('h3', 'corner:category#4');
  assert.deepEqual(cat(), ['k1', 'b1', 'n1', 'h3']);
  run('n1', 'corner:category#0');
  assert.deepEqual(cat(), ['n1', 'k1', 'b1', 'h3']);
  run('n1', 'corner:category#2');
  assert.deepEqual(cat(), ['k1', 'n1', 'b1', 'h3'], '1 つ下へ');
  // コーナーの間（カテゴリ別 → 雑談の先頭）。一般のバズもカテゴリ別・雑談には入る
  run('g1', 'corner:chat');
  run('b1', 'corner:chat#0');
  assert.deepEqual([cat(), chat()], [['k1', 'n1', 'h3'], ['b1', 'g1']]);
  // メイン候補: 入れる・並べ替え（下へは 1 つ引く）
  run('h1', 'cand');
  run('h2', 'cand');
  run('h3', 'cand#0');
  assert.deepEqual([w.week.mainCand, cat()], [['h3', 'h1', 'h2'], ['k1', 'n1']], 'コーナーからメイン候補へ移すとコーナーからは外れる');
  assert.deepEqual(res('h3', 'cand#0'), { ok: false, reason: null });
  assert.deepEqual(res('h3', 'cand#1'), { ok: false, reason: null });
  assert.equal(res('h3', 'cand#3').action.target, 'cand#2');
  run('h3', 'cand#3');
  assert.deepEqual(w.week.mainCand, ['h1', 'h2', 'h3']);
  run('h3', 'cand#1');
  assert.deepEqual(w.week.mainCand, ['h1', 'h3', 'h2']);
  assert.equal(res('h2', 'cand').ok, false, '最後のものを末尾へ＝同じ場所');
  // メイン候補 → メインの枠 → コーナー
  run('h3', 'slot:0');
  run('h3', 'corner:category#0');
  assert.deepEqual([mainSlots(w.week.rundown), w.week.mainCand, cat()], [[null, null, null], ['h1', 'h2'], ['h3', 'k1', 'n1']]);
  // 左の列へ: 入っている話題は外す・入っていない話題は何もしない
  let r = res('k1', 'material');
  assert.deepEqual([r.ok, r.action], [true, { type: 'unplace', topicId: 'k1' }]);
  drop(w, 'k1', 'inbox');
  drop(w, 'h1', 'inbox');
  assert.deepEqual([cat(), w.week.mainCand], [['h3', 'n1'], ['h2']]);
  assert.deepEqual(res('k1', 'material'), { ok: false, reason: null });
  // 話題は投稿の並び・ほかの話題の上には置かない（外側の置き場所を探す＝理由なしで断る）
  assert.deepEqual(res('k1', 'open#0'), { ok: false, reason: null });
  assert.deepEqual(res('k1', 'topic:h3'), { ok: false, reason: null });
});

test('Alt+↑/↓: 同じコーナーの中で 1 つ動かす（メインは枠の入れ替え・端では動かない）', () => {
  const w = world();
  for (const [id, key] of [['h1', 'slot:0'], ['h2', 'slot:1'], ['h3', 'cand'], ['n1', 'cand'], ['k1', 'corner:category'], ['b1', 'corner:category'], ['g1', 'corner:category']]) drop(w, id, key);
  const step = (id, d) => { const k = stepTarget(w.week, id, d); if (k) drop(w, id, k); return k; };
  assert.equal(step('h1', -1), null);
  assert.equal(step('h1', 1), 'slot:1');
  assert.deepEqual(mainSlots(w.week.rundown), ['h2', 'h1', null]);
  assert.equal(step('h1', 1), 'slot:2');
  assert.deepEqual(mainSlots(w.week.rundown), ['h2', null, 'h1']);
  assert.equal(step('h1', 1), null);
  assert.equal(step('h3', 1), 'cand#1');
  assert.deepEqual(w.week.mainCand, ['n1', 'h3']);
  assert.equal(step('h3', 1), null);
  assert.equal(step('h3', -1), 'cand#0');
  assert.deepEqual(w.week.mainCand, ['h3', 'n1']);
  const cat = () => w.week.rundown.corners.find((c) => c.key === 'category').items;
  step('k1', 1);
  assert.deepEqual(cat(), ['b1', 'k1', 'g1']);
  step('g1', -1);
  step('g1', -1);
  assert.deepEqual(cat(), ['g1', 'b1', 'k1']);
  assert.equal(step('g1', -1), null);
  assert.equal(step('k1', 1), null);
  assert.equal(stepTarget(w.week, 'g2', 1), null, '番組に入っていない');
});

test('「＋」の入れ先: 一般のバズはメイン・メイン候補が押せない（理由つき）・入っている枠は「いまの…はメイン候補へ」', () => {
  const w = world();
  drop(w, 'h1', 'slot:0');
  const night = addTargets(w.week, w.topicsById.get('h2'), w.topicsById);
  assert.deepEqual(night.map((x) => [x.key, x.disabled]), [['slot:0', false], ['slot:1', false], ['slot:2', false], ['cand', false], ['corner:category', false], ['corner:chat', false]]);
  assert.equal(night[0].note, 'いまの「ホストコール」はメイン候補へ');
  assert.equal(night[1].note, '空き');
  const gen = addTargets(w.week, w.topicsById.get('g1'), w.topicsById);
  assert.deepEqual(gen.map((x) => x.disabled), [true, true, true, true, false, false]);
  assert.equal(gen[0].note, WHY_NOT.generalMain);
  assert.equal(gen[3].note, WHY_NOT.generalCand);
});

test('投稿を置く: 開いた話題の中の並べ替え・左から足す（位置つき）・左へ戻すと外れる・ほかの話題のカードへ移す・置けない所は理由', () => {
  const w = world();
  const openItems = ['p1', 'p2', 'p3', 'img:abcd'];
  const postsById = new Map([['p1', {}], ['p2', {}], ['p3', {}], ['p9', {}]]);
  const ctx = { week: w.week, topicsById: w.topicsById, openId: 'h1', openItems, postsById };
  const res = (drag, key) => resolveDrop({ kind: 'post', ...drag }, key, ctx);
  // 並べ替え（open#位置＝その前に入れる）
  let r = res({ id: 'p3', source: 'open' }, 'open#0');
  assert.deepEqual([r.action, r.hint], [{ type: 'reorder', topicId: 'h1', order: ['p3', 'p1', 'p2', 'img:abcd'] }, '先頭へ（代表にする）']);
  assert.deepEqual(res({ id: 'p1', source: 'open' }, 'open#3').action.order, ['p2', 'p3', 'p1', 'img:abcd']);
  assert.deepEqual(res({ id: 'p1', source: 'open' }, 'open').action.order, ['p2', 'p3', 'img:abcd', 'p1'], '末尾の置き場所');
  assert.deepEqual(res({ id: 'img:abcd', source: 'open' }, 'open#1').action.order, ['p1', 'img:abcd', 'p2', 'p3'], '画像も並べ替えられる');
  for (const k of ['open#1', 'open#2']) assert.deepEqual(res({ id: 'p2', source: 'open' }, k), { ok: false, reason: null }, '自分の前後は何もしない');
  // 左の「足せる投稿」から、選んだ位置へ
  r = res({ id: 'p9', source: 'addable' }, 'open#1');
  assert.deepEqual([r.action, r.hint], [{ type: 'addPost', topicId: 'h1', postId: 'p9', index: 1 }, '「ホストコール」に足す']);
  assert.equal(res({ id: 'p9', source: 'addable' }, 'open').action.index, 4);
  assert.deepEqual(res({ id: 'p2', source: 'addable' }, 'open#0'), { ok: false, reason: WHY_NOT.already });
  // 開いた話題のカード（の頭）へ落としても足せる
  assert.deepEqual(res({ id: 'p9', source: 'addable' }, 'topic:h1').action, { type: 'addPost', topicId: 'h1', postId: 'p9', index: 4 });
  assert.deepEqual(res({ id: 'p1', source: 'open' }, 'topic:h1'), { ok: false, reason: null });
  // 左の列へ: 開いた話題の投稿は外す・左の投稿はそのまま
  assert.deepEqual(res({ id: 'p2', source: 'open' }, 'material').action, { type: 'removePost', topicId: 'h1', itemId: 'p2' });
  assert.deepEqual(res({ id: 'img:abcd', source: 'open' }, 'material').action, { type: 'removePost', topicId: 'h1', itemId: 'img:abcd' });
  assert.deepEqual(res({ id: 'p9', source: 'addable' }, 'material'), { ok: false, reason: null });
  // ほかの話題のカードへ移す（画像・データに無い投稿は移せない）
  r = res({ id: 'p2', source: 'open' }, 'topic:k1');
  assert.deepEqual([r.action, r.hint], [{ type: 'movePost', postId: 'p2', to: 'k1' }, '「生誕祭」へ移す']);
  assert.deepEqual(res({ id: 'img:abcd', source: 'open' }, 'topic:k1'), { ok: false, reason: WHY_NOT.imageMove });
  assert.deepEqual(res({ id: '777', source: 'open' }, 'topic:k1'), { ok: false, reason: WHY_NOT.missingMove });
  assert.deepEqual(res({ id: 'p2', source: 'open' }, 'topic:nope'), { ok: false, reason: null });
  const own = w.topicsById.get('k1').postIds[0];
  assert.deepEqual(resolveDrop({ kind: 'post', id: own, source: 'addable' }, 'topic:k1', { ...ctx, postsById: new Map([[own, {}]]) }), { ok: false, reason: WHY_NOT.already });
  // 枠・コーナーの置き場所には置けない（理由）
  for (const k of ['slot:0', 'cand', 'corner:category#1', 'corner:chat']) assert.deepEqual(res({ id: 'p2', source: 'open' }, k), { ok: false, reason: WHY_NOT.postZone }, k);
  // 話題を開いていなければ並びには置けない
  assert.deepEqual(resolveDrop({ kind: 'post', id: 'p9', source: 'addable' }, 'open#0', { ...ctx, openId: null }), { ok: false, reason: null });
  assert.deepEqual(resolveDrop(null, 'open#0', ctx), { ok: false, reason: null });
});

test('おまかせで下書き: 空いている所だけ（メインの空き枠は夜職のおすすめ・カテゴリ別はジャンルを順に・雑談は一般のおすすめ）。入っているもの・メイン候補は使わない', () => {
  const w = world();
  const many = [...w.topics, T('h4', 'host', 2, 1.9), T('h5', 'host', 2, 1.8), T('k2', 'kyaba', 2, 1.7), T('b2', 'kabuki', 1, 1.6), T('n2', 'night', 1, 1.5), T('k3', 'kyaba', 1, 1.4), T('x1', 'host', 1, null)];
  let plan = autoDraftPlan({ week: w.week, topics: many, pickIds: new Set() });
  assert.deepEqual(plan.empty, { main: 3, category: true, chat: true });
  assert.deepEqual(plan.main, [{ slot: 0, id: 'h1' }, { slot: 1, id: 'k1' }, { slot: 2, id: 'h2' }], '夜職で 2 件以上の話題を話題性の順に');
  assert.deepEqual(plan.category, ['h3', 'k2', 'b1', 'n1', 'h4', 'k3'], 'ホスト→キャバクラ→歌舞伎町→夜職その他…と回す（6 本。メインに使った話題は除く）');
  assert.deepEqual(plan.chat, ['g1', 'g2', 'g3']);
  assert.deepEqual(draftSummary(plan), { filled: true, text: 'メイン 3・カテゴリ別 6・雑談 3 を入れました' });
  assert.ok(![...plan.category, ...plan.main.map((m) => m.id)].includes('x1'), '話題性が分からない話題は使わない');
  assert.equal(BOARD.draftCategory, 6);
  assert.equal(BOARD.draftChat, 3);
  // 優先ジャンルを変えると回す順の先頭が変わる
  assert.equal(autoDraftPlan({ week: w.week, topics: many, priorityGenre: 'kabuki' }).category[0], 'b1');
  // 雑談おすすめ（show_pick）が先
  assert.deepEqual(autoDraftPlan({ week: w.week, topics: many, pickIds: new Set(w.topicsById.get('g3').postIds) }).chat, ['g3', 'g1', 'g2']);
  assert.deepEqual(rankGeneral(many, new Set()).map((t) => t.id), ['g1', 'g2', 'g3']);
  // 投稿がすべて対象期間の外（期間外）の話題は使わない。一部だけ期間外なら使う
  const outside = many.map((t) => (t.id === 'h1' ? { ...t, outsideCount: t.stats.count } : t.id === 'k1' ? { ...t, outsideCount: 1 } : t));
  const po = autoDraftPlan({ week: w.week, topics: outside });
  assert.ok(![...po.main.map((m) => m.id), ...po.category, ...po.chat].includes('h1'), '全部期間外は使わない');
  assert.equal(po.main[0].id, 'k1', '一部だけ期間外なら使う');
  // 入っている所は動かさない: メイン 2 が入っていれば 1・3 だけ、カテゴリ別に 1 つでもあれば足さない。メイン候補の話題は使わない
  drop(w, 'h3', 'slot:1');
  drop(w, 'h1', 'cand');
  drop(w, 'b2', 'corner:category');
  plan = autoDraftPlan({ week: w.week, topics: many });
  assert.deepEqual(plan.empty, { main: 2, category: false, chat: true });
  assert.deepEqual(plan.main, [{ slot: 0, id: 'k1' }, { slot: 2, id: 'h2' }]);
  assert.deepEqual(plan.category, []);
  assert.deepEqual(draftSummary(plan).text, 'メイン 2・雑談 3 を入れました');
  // 空きが無い／空きはあるが入れられる話題が無い
  drop(w, 'k1', 'slot:0');
  drop(w, 'h2', 'slot:2');
  drop(w, 'g1', 'corner:chat');
  plan = autoDraftPlan({ week: w.week, topics: many });
  assert.deepEqual([plan.main, plan.category, plan.chat], [[], [], []]);
  assert.deepEqual(draftSummary(plan), { filled: false, text: '空いている所がありません（メイン・カテゴリ別・雑談とも入っています）' });
  const none = autoDraftPlan({ week: defaultWeek(), topics: [] });
  assert.equal(draftSummary(none).filled, false);
  assert.match(draftSummary(none).text, /見つかりませんでした/);
});

test('開いた話題に足せる投稿: 同じジャンルが先・表示の多い順・入っている印・ほかの話題にある印・ジャンル／検索・ページ分け・削除した投稿は出さない', () => {
  const w = world();
  const topic = { ...w.topicsById.get('h1'), postIds: ['a1', 'a2'] };
  const other = { ...w.topicsById.get('k1'), postIds: ['c1', 'c2'] };
  const topicsById = new Map([[topic.id, topic], [other.id, other], ['p:b1', T('p:b1', 'host', 1)]]);
  const posts = [
    P('a1', 'u1', 'コールの動画', 500), P('a2', 'u2', 'コール 2 本目', 100), P('b1', 'u3', '同じホストの別の話', 900), P('b2', 'u4', 'ホストの小ネタ', null),
    P('c1', 'u5', 'キャバの話 コール', 9999, ['キャバクラ']), P('c2', 'u6', 'キャバの話 2', 50, ['キャバクラ']), P('d1', 'u7', '一般の話', 7000, ['その他']), P('z9', 'u8', '削除した投稿', 99999),
  ];
  const postTopic = new Map([['a1', 'h1'], ['a2', 'h1'], ['b1', 'p:b1'], ['b2', 'p:b2'], ['c1', 'k1'], ['c2', 'k1'], ['d1', 'p:d1']]);
  const ctx = { weekPosts: posts, postTopic, topicsById };
  let r = addablePosts(ctx, topic);
  assert.deepEqual(ids(r), ['b1', 'a1', 'a2', 'b2', 'c1', 'd1', 'c2'], 'ホスト（表示の多い順・不明は後ろ）→ ほかのジャンル（表示の多い順）');
  assert.deepEqual(r.items.filter((x) => x.inTopic).map((x) => x.id), ['a1', 'a2']);
  assert.deepEqual(r.items.filter((x) => x.from).map((x) => [x.id, x.from]), [['c1', 'k1'], ['c2', 'k1']], '2 件以上の話題に入っている投稿は「いまの話題」つき');
  assert.equal(r.total, 7);
  assert.deepEqual(ids(addablePosts(ctx, topic, { chip: 'kyaba' })), ['c1', 'c2']);
  assert.deepEqual(ids(addablePosts(ctx, topic, { query: 'コール' })), ['a1', 'a2', 'c1']);
  assert.deepEqual(ids(addablePosts(ctx, topic, { query: '@U7' })), ['d1']);
  r = addablePosts(ctx, topic, { limit: 2 });
  assert.deepEqual([ids(r), r.more], [['b1', 'a1'], 5]);
  assert.deepEqual(addablePosts(ctx, null), { items: [], total: 0, more: 0 });
});

test('古い順に並べる: 投稿日時の昇順（日時が無い投稿・データに無い投稿・画像は後ろに今の順で）', () => {
  const postsById = new Map([['1', { ts: 300 }], ['2', { ts: 100 }], ['3', { ts: 200 }], ['4', {}]]);
  assert.deepEqual(oldestFirst(['1', 'img:aaaa', '2', '999', '3', '4'], postsById), ['2', '3', '1', 'img:aaaa', '999', '4']);
  assert.deepEqual(oldestFirst([], postsById), []);
});

// ================================================================ ステップ①: 投稿からまとまりを作る

/** ステップ①の世界: まとまり（2 件以上・手で作った）と 1 件だけの投稿 */
function world1() {
  const posts = [
    P('a1', 'u1', 'コールの動画', 500), P('a2', 'u2', 'コール 2 本目', 100),            // ホストコール（自動のまとまり）
    P('b1', 'u3', '担当との別れ話', 900), P('b2', 'u4', 'ホストの小ネタ', null),          // 1 件ずつ（まだ入っていない）
    P('c1', 'u5', 'キャバの話 コール', 9999, ['キャバクラ']),                              // 手で作ったまとまり（1 件でもまとまり）
    P('d1', 'u7', '一般のおすすめ', 7000, ['その他']), P('d2', 'u8', '一般のその他', 8000, ['その他']), // 一般のバズ（1 件ずつ）
    P('e1', 'u9', '片付けた話', 6000), P('z9', 'u0', '削除した投稿', 99999),
  ];
  const topics = [
    { ...T('h1', 'host', 2, 9, { name: 'ホストコール' }), postIds: ['a1', 'a2'] },
    T('p:b1', 'host', 1, 8, { postIds: ['b1'] }), T('p:b2', 'host', 1, 7, { postIds: ['b2'] }),
    { ...T('m:2', 'kyaba', 1, 6, { name: 'キャバの話', postIds: ['c1'] }), kind: 'manual' },
    T('p:d1', 'general', 1, 5, { postIds: ['d1'] }), T('p:d2', 'general', 1, 4, { postIds: ['d2'] }),
    { ...T('m:1', 'host', 0, null, { name: '空のまとまり', postIds: [] }), kind: 'manual' },
    { ...T('d:x', 'night', 1, 3, { name: '辞書のまとまり', postIds: ['q1'] }), kind: 'dict' },
  ];
  const shelved = T('p:e1', 'host', 1, 2, { postIds: ['e1'] });
  const topicsById = new Map([...topics, shelved].map((t) => [t.id, t]));
  const postTopic = new Map([['a1', 'h1'], ['a2', 'h1'], ['b1', 'p:b1'], ['b2', 'p:b2'], ['c1', 'm:2'], ['d1', 'p:d1'], ['d2', 'p:d2'], ['e1', 'p:e1']]);
  const week = defaultWeek();
  week.overrides.manual = [{ id: 'm:1', name: '空のまとまり', genre: 'host' }, { id: 'm:2', name: 'キャバの話', genre: 'kyaba' }];
  const ctx = { weekPosts: posts, postTopic, topicsById, visibleIds: new Set(topics.map((t) => t.id)), recommended: new Set(['p:d1']), bookmarkIds: new Set(['b2', 'c1']), newPosts: new Set(['a2', 'b1']), openId: null };
  return { posts, topics, topicsById, postTopic, week, ctx };
}

test('①投稿の一覧: 表示の多い順・まだ入っていないものだけ／すべて（入っているまとまりつき）・おすすめ（一般はおすすめだけ）・チップ・検索・ページ分け・片付け／削除は出さない', () => {
  const w = world1();
  // 既定: まだまとまりに入っていない投稿だけ。夜職は全部・一般のバズはおすすめの話題の投稿だけ。表示が不明な投稿は後ろ
  let r = postList(w.ctx);
  assert.deepEqual(ids(r), ['d1', 'b1', 'b2'], '片付けた話題の投稿（e1）・削除した投稿（z9）・まとまりの中（a1 a2 c1）・おすすめ外の一般（d2）は出ない');
  assert.deepEqual([r.total, r.more, r.ids], [3, 0, ['d1', 'b1', 'b2']]);
  assert.ok(r.items.every((x) => x.group == null && !x.inOpen));
  // すべての投稿: まとまりに入っている投稿は「◯◯に入っています」（group）。1 件でも手で作ったまとまりはまとまり
  r = postList(w.ctx, { filter: 'all' });
  assert.deepEqual(ids(r), ['c1', 'd1', 'b1', 'a1', 'a2', 'b2']);
  assert.deepEqual(r.items.filter((x) => x.group).map((x) => [x.id, x.group]), [['c1', 'm:2'], ['a1', 'h1'], ['a2', 'h1']]);
  // 開いているまとまりの中の投稿は inOpen（薄く「入っています」）
  r = postList({ ...w.ctx, openId: 'h1' }, { filter: 'all' });
  assert.deepEqual(r.items.filter((x) => x.inOpen).map((x) => x.id), ['a1', 'a2']);
  // チップ: ジャンル（一般は全部出る）・★ブックマーク・NEW
  assert.deepEqual(ids(postList(w.ctx, { chip: 'general' })), ['d2', 'd1'], '一般のチップはおすすめ以外も');
  assert.deepEqual(ids(postList(w.ctx, { chip: 'host' })), ['b1', 'b2']);
  assert.deepEqual(ids(postList(w.ctx, { chip: 'kyaba' })), [], 'キャバクラの投稿はまとまりの中だけ');
  assert.deepEqual(ids(postList(w.ctx, { chip: 'kyaba', filter: 'all' })), ['c1']);
  assert.deepEqual(ids(postList(w.ctx, { chip: 'bookmarks' })), ['b2']);
  assert.deepEqual(ids(postList(w.ctx, { chip: 'bookmarks', filter: 'all' })), ['c1', 'b2']);
  assert.deepEqual(ids(postList(w.ctx, { chip: 'new' })), ['b1']);
  assert.deepEqual(ids(postList(w.ctx, { chip: 'new', filter: 'all' })), ['b1', 'a2']);
  // 検索（本文・@アカウント）。おすすめのチップは全部から探す（おすすめ外の一般も）
  assert.deepEqual(ids(postList(w.ctx, { query: '一般' })), ['d2', 'd1']);
  assert.deepEqual(ids(postList(w.ctx, { query: 'コール', filter: 'all' })), ['c1', 'a1', 'a2']);
  assert.deepEqual(ids(postList(w.ctx, { query: 'コール' })), [], 'まだ入っていないものだけ');
  assert.deepEqual(ids(postList(w.ctx, { query: '@U3' })), ['b1']);
  assert.deepEqual(ids(postList(w.ctx, { query: '一般', chip: 'host' })), []);
  // ページ分け（ids は全部）
  r = postList(w.ctx, { filter: 'all', limit: 2 });
  assert.deepEqual([ids(r), r.total, r.more, r.ids.length], [['c1', 'd1'], 6, 4, 6]);
  assert.equal(postList(w.ctx, { limit: 0 }).total, 3, '件数だけ数える');
  assert.deepEqual(postList({ weekPosts: [] }), { items: [], total: 0, more: 0, ids: [] });
});

test('①まとまりの一覧: 作ったもの（新しい順）→ 自動のもの（今の並び）・1 件だけの話題は出ない・番組に入っている場所の印・ページ分け・番組の本数', () => {
  const w = world1();
  let r = groupList({ week: w.week, topics: w.topics });
  assert.deepEqual(ids(r), ['m:2', 'm:1', 'h1', 'd:x'], '作った（あとで作ったものが先）→ 自動（2 件以上・辞書など）');
  assert.deepEqual(r.items.map((x) => x.made), [true, true, false, false]);
  assert.ok(r.items.every((x) => x.place == null));
  assert.equal(placedCount(w.week), 0);
  // 番組に入っているまとまりは場所つき（薄くはしない）。メイン候補は本数に数えない
  const drop1 = (id, target) => applyDrop(w.week, { trash: [], hiddenPosts: [] }, [{ key: `t:${id}`, type: 'topic', id }], target, { topicsById: w.topicsById, postTopic: w.postTopic, postsById: new Map(), weekKey: '2026-11-21', now: 1 });
  drop1('h1', 'slot:0');
  drop1('m:2', 'corner:category');
  drop1('d:x', 'cand');
  r = groupList({ week: w.week, topics: w.topics });
  assert.deepEqual(r.items.map((x) => (x.place ? x.place.label : null)), ['カテゴリ別', null, 'メイン1', 'メイン候補']);
  assert.equal(placedCount(w.week), 2);
  r = groupList({ week: w.week, topics: w.topics }, { limit: 1 });
  assert.deepEqual([ids(r), r.total, r.more], [['m:2'], 4, 3]);
  assert.deepEqual(groupList({ week: defaultWeek(), topics: [T('p:1', 'host', 1)] }), { items: [], total: 0, more: 0 });
});

test('①チェック: 付け外し・Shift で前に押した行との間をまとめて・チェックした行をつかむと全部（一覧の順）・名前とジャンルの下書き', () => {
  const list = ['a', 'b', 'c', 'd', 'e'];
  let s = toggleSelect(new Set(), null, list, 'b');
  assert.deepEqual([[...s.sel], s.anchor], [['b'], 'b']);
  s = toggleSelect(s.sel, s.anchor, list, 'd', true);
  assert.deepEqual([[...s.sel].sort(), s.anchor], [['b', 'c', 'd'], 'b'], 'Shift: b〜d');
  s = toggleSelect(s.sel, s.anchor, list, 'a', true);
  assert.deepEqual([...s.sel].sort(), ['a', 'b', 'c', 'd'], '上へも');
  s = toggleSelect(s.sel, s.anchor, list, 'c');
  assert.deepEqual([[...s.sel].sort(), s.anchor], [['a', 'b', 'd'], 'c'], 'もう一度押すと外れる');
  s = toggleSelect(new Set(['a']), 'zzz', list, 'c', true);
  assert.deepEqual([[...s.sel].sort(), s.anchor], [['a', 'c'], 'c'], '前に押した行が一覧に無ければ 1 件だけ');
  // つかんだ行と一緒に動かす投稿
  assert.deepEqual(dragIds(new Set(['d', 'b']), list, 'b'), ['b', 'd'], 'チェックした行をつかむ → チェックした全部（一覧の順）');
  assert.deepEqual(dragIds(new Set(['d', 'b']), list, 'c'), ['c'], 'チェックしていない行はその 1 件');
  assert.deepEqual(dragIds(new Set(), list, 'a'), ['a']);
  // 名前（最初の投稿の言葉）とジャンル（多数決）の下書き
  const d = groupDraft([P('1', 'u', '担当との別れ話がつらい', 1, ['キャバクラ']), P('2', 'u', '別の話', 1, ['キャバクラ']), P('3', 'u', 'さらに別', 1, ['ホスト'])]);
  assert.equal(d.genre, 'kyaba');
  assert.ok(d.name && d.name.length <= 20 && '担当との別れ話がつらい'.includes(d.name.slice(0, 2)), d.name);
  assert.equal(groupDraft([P('1', 'u', '一般の話', 1, ['その他'])]).genre, 'general');
  assert.deepEqual(groupDraft([]), { name: '新しいまとまり', genre: 'night' });
});

test('①投稿を置く: 新しいまとまり（まとめて・画像やデータに無い投稿は入れない）・まとまりのカードへ足す（入っているものは除く）・開いた並びの入る位置・置けない所は理由', () => {
  const w = world1();
  const postsById = new Map(w.posts.map((p) => [p.id, p]));
  const ctx = { week: w.week, topicsById: w.topicsById, openId: null, openItems: [], postsById };
  const res = (drag, key, c = ctx) => resolveDrop({ kind: 'post', source: 'list', ...drag }, key, c);
  assert.deepEqual(parseDropKey('newgroup'), { zone: 'newgroup' });
  // 新しいまとまり: 1 件・チェックした行をまとめて
  let r = res({ id: 'b1' }, 'newgroup');
  assert.deepEqual([r.action, r.hint], [{ type: 'newGroup', postIds: ['b1'] }, '新しいまとまりを作る']);
  r = res({ id: 'b1', ids: ['b1', 'b2', 'd1'] }, 'newgroup');
  assert.deepEqual([r.action, r.hint], [{ type: 'newGroup', postIds: ['b1', 'b2', 'd1'] }, '新しいまとまりを作る（3件）']);
  // 開いたまとまりの中の投稿からも作れる（画像・データに無い投稿だけでは作れない）
  assert.deepEqual(res({ id: 'a1', source: 'open' }, 'newgroup').action, { type: 'newGroup', postIds: ['a1'] });
  assert.deepEqual(res({ id: 'img:abcd', source: 'open' }, 'newgroup'), { ok: false, reason: WHY_NOT.imageGroup });
  assert.deepEqual(res({ id: '777', source: 'open' }, 'newgroup'), { ok: false, reason: WHY_NOT.missingGroup });
  assert.deepEqual(resolveDrop({ kind: 'topic', id: 'h1' }, 'newgroup', ctx), { ok: false, reason: null }, 'まとまりのカードは置けない');
  // まとまりのカードへ足す
  r = res({ id: 'b1' }, 'topic:h1');
  assert.deepEqual([r.action, r.hint], [{ type: 'addPosts', topicId: 'h1', postIds: ['b1'], index: null, order: false }, 'このまとまりに足す']);
  r = res({ id: 'b1', ids: ['b1', 'a1', 'b2'] }, 'topic:h1');
  assert.deepEqual([r.action.postIds, r.hint], [['b1', 'b2'], 'このまとまりに足す（2件）'], 'もう入っている投稿（a1）は除く');
  assert.deepEqual(res({ id: 'a1' }, 'topic:h1'), { ok: false, reason: WHY_NOT.already }, '「すべての投稿」で、入っているまとまりへ');
  assert.deepEqual(res({ id: 'a1', ids: ['a1', 'a2'] }, 'topic:h1'), { ok: false, reason: WHY_NOT.already });
  assert.deepEqual(res({ id: 'a1' }, 'topic:m:2').action, { type: 'addPosts', topicId: 'm:2', postIds: ['a1'], index: null, order: false }, 'ほかのまとまりにある投稿は移る');
  assert.deepEqual(res({ id: 'b1' }, 'topic:nope'), { ok: false, reason: null });
  // 開いたまとまり: カードの頭へ（最後に足す）・並びの入る位置へ（まとめて）
  const opened = { ...ctx, openId: 'h1', openItems: ['a1', 'a2'] };
  assert.deepEqual(res({ id: 'b1' }, 'topic:h1', opened).action, { type: 'addPosts', topicId: 'h1', postIds: ['b1'], index: null, order: true });
  r = res({ id: 'b1', ids: ['b1', 'b2'] }, 'open#1', opened);
  assert.deepEqual([r.action, r.hint], [{ type: 'addPosts', topicId: 'h1', postIds: ['b1', 'b2'], index: 1, order: true }, '「ホストコール」に足す（2件）']);
  assert.equal(res({ id: 'b1' }, 'open', opened).action.index, 2, '末尾の置き場所');
  assert.deepEqual(res({ id: 'a2' }, 'open#0', opened), { ok: false, reason: WHY_NOT.already });
  assert.deepEqual(res({ id: 'b1' }, 'open#0'), { ok: false, reason: null }, '開いていなければ並びには置けない');
  // 一覧の投稿を左の列の上で離しても何もしない。開いたまとまりの投稿は左へ戻すと外れる・ほかのカードへは移る（②と同じ）
  assert.deepEqual(res({ id: 'b1' }, 'material', opened), { ok: false, reason: null });
  assert.deepEqual(res({ id: 'a1', source: 'open' }, 'material', opened).action, { type: 'removePost', topicId: 'h1', itemId: 'a1' });
  assert.deepEqual(res({ id: 'a1', source: 'open' }, 'topic:m:2', opened).action, { type: 'movePost', postId: 'a1', to: 'm:2' });
  // 番組の枠（②の置き場所）には置けない（理由）
  assert.deepEqual(res({ id: 'b1' }, 'slot:0'), { ok: false, reason: WHY_NOT.postZone });
});
