// かんたん編成（#plan）の純粋関数。DOM 非依存（node:test から import される）。
// 2 つのステップ: ① 投稿からまとまりを作る（左＝投稿・右＝まとまり）／② まとまりを番組に並べる（左＝まとまり・右＝番組の流れ）。
// ②: まとまりの一覧（チップ・検索・番組に入っている印・ページ分け）／番組の流れ（コーナーごとの並び・時間）／「おまかせで下書き」の中身／開いたまとまりに足せる投稿。
// ①: 投稿の一覧（まだ入っていないものだけ／すべて・チップ・検索）／まとまりの一覧（作ったものが先）／チェックの選び方。
// 共通: ドラッグして置いた先 → することを決める（置けない理由も）。画面のことばは「まとまり」（コードの中の名前は topic のまま）。
// 置いた結果そのものは、フォルダの画面（#plan-folders）と同じ関数（folders.js の applyDrop など）で作る。
import { searchKey } from '../../assets/js/core.js';
import { BOARD, GENRE_PRIORITY, NIGHT_GENRES, SHOW_DEFAULTS } from './config.js';
import { mainSlots, canBeMain, suggestMain, cornerDef, totalMinutes, postGenre, compareIds, isImageItem, genreLabel, topicPhrase, majorityGenre } from './logic.js';
import { placeOf, placedTopicIds, queryTokens, searchPosts, rankGeneral, isNightGenre, isFolderTopic } from './folders.js';

// ================================================================ チップ（素材のしぼり込み。1 つだけ選ぶ）

export const BOARD_CHIPS = Object.freeze([
  Object.freeze({ key: 'rec', label: 'おすすめ' }),
  Object.freeze({ key: 'host', label: 'ホスト', genre: 'host' }),
  Object.freeze({ key: 'kyaba', label: 'キャバクラ', genre: 'kyaba' }),
  Object.freeze({ key: 'kabuki', label: '歌舞伎町', genre: 'kabuki' }),
  Object.freeze({ key: 'night', label: '夜職その他', genre: 'night' }),
  Object.freeze({ key: 'general', label: '一般', genre: 'general' }),
  Object.freeze({ key: 'bookmarks', label: '★ブックマーク' }),
  Object.freeze({ key: 'new', label: 'NEW' }),
]);

/** 出すチップ（★ブックマークは機能があるときだけ、NEW は新しい話題があるときだけ） */
export function boardChips({ hasBookmarks = false, newCount = 0 } = {}) {
  return BOARD_CHIPS.filter((c) => (c.key === 'bookmarks' ? hasBookmarks : c.key === 'new' ? newCount > 0 : true));
}

/** 覚えていたチップが今は無ければ「おすすめ」 */
export function sanitizeChip(key, chips = BOARD_CHIPS) {
  return chips.some((c) => c.key === key) ? key : 'rec';
}

/** カードに出す短いジャンル名（一般のバズ → 一般） */
export function genreShort(g) {
  return g === 'general' ? '一般' : genreLabel(g);
}

// ================================================================ 素材（左の列）

function chipFilter(ctx, chip, searching) {
  const { topics, recommended = new Set(), pickIds = new Set(), bookmarkIds = new Set(), newTopics = new Set() } = ctx;
  const c = BOARD_CHIPS.find((x) => x.key === chip) || BOARD_CHIPS[0];
  if (c.genre === 'general') return rankGeneral(topics, pickIds);
  if (c.genre) return topics.filter((t) => t.genre === c.genre);
  if (c.key === 'bookmarks') return topics.filter((t) => t.postIds.some((id) => bookmarkIds.has(id)) || (t.linkId && bookmarkIds.has(t.linkId)));
  if (c.key === 'new') return topics.filter((t) => newTopics.has(t.id));
  // おすすめ: 夜職は全部（話題性の順）、一般のバズはおすすめの上位だけ。検索中は全部から探す
  return searching ? topics : topics.filter((t) => isNightGenre(t.genre) || recommended.has(t.id));
}

/**
 * 素材の一覧（話題のカード）。
 * ctx: { week, topics（片付け・削除・保留を除いた話題。話題性の順）, recommended（一般のバズのおすすめ id の Set）, pickIds, bookmarkIds（投稿 id の Set）,
 *        newTopics（新しい話題 id の Set か Map）, weekPosts（検索する投稿）, postTopic（投稿 id → 話題 id）}
 * opts: { chip, query, limit }
 * 返り値: { items: [{ id, used: { key, label } | null, match: { postId, count } | null }], total, more }
 *  - 番組に入っている話題は used つき（薄く表示・ドラッグ不可）。並びは変えない
 *  - 検索: 話題名が一致した話題 → 投稿（本文・@アカウント）が一致した話題（match に最初の投稿と件数）
 */
export function materialList(ctx, opts = {}) {
  const { week, weekPosts = [], postTopic = new Map() } = ctx;
  const { chip = 'rec', query = '', limit = BOARD.pageSize } = opts;
  const tokens = queryTokens(query);
  const base = chipFilter(ctx, chip, tokens.length > 0);
  let list;
  if (!tokens.length) list = base.map((t) => ({ id: t.id, match: null }));
  else {
    const inBase = new Map(base.map((t, i) => [t.id, i]));
    const byName = base.filter((t) => { const n = searchKey(t.name || ''); return tokens.every((k) => n.includes(k)); });
    const named = new Set(byName.map((t) => t.id));
    const hits = new Map(); // 話題 id → { postId, count }
    for (const p of searchPosts(weekPosts, query)) {
      const tid = postTopic.get(p.id);
      if (!tid || !inBase.has(tid) || named.has(tid)) continue;
      const h = hits.get(tid);
      if (h) h.count += 1; else hits.set(tid, { postId: p.id, count: 1 });
    }
    const byPost = [...hits.keys()].sort((a, b) => inBase.get(a) - inBase.get(b));
    list = [...byName.map((t) => ({ id: t.id, match: null })), ...byPost.map((id) => ({ id, match: hits.get(id) }))];
  }
  const shown = list.slice(0, Math.max(0, limit));
  return {
    items: shown.map((x) => ({ ...x, used: placeOf(week, x.id) })),
    total: list.length,
    more: Math.max(0, list.length - shown.length),
  };
}

// ================================================================ 番組の流れ（右の列）

/**
 * コーナーごとの並び。返り値: [{ key: 'main'|'cand'|'category'|'chat', label, sub, color, slots（メインは true）, ids: [話題 id | null] }]
 * メインは枠（長さ 3・空きは null）。メイン候補（キープ）はメインのすぐ下。
 */
export function flowSections(week) {
  const corner = (k) => week.rundown.corners.find((c) => c.key === k) || { key: k, min: 0, items: [] };
  const main = corner('main');
  const max = cornerDef('main').maxItems;
  const per = Math.round((main.min || 0) / max);
  return [
    { key: 'main', label: 'メイン', sub: `各 約${per}分・${max}本まで`, color: 'main', slots: true, ids: mainSlots(week.rundown) },
    { key: 'cand', label: 'メイン候補（キープ）', sub: 'メインに入れる前の置き場', color: 'main', slots: false, ids: [...(week.mainCand || [])] },
    { key: 'category', label: cornerDef('category').name, sub: `約${corner('category').min}分`, color: 'night', slots: false, ids: corner('category').items.filter(Boolean) },
    { key: 'chat', label: cornerDef('chat').name, sub: `約${corner('chat').min}分`, color: 'general', slots: false, ids: corner('chat').items.filter(Boolean) },
  ];
}

/**
 * 時間の目安。planned: コーナーの時間の合計（予定）／ filled: 入っている分（メインは 1 本ごと、ほかは 1 つでも入っていればそのコーナーの時間）
 */
export function flowMinutes(rundown) {
  let filled = 0;
  for (const c of rundown.corners) {
    const def = cornerDef(c.key);
    if (!def) continue;
    const n = c.items.filter(Boolean).length;
    if (def.kind === 'main') filled += ((c.min || 0) * Math.min(n, def.maxItems)) / def.maxItems;
    else if (n) filled += c.min || 0;
  }
  return { filled: Math.round(filled), planned: totalMinutes(rundown) || SHOW_DEFAULTS.totalMinutes };
}

/** 分 → 「1:15」 */
export function formatHm(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

// ================================================================ ドラッグして置いた先 → すること

/**
 * 置き場所のキー:
 *   slot:0〜2 … メインの枠 ／ cand・cand#位置 … メイン候補 ／ corner:category・corner:chat（#位置）… コーナー
 *   material … 左の列（番組・まとまりから外す）／ open#位置 … 開いたまとまりの投稿の並び ／ topic:<話題id> … 右の列のまとまりのカード（投稿を足す・移す）
 *   newgroup … ステップ①の「＋ 新しいまとまり」
 */
export function parseDropKey(key) {
  const s = String(key || '');
  if (s === 'material') return { zone: 'material' };
  if (s === 'newgroup') return { zone: 'newgroup' };
  if (s.startsWith('topic:')) return { zone: 'topic', topicId: s.slice(6) };
  const [base, pos] = s.split('#');
  const index = pos != null && pos !== '' && Number.isInteger(Number(pos)) ? Number(pos) : null;
  let m = /^slot:([0-2])$/.exec(base);
  if (m) return { zone: 'slot', slot: Number(m[1]) };
  if (base === 'cand') return { zone: 'cand', index };
  m = /^corner:(category|chat)$/.exec(base);
  if (m) return { zone: 'corner', corner: m[1], index };
  if (base === 'open') return { zone: 'open', index };
  return { zone: null };
}

export const WHY_NOT = Object.freeze({
  generalMain: '一般のバズはメインに入れられません（雑談へどうぞ）',
  generalCand: '一般のバズはメイン候補に入れられません（雑談へどうぞ）',
  postZone: '投稿は、開いたまとまりの中か、ほかのまとまりのカードに入れます',
  already: 'もうこのまとまりに入っています',
  imageMove: '画像はほかのまとまりへ移せません',
  missingMove: 'データに無い投稿はほかのまとまりへ移せません',
  imageGroup: '画像だけでは新しいまとまりを作れません',
  missingGroup: 'データに無い投稿だけでは新しいまとまりを作れません',
});

const no = (reason = null) => ({ ok: false, reason });

/**
 * drag を key に置いたらどうなるか。
 * drag: { kind: 'topic', id } ／ { kind: 'post', id（投稿 id・画像は img:<id>）, source: 'open'（開いたまとまりの中）| 'addable'（②の左の「足せる投稿」）| 'list'（①の左の投稿の一覧）,
 *         ids（'list' でチェックした行をまとめてつかんだとき、その全部。無ければ [id]）}
 * ctx: { week, topicsById, openId（開いているまとまり）, openItems（その並び。全件）, postsById }
 * 返り値: { ok: true, action, hint } ／ { ok: false, reason（置けない理由。同じ場所など理由が無いときは null）}
 * action: { type: 'place', topicId, target（applyDrop に渡すキー）} ／ { type: 'unplace', topicId } ／ { type: 'reorder', topicId, order }
 *       ／ { type: 'addPost', topicId, postId, index } ／ { type: 'removePost', topicId, itemId } ／ { type: 'movePost', postId, to }
 *       ／ { type: 'addPosts', topicId, postIds, index（null＝並びは決めない）, order（並びの最後に足すと決めるか）} ／ { type: 'newGroup', postIds }
 */
export function resolveDrop(drag, key, ctx) {
  const k = parseDropKey(key);
  if (!drag || !k.zone) return no();
  const { week, topicsById = new Map() } = ctx;
  const nameOf = (id) => (topicsById.get(id) || {}).name || 'まとまり';

  if (drag.kind === 'topic') {
    const t = topicsById.get(drag.id);
    const at = placeOf(week, drag.id);
    if (k.zone === 'material') return at ? { ok: true, action: { type: 'unplace', topicId: drag.id }, hint: '番組から外す（左の一覧に戻す）' } : no();
    if (!t) return no();
    if (k.zone === 'slot') {
      if (!canBeMain(t)) return no(WHY_NOT.generalMain);
      const slots = mainSlots(week.rundown);
      if (slots[k.slot] === drag.id) return no();
      const cur = slots[k.slot];
      const fromMain = slots.includes(drag.id);
      const hint = !cur ? `メイン${k.slot + 1} に入れる` : fromMain ? `メイン${k.slot + 1} と入れ替える` : `メイン${k.slot + 1} に入れる（「${nameOf(cur)}」はメイン候補へ）`;
      return { ok: true, action: { type: 'place', topicId: drag.id, target: `slot:${k.slot}` }, hint };
    }
    if (k.zone === 'cand') {
      if (!canBeMain(t)) return no(WHY_NOT.generalCand);
      const list = week.mainCand || [];
      const cur = list.indexOf(drag.id);
      let idx = k.index == null ? list.length : Math.max(0, Math.min(list.length, k.index));
      if (cur >= 0) {
        if (idx === cur || idx === cur + 1) return no();
        if (idx > cur) idx -= 1; // 自分を抜いたあとの位置（applyDrop は抜いてから入れる）
      }
      return { ok: true, action: { type: 'place', topicId: drag.id, target: `cand#${idx}` }, hint: cur >= 0 ? '並べ替える' : 'メイン候補（キープ）に入れる' };
    }
    if (k.zone === 'corner') {
      const c = week.rundown.corners.find((x) => x.key === k.corner);
      const list = c ? c.items : [];
      const cur = list.indexOf(drag.id);
      const idx = k.index == null ? list.length : Math.max(0, Math.min(list.length, k.index));
      if (cur >= 0 && (idx === cur || idx === cur + 1)) return no();
      // 並べ替えは moveToIndex が自分の分をずらす。ほかから入れるときはその位置へ
      return { ok: true, action: { type: 'place', topicId: drag.id, target: `corner:${k.corner}#${idx}` }, hint: cur >= 0 ? '並べ替える' : `${cornerDef(k.corner).name}に入れる` };
    }
    return no(); // 話題を投稿の並び・ほかの話題の上へは置かない（外側の置き場所を探す）
  }

  if (drag.kind === 'post') {
    const { openId = null, openItems = [], postsById = new Map() } = ctx;
    const ids = Array.isArray(drag.ids) && drag.ids.length ? drag.ids : [drag.id];
    const count = (n) => (n > 1 ? `（${n}件）` : '');
    // ①: 新しいまとまりを作る（一覧の投稿・開いたまとまりの中の投稿から。画像・データに無い投稿は入れない）
    if (k.zone === 'newgroup') {
      const usable = ids.filter((id) => !isImageItem(id) && postsById.has(id));
      if (!usable.length) return no(ids.some((id) => isImageItem(id)) ? WHY_NOT.imageGroup : WHY_NOT.missingGroup);
      return { ok: true, action: { type: 'newGroup', postIds: usable }, hint: `新しいまとまりを作る${count(usable.length)}` };
    }
    // ①: 一覧の投稿（チェックした行はまとめて）→ まとまりのカード・開いた並び
    if (drag.source === 'list') {
      if (k.zone === 'material') return no();
      if (k.zone !== 'topic' && k.zone !== 'open') return no(WHY_NOT.postZone);
      const toOpen = k.zone === 'open' || k.topicId === openId;
      const dst = toOpen ? openId : k.topicId;
      const t = dst ? topicsById.get(dst) : null;
      if (!t) return no();
      const have = new Set(toOpen ? openItems : [...(t.postIds || []), ...(t.missingIds || [])]);
      const add = ids.filter((id) => !have.has(id));
      if (!add.length) return no(WHY_NOT.already);
      if (k.zone === 'open') {
        const idx = k.index == null ? openItems.length : Math.max(0, Math.min(openItems.length, k.index));
        return { ok: true, action: { type: 'addPosts', topicId: dst, postIds: add, index: idx, order: true }, hint: `「${nameOf(dst)}」に足す${count(add.length)}` };
      }
      return { ok: true, action: { type: 'addPosts', topicId: dst, postIds: add, index: null, order: toOpen }, hint: `このまとまりに足す${count(add.length)}` };
    }
    if (k.zone === 'open') {
      if (!openId) return no();
      const n = openItems.length;
      const idx = k.index == null ? n : Math.max(0, Math.min(n, k.index));
      if (drag.source === 'open') {
        const cur = openItems.indexOf(drag.id);
        if (cur < 0 || idx === cur || idx === cur + 1) return no();
        const rest = openItems.filter((x) => x !== drag.id);
        const j = idx > cur ? idx - 1 : idx;
        return { ok: true, action: { type: 'reorder', topicId: openId, order: [...rest.slice(0, j), drag.id, ...rest.slice(j)] }, hint: j === 0 ? '先頭へ（代表にする）' : '並べ替える' };
      }
      if (openItems.includes(drag.id)) return no(WHY_NOT.already);
      return { ok: true, action: { type: 'addPost', topicId: openId, postId: drag.id, index: idx }, hint: `「${nameOf(openId)}」に足す` };
    }
    if (k.zone === 'material') {
      return drag.source === 'open' && openId ? { ok: true, action: { type: 'removePost', topicId: openId, itemId: drag.id }, hint: 'このまとまりから外す' } : no();
    }
    if (k.zone === 'topic') {
      if (!topicsById.has(k.topicId)) return no();
      if (k.topicId === openId) return drag.source === 'open' ? no() : (openItems.includes(drag.id) ? no(WHY_NOT.already) : { ok: true, action: { type: 'addPost', topicId: openId, postId: drag.id, index: openItems.length }, hint: `「${nameOf(openId)}」に足す` });
      if (isImageItem(drag.id)) return no(WHY_NOT.imageMove);
      if (!postsById.has(drag.id)) return no(WHY_NOT.missingMove);
      if ((topicsById.get(k.topicId).postIds || []).includes(drag.id)) return no(WHY_NOT.already);
      return { ok: true, action: { type: 'movePost', postId: drag.id, to: k.topicId }, hint: `「${nameOf(k.topicId)}」へ移す` };
    }
    return no(WHY_NOT.postZone);
  }
  return no();
}

/**
 * Alt+↑/↓: 同じコーナーの中で 1 つ動かす。返り値: applyDrop に渡すキー（動かせなければ null）。メインは枠の入れ替え
 */
export function stepTarget(week, topicId, delta) {
  const at = placeOf(week, topicId);
  if (!at || !delta) return null;
  const d = delta > 0 ? 1 : -1;
  if (at.key.startsWith('slot:')) {
    const k = Number(at.key.slice(5)) + d;
    return k >= 0 && k < cornerDef('main').maxItems ? `slot:${k}` : null;
  }
  if (at.key === 'cand') {
    const list = week.mainCand || [];
    const j = list.indexOf(topicId) + d;
    return j >= 0 && j < list.length ? `cand#${j}` : null;
  }
  const ck = at.key.slice(7);
  const c = week.rundown.corners.find((x) => x.key === ck);
  const i = c ? c.items.indexOf(topicId) : -1;
  if (i < 0 || i + d < 0 || i + d >= c.items.length) return null;
  return `corner:${ck}#${d > 0 ? i + 2 : i - 1}`;
}

/**
 * 「＋」のメニュー（入れ先を選ぶ）。返り値: [{ key（applyDrop に渡すキー）, label, disabled, note }]
 */
export function addTargets(week, topic, topicsById = new Map()) {
  const slots = mainSlots(week.rundown);
  const mainOk = canBeMain(topic);
  const name = (id) => (topicsById.get(id) || {}).name || 'まとまり';
  const out = slots.map((id, k) => ({
    key: `slot:${k}`, label: `メイン${k + 1}`, disabled: !mainOk,
    note: !mainOk ? WHY_NOT.generalMain : id ? `いまの「${name(id)}」はメイン候補へ` : '空き',
  }));
  out.push({ key: 'cand', label: 'メイン候補（キープ）', disabled: !mainOk, note: mainOk ? null : WHY_NOT.generalCand });
  out.push({ key: 'corner:category', label: cornerDef('category').name, disabled: false, note: null });
  out.push({ key: 'corner:chat', label: cornerDef('chat').name, disabled: false, note: null });
  return out;
}

// ================================================================ おまかせで下書き

/**
 * 空いている所だけを埋める案（入っているものは動かさない）。
 * ctx: { week, topics（片付け・削除・保留を除いた話題。話題性の順）, pickIds, priorityGenre }
 * 返り値: { main: [{ slot, id }], category: [id], chat: [id], empty: { main: 空き枠の数, category: 空か, chat: 空か } }
 *  - メイン: 空き枠に suggestMain の順（夜職だけ・2 件以上の話題が先）
 *  - カテゴリ別ニュース（空のときだけ）: 夜職の話題を、ジャンルを順に回しながら上から（BOARD.draftCategory 本まで）
 *  - 雑談（空のときだけ）: 一般のバズのおすすめの上から（show_pick が先。BOARD.draftChat 本まで）
 *  - 番組に入っている話題・メイン候補は使わない
 *  - 投稿がすべて対象期間の外（「期間外」）の話題は使わない（2026-11-21）
 */
export function autoDraftPlan(ctx) {
  const { week, pickIds = new Set(), priorityGenre = GENRE_PRIORITY.default } = ctx;
  const allOutside = (t) => Boolean(t.outsideCount) && t.outsideCount >= (t.stats ? t.stats.count : (t.postIds || []).length);
  const topics = (ctx.topics || []).filter((t) => !allOutside(t));
  const used = placedTopicIds(week);
  const slots = mainSlots(week.rundown);
  const emptySlots = slots.map((id, k) => (id ? -1 : k)).filter((k) => k >= 0);
  const corner = (k) => (week.rundown.corners.find((c) => c.key === k) || { items: [] }).items.filter(Boolean);
  const empty = { main: emptySlots.length, category: corner('category').length === 0, chat: corner('chat').length === 0 };
  const plan = { main: [], category: [], chat: [], empty };

  const mains = emptySlots.length ? suggestMain(topics, used, emptySlots.length) : [];
  mains.forEach((t, i) => { plan.main.push({ slot: emptySlots[i], id: t.id }); used.add(t.id); });

  if (empty.category) {
    const order = [...new Set([...(NIGHT_GENRES.includes(priorityGenre) ? [priorityGenre] : []), ...GENRE_PRIORITY.order, ...NIGHT_GENRES])];
    const queues = new Map(order.map((g) => [g, []]));
    for (const t of topics) if (queues.has(t.genre) && !used.has(t.id) && t.score != null) queues.get(t.genre).push(t);
    let progressed = true;
    while (plan.category.length < BOARD.draftCategory && progressed) {
      progressed = false;
      for (const g of order) {
        if (plan.category.length >= BOARD.draftCategory) break;
        const t = queues.get(g).shift();
        if (!t) continue;
        plan.category.push(t.id);
        used.add(t.id);
        progressed = true;
      }
    }
  }
  if (empty.chat) {
    const picked = (t) => t.postIds.some((id) => pickIds.has(id));
    const pool = rankGeneral(topics.filter((t) => !used.has(t.id)), pickIds).filter((t) => t.score != null || picked(t));
    for (const t of pool.slice(0, BOARD.draftChat)) { plan.chat.push(t.id); used.add(t.id); }
  }
  return plan;
}

/** 下書きの結果のお知らせ。入れたものが無ければ理由（空きが無い／入れられる話題が無い） */
export function draftSummary(plan) {
  const parts = [];
  if (plan.main.length) parts.push(`メイン ${plan.main.length}`);
  if (plan.category.length) parts.push(`カテゴリ別 ${plan.category.length}`);
  if (plan.chat.length) parts.push(`雑談 ${plan.chat.length}`);
  if (parts.length) return { filled: true, text: `${parts.join('・')} を入れました` };
  const anyEmpty = plan.empty.main > 0 || plan.empty.category || plan.empty.chat;
  return { filled: false, text: anyEmpty ? '入れられるまとまりが見つかりませんでした（対象期間を広げるか、手で入れてください）' : '空いている所がありません（メイン・カテゴリ別・雑談とも入っています）' };
}

// ================================================================ 開いた話題に足せる投稿（左の列）

/**
 * ctx: { weekPosts（今の対象期間の投稿）, postTopic（投稿 id → 話題 id）, topicsById }
 * opts: { query, chip（'all' かジャンル）, limit }
 * 返り値: { items: [{ id, inTopic（もう入っている）, from（ほかの 2 件以上の話題に入っているとき、その話題 id）}], total, more }
 * 並び: 話題と同じジャンルが先 → 表示の多い順。検索は全部の投稿から（本文・@アカウント）
 */
export function addablePosts(ctx, topic, opts = {}) {
  const { weekPosts = [], postTopic = new Map(), topicsById = new Map() } = ctx;
  const { query = '', chip = 'all', limit = BOARD.pageSize } = opts;
  if (!topic) return { items: [], total: 0, more: 0 };
  const have = new Set(topic.postIds || []);
  // 削除（非表示）した投稿は話題に入っていないので出さない
  let list = weekPosts.filter((p) => postTopic.has(p.id) || have.has(p.id));
  if (chip && chip !== 'all') list = list.filter((p) => postGenre(p) === chip);
  if (queryTokens(query).length) {
    const ids = new Set(searchPosts(list, query).map((p) => p.id));
    list = list.filter((p) => ids.has(p.id));
  }
  const imp = (p) => (p.metrics && Number.isFinite(p.metrics.impression_count) ? p.metrics.impression_count : -1);
  const same = (p) => (postGenre(p) === topic.genre ? 0 : 1);
  list = [...list].sort((a, b) => same(a) - same(b) || imp(b) - imp(a) || compareIds(a.id, b.id));
  const shown = list.slice(0, Math.max(0, limit));
  return {
    items: shown.map((p) => {
      const tid = postTopic.get(p.id);
      const other = tid && tid !== topic.id ? topicsById.get(tid) : null;
      return { id: p.id, inTopic: have.has(p.id), from: other && isFolderTopic(other) ? other.id : null };
    }),
    total: list.length,
    more: Math.max(0, list.length - shown.length),
  };
}

/** 古い順（投稿日時の昇順。日時が無い投稿・データに無い投稿・画像は後ろに今の順で） */
export function oldestFirst(items, postsById = new Map()) {
  const ts = (id) => { const p = postsById.get(id); return p && Number.isFinite(p.ts) ? p.ts : null; };
  const dated = items.filter((id) => ts(id) != null).sort((a, b) => ts(a) - ts(b) || compareIds(a, b));
  return [...dated, ...items.filter((id) => ts(id) == null)];
}

// ================================================================ ステップ①: 投稿からまとまりを作る

/**
 * 左の列の投稿の一覧（表示の多い順）。
 * ctx: { weekPosts（今の対象期間の投稿。保留は入っていない）, postTopic（投稿 id → 話題 id）, topicsById,
 *        visibleIds（片付け・削除・保留を除いた話題 id の Set）, recommended（一般のバズのおすすめの話題 id の Set）,
 *        bookmarkIds（投稿 id の Set）, newPosts（前回のチェックより新しい投稿 id の Set）, openId（開いているまとまり）}
 * opts: { chip（BOARD_CHIPS のキー）, query, filter（'free'＝まだまとまりに入っていないものだけ／'all'＝すべての投稿）, limit }
 * 返り値: { items: [{ id, group（入っているまとまりの id。無ければ null）, inOpen（開いているまとまりに入っている）}], total, more, ids（しぼり込んだ全部の id。並び順）}
 *  - 「入っている」＝その投稿の話題がまとまり（isFolderTopic。2 件以上か、手で作った・辞書・ボットなど）
 *  - おすすめ: 夜職は全部、一般のバズはおすすめの話題の投稿だけ。検索中は全部から探す
 *  - 削除（非表示）した投稿・片付けた／削除した／保留の話題の投稿は出さない
 */
export function postList(ctx, opts = {}) {
  const { weekPosts = [], postTopic = new Map(), topicsById = new Map(), visibleIds = null, recommended = new Set(), bookmarkIds = new Set(), newPosts = new Set(), openId = null } = ctx;
  const { chip = 'rec', query = '', filter = 'free', limit = BOARD.pageSize } = opts;
  const c = BOARD_CHIPS.find((x) => x.key === chip) || BOARD_CHIPS[0];
  const searching = queryTokens(query).length > 0;
  const topicOf = (p) => topicsById.get(postTopic.get(p.id)) || null;
  let list = weekPosts.filter((p) => { const t = topicOf(p); return Boolean(t) && (!visibleIds || visibleIds.has(t.id)); });
  if (filter !== 'all') list = list.filter((p) => !isFolderTopic(topicOf(p)));
  if (c.genre) list = list.filter((p) => postGenre(p) === c.genre);
  else if (c.key === 'bookmarks') list = list.filter((p) => bookmarkIds.has(p.id));
  else if (c.key === 'new') list = list.filter((p) => newPosts.has(p.id));
  else if (!searching) list = list.filter((p) => { const t = topicOf(p); return isNightGenre(postGenre(p)) || isNightGenre(t.genre) || recommended.has(t.id); });
  if (searching) {
    const hit = new Set(searchPosts(list, query).map((p) => p.id));
    list = list.filter((p) => hit.has(p.id));
  }
  const imp = (p) => (p.metrics && Number.isFinite(p.metrics.impression_count) ? p.metrics.impression_count : -1);
  list = [...list].sort((a, b) => imp(b) - imp(a) || compareIds(a.id, b.id));
  const shown = list.slice(0, Math.max(0, limit));
  return {
    items: shown.map((p) => { const t = topicOf(p); const g = isFolderTopic(t) ? t.id : null; return { id: p.id, group: g, inOpen: Boolean(openId) && t.id === openId }; }),
    total: list.length,
    more: Math.max(0, list.length - shown.length),
    ids: list.map((p) => p.id),
  };
}

/**
 * 右の列のまとまりの一覧。手で作ったもの（新しい順・「作った」）→ 自動のもの（今の並び・「自動」）。
 * ctx: { week, topics（片付け・削除・保留を除いた話題。話題性の順）}
 * opts: { limit }
 * 返り値: { items: [{ id, made（手で作った）, place（番組に入っていればその場所 { key, label }）}], total, more }
 */
export function groupList(ctx, opts = {}) {
  const { week, topics = [] } = ctx;
  const { limit = BOARD.pageSize } = opts;
  const madeAt = new Map(((week.overrides && week.overrides.manual) || []).map((m, i) => [m.id, i]));
  const groups = topics.filter((t) => isFolderTopic(t));
  const made = groups.filter((t) => t.kind === 'manual').sort((a, b) => (madeAt.get(b.id) ?? -1) - (madeAt.get(a.id) ?? -1));
  const auto = groups.filter((t) => t.kind !== 'manual');
  const list = [...made, ...auto];
  const shown = list.slice(0, Math.max(0, limit));
  return {
    items: shown.map((t) => ({ id: t.id, made: t.kind === 'manual', place: placeOf(week, t.id) })),
    total: list.length,
    more: Math.max(0, list.length - shown.length),
  };
}

/** 番組（メイン・カテゴリ別・雑談）に入っている本数。メイン候補（キープ）は数えない */
export function placedCount(week) {
  return week.rundown.corners.reduce((n, c) => n + c.items.filter(Boolean).length, 0);
}

/**
 * チェックの付け外し。shift を押していて前に押した行（anchor）が一覧にあれば、その間をまとめて選ぶ。
 * 返り値: { sel: Set, anchor }
 */
export function toggleSelect(sel, anchor, ids, id, shift = false) {
  const next = new Set(sel);
  const i = ids.indexOf(id);
  const a = anchor != null ? ids.indexOf(anchor) : -1;
  if (shift && a >= 0 && i >= 0) {
    for (let j = Math.min(a, i); j <= Math.max(a, i); j++) next.add(ids[j]);
    return { sel: next, anchor };
  }
  if (next.has(id)) next.delete(id); else next.add(id);
  return { sel: next, anchor: id };
}

/** つかんだ行と一緒に動かす投稿（チェックした行をつかんだらチェックした全部。一覧の並び順）。チェックしていない行はその 1 件 */
export function dragIds(sel, ids, id) {
  return sel.has(id) ? ids.filter((x) => sel.has(x)) : [id];
}

/** まとまりにするときの名前とジャンルの下書き（最初の投稿の言葉・多数決）。posts: 投稿の配列 */
export function groupDraft(posts) {
  const list = (posts || []).filter(Boolean);
  return { name: list.length ? topicPhrase(list[0].text) : '新しいまとまり', genre: list.length ? majorityGenre(list) : 'night' };
}
