// 編成画面（フォルダ型・v2 段階1）の純粋関数。DOM 非依存（node:test から import される）。
// フォルダの木・フォルダの中身（行）・検索・おすすめ・複数選択・ドラッグ＆ドロップの結果・元に戻す/やり直す。
//
// フォルダのキー:
//   slot:0〜2      … メイン1〜3（話題を 1 つ）       cand            … メイン候補（メイン1〜3に入れる前の置き場）
//   corner:category / corner:chat … カテゴリ別ニュース・雑談
//   group:night / group:general … まとまり（話題）の一覧    topic:<話題id> … まとまりの中（投稿）
//   inbox … 受信箱（どのまとまりにも・番組構成にも入っていない今週の投稿）
//   bookmarks / new / shelf / trash / search
// 行のキー: p:<投稿id>（投稿）／ t:<話題id>（まとまり）／ tr:<ゴミ箱id>（削除した話題）／ h:<投稿id>（削除した投稿）

import { searchKey } from '../../assets/js/core.js';
import { NIGHT_GENRES, PLAN_V2 } from './config.js';
import {
  assignTopic, removeTopic, setMainSlot, mainSlots, moveToIndex, replaceTopicId, usedTopicIds, canBeMain, cornerDef,
  shelveTopic, trashTopic, hidePost, cleanTerms, topicPhrase, majorityGenre, compareIds,
} from './logic.js';

const KINDS_FOLDER = new Set(['dict', 'tag', 'cluster', 'carried', 'manual', 'bot']);

/** 「まとまり」（フォルダとして扱う話題）か。辞書・話題名・類似まとめ・持ち越し・手で作った話題、または 2 件以上 */
export function isFolderTopic(t) {
  return Boolean(t) && (KINDS_FOLDER.has(t.kind) || (t.stats ? t.stats.count : t.postIds.length) >= 2);
}

export function isNightGenre(g) {
  return NIGHT_GENRES.includes(g);
}

/** 投稿 id → 話題 id の対応表 */
export function postTopicMap(topics) {
  const m = new Map();
  for (const t of topics) for (const id of t.postIds) if (!m.has(id)) m.set(id, t.id);
  return m;
}

/**
 * 一般のバズの「おすすめ」（今週の上位 n 件）。show_pick（ボットの雑談おすすめ）を含む話題を最優先、次に話題性スコア順。
 * 返り値: おすすめの話題 id の Set
 */
export function recommendGeneral(topics, n = PLAN_V2.generalRecommendN, pickIds = new Set()) {
  const general = topics.filter((t) => !isNightGenre(t.genre));
  const pick = (t) => t.postIds.some((id) => pickIds.has(id)) || (t.linkId && pickIds.has(t.linkId));
  const sorted = general.map((t, i) => ({ t, i, p: pick(t) ? 1 : 0 })).sort((a, b) => {
    if (a.p !== b.p) return b.p - a.p;
    const sa = a.t.score;
    const sb = b.t.score;
    if (sa == null && sb != null) return 1;
    if (sb == null && sa != null) return -1;
    if (sa != null && sb != null && sa !== sb) return sb - sa;
    return a.i - b.i;
  });
  return new Set(sorted.slice(0, Math.max(0, n)).map((x) => x.t.id));
}

/** 番組構成（メイン1〜3・メイン候補・カテゴリ別・雑談）に入っている話題 id */
export function placedTopicIds(week) {
  return new Set([...usedTopicIds(week.rundown), ...(week.mainCand || [])]);
}

/** 話題の置き場所のラベル（「メイン1」「メイン候補」「カテゴリ別」「雑談」）。無ければ null */
export function placeOf(week, topicId) {
  const slots = mainSlots(week.rundown);
  const k = slots.indexOf(topicId);
  if (k >= 0) return { key: `slot:${k}`, label: `メイン${k + 1}` };
  if ((week.mainCand || []).includes(topicId)) return { key: 'cand', label: 'メイン候補' };
  for (const c of week.rundown.corners) {
    if (c.key !== 'main' && c.items.includes(topicId)) return { key: `corner:${c.key}`, label: c.key === 'category' ? 'カテゴリ別' : '雑談' };
  }
  return null;
}

// ================================================================ 検索

const indexCache = new WeakMap();

function postIndex(post) {
  let s = indexCache.get(post);
  if (s == null) {
    s = searchKey([post.text, post.user ? `@${post.user}` : '', ...cleanTerms(post.matched_terms).words, ...cleanTerms(post.matched_terms).topics].join('\n'));
    indexCache.set(post, s);
  }
  return s;
}

/** 検索語（スペース区切り。全角スペースも可） */
export function queryTokens(q) {
  return searchKey(String(q || '')).split(/[\s　]+/).map((x) => x.trim()).filter(Boolean);
}

/**
 * 今週の投稿から検索（本文・アカウント・話題名・matched_terms。スペース区切りで AND）。
 * topicNameOf(postId) で投稿が入っている話題名を引く。
 */
export function searchPosts(posts, q, topicNameOf = () => '') {
  const tokens = queryTokens(q);
  if (!tokens.length) return [];
  return posts.filter((p) => {
    const hay = postIndex(p) + '\n' + searchKey(topicNameOf(p.id) || '');
    return tokens.every((t) => hay.includes(t));
  });
}

// ================================================================ フォルダの中身（行）

/**
 * ctx: {
 *   week, saved, topics（片付け・削除を除いた話題・スコア順）, topicsById（全話題）, postsById,
 *   weekPosts（今週の投稿＋個人追加）, shelvedTopics, trashedTopics, newPostIds(Set), bookmarkPosts([post]),
 *   pickIds(Set), generalAll(boolean), query
 * }
 * 返り値: { rows, total, hidden（おすすめ外で隠した件数）}
 */
export function folderRows(ctx, key) {
  const { week, topics, topicsById } = ctx;
  const visible = new Map(topics.map((t) => [t.id, t]));
  const topicRow = (t) => ({ key: `t:${t.id}`, type: 'topic', id: t.id });
  const postRow = (id) => ({ key: `p:${id}`, type: 'post', id });
  const topicRows = (ids) => ids.map((id) => visible.get(id)).filter(Boolean).map(topicRow);
  const rec = ctx.recommended || recommendGeneral(topics, PLAN_V2.generalRecommendN, ctx.pickIds);
  const out = (rows, total = rows.length, hidden = 0) => ({ rows, total, hidden });

  if (key.startsWith('slot:')) {
    const id = mainSlots(week.rundown)[Number(key.slice(5))];
    return out(id ? topicRows([id]) : []);
  }
  if (key === 'cand') return out(topicRows(week.mainCand || []));
  if (key.startsWith('corner:')) {
    const c = week.rundown.corners.find((x) => x.key === key.slice(7));
    return out(c ? topicRows(c.items.filter(Boolean)) : []);
  }
  if (key === 'group:night' || key === 'group:general') {
    const night = key === 'group:night';
    const all = topics.filter((t) => isFolderTopic(t) && isNightGenre(t.genre) === night);
    if (night || ctx.generalAll) return out(all.map(topicRow));
    const shown = all.filter((t) => rec.has(t.id));
    return out(shown.map(topicRow), all.length, all.length - shown.length);
  }
  if (key.startsWith('topic:')) {
    const t = topicsById.get(key.slice(6));
    if (!t) return out([]);
    const ids = t.missingIds ? [...t.postIds, ...t.missingIds] : (t.postIds.length ? t.postIds : (t.linkId ? [t.linkId] : []));
    return out(ids.map(postRow));
  }
  if (key === 'inbox') {
    const placed = placedTopicIds(week);
    const singles = topics.filter((t) => !isFolderTopic(t) && !placed.has(t.id));
    const night = singles.filter((t) => isNightGenre(t.genre));
    const general = singles.filter((t) => !isNightGenre(t.genre));
    const gShown = ctx.generalAll ? general : general.filter((t) => rec.has(t.id));
    const rows = [...night, ...gShown].flatMap((t) => (t.postIds.length ? t.postIds : (t.linkId ? [t.linkId] : [])).map(postRow));
    return out(rows, night.length + general.length, general.length - gShown.length);
  }
  if (key === 'bookmarks') return out((ctx.bookmarkRows || ctx.bookmarkPosts || []).map((p) => postRow(p.id)));
  if (key === 'new') return out([...(ctx.newPostIds || [])].filter((id) => ctx.postsById.has(id)).map(postRow));
  if (key === 'shelf') return out((ctx.shelvedTopics || []).map(topicRow));
  if (key === 'hold') {
    // 保留（言葉に一致）: 話題名が一致した話題と、本文・アカウントが一致した投稿
    return out([
      ...(ctx.heldTopics || []).map((t) => ({ key: `ht:${t.id}`, type: 'heldTopic', id: t.id })),
      ...[...(ctx.heldPosts || new Map()).keys()].map((id) => ({ key: `hp:${id}`, type: 'heldPost', id })),
    ]);
  }
  if (key === 'trash') {
    const rows = [
      ...[...(ctx.saved.trash || [])].reverse().map((e) => ({ key: `tr:${e.id}`, type: 'trash', id: e.id })),
      ...[...(ctx.saved.hiddenPosts || [])].reverse().map((x) => ({ key: `h:${x.id}`, type: 'hidden', id: x.id })),
    ];
    return out(rows);
  }
  if (key === 'search') {
    const nameOf = (pid) => { const t = topicsById.get(ctx.postTopic.get(pid)); return t && isFolderTopic(t) ? t.name : ''; };
    return out(searchPosts(ctx.weekPosts || [], ctx.query, nameOf).map((p) => postRow(p.id)));
  }
  return out([]);
}

// ================================================================ フォルダの木

/**
 * 左ペインの木。open: 開いているノードのキー（Set）。
 * 返り値: [{ key, label, count, depth, genre?, drop, group?, open?, hasChildren?, topicId?, sub? }]（表示順・平らな配列）
 */
export function buildTree(ctx, open = new Set()) {
  const { week, topics } = ctx;
  const visible = new Map(topics.map((t) => [t.id, t]));
  const nodes = [];
  const add = (n) => nodes.push({ depth: 0, drop: true, ...n });
  const slots = mainSlots(week.rundown);
  add({ key: 'h:show', label: '番組構成', group: true, drop: false, count: null });
  slots.forEach((id, k) => {
    const t = id ? visible.get(id) : null;
    add({ key: `slot:${k}`, label: `メイン${k + 1}`, sub: t ? t.name : '空き', count: t ? 1 : 0, depth: 1, genre: 'main', topicId: t ? t.id : null });
  });
  add({ key: 'cand', label: 'メイン候補', count: (week.mainCand || []).filter((id) => visible.has(id)).length, depth: 1, genre: 'main' });
  for (const c of week.rundown.corners) {
    if (c.key === 'main') continue;
    add({ key: `corner:${c.key}`, label: cornerDef(c.key).name, count: c.items.filter((id) => id && visible.has(id)).length, depth: 1, genre: c.key === 'chat' ? 'general' : 'night' });
  }
  add({ key: 'h:topics', label: 'まとまり（話題）', group: true, drop: false, count: null });
  const rec = ctx.recommended || recommendGeneral(topics, PLAN_V2.generalRecommendN, ctx.pickIds);
  for (const night of [true, false]) {
    const key = night ? 'group:night' : 'group:general';
    let list = topics.filter((t) => isFolderTopic(t) && isNightGenre(t.genre) === night);
    const total = list.length;
    if (!night && !ctx.generalAll) list = list.filter((t) => rec.has(t.id));
    const isOpen = open.has(key);
    add({ key, label: night ? '夜職' : '一般のバズ', count: total, depth: 1, drop: false, hasChildren: list.length > 0, open: isOpen, genre: night ? 'night' : 'general' });
    if (isOpen) for (const t of list) add({ key: `topic:${t.id}`, label: t.name, count: t.stats.count, depth: 2, genre: t.genre, topicId: t.id, bot: t.bot ? (t.bot.low ? 'low' : 'ok') : null });
  }
  const placed = placedTopicIds(week);
  const inboxCount = topics.filter((t) => !isFolderTopic(t) && !placed.has(t.id)).length;
  add({ key: 'inbox', label: '受信箱（未整理）', count: inboxCount });
  if (ctx.bookmarkPosts) add({ key: 'bookmarks', label: '★ブックマーク', count: ctx.bookmarkPosts.length, drop: false });
  add({ key: 'new', label: 'NEW', count: (ctx.newPostIds || new Set()).size, drop: false });
  add({ key: 'shelf', label: '片付け', count: (ctx.shelvedTopics || []).length });
  add({ key: 'hold', label: '保留', sub: '保留する言葉に一致', count: (ctx.heldTopics || []).length + (ctx.heldPosts ? ctx.heldPosts.size : 0), drop: false });
  add({ key: 'trash', label: 'ゴミ箱', count: (ctx.saved.trash || []).length + (ctx.saved.hiddenPosts || []).length });
  return nodes;
}

// ================================================================ 複数選択

/**
 * 行のクリックによる選択。state: { sel: Set(行キー), anchor: 行番号 | null }
 * mods: { ctrl（⌘も）, shift }。返り値は新しい state。
 */
export function selectClick(state, rows, index, mods = {}) {
  const key = rows[index] && rows[index].key;
  if (!key) return state;
  const sel = new Set(mods.ctrl ? state.sel : []);
  if (mods.shift && state.anchor != null && rows[state.anchor]) {
    const [a, b] = [Math.min(state.anchor, index), Math.max(state.anchor, index)];
    for (let i = a; i <= b; i++) sel.add(rows[i].key);
    return { sel, anchor: state.anchor };
  }
  if (mods.ctrl && state.sel.has(key)) sel.delete(key);
  else sel.add(key);
  return { sel, anchor: index };
}

/** チェックボックス（足す／外す） */
export function toggleCheck(state, rows, index) {
  return selectClick(state, rows, index, { ctrl: true });
}

/** 表示中をすべて選択 */
export function selectAllRows(rows) {
  return { sel: new Set(rows.map((r) => r.key)), anchor: rows.length ? 0 : null };
}

/** 一覧が変わったとき、見えなくなった行を選択から外す */
export function pruneSelection(state, rows) {
  const keys = new Set(rows.map((r) => r.key));
  const sel = new Set([...state.sel].filter((k) => keys.has(k)));
  return { sel, anchor: state.anchor != null && state.anchor < rows.length ? state.anchor : null };
}

// ================================================================ ドラッグ＆ドロップ・移動先（結果）

/** 行（投稿・まとまり）→ 関係する話題 id（投稿は入っている話題。重複なし・順番を保つ） */
export function topicsOfRows(rows, postTopic) {
  const out = [];
  for (const r of rows) {
    const id = r.type === 'topic' ? r.id : r.type === 'post' ? postTopic.get(r.id) : null;
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** 置けるフォルダか（見出し・一覧ノード・NEW・ブクマには置けない） */
export function isDropTarget(key) {
  return /^(slot:[0-2]|cand|corner:(category|chat)|topic:.+|inbox|shelf|trash)$/.test(key.split('#')[0]);
}

function removeFromCand(week, ids) {
  week.mainCand = (week.mainCand || []).filter((x) => !ids.includes(x));
}

/**
 * 行（投稿・まとまり）をフォルダへ移す（ドロップ・「移動先…」・仕分けモード共通）。week と saved をその場で書き換える。
 * target: フォルダのキー（並べ替えは "corner:category#2" のように #位置）
 * ctx: { topicsById, postTopic(Map), weekKey, now, origGenreOf? }
 * 返り値: { ok, message, changed }
 */
export function applyDrop(week, saved, rows, target, ctx) {
  const [tkey, posStr] = target.split('#');
  const pos = posStr != null ? Number(posStr) : null;
  const { topicsById, postTopic } = ctx;
  const posts = rows.filter((r) => r.type === 'post').map((r) => r.id);
  const topicIdsDirect = rows.filter((r) => r.type === 'topic').map((r) => r.id);
  const topicIds = topicsOfRows(rows, postTopic);
  const name = (id) => (topicsById.get(id) || {}).name || '話題';
  if (!rows.length) return { ok: false, message: '何も選ばれていません' };

  // メイン1〜3（夜職のみ。1 つ目をその枠へ、残りはメイン候補へ）
  if (/^slot:[0-2]$/.test(tkey)) {
    const slot = Number(tkey.slice(5));
    const okIds = topicIds.filter((id) => canBeMain(topicsById.get(id)));
    if (!okIds.length) return { ok: false, message: '一般のバズはメインに入れません' };
    const r = setMainSlot(week.rundown, okIds[0], slot);
    week.rundown = r.rundown;
    removeFromCand(week, okIds);
    const rest = okIds.slice(1);
    for (const id of rest) week.rundown = removeTopic(week.rundown, id);
    week.mainCand = [...new Set([...(r.displaced ? [r.displaced] : []), ...rest, ...(week.mainCand || [])])];
    const skipped = topicIds.length - okIds.length;
    return { ok: true, changed: true, message: `「${name(okIds[0])}」をメイン${slot + 1}に入れました${r.displaced ? `（「${name(r.displaced)}」はメイン候補へ）` : ''}${skipped ? `（一般のバズ ${skipped}件は入れていません）` : ''}` };
  }
  // メイン候補（夜職のみ）
  if (tkey === 'cand') {
    const okIds = topicIds.filter((id) => canBeMain(topicsById.get(id)));
    if (!okIds.length) return { ok: false, message: '一般のバズはメイン候補に入れません' };
    for (const id of okIds) week.rundown = removeTopic(week.rundown, id);
    removeFromCand(week, okIds);
    const list = [...(week.mainCand || [])];
    const at = pos != null && pos >= 0 && pos <= list.length ? pos : list.length;
    list.splice(at, 0, ...okIds);
    week.mainCand = list;
    return { ok: true, changed: true, message: `${okIds.length}件をメイン候補に入れました${topicIds.length - okIds.length ? `（一般のバズ ${topicIds.length - okIds.length}件は入れていません）` : ''}` };
  }
  // カテゴリ別・雑談（並べ替えも）
  if (tkey === 'corner:category' || tkey === 'corner:chat') {
    const ck = tkey.slice(7);
    removeFromCand(week, topicIds);
    let at = pos;
    for (const id of topicIds) {
      week.rundown = at != null ? moveToIndex(week.rundown, ck, id, at) : (assignTopic(week.rundown, id, ck) || week.rundown);
      if (at != null) at += 1;
    }
    return { ok: true, changed: true, message: `${topicIds.length}件を「${cornerDef(ck).name}」に入れました` };
  }
  // まとまりへ: 投稿は移動、まとまりは結合
  if (tkey.startsWith('topic:')) {
    const dst = tkey.slice(6);
    if (!topicsById.has(dst)) return { ok: false, message: '移動先のまとまりが見つかりません' };
    let n = 0;
    for (const pid of posts) {
      if (postTopic.get(pid) === dst) continue;
      week.overrides.moves[pid] = dst;
      n++;
    }
    for (const src of topicIdsDirect) {
      if (src === dst) continue;
      week.overrides.merges[src] = dst;
      week.rundown = replaceTopicId(week.rundown, src, dst);
      week.mainCand = [...new Set((week.mainCand || []).map((x) => (x === src ? dst : x)))];
      if (week.script[src] && !week.script[dst]) week.script[dst] = week.script[src];
      n++;
    }
    return { ok: n > 0, changed: n > 0, message: n ? `${n}件を「${name(dst)}」へ移しました` : 'すでにそのまとまりに入っています' };
  }
  // 受信箱へ: まとまりから外す・番組構成から外す
  if (tkey === 'inbox') {
    for (const pid of posts) {
      const tid = postTopic.get(pid);
      const t = topicsById.get(tid);
      if (t && t.postIds.length > 1) week.overrides.moves[pid] = `p:${pid}`;
      else if (tid) { week.rundown = removeTopic(week.rundown, tid); removeFromCand(week, [tid]); }
    }
    for (const tid of topicIdsDirect) { week.rundown = removeTopic(week.rundown, tid); removeFromCand(week, [tid]); }
    return { ok: true, changed: true, message: `${rows.length}件を受信箱に戻しました` };
  }
  // 片付け（この週だけ）
  if (tkey === 'shelf') {
    let w = week;
    for (const tid of topicIdsDirect) w = shelveTopic(w, topicsById.get(tid), ctx.now);
    for (const pid of posts) {
      const tid = postTopic.get(pid);
      const t = topicsById.get(tid);
      if (t && t.postIds.length > 1) {
        // まとまりの中の投稿は外してから片付ける
        w.overrides.moves[pid] = `p:${pid}`;
        const post = ctx.postsById ? ctx.postsById.get(pid) : null;
        w = shelveTopic(w, { id: `p:${pid}`, name: topicPhrase(post ? post.text : ''), genre: post ? majorityGenre([post]) : t.genre, postIds: [pid] }, ctx.now);
      } else if (t) w = shelveTopic(w, t, ctx.now);
    }
    Object.assign(week, w);
    removeFromCand(week, topicIds);
    return { ok: true, changed: true, message: `${rows.length}件を片付けました（この週の候補から外しました）` };
  }
  // ゴミ箱（まとまりは削除、投稿は非表示）
  if (tkey === 'trash') {
    for (const tid of topicIdsDirect) {
      const r = trashTopic(saved, week, topicsById.get(tid), ctx.weekKey, ctx.now);
      saved.trash = r.saved.trash;
      Object.assign(week, r.week);
    }
    for (const pid of posts) saved.hiddenPosts = hidePost(saved, pid, ctx.weekKey, ctx.now, name(postTopic.get(pid))).hiddenPosts;
    removeFromCand(week, topicIdsDirect);
    return { ok: true, changed: true, message: `${rows.length}件を削除しました（ゴミ箱から戻せます）` };
  }
  return { ok: false, message: 'そこには置けません' };
}

/**
 * 選んだ行から新しいまとまりを作る（「まとまりにする」）。投稿は移動、まとまりは結合。
 * 返り値: 新しい話題 id
 */
export function makeGroup(week, rows, ctx, opts = {}) {
  const id = `m:${(ctx.now || 0).toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const posts = rows.filter((r) => r.type === 'post').map((r) => ctx.postsById && ctx.postsById.get(r.id)).filter(Boolean);
  const genre = opts.genre || (posts.length ? majorityGenre(posts) : 'night');
  const first = posts[0];
  const name = (opts.name || '').trim() || (first ? topicPhrase(first.text) : '新しいまとまり');
  week.overrides.manual = [...week.overrides.manual, { id, name, genre }];
  for (const r of rows) {
    if (r.type === 'post') week.overrides.moves[r.id] = id;
    else if (r.type === 'topic') {
      week.overrides.merges[r.id] = id;
      week.rundown = replaceTopicId(week.rundown, r.id, id);
      week.mainCand = (week.mainCand || []).map((x) => (x === r.id ? id : x));
    }
  }
  return id;
}

/** 空のまとまり（新しいフォルダ）を作る */
export function createEmptyGroup(week, name, genre, nowMs) {
  const id = `m:${(nowMs || 0).toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  week.overrides.manual = [...week.overrides.manual, { id, name: (name || '').trim() || '新しいまとまり', genre: genre || 'night' }];
  return id;
}

/** まとまりの名前を変える（空なら自動の名前に戻す） */
export function renameTopic(week, topic, name) {
  const v = String(name || '').trim().slice(0, 80);
  if (topic.kind === 'manual') {
    week.overrides.manual = week.overrides.manual.map((m) => (m.id === topic.id ? { ...m, name: v || m.name } : m));
    delete week.overrides.renames[topic.id];
  } else if (!v || v === topic.autoName) delete week.overrides.renames[topic.id];
  else week.overrides.renames[topic.id] = v;
}

// ================================================================ 元に戻す・やり直す

export function createHistory(limit = PLAN_V2.historyLimit) {
  return { past: [], future: [], limit };
}

/** 操作の前の状態（snap）を積む。やり直しは消える */
export function recordHistory(h, label, snap) {
  return { ...h, past: [...h.past, { label, snap }].slice(-h.limit), future: [] };
}

/** 元に戻す。返り値: { history, snap（戻す先）, label } | null */
export function undoHistory(h, currentSnap) {
  if (!h.past.length) return null;
  const last = h.past[h.past.length - 1];
  return { history: { ...h, past: h.past.slice(0, -1), future: [{ label: last.label, snap: currentSnap }, ...h.future] }, snap: last.snap, label: last.label };
}

/** やり直す。返り値: { history, snap, label } | null */
export function redoHistory(h, currentSnap) {
  if (!h.future.length) return null;
  const next = h.future[0];
  return { history: { ...h, past: [...h.past, { label: next.label, snap: currentSnap }].slice(-h.limit), future: h.future.slice(1) }, snap: next.snap, label: next.label };
}

// ================================================================ 仕分けモード

/** 仕分けの進み具合（n / 全件・残り） */
export function sortProgress(items, decisions, index) {
  const done = items.filter((it) => decisions.has(it.key)).length;
  return { pos: Math.min(index + 1, items.length), total: items.length, done, remaining: items.length - done };
}

/** 夜職 ⇄ 一般のバズ の切り替え先（夜職へ戻すときは元のカテゴリの夜職ジャンル、無ければ夜職その他） */
export function toggledGenre(current, origNightGenre = null) {
  if (isNightGenre(current)) return 'general';
  return origNightGenre && isNightGenre(origNightGenre) ? origNightGenre : 'night';
}

export { compareIds };
