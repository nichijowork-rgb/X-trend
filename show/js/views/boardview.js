// ① 編成（準備）— かんたん編成（#plan）。2 つのステップ（上の大きなボタンで切り替え。どちらも「左から右へドラッグ」）:
//   ステップ① 投稿からまとまりを作る: 左＝投稿（表示の多い順・まだ入っていないものだけ）、右＝まとまり（「＋ 新しいまとまり」・作った／自動）
//   ステップ② まとまりを番組に並べる: 左＝まとまり、右＝番組の流れ（メイン・メイン候補・カテゴリ別・雑談）
// カードをドラッグして入れる・並べ替える・左へ戻して外す。「＋」で入れ先を選ぶ。右のカードを押すとその場で開き、投稿を並べ替え・追加できる。
// 画面半分（960px）で 2 列、1400px 以上は右にプレビューの列、760px 以下は 1 列（左／右の切り替え）。画面のことばは「まとまり」（コードの中の名前は topic）。
// くわしい整理（片付け・ゴミ箱・保留・仕分けなど）は従来のフォルダの画面（#plan-folders）で。保存データは同じ。
// 置いた結果は board.js の resolveDrop → folders.js の applyDrop など（フォルダの画面と同じ関数）で作る。文字はすべて textContent。
import { formatCompact, formatDateTime } from '../../../assets/js/core.js';
import { sizedImageUrl } from '../../../assets/js/media.js';
import { BOARD, CHECKPOINTS, GENRES, NIGHT_GENRES, TEXT } from '../config.js';
import { autoTitle, recordCheckpoint, statusUrl, leadText, isImageItem, assignTopic, setMainSlot, removeTopic, cornerDef, genreLabel, moveItemTo } from '../logic.js';
import { applyDrop, createEmptyGroup, renameTopic, addPostsToTopic, placeOf, makeGroup, isFolderTopic } from '../folders.js';
import {
  boardChips, sanitizeChip, genreShort, materialList, flowSections, flowMinutes, formatHm, resolveDrop, stepTarget, addTargets,
  autoDraftPlan, draftSummary, addablePosts, oldestFirst, postList, groupList, placedCount, toggleSelect, dragIds, groupDraft,
} from '../board.js';
import { h, btn, field, postCard, metaCard, genreSticker, embedHost, isEditable } from '../dom.js';
import { scriptFor, topicMarks, refYear, mainTopics, currentTitle, bmInfo, statsLine } from './common.js';
import { beginPointer, isDragging } from './dnd.js';
import { contextMenu, nameDialog } from './menu.js';
import { toolsDialog } from './tools.js';
import { urlAddDialog } from './urladd.js';

const wide = () => typeof matchMedia === 'function' && matchMedia('(min-width: 1400px)').matches;
const narrow = () => typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches;
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function ui(app) {
  const u = app.ui;
  if (!u.board) {
    let pref = {};
    try { pref = JSON.parse(localStorage.getItem(BOARD.prefKey) || '{}') || {}; } catch { pref = {}; }
    u.board = {
      // ステップ（1＝投稿からまとまりを作る／2＝まとまりを番組に並べる）。前に使っていたほうを覚える（初めては 1）
      step: pref.step === 2 ? 2 : 1,
      chip: typeof pref.chip === 'string' ? pref.chip : 'rec', query: '', pages: 1,
      open: null, left: 'material', addQuery: '', addChip: 'all', addPages: 1, itemPages: 1,
      tab: 'material', preview: null, flash: null, scroll: { left: 0, right: 0 }, scrollTo: null, focusKey: null, quietUntil: 0,
      // ステップ①: 開いているまとまり・チップ・検索・出す投稿（free＝まだ入っていないものだけ／all）・チェック・まとまりの一覧のページ
      open1: null, chip1: typeof pref.chip1 === 'string' ? pref.chip1 : 'rec', query1: '', pages1: 1, filter: 'free',
      sel: new Set(), anchor: null, gpages: 1, scroll1: { left: 0, right: 0 },
    };
  }
  return u.board;
}

function savePref(b) {
  try { localStorage.setItem(BOARD.prefKey, JSON.stringify({ chip: b.chip, step: b.step, chip1: b.chip1 })); } catch { /* 保存できなくても動く */ }
}

/** 列ごとのスクロール位置（ステップごとに別） */
const scrollOf = (b) => (b.step === 1 ? b.scroll1 : b.scroll);
const REMOVED_TEXT = 'まとまりから外しました（まだ入っていない投稿に戻りました）';

function setStep(app, n) {
  const b = ui(app);
  if (b.step === n) return;
  b.step = n;
  b.preview = null;
  b.tab = 'material';
  b.focusKey = `bd-step-${n}`;
  app.ui.menu = null;
  savePref(b);
  app.render();
}

const topicRow = (id) => ({ key: `t:${id}`, type: 'topic', id });
const nameOf = (app, id) => (app.topicsById.get(id) || {}).name || 'まとまり';
const applyCtx = (app) => ({ topicsById: app.topicsById, postTopic: app.postTopic, postsById: app.postsById, weekKey: app.weekKey, now: Date.now() });

/** 開いているまとまり（ステップごとに別） */
function openTopic(app) {
  const b = ui(app);
  const id = b.step === 1 ? b.open1 : b.open;
  return id ? app.topicsById.get(id) || null : null;
}
/** ②で左の列が「足せる投稿」になっているか（①の左はいつも投稿の一覧） */
const isAddMode = (app) => ui(app).step !== 1 && Boolean(openTopic(app)) && ui(app).left === 'addable';

// ================================================================ 操作（どれも 1 回で元に戻せる）

/** 話題を番組へ（target は applyDrop のキー: slot:0 / cand#2 / corner:category#1 …）。並べ替えも */
function placeTopic(app, topicId, target) {
  const b = ui(app);
  const wk = app.weekState();
  const before = placeOf(wk, topicId);
  const base = target.split('#')[0];
  let res = null;
  app.edit(`番組に入れる：${nameOf(app, topicId)}`, (w, s) => { res = applyDrop(w, s, [topicRow(topicId)], target, applyCtx(app)); }, { render: false });
  if (res && !res.ok) {
    app.history = { ...app.history, past: app.history.past.slice(0, -1) };
    app.toast(res.message);
  } else if (res) {
    const same = before && before.key === base;
    const text = base.startsWith('slot:') ? res.message
      : same ? `「${nameOf(app, topicId)}」を並べ替えました`
        : `「${nameOf(app, topicId)}」を${base === 'cand' ? 'メイン候補（キープ）' : cornerDef(base.slice(7)).name}に入れました`;
    b.flash = { id: topicId, at: Date.now() };
    app.toast(text, () => app.undo());
  }
  app.render();
}

/** 番組から外す（素材に戻す） */
function unplace(app, topicId) {
  const b = ui(app);
  if (!placeOf(app.weekState(), topicId)) return;
  if (b.open === topicId) { b.open = null; b.left = 'material'; }
  app.edit(`番組から外す：${nameOf(app, topicId)}`, (w, s) => { applyDrop(w, s, [topicRow(topicId)], 'inbox', applyCtx(app)); },
    { toastText: `「${nameOf(app, topicId)}」を番組から外しました（左の一覧に戻りました）` });
}

/** 片付ける・削除（フォルダの画面の「片付け」「ゴミ箱」から戻せる） */
function putAway(app, topicId, where) {
  const b = ui(app);
  const name = nameOf(app, topicId);
  if (b.open === topicId) { b.open = null; b.left = 'material'; }
  if (b.open1 === topicId) b.open1 = null;
  if (b.preview && b.preview.kind === 'topic' && b.preview.id === topicId) b.preview = null;
  app.edit(where === 'trash' ? `削除「${name}」` : `片付け「${name}」`, (w, s) => { applyDrop(w, s, [topicRow(topicId)], where, applyCtx(app)); },
    { toastText: where === 'trash' ? `「${name}」を削除しました（「フォルダで整理」のゴミ箱から戻せます）` : `「${name}」を片付けました（この週の一覧から外しました。「フォルダで整理」の片付けから戻せます）` });
}

function setTopicGenre(app, topicId, genre) {
  app.edit(`ジャンル変更：${genreLabel(genre)}`, (w) => { w.overrides.genres[topicId] = genre; }, { toastText: `「${nameOf(app, topicId)}」のジャンルを「${genreLabel(genre)}」にしました` });
}

/** 開いた話題の並びを決める（先頭が代表投稿） */
function setOrder(app, topicId, order, text) {
  app.edit('投稿の並べ替え', (w) => { w.postOrder = { ...w.postOrder, [topicId]: [...order] }; }, { toastText: text });
}

/**
 * 投稿をまとまりに足す（ほかのまとまりにある投稿は移す）。index: 話す順に入れる位置（null＝最後）。
 * order: 話す順まで決めるか（閉じたカードへ置いたときは決めない＝表示の多い順のまま。手で並べてあるまとまりは最後に足す）
 */
function addPosts(app, topicId, ids, index = null, order = true) {
  const b = ui(app);
  const t = app.topicsById.get(topicId);
  if (!t) return;
  const items = app.itemsFor(t);
  const fresh = [...new Set(ids)].filter((id) => !items.includes(id));
  if (!fresh.length) { app.toast('もうこのまとまりに入っています'); return; }
  const sources = [...new Set(fresh.map((id) => app.postTopic.get(id)).filter((x) => x && x !== t.id))].map((id) => app.topicsById.get(id)).filter(Boolean);
  let result = null;
  app.edit(`投稿を足す「${t.name}」`, (w) => {
    result = addPostsToTopic(w, t, fresh, { postsById: app.basePostsById, postTopic: app.postTopic, topicsById: app.topicsById, inRange: new Set(app.weekPosts.map((p) => p.id)), move: true, now: Date.now() });
    const done = fresh.filter((id) => result.added.includes(id) || result.missing.includes(id));
    if (!done.length) return;
    if (order || w.postOrder[t.id]) {
      const at = index == null ? items.length : Math.max(0, Math.min(items.length, index));
      w.postOrder = { ...w.postOrder, [t.id]: [...items.slice(0, at), ...done, ...items.slice(at)] };
    }
    // 1 件だけの話題として番組に入っていた投稿を移したら、その空になった話題は番組から外す
    for (const ft of sources) {
      if (ft.postIds.some((id) => !done.includes(id)) || (ft.missingIds || []).length) continue;
      w.rundown = removeTopic(w.rundown, ft.id);
      w.mainCand = (w.mainCand || []).filter((x) => x !== ft.id);
    }
  }, { render: false });
  const n = result ? result.added.length + result.missing.length : 0;
  if (!n) {
    app.history = { ...app.history, past: app.history.past.slice(0, -1) };
    app.toast('足せませんでした');
  } else {
    const ft = sources.length === 1 ? sources[0] : null;
    const text = n === 1
      ? `「${t.name}」に足しました${result.moved.length && ft ? `（「${ft.name}」から移しました）` : ''}`
      : `「${t.name}」に ${n}件足しました${result.moved.length ? `（${result.moved.length}件はほかのまとまりから移しました）` : ''}`;
    if (b.step === 1) { b.flash = { id: t.id, at: Date.now() }; b.sel = new Set([...b.sel].filter((id) => !fresh.includes(id))); }
    app.toast(text, () => app.undo());
  }
  app.render();
}

/** 投稿を 1 件足す（「＋」・開いた並びへのドラッグ。index の位置へ） */
function addPost(app, topicId, postId, index = null) {
  addPosts(app, topicId, [postId], index, true);
}

/**
 * 投稿から新しいまとまりを作る（フォルダの画面の「まとまりにする」と同じ makeGroup）。
 * ask: 作ったあとで名前を聞く（ドラッグで作ったとき。そのままでもよい）
 */
function createGroup(app, ids, { name = '', genre = null, ask = false } = {}) {
  const b = ui(app);
  const posts = [...new Set(ids)].map((id) => app.postsById.get(id)).filter(Boolean);
  if (!posts.length) { app.toast('まとまりにできる投稿がありません'); return; }
  const draft = groupDraft(posts);
  const moved = new Set(posts.map((p) => p.id));
  const sources = [...new Set(posts.map((p) => app.postTopic.get(p.id)).filter(Boolean))].map((id) => app.topicsById.get(id)).filter(Boolean);
  let gid = null;
  app.edit('まとまりにする', (w) => {
    gid = makeGroup(w, posts.map((p) => ({ key: `p:${p.id}`, type: 'post', id: p.id })), applyCtx(app), { name: String(name || '').trim() || draft.name, genre: genre || draft.genre });
    // 1 件だけの話題として番組に入っていた投稿をまとめたら、その空になった話題は番組から外す
    for (const ft of sources) {
      if (ft.postIds.some((id) => !moved.has(id)) || (ft.missingIds || []).length) continue;
      w.rundown = removeTopic(w.rundown, ft.id);
      w.mainCand = (w.mainCand || []).filter((x) => x !== ft.id);
    }
  }, { render: false });
  b.sel = new Set();
  b.anchor = null;
  const t = gid ? app.topicsById.get(gid) : null;
  if (t) {
    b.flash = { id: gid, at: Date.now() };
    b.scroll1.right = 0;
    b.gpages = 1;
    app.toast(`まとまり「${t.name}」を作りました（投稿 ${posts.length}件）`, () => app.undo());
    if (ask) app.ui.nameDlg = { mode: 'rename', topicId: gid, name: t.name, made: true };
  }
  app.render();
}

/** チェックした投稿を「まとまりにする」: 名前（自動の下書き）とジャンル（多数決）を聞いてから作る */
function askGroup(app, ids) {
  const posts = ids.map((id) => app.postsById.get(id)).filter(Boolean);
  if (!posts.length) return;
  const d = groupDraft(posts);
  app.ui.menu = null;
  app.ui.nameDlg = { mode: 'group', ids: posts.map((p) => p.id), name: d.name, genre: d.genre };
  app.render();
}

function movePost(app, postId, to) {
  app.edit('投稿の移動', (w, s) => { applyDrop(w, s, [{ key: `p:${postId}`, type: 'post', id: postId }], `topic:${to}`, applyCtx(app)); },
    { toastText: `投稿を「${nameOf(app, to)}」へ移しました` });
}

function runAction(app, a) {
  if (a.type === 'place') placeTopic(app, a.topicId, a.target);
  else if (a.type === 'unplace') unplace(app, a.topicId);
  else if (a.type === 'reorder') setOrder(app, a.topicId, a.order, '投稿を並べ替えました（先頭が代表投稿）');
  else if (a.type === 'addPost') addPost(app, a.topicId, a.postId, a.index);
  else if (a.type === 'addPosts') addPosts(app, a.topicId, a.postIds, a.index, a.order);
  else if (a.type === 'newGroup') createGroup(app, a.postIds, { ask: true });
  else if (a.type === 'removePost') { const t = app.topicsById.get(a.topicId); if (t) app.removeItem(t, a.itemId, isImageItem(a.itemId) ? null : REMOVED_TEXT); }
  else if (a.type === 'movePost') movePost(app, a.postId, a.to);
}

/** おまかせで下書き: 空いている所だけ埋める */
function autoDraft(app) {
  const plan = autoDraftPlan({ week: app.weekState(), topics: app.visibleTopics, pickIds: app.pickIds, priorityGenre: app.saved.priorityGenre });
  const sum = draftSummary(plan);
  if (!sum.filled) { app.toast(sum.text); return; }
  app.edit('おまかせで下書き', (w) => {
    for (const m of plan.main) w.rundown = setMainSlot(w.rundown, m.id, m.slot).rundown;
    for (const id of plan.category) w.rundown = assignTopic(w.rundown, id, 'category') || w.rundown;
    for (const id of plan.chat) w.rundown = assignTopic(w.rundown, id, 'chat') || w.rundown;
  }, { toastText: sum.text });
}

function toggleOpen(app, topicId) {
  const b = ui(app);
  if (b.step === 1) {
    // ①: 左は投稿の一覧のまま（開いたまとまりに「＋」で足せるようになる）
    b.open1 = b.open1 === topicId ? null : topicId;
    b.itemPages = 1;
    if (b.open1 && wide()) b.preview = { kind: 'topic', id: topicId, item: null };
    app.render();
    return;
  }
  if (b.open === topicId) { b.open = null; b.left = 'material'; } else {
    b.open = topicId;
    b.left = 'addable';
    b.addQuery = '';
    b.addChip = 'all';
    b.addPages = 1;
    b.itemPages = 1;
    b.scroll.left = 0;
    if (wide()) b.preview = { kind: 'topic', id: topicId, item: null };
  }
  app.render();
}

function showPreview(app, pv) {
  const b = ui(app);
  b.preview = pv;
  app.render();
}

/** 番組に入っている話題のカードへ（右の列で光らせる） */
function goToPlaced(app, topicId) {
  const b = ui(app);
  if (b.step !== 2) { b.step = 2; savePref(b); }
  b.tab = 'flow';
  b.flash = { id: topicId, at: Date.now() };
  b.scrollTo = topicId;
  app.render();
}

// ================================================================ ドラッグ

function dragOpts(app, drag, sourceEl, handle) {
  const t = openTopic(app);
  // ドラッグ中は描き直さないので、置き場所の判定に使う状態は始めに 1 回だけ作る
  const ctx = { week: app.weekState(), topicsById: app.topicsById, openId: t ? t.id : null, openItems: t ? app.itemsFor(t) : [], postsById: app.postsById };
  const res = (key) => resolveDrop(drag, key, ctx);
  return {
    handle, kind: drag.kind, source: sourceEl,
    getRows: () => [drag],
    label: () => '',
    ghost: () => {
      const c = sourceEl.cloneNode(true);
      for (const n of [c, ...c.querySelectorAll('*')]) { for (const a of [...n.attributes]) if (a.name.startsWith('data-') || a.name === 'id' || a.name === 'tabindex') n.removeAttribute(a.name); }
      for (const n of c.querySelectorAll('.bd-open-body')) n.remove();
      c.classList.remove('is-flash', 'is-sel');
      // チェックした行をまとめてつかんだとき
      if (drag.ids && drag.ids.length > 1) c.append(h('span', { class: 'bd-lift-n' }, `${drag.ids.length}件`));
      return c;
    },
    canDrop: (key) => res(key).ok,
    whyNot: (key) => res(key).reason,
    hint: (key) => { const r = res(key); return r.ok ? r.hint : ''; },
    onDenied: (m) => app.toast(m),
    onDrop: (key) => { const r = res(key); if (r.ok) runAction(app, r.action); },
  };
}

/** カードにドラッグを付ける（マウスはカードのどこでも、タッチ・ペンは ⋮⋮ から） */
function makeDraggable(app, card, grip, drag, sourceEl = card) {
  card.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, a, input, textarea, select, summary, label')) return;
    beginPointer(e, dragOpts(app, drag, sourceEl, false));
  });
  if (grip) {
    grip.addEventListener('pointerdown', (e) => { e.stopPropagation(); beginPointer(e, dragOpts(app, drag, sourceEl, true)); });
  }
}

/** タッチの長押しでメニュー（右クリックの代わり） */
function onLongPress(app, el, open) {
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || e.target.closest('button, a, input, .bd-grip')) return;
    const sx = e.clientX;
    const sy = e.clientY;
    let timer = setTimeout(() => { timer = null; done(); if (!isDragging()) { ui(app).quietUntil = Date.now() + 600; open(sx, sy); } }, BOARD.longPressMs);
    const moved = (ev) => { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 8) done(); };
    const done = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      el.removeEventListener('pointermove', moved);
      el.removeEventListener('pointerup', done);
      el.removeEventListener('pointercancel', done);
      el.removeEventListener('pointerleave', done);
    };
    el.addEventListener('pointermove', moved);
    el.addEventListener('pointerup', done);
    el.addEventListener('pointercancel', done);
    el.addEventListener('pointerleave', done);
  });
}

// ================================================================ メニュー

function openMenu(app, items, x, y, returnKey = null) {
  app.ui.menu = { items, x, y, returnKey };
  app.render();
}

function closeMenu(app) {
  const m = app.ui.menu;
  app.ui.menu = null;
  if (m && m.returnKey) ui(app).focusKey = m.returnKey;
  app.render();
}

/** 「＋」: 入れ先を選ぶ */
function addMenuItems(app, t) {
  return [{ heading: `「${t.name}」を入れる所` }, ...addTargets(app.weekState(), t, app.topicsById).map((x) => ({
    label: x.label, note: x.note, key: `bd-to-${x.key}`, disabled: x.disabled, title: x.disabled ? x.note : null, run: () => placeTopic(app, t.id, x.key),
  }))];
}

/** 名前・ジャンル・片付け・削除（まとまりのカードのメニューの下半分。①②共通） */
function tidyMenuItems(app, t) {
  const items = [{ label: '名前を変える', key: 'bd-ctx-rename', hint: 'F2', run: () => openRename(app, t.id) }, { heading: 'ジャンル' }];
  for (const g of GENRES) items.push({ label: g.label, key: `bd-ctx-genre-${g.key}`, disabled: g.key === t.genre, run: () => setTopicGenre(app, t.id, g.key) });
  items.push({ sep: true });
  items.push({ label: '片付ける（この週は使わない）', key: 'bd-ctx-shelf', run: () => putAway(app, t.id, 'shelf') });
  items.push({ label: '削除（ゴミ箱へ）', key: 'bd-ctx-trash', danger: true, run: () => putAway(app, t.id, 'trash') });
  return items;
}

/** 右クリック・長押し・メニューキー: ②のまとまりのカード */
function topicMenuItems(app, t) {
  const b = ui(app);
  const placed = placeOf(app.weekState(), t.id);
  const items = [];
  if (placed) {
    items.push({ label: b.open === t.id ? '閉じる' : '開く（中の投稿を見る）', key: 'bd-ctx-open', run: () => toggleOpen(app, t.id) });
    items.push({ label: '番組から外す（左の一覧に戻す）', key: 'bd-ctx-unplace', hint: 'Del', run: () => unplace(app, t.id) });
  }
  items.push({ label: 'プレビュー（X の表示）', key: 'bd-ctx-preview', run: () => showPreview(app, { kind: 'topic', id: t.id, item: null }) });
  items.push(...addMenuItems(app, t).map((x) => (x.heading ? { heading: placed ? '入れる所を変える' : '番組に入れる' } : { ...x, key: x.key.replace('bd-to-', 'bd-ctx-to-') })));
  items.push({ sep: true });
  items.push(...tidyMenuItems(app, t));
  return items;
}

/** 右クリック・長押し・メニューキー: ①のまとまりのカード */
function groupMenuItems(app, t) {
  const b = ui(app);
  return [
    { label: b.open1 === t.id ? '閉じる' : '開く（中の投稿を見る）', key: 'bd-ctx-open', run: () => toggleOpen(app, t.id) },
    { label: 'プレビュー（X の表示）', key: 'bd-ctx-preview', run: () => showPreview(app, { kind: 'topic', id: t.id, item: null }) },
    { sep: true },
    ...tidyMenuItems(app, t),
  ];
}

/** 開いたまとまりの中の 1 件 */
function postMenuItems(app, t, id) {
  const items = app.itemsFor(t);
  const i = items.indexOf(id);
  const out = [
    { label: '先頭へ（代表にする）', key: 'bd-ctx-top', disabled: i === 0, run: () => setOrder(app, t.id, moveItemTo(items, id, 0), '先頭（代表投稿）にしました') },
    { label: '末尾へ', key: 'bd-ctx-bottom', disabled: i === items.length - 1, run: () => setOrder(app, t.id, moveItemTo(items, id, items.length), '末尾へ移しました') },
    { label: 'このまとまりから外す', key: 'bd-ctx-remove-post', hint: 'Del', run: () => app.removeItem(t, id, isImageItem(id) ? null : REMOVED_TEXT) },
  ];
  if (!isImageItem(id)) out.push({ label: 'X で開く', key: 'bd-ctx-x', run: () => app.openViewer(statusUrl(id)) });
  return out;
}

function openRename(app, topicId) {
  const t = app.topicsById.get(topicId);
  if (!t) return;
  app.ui.menu = null;
  app.ui.nameDlg = { mode: 'rename', topicId, name: t.name, genre: null };
  app.render();
}

function nameDlg(app) {
  const u = app.ui;
  const b = ui(app);
  const d = u.nameDlg;
  const close = () => { u.nameDlg = null; app.render(); };
  if (d.mode === 'rename') {
    const t = app.topicsById.get(d.topicId);
    return nameDialog({
      // made: ドラッグで作った直後（自動の名前が入っている。そのままでもよい）
      title: d.made ? 'まとまりの名前（そのままでもかまいません）' : 'まとまりの名前を変える', okLabel: d.made ? '決める' : '変える', name: d.name, onClose: close,
      onOk: (name) => {
        u.nameDlg = null;
        if (t && String(name || '').trim() !== t.name) app.edit(`名前の変更「${name}」`, (w) => renameTopic(w, t, name), { toastText: '名前を変えました' });
        else app.render();
      },
    });
  }
  if (d.mode === 'group') {
    return nameDialog({
      title: `${d.ids.length}件をまとまりにする`, okLabel: 'まとまりにする', name: d.name, genre: d.genre || 'night', genres: GENRES, onClose: close,
      onOk: (name, g) => { u.nameDlg = null; createGroup(app, d.ids, { name, genre: g }); },
    });
  }
  return nameDialog({
    title: '新しいまとまりを作る', okLabel: '作る', name: d.name || '', genre: d.genre || 'night', genres: GENRES, onClose: close,
    onOk: (name, g) => {
      u.nameDlg = null;
      const label = String(name || '').trim() || '新しいまとまり';
      let id = null;
      if (b.step === 1) {
        // ①: 空のまとまりを作って開く（番組には入れない。左の投稿を「＋」かドラッグで足す）
        app.edit('新しいまとまり', (w) => { id = createEmptyGroup(w, label, g, Date.now()); }, { render: false });
        if (id && app.topicsById.has(id)) { b.open1 = id; b.itemPages = 1; b.tab = 'flow'; b.flash = { id, at: Date.now() }; b.scroll1.right = 0; b.gpages = 1; }
        app.toast(`まとまり「${label}」を作りました。左の投稿を「＋」かドラッグで足してください`, () => app.undo());
        app.render();
        return;
      }
      const ck = NIGHT_GENRES.includes(g) ? 'category' : 'chat';
      app.edit('新しいまとまり', (w) => { id = createEmptyGroup(w, label, g, Date.now()); w.rundown = assignTopic(w.rundown, id, ck) || w.rundown; }, { render: false });
      if (id && app.topicsById.has(id)) { b.open = id; b.left = 'addable'; b.addQuery = ''; b.addChip = 'all'; b.addPages = 1; b.itemPages = 1; b.tab = 'flow'; b.flash = { id, at: Date.now() }; b.scrollTo = id; }
      app.toast(`まとまり「${label}」を作って「${cornerDef(ck).name}」に入れました。左の投稿を「＋」かドラッグで足してください`, () => app.undo());
      app.render();
    },
  });
}

// ================================================================ 描画

export function renderBoard(app) {
  const b = ui(app);
  const wk = app.weekState();
  // 開いているまとまり・プレビューが無くなっていたら閉じる（元に戻す・データの更新など）
  if (b.open && !(app.topicsById.has(b.open) && placeOf(wk, b.open))) { b.open = null; b.left = 'material'; }
  if (b.open1) {
    const t1 = app.topicsById.get(b.open1);
    if (!(t1 && isFolderTopic(t1) && app.visibleTopics.includes(t1))) b.open1 = null;
  }
  if (b.preview && b.preview.kind === 'topic' && !app.topicsById.has(b.preview.id)) b.preview = null;
  const isWide = wide();
  const isNarrow = narrow();
  const panel = !isWide && Boolean(b.preview);
  const root = h('div', { class: `bd${isWide ? ' is-wide' : ''}${isNarrow ? ' is-narrow' : ''}${panel ? ' is-panel' : ''}`, dataset: { keep: `plan:${app.weekKey}`, tab: b.tab, step: String(b.step) } });
  root.append(topBar(app, wk), stepSwitch(app, wk));
  if (isNarrow) root.append(tabSwitch(app));
  const cols = h('div', { class: 'bd-cols', dataset: { keep: 'cols' } });
  if (b.step === 1) cols.append(postsCol(app, wk, panel), groupsCol(app, wk));
  else cols.append(leftCol(app, wk, panel), rightCol(app, wk));
  if (isWide || b.preview) cols.append(previewCol(app, wk, isWide));
  root.append(cols);
  root.append(h('p', { id: 'drag-status', class: 'sr-only', attrs: { role: 'status', 'aria-live': 'polite' } }));
  const u = app.ui;
  if (u.nameDlg) root.append(nameDlg(app));
  else if (u.tools) root.append(toolsDialog(app));
  else if (u.urlDlg) root.append(urlAddDialog(app));
  if (u.menu) root.append(contextMenu(u.menu.items, u.menu.x, u.menu.y, () => closeMenu(app)));
  app.afterRender = () => afterRender(app);
  return root;
}

function afterRender(app) {
  const b = ui(app);
  for (const d of document.querySelectorAll('#view dialog[data-modal]')) if (!d.open && typeof d.showModal === 'function') d.showModal();
  // 検索欄は描き直さない（日本語入力の途中で消えないように）。表示だけ今の状態に合わせる
  const input = document.querySelector('#view [data-key="bd-search"]');
  if (input) {
    const add = isAddMode(app);
    const want = b.step === 1 ? b.query1 : add ? b.addQuery : b.query;
    if (input.value !== want && document.activeElement !== input) input.value = want;
    input.placeholder = b.step === 1 ? '検索（本文・@アカウント）' : add ? '投稿を検索（本文・@アカウント）' : '検索（まとまりの名前・本文・@アカウント）';
  }
  // 列ごとのスクロール位置を保つ
  for (const [key, side] of [['bd-lscroll', 'left'], ['bd-rscroll', 'right']]) {
    const el = document.querySelector(`#view [data-key="${key}"]`);
    if (!el) continue;
    if (!el.__bdBound) { el.__bdBound = true; el.addEventListener('scroll', () => { if (el.isConnected) scrollOf(ui(app))[side] = el.scrollTop; }, { passive: true }); }
    if (Math.abs(el.scrollTop - scrollOf(b)[side]) > 1) el.scrollTop = scrollOf(b)[side];
  }
  if (b.scrollTo) {
    const el = document.querySelector(`#view [data-flow-id="${CSS.escape(b.scrollTo)}"]`);
    b.scrollTo = null;
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }
  if (b.focusKey) {
    const el = document.querySelector(`#view [data-key="${CSS.escape(b.focusKey)}"]`);
    b.focusKey = null;
    if (el && !el.disabled) el.focus({ preventScroll: true });
  }
}

// ---------------------------------------------------------------- 上の帯

function topBar(app, wk) {
  const u = app.ui;
  const auto = autoTitle(app.saved.showName, mainTopics(app).map((t) => t.name));
  const isAuto = !(typeof wk.title === 'string' && wk.title.trim());
  const titleInput = h('input', { class: 'input input-sm input-title', type: 'text', value: currentTitle(app), maxLength: 200, dataset: { key: 'title' }, attrs: { autocomplete: 'off', 'aria-label': '配信タイトル', title: isAuto ? '配信タイトル（メインのまとまりから自動で作っています。書き換えできます）' : '配信タイトル' } });
  titleInput.addEventListener('input', () => app.update((w) => { w.title = titleInput.value === auto ? null : titleInput.value; }, { render: false, debounce: true }));
  titleInput.addEventListener('change', () => app.render());
  const last = wk.checkpoints[wk.checkpoints.length - 1];
  const cpLabel = last ? `前回のチェック：${CHECKPOINTS.find((c) => c.kind === last.kind)?.label || ''} ${last.recordedAt ? formatDateTime(null, Math.floor(last.recordedAt / 1000)) : ''}（その後の新しい投稿 ${app.newInfo ? app.newInfo.posts.size : 0}件）` : 'チェックを記録すると、それ以降に増えた投稿・まとまりに NEW が付きます';
  const closeMore = (fn) => (e) => { const d = e.currentTarget.closest('details'); if (d) d.open = false; fn(); };
  const more = h('details', { class: 'menu menu-more bd-more' },
    h('summary', { class: 'btn btn-small', dataset: { key: 'bd-more' }, attrs: { 'aria-label': 'そのほかの操作', title: '新しいまとまり・チェックの記録・ツール・フォルダで整理' } }, '…'),
    h('div', { class: 'menu-list' },
      h('button', { type: 'button', class: 'menu-item', dataset: { key: 'bd-new-topic' }, on: { click: closeMore(() => { u.nameDlg = { mode: 'new', name: '', genre: 'night' }; app.render(); }) } }, '＋ 新しいまとまりを作る'),
      CHECKPOINTS.map((cp) => h('button', {
        type: 'button', class: 'menu-item', dataset: { key: `cp-${cp.kind}` },
        on: { click: closeMore(() => app.edit(`チェックポイント（${cp.label}）`, (w) => { Object.assign(w, recordCheckpoint(w, cp.kind, app.ds.generated_at, app.weekPostIds, app.topics.map((t) => t.id), Date.now())); }, { toastText: `${cp.label}のチェックを記録しました（これ以降に増えた投稿・まとまりに NEW が付きます）` })) },
      }, `チェックを記録：${cp.label}（${cp.when}）`)),
      h('p', { class: 'menu-note' }, cpLabel),
      h('button', { type: 'button', class: 'menu-item', dataset: { key: 'tools-open' }, on: { click: closeMore(() => { u.tools = true; app.render(); }) } }, 'ツール…（番組名・書き出し・ボットへの修正 など）'),
      h('a', { class: 'menu-item', href: '#plan-folders', dataset: { key: 'bd-folders' } }, 'フォルダで整理（くわしい画面）')));
  return h('header', { class: 'bd-top' },
    h('label', { class: 'bd-titlebox' }, h('span', { class: 'sr-only' }, '配信タイトル'), titleInput),
    isAuto ? null : btn('自動に戻す', () => app.update((w) => { w.title = null; }), 'btn btn-small btn-ghost', { 'data-key': 'title-auto', title: 'タイトルをメインのまとまりから自動で作る形に戻します' }),
    // 「おまかせで下書き」は番組に並べるステップ（②）だけ
    ui(app).step === 2 ? btn('おまかせで下書き', () => autoDraft(app), 'btn btn-small btn-red', { 'data-key': 'bd-draft', title: '空いている所（メインの空き枠・空のカテゴリ別・空の雑談）だけ、おすすめのまとまりで埋めます。入っているものは動かしません' }) : null,
    btn('↶ 元に戻す', () => app.undo(), 'btn btn-small', { 'data-key': 'undo', disabled: !app.history.past.length }),
    btn('↷ やり直す', () => app.redo(), 'btn btn-small bd-redo', { 'data-key': 'redo', disabled: !app.history.future.length }),
    more);
}

/** いちばん上: ステップの切り替え（① 投稿からまとまりを作る → ② まとまりを番組に並べる） */
function stepSwitch(app, wk) {
  const b = ui(app);
  const free = postList(postCtx(app), { chip: 'rec', filter: 'free', limit: 0 }).total;
  const groups = groupList({ week: wk, topics: app.visibleTopics }, { limit: 0 }).total;
  const one = (n, title, sub, tip) => {
    const on = b.step === n;
    return h('button', {
      type: 'button', class: `bd-step${on ? ' is-on' : ''}`, dataset: { key: `bd-step-${n}` }, attrs: { role: 'tab', 'aria-selected': String(on), title: tip }, on: { click: () => setStep(app, n) },
    }, h('span', { class: 'bd-step-n', attrs: { 'aria-hidden': 'true' } }, String(n)),
    h('span', { class: 'bd-step-tx' }, h('span', { class: 'bd-step-t' }, title), h('span', { class: 'bd-step-s', dataset: { key: `bd-step-${n}-sub` } }, sub)));
  };
  const box = h('div', { class: 'bd-steps', attrs: { role: 'tablist', 'aria-label': '編成の手順' } },
    one(1, '投稿からまとまりを作る', `まだ入っていない投稿 ${free}件`, '左の投稿を右へドラッグして、まとまり（番組で話す 1 つの話）を作ります。数は「おすすめ」（夜職は全部・一般のバズはおすすめだけ）の中で、まだどのまとまりにも入っていない投稿'),
    h('span', { class: 'bd-step-arrow', attrs: { 'aria-hidden': 'true' } }, '→'),
    one(2, 'まとまりを番組に並べる', `まとまり ${groups}・番組に ${placedCount(wk)}本`, 'できたまとまりを右の「番組の流れ」（メイン・カテゴリ別・雑談）へドラッグして並べます'));
  // 左右の矢印キーでも切り替え
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    e.stopPropagation();
    setStep(app, e.key === 'ArrowRight' ? 2 : 1);
  });
  return box;
}

/** 760px 以下: 左／右の列の切り替え */
function tabSwitch(app) {
  const b = ui(app);
  const wk = app.weekState();
  const one = (key, label) => btn(label, () => { b.tab = key; b.preview = null; app.render(); }, `bd-tab${b.tab === key ? ' is-on' : ''}`, { 'data-key': `bd-tab-${key}`, 'aria-pressed': String(b.tab === key) });
  if (b.step === 1) {
    const g = groupList({ week: wk, topics: app.visibleTopics }, { limit: 0 }).total;
    return h('div', { class: 'bd-tabs', attrs: { role: 'group', 'aria-label': '表示する列' } }, one('material', '投稿'), one('flow', `まとまり（${g}）`));
  }
  const n = flowSections(wk).reduce((s, x) => s + x.ids.filter(Boolean).length, 0);
  return h('div', { class: 'bd-tabs', attrs: { role: 'group', 'aria-label': '表示する列' } }, one('material', isAddMode(app) ? '足せる投稿' : 'まとまり'), one('flow', `番組の流れ（${n}）`));
}

// ---------------------------------------------------------------- 左: 素材

function matCtx(app) {
  return {
    week: app.weekState(), topics: app.visibleTopics, recommended: app.recommended, pickIds: app.pickIds,
    bookmarkIds: new Set((app.bookmarkPosts || []).map((p) => p.id)), newTopics: app.newInfo ? app.newInfo.topics : new Map(),
    weekPosts: app.weekPosts || [], postTopic: app.postTopic, topicsById: app.topicsById,
  };
}

function searchBox(app) {
  const wrap = h('div', { class: 'bd-search', dataset: { keep: 'bd-search' }, attrs: { 'data-keep-leaf': '' } });
  const input = h('input', { class: 'input input-sm', type: 'search', dataset: { key: 'bd-search' }, attrs: { autocomplete: 'off', 'aria-label': '検索', placeholder: ui(app).step === 1 ? '検索（本文・@アカウント）' : '検索（まとまりの名前・本文・@アカウント）' } });
  let timer = null;
  // 打った字はすぐ状態に入れる（描き直しだけ少し待つ。待つ間にチップを押しても、打った字が元に戻らない）
  const store = () => {
    const b = ui(app);
    if (b.step === 1) {
      if (b.query1 === input.value) return;
      b.query1 = input.value;
      b.pages1 = 1;
      b.scroll1.left = 0;
      return;
    }
    const add = isAddMode(app);
    if ((add ? b.addQuery : b.query) === input.value) return;
    if (add) { b.addQuery = input.value; b.addPages = 1; } else { b.query = input.value; b.pages = 1; }
    b.scroll.left = 0;
  };
  const later = (ms) => { clearTimeout(timer); timer = setTimeout(() => app.render(), ms); };
  // 日本語入力の変換中は描き直さない（確定してから）
  input.addEventListener('input', (e) => { if (e.isComposing) return; store(); later(150); });
  input.addEventListener('compositionend', () => { store(); later(50); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && input.value && !e.isComposing) { e.preventDefault(); e.stopPropagation(); input.value = ''; clearTimeout(timer); store(); app.render(); } });
  wrap.append(input);
  return wrap;
}

/** ①の左の投稿の一覧に出すチップ（NEW は前回のチェックより新しい投稿があるとき） */
const postChips = (app) => boardChips({ hasBookmarks: app.bookmarkPosts != null, newCount: app.newInfo ? app.newInfo.posts.size : 0 });

function chipsRow(app, addMode) {
  const b = ui(app);
  const posts = b.step === 1;
  const row = h('div', { class: 'bd-chips', attrs: { role: 'group', 'aria-label': addMode ? '投稿のジャンル' : posts ? '投稿のしぼり込み' : 'まとまりのしぼり込み' } });
  const list = posts ? postChips(app) : addMode
    ? [{ key: 'all', label: 'すべて' }, ...GENRES.map((g) => ({ key: g.key, label: genreShort(g.key), genre: g.key }))]
    : boardChips({ hasBookmarks: app.bookmarkPosts != null, newCount: app.newInfo ? app.newInfo.topics.size : 0 });
  const cur = posts ? sanitizeChip(b.chip1, list) : addMode ? b.addChip : sanitizeChip(b.chip, list);
  for (const c of list) {
    row.append(h('button', {
      type: 'button', class: `bd-chip${c.key === 'new' ? ' is-new' : ''}`, dataset: { key: `bd-chip-${c.key}` }, attrs: { 'aria-pressed': String(cur === c.key) },
      on: { click: () => {
        if (posts) { b.chip1 = c.key; b.pages1 = 1; savePref(b); } else if (addMode) { b.addChip = c.key; b.addPages = 1; } else { b.chip = c.key; b.pages = 1; savePref(b); }
        scrollOf(b).left = 0;
        app.render();
      } },
    }, c.genre ? h('span', { class: `bd-dot g-${c.genre}`, attrs: { 'aria-hidden': 'true' } }) : null, c.label));
  }
  return row;
}

function leftCol(app, wk, hidden) {
  const b = ui(app);
  const t = openTopic(app);
  const addMode = isAddMode(app);
  const col = h('section', { class: `bd-col bd-left${hidden ? ' is-hidden' : ''}${addMode ? ' is-add' : ''}`, attrs: { 'aria-label': addMode ? '足せる投稿' : 'まとまり' }, dataset: { keep: 'left', drop: 'material' } });
  col.append(h('div', { class: 'bd-head' },
    h('h3', { class: 'bd-h' }, addMode ? '投稿' : 'まとまり', h('small', { dataset: { key: 'bd-left-sub' } }, addMode ? `「${t.name}」に足せる投稿` : 'おすすめ順')),
    addMode ? btn('← まとまりに戻る', () => { b.left = 'material'; b.scroll.left = 0; app.render(); }, 'btn btn-small btn-ghost bd-back', { 'data-key': 'bd-back-material', title: 'まとまりの一覧に戻ります（開いたまとまりはそのまま）' })
      : (t ? btn('足せる投稿を見る', () => { b.left = 'addable'; b.scroll.left = 0; app.render(); }, 'btn btn-small btn-ghost bd-back', { 'data-key': 'bd-show-addable', title: `開いている「${t.name}」に足せる投稿の一覧` }) : null)));
  col.append(searchBox(app));
  col.append(chipsRow(app, addMode));
  const scroll = h('div', { class: 'bd-scroll', dataset: { keep: 'lscroll', key: 'bd-lscroll', dndScroll: '' } });
  if (addMode) fillAddable(app, wk, t, scroll); else fillMaterial(app, wk, scroll);
  col.append(scroll);
  // 一覧に無い投稿・自分の画像を足す入口（一覧の下にいつも見える。画像の選択は開いた話題の入力欄を使う）
  if (addMode) {
    col.append(h('div', { class: 'bd-foot' },
      btn('URL から投稿を追加', () => { app.ui.urlDlg = { topicId: t.id, text: '' }; app.render(); }, 'btn btn-small btn-ghost', { 'data-key': 'bd-left-url', title: `X の投稿の URL を貼って、「${t.name}」に足します` }),
      h('label', { class: 'btn btn-small btn-ghost', attrs: { for: `bd-img-file-${t.id}`, title: '画像を追加（ファイルを選ぶ・Ctrl+V で貼り付け）' }, dataset: { key: 'bd-left-img' } }, '画像を追加')));
  }
  // 右から持ってきたときの案内（ドラッグ中だけ出る）
  col.append(h('div', { class: 'bd-drop-note', attrs: { 'aria-hidden': 'true' } },
    h('span', { class: 'for-topic' }, 'ここで離すと番組から外します（左の一覧に戻ります）'),
    h('span', { class: 'for-post' }, 'ここで離すとこのまとまりから外します')));
  return col;
}

function fillMaterial(app, wk, scroll) {
  const b = ui(app);
  const chips = boardChips({ hasBookmarks: app.bookmarkPosts != null, newCount: app.newInfo ? app.newInfo.topics.size : 0 });
  const list = materialList(matCtx(app), { chip: sanitizeChip(b.chip, chips), query: b.query, limit: b.pages * BOARD.pageSize });
  scroll.dataset.total = String(list.total);
  if (b.query.trim()) scroll.append(h('p', { class: 'bd-note', dataset: { key: 'bd-search-note' } }, `「${b.query.trim()}」：${list.total}件（名前が合うもの → 中の投稿が合うもの）`));
  for (const it of list.items) {
    const t = app.topicsById.get(it.id);
    if (t) scroll.append(materialCard(app, wk, t, it));
  }
  if (!list.items.length) scroll.append(h('p', { class: 'empty bd-empty' }, b.query.trim() ? '見つかりませんでした' : 'ここに出すまとまりはありません'));
  if (list.more) scroll.append(btn(`もっと見る（あと ${list.more}件）`, () => { b.pages += 1; app.render(); }, 'btn btn-small btn-ghost bd-more-btn', { 'data-key': 'bd-more-list' }));
}

/** カードの印（★・NEW・雑談おすすめ・Grok・持ち越し・期間外） */
function cardMarks(app, t) {
  const out = [];
  if (t.bookmarkCount) out.push(h('span', { class: 'bd-mark is-star', attrs: { title: `ブックマークした投稿 ${t.bookmarkCount}件` } }, `★${t.bookmarkCount > 1 ? t.bookmarkCount : ''}`));
  if (app.newInfo && app.newInfo.topics.has(t.id)) out.push(h('span', { class: 'bd-mark is-new', attrs: { title: '前回のチェックのあとに増えたまとまり' } }, 'NEW'));
  if (t.postIds.some((id) => app.pickIds.has(id))) out.push(h('span', { class: 'bd-mark is-pick', attrs: { title: '雑談おすすめ（Grok）' } }, '雑談おすすめ'));
  if (t.bot) out.push(h('span', { class: `bd-mark is-bot${t.bot.low ? ' is-low' : ''}`, attrs: { title: t.bot.low ? 'Grok のまとめ（要確認）' : 'Grok のまとめ' } }, t.bot.low ? 'Grok?' : 'Grok'));
  if (t.kind === 'carried') out.push(h('span', { class: 'bd-mark', attrs: { title: '先週から持ち越したまとまり' } }, '持ち越し'));
  if (t.outsideCount) out.push(h('span', { class: 'bd-mark is-out', attrs: { title: '対象期間の外の投稿があります（番組に入っているので残しています）' } }, '期間外'));
  return out;
}

const metaText = (t) => `${genreShort(t.genre)}・投稿 ${t.stats.count}・合計 ${formatCompact(t.stats.totalImp)}`;

function materialCard(app, wk, t, it) {
  const b = ui(app);
  const used = it.used;
  const sel = b.preview && b.preview.kind === 'topic' && b.preview.id === t.id;
  const card = h('div', {
    class: `bd-card is-material${used ? ' is-used' : ''}${sel ? ' is-sel' : ''}`, tabIndex: 0,
    dataset: { key: `mat-${t.id}`, card: 'material', topic: t.id },
    attrs: { role: 'button', 'aria-label': `${t.name}（${metaText(t)}）${used ? `。番組に入っています（${used.label}）` : ''}`, title: used ? `番組に入っています（${used.label}）。押すと右の列で光ります` : null },
  });
  const grip = used ? h('span', { class: 'bd-grip is-off', attrs: { 'aria-hidden': 'true' } }, '⋮⋮') : h('span', { class: 'bd-grip', attrs: { 'aria-hidden': 'true', title: 'つかんで右へ' } }, '⋮⋮');
  let sub = metaText(t);
  if (it.match) {
    const p = app.postsById.get(it.match.postId);
    sub = `一致：${p ? `@${p.user} ${oneLine(p.text).slice(0, 40)}` : '投稿'}${it.match.count > 1 ? ` ほか${it.match.count - 1}件` : ''}`;
  }
  card.append(h('span', { class: `bd-stripe g-${t.genre}` }), grip,
    h('div', { class: 'bd-tx' },
      h('div', { class: 'bd-ttl' }, h('span', { class: 'bd-name' }, t.name), used ? h('span', { class: 'bd-used', dataset: { key: `used-${t.id}` } }, '番組に入っています') : null, ...cardMarks(app, t)),
      h('div', { class: 'bd-meta' }, sub)));
  if (!used) {
    const add = h('button', { type: 'button', class: 'bd-rd bd-add', dataset: { key: `add-${t.id}` }, attrs: { 'aria-label': `「${t.name}」を番組に入れる`, 'aria-haspopup': 'menu', title: '入れ先を選ぶ（メイン・メイン候補・カテゴリ別・雑談）' } }, '＋');
    add.addEventListener('click', (e) => { e.stopPropagation(); const r = add.getBoundingClientRect(); openMenu(app, addMenuItems(app, t), r.right - 250, r.bottom + 4, `add-${t.id}`); });
    card.append(add);
    makeDraggable(app, card, grip, { kind: 'topic', id: t.id });
  }
  card.addEventListener('click', (e) => {
    if (e.target.closest('button, a') || Date.now() < b.quietUntil) return;
    if (used) goToPlaced(app, t.id); else showPreview(app, { kind: 'topic', id: t.id, item: null });
  });
  const menu = (x, y) => openMenu(app, topicMenuItems(app, t), x, y, `mat-${t.id}`);
  card.addEventListener('contextmenu', (e) => { e.preventDefault(); menu(e.clientX, e.clientY); });
  onLongPress(app, card, menu);
  return card;
}

// ---------------------------------------------------------------- 左: 開いた話題に足せる投稿

function fillAddable(app, wk, t, scroll) {
  const b = ui(app);
  const list = addablePosts({ weekPosts: app.weekPosts || [], postTopic: app.postTopic, topicsById: app.topicsById }, t, { query: b.addQuery, chip: b.addChip, limit: b.addPages * BOARD.pageSize });
  scroll.dataset.total = String(list.total);
  scroll.append(h('p', { class: 'bd-note' }, b.addQuery.trim() ? `「${b.addQuery.trim()}」：${list.total}件` : `「＋」か、右の開いたまとまりへドラッグで足せます（${genreShort(t.genre)}の投稿が先・表示の多い順）`));
  for (const it of list.items) scroll.append(addableRow(app, t, it));
  if (!list.items.length) scroll.append(h('p', { class: 'empty bd-empty' }, '見つかりませんでした'));
  if (list.more) scroll.append(btn(`もっと見る（あと ${list.more}件）`, () => { b.addPages += 1; app.render(); }, 'btn btn-small btn-ghost bd-more-btn', { 'data-key': 'bd-more-list' }));
}

function thumbOf(app, id) {
  if (isImageItem(id)) {
    const imgId = id.slice(4);
    const d = app.imageData(imgId);
    if (!d) { app.loadImage(imgId).catch(() => {}); return h('span', { class: 'bd-th is-ph', attrs: { 'aria-hidden': 'true' } }, '画像'); }
    return h('img', { class: 'bd-th', src: d.url, alt: '', decoding: 'async' });
  }
  const p = app.postsById.get(id);
  const m = p ? (p.media || []).find((x) => (x.type === 'photo' ? x.url : x.preview)) : null;
  if (!m) return null;
  const img = h('img', { class: 'bd-th', alt: '', loading: 'lazy', decoding: 'async', referrerPolicy: 'no-referrer' });
  img.addEventListener('error', () => img.remove());
  img.src = sizedImageUrl(m.type === 'photo' ? m.url : m.preview, 'thumb');
  return img;
}

/** 1 件の文（本文 1 行・下の行） */
function postText(app, id) {
  if (isImageItem(id)) {
    const m = (app.weekState().images || []).find((x) => `img:${x.id}` === id);
    return { text: `（画像）${(m && m.caption) || 'キャプションなし'}`, meta: '自分で追加した画像' };
  }
  const p = app.postsById.get(id);
  if (p) return { text: oneLine(p.text) || '（本文なし）', meta: `@${p.user}・表示 ${formatCompact(p.metrics ? p.metrics.impression_count : null)}・${formatDateTime(p.created_jst, p.ts, refYear(app))}` };
  const lm = app.linkMetaOf(id);
  return {
    text: lm && lm.text ? oneLine(lm.text) : `データに無い投稿（ID ${id}）`,
    meta: `${lm && lm.handle ? `@${lm.handle}・` : ''}${lm && lm.text ? '数値は次回の更新で' : (lm && lm.error ? '本文を取得できませんでした' : '数値は不明')}`,
    missing: true,
  };
}

function addableRow(app, t, it) {
  const b = ui(app);
  const x = postText(app, it.id);
  const other = it.from ? app.topicsById.get(it.from) : null;
  const sel = b.preview && b.preview.kind === 'post' && b.preview.id === it.id;
  const row = h('div', {
    class: `bd-post is-addable${it.inTopic ? ' is-in' : ''}${sel ? ' is-sel' : ''}`, tabIndex: 0,
    dataset: { key: `addable-${it.id}`, card: 'addable', post: it.id }, attrs: { role: 'button', 'aria-label': `${x.text.slice(0, 60)}${it.inTopic ? '（入っています）' : ''}` },
  });
  const grip = h('span', { class: `bd-grip${it.inTopic ? ' is-off' : ''}`, attrs: { 'aria-hidden': 'true' } }, '⋮⋮');
  row.append(...[grip, thumbOf(app, it.id)].filter(Boolean),
    h('div', { class: 'bd-ptx' }, h('div', { class: 'bd-pt' }, x.text),
      h('div', { class: 'bd-pm' }, x.meta, it.inTopic ? '・入っています' : '', other ? h('span', { class: 'bd-from', attrs: { title: `いまは「${other.name}」に入っています。足すとこちらへ移ります` } }, `▸ ${other.name}`) : null)));
  if (!it.inTopic) {
    const add = h('button', { type: 'button', class: 'bd-rd bd-add', dataset: { key: `addp-${it.id}` }, attrs: { 'aria-label': `「${t.name}」に足す`, title: `「${t.name}」の最後に足す${other ? `（「${other.name}」から移ります）` : ''}` } }, '＋');
    add.addEventListener('click', (e) => { e.stopPropagation(); addPost(app, t.id, it.id, null); });
    row.append(add);
    makeDraggable(app, row, grip, { kind: 'post', id: it.id, source: 'addable' });
  }
  row.addEventListener('click', (e) => {
    if (e.target.closest('button, a') || Date.now() < b.quietUntil) return;
    showPreview(app, { kind: 'post', id: it.id, addable: !it.inTopic });
  });
  return row;
}

// ---------------------------------------------------------------- 右: 番組の流れ

function rightCol(app, wk) {
  const fm = flowMinutes(wk.rundown);
  const col = h('section', { class: 'bd-col bd-right', attrs: { 'aria-label': '番組の流れ' }, dataset: { keep: 'right' } });
  col.append(h('div', { class: 'bd-head' },
    h('h3', { class: 'bd-h' }, '番組の流れ', h('small', {}, '上から順に進行')),
    h('span', { class: `bd-total${fm.filled > fm.planned ? ' is-over' : ''}`, dataset: { key: 'bd-total' }, attrs: { title: '合計＝入っている分の目安（メインは 1 本ごと）。予定＝コーナーの時間の合計（時間は「フォルダで整理」で変えられます）' } }, `合計 ${formatHm(fm.filled)} / 予定 ${formatHm(fm.planned)}`)));
  const scroll = h('div', { class: 'bd-scroll', dataset: { keep: 'rscroll', key: 'bd-rscroll', dndScroll: '' } });
  const visible = new Map(app.visibleTopics.map((t) => [t.id, t]));
  for (const sec of flowSections(wk)) {
    const box = h('div', { class: `bd-sec is-${sec.key}`, dataset: { key: `sec-${sec.key}` } });
    box.append(h('div', { class: 'bd-sec-h' }, h('span', { class: `bd-sec-dot g-${sec.color}`, attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'bd-sec-name' }, sec.label), h('span', { class: 'bd-sec-sub' }, sec.sub)));
    const list = h('div', { class: 'bd-list' });
    if (sec.slots) {
      sec.ids.forEach((id, k) => {
        const t = id ? visible.get(id) : null;
        if (t) list.append(flowCard(app, wk, t, { drop: `slot:${k}`, slot: k }));
        else list.append(h('div', { class: 'bd-zone is-slot', dataset: { drop: `slot:${k}`, key: `slot-${k}` } }, `メイン${k + 1}　ここに入れる`));
      });
    } else {
      const base = sec.key === 'cand' ? 'cand' : `corner:${sec.key}`;
      // 位置は保存データの中の位置（見つからない話題を飛ばしてもずれないように）
      const raw = sec.key === 'cand' ? (wk.mainCand || []) : (wk.rundown.corners.find((c) => c.key === sec.key) || { items: [] }).items;
      raw.forEach((id, i) => {
        const t = id ? visible.get(id) : null;
        if (t) list.append(flowCard(app, wk, t, { item: base, index: i }));
      });
      list.append(h('div', { class: `bd-zone${sec.key === 'cand' ? ' is-thin' : ''}`, dataset: { drop: base, key: `zone-${sec.key}` } }, sec.key === 'cand' ? '＋ ここにドラッグでキープ' : '＋ ここにドラッグ'));
    }
    box.append(list);
    scroll.append(box);
  }
  col.append(scroll);
  return col;
}

/** 右の列の話題のカード（押すとその場で開く） */
function flowCard(app, wk, t, pos) {
  const b = ui(app);
  const open = b.open === t.id;
  const flash = b.flash && b.flash.id === t.id && Date.now() - b.flash.at < 1600;
  const card = h('div', {
    class: `bd-card is-flow${open ? ' is-open-head' : ''}${flash && !open ? ' is-flash' : ''}`, tabIndex: 0,
    dataset: { key: `flow-${t.id}`, card: 'flow', topic: t.id },
    attrs: { role: 'button', 'aria-expanded': String(open), 'aria-label': `${pos.slot != null ? `メイン${pos.slot + 1}：` : ''}${t.name}（${metaText(t)}）。押すと${open ? '閉じます' : '中の投稿を開きます'}` },
  });
  const grip = h('span', { class: 'bd-grip', attrs: { 'aria-hidden': 'true', title: 'つかんで並べ替え・左へ戻すと外れます' } }, '⋮⋮');
  const x = h('button', { type: 'button', class: 'bd-rd bd-x', dataset: { key: `unplace-${t.id}` }, attrs: { 'aria-label': `「${t.name}」を番組から外す`, title: '番組から外す（左の一覧に戻ります。Ctrl+Z で戻せます）' } }, '✕');
  x.addEventListener('click', (e) => { e.stopPropagation(); unplace(app, t.id); });
  card.append(h('span', { class: `bd-stripe g-${t.genre}` }), grip,
    h('div', { class: 'bd-tx' },
      h('div', { class: 'bd-ttl' }, pos.slot != null ? h('span', { class: 'bd-slotn', attrs: { title: `メイン${pos.slot + 1}` } }, String(pos.slot + 1)) : null, h('span', { class: 'bd-name' }, t.name), ...cardMarks(app, t)),
      h('div', { class: 'bd-meta' }, metaText(t))),
    x);
  // 置き場所: メインの枠は入れ替え、並びは前／後ろ。投稿はこの話題へ移せる
  const outer = open ? h('div', { class: `bd-open${flash ? ' is-flash' : ''}`, dataset: { key: 'bd-open' } }) : card;
  if (pos.drop) outer.dataset.drop = pos.drop;
  else { outer.dataset.dropItem = pos.item; outer.dataset.dropIndex = String(pos.index); }
  outer.dataset.dropAlt = `topic:${t.id}`;
  outer.dataset.flowId = t.id;
  makeDraggable(app, card, grip, { kind: 'topic', id: t.id }, outer);
  card.addEventListener('click', (e) => {
    if (e.target.closest('button, a') || Date.now() < b.quietUntil) return;
    toggleOpen(app, t.id);
  });
  const menu = (px, py) => openMenu(app, topicMenuItems(app, t), px, py, `flow-${t.id}`);
  card.addEventListener('contextmenu', (e) => { e.preventDefault(); menu(e.clientX, e.clientY); });
  onLongPress(app, card, menu);
  if (!open) return card;
  outer.append(card, openBody(app, wk, t));
  return outer;
}

/** 開いた話題の中身: 話す順の投稿・ボタン・台本 */
function openBody(app, wk, t) {
  const b = ui(app);
  const items = app.itemsFor(t);
  const shown = items.slice(0, b.itemPages * BOARD.itemPageSize);
  const manual = Boolean(wk.postOrder[t.id]);
  const body = h('div', { class: 'bd-open-body' });
  body.append(h('div', { class: 'bd-open-info' },
    h('span', { dataset: { key: 'bd-open-count' } }, `話す順（上から）・${items.length}件`, items.length ? '・先頭が代表' : ''),
    items.length > 1 ? btn('古い順に並べる', () => setOrder(app, t.id, oldestFirst(items, app.postsById), '古い順に並べました（先頭が代表投稿）'), 'bd-link', { 'data-key': 'bd-order-old', title: '投稿日時の古い順に並べ替えます（時系列で話すとき）' }) : null,
    manual ? btn('並びを元に戻す', () => app.edit('手動順をやめる', (w) => { const po = { ...w.postOrder }; delete po[t.id]; w.postOrder = po; }, { toastText: '並びを元（表示の多い順）に戻しました' }), 'bd-link', { 'data-key': 'bd-order-reset', title: '手で並べた順をやめて、表示の多い順に戻します' }) : null));
  const list = h('div', { class: 'bd-posts', dataset: { key: 'bd-open-list' } });
  shown.forEach((id, i) => list.append(openRow(app, t, id, i)));
  const one = narrow();
  list.append(h('div', { class: `bd-zone is-posts${shown.length ? ' is-thin' : ''}`, dataset: { drop: `open#${shown.length}`, key: 'zone-open' } },
    one ? `投稿を足すには、上の「${b.step === 1 ? '投稿' : '足せる投稿'}」で「＋」` : (shown.length ? '＋ 左の投稿をここへ' : '左の投稿を「＋」かドラッグで足してください')));
  body.append(list);
  if (items.length > shown.length) body.append(btn(`残り ${items.length - shown.length}件を表示`, () => { b.itemPages += 1; app.render(); }, 'btn btn-small btn-ghost bd-more-btn', { 'data-key': 'bd-more-items' }));
  const file = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'sr-only', id: `bd-img-file-${t.id}`, dataset: { key: 'bd-img-file' } });
  file.addEventListener('change', () => { const fs = [...(file.files || [])]; file.value = ''; app.addImages(fs, t.id); });
  body.append(h('div', { class: 'bd-mini' },
    btn('プレビュー（X の表示）', () => showPreview(app, { kind: 'topic', id: t.id, item: null }), 'btn btn-small', { 'data-key': 'bd-preview' }),
    btn('URL から投稿を追加', () => { app.ui.urlDlg = { topicId: t.id, text: '' }; app.render(); }, 'btn btn-small btn-ghost', { 'data-key': 'bd-url-add', title: 'X の投稿の URL を貼って、このまとまりに足します' }),
    h('label', { class: 'btn btn-small btn-ghost', attrs: { for: `bd-img-file-${t.id}`, title: '画像を追加（ファイルを選ぶ・Ctrl+V で貼り付け）' }, dataset: { key: 'bd-img-add' } }, '画像を追加'), file,
    btn('名前を変える', () => openRename(app, t.id), 'btn btn-small btn-ghost', { 'data-key': 'bd-rename' }),
    btn('閉じる', () => toggleOpen(app, t.id), 'btn btn-small btn-ghost', { 'data-key': 'bd-close' })));
  // 台本（リード文・話すポイント）。入力中は描き直さない
  const sc = scriptFor(app, t.id);
  const auto = leadText(t, app.postsById, app.ds.refTs);
  const lead = h('textarea', { class: 'input', rows: 3, value: typeof sc.lead === 'string' && sc.lead.trim() ? sc.lead : auto, dataset: { key: 'bd-lead' } });
  lead.addEventListener('input', () => app.update((w) => { w.script[t.id] = { ...scriptFor(app, t.id), lead: lead.value === auto ? null : lead.value }; }, { render: false, debounce: true }));
  const points = h('textarea', { class: 'input', rows: 2, value: sc.points, placeholder: '話すポイント（自分用）', dataset: { key: 'bd-points' } });
  points.addEventListener('input', () => app.update((w) => { w.script[t.id] = { ...scriptFor(app, t.id), points: points.value }; }, { render: false, debounce: true }));
  const det = h('details', { class: 'bd-script', open: Boolean(app.ui.scriptOpen) },
    h('summary', { dataset: { key: 'bd-script' } }, '台本（リード文・話すポイント）'),
    field('リード文', lead, t.bot && t.bot.summary ? '（Grok のまとめ。書き換えできます）' : '（数字からの自動下書き。書き換えできます）'),
    field('話すポイント', points));
  det.addEventListener('toggle', () => { app.ui.scriptOpen = det.open; });
  body.append(det);
  return body;
}

function openRow(app, t, id, i) {
  const b = ui(app);
  const x = postText(app, id);
  const sel = b.preview && ((b.preview.kind === 'post' && b.preview.id === id) || (b.preview.kind === 'topic' && b.preview.id === t.id && b.preview.item === id));
  const row = h('div', {
    class: `bd-post is-in-open${sel ? ' is-sel' : ''}`, tabIndex: 0,
    dataset: { key: `post-${id}`, card: 'post', post: id, dropItem: 'open', dropIndex: String(i) },
    attrs: { role: 'button', 'aria-label': `${i + 1}件目${i === 0 ? '（代表）' : ''}：${x.text.slice(0, 60)}`, title: x.missing ? TEXT.missingPost : null },
  });
  const grip = h('span', { class: 'bd-grip', attrs: { 'aria-hidden': 'true', title: 'つかんで並べ替え' } }, '⋮⋮');
  const rm = h('button', { type: 'button', class: 'bd-rd bd-x', dataset: { key: `rm-${id}` }, attrs: { 'aria-label': 'このまとまりから外す', title: 'このまとまりから外す（Ctrl+Z で戻せます）' } }, '✕');
  rm.addEventListener('click', (e) => { e.stopPropagation(); app.removeItem(t, id, isImageItem(id) ? null : REMOVED_TEXT); });
  row.append(...[grip, thumbOf(app, id)].filter(Boolean),
    h('div', { class: 'bd-ptx' },
      h('div', { class: 'bd-pt' }, i === 0 ? h('span', { class: 'bd-rep', dataset: { key: 'bd-rep' } }, '代表') : null, x.text),
      h('div', { class: 'bd-pm' }, x.meta)),
    rm);
  makeDraggable(app, row, grip, { kind: 'post', id, source: 'open' });
  row.addEventListener('click', (e) => {
    if (e.target.closest('button, a') || Date.now() < b.quietUntil) return;
    showPreview(app, { kind: 'topic', id: t.id, item: id });
  });
  const menu = (px, py) => openMenu(app, postMenuItems(app, t, id), px, py, `post-${id}`);
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); menu(e.clientX, e.clientY); });
  onLongPress(app, row, menu);
  return row;
}

// ================================================================ ステップ①: 投稿からまとまりを作る（左＝投稿・右＝まとまり）

function postCtx(app) {
  return {
    weekPosts: app.weekPosts || [], postTopic: app.postTopic, topicsById: app.topicsById,
    visibleIds: new Set(app.visibleTopics.map((t) => t.id)), recommended: app.recommended,
    bookmarkIds: new Set((app.bookmarkPosts || []).map((p) => p.id)), newPosts: app.newInfo ? app.newInfo.posts : new Set(),
    openId: ui(app).open1,
  };
}

/** 左: 投稿の一覧（表示の多い順。チェックしてまとめて動かせる） */
function postsCol(app, wk, hidden) {
  const b = ui(app);
  const open = openTopic(app);
  const col = h('section', { class: `bd-col bd-left bd-posts-col${hidden ? ' is-hidden' : ''}`, attrs: { 'aria-label': '投稿' }, dataset: { keep: 'posts', drop: 'material' } });
  const filter = h('select', { class: 'input input-sm bd-filter', dataset: { key: 'bd-filter' }, attrs: { 'aria-label': '出す投稿', title: 'まだどのまとまりにも入っていない投稿だけ出すか、すべての投稿を出すか' } },
    h('option', { value: 'free', selected: b.filter !== 'all' }, 'まだ入っていないものだけ'),
    h('option', { value: 'all', selected: b.filter === 'all' }, 'すべての投稿'));
  filter.addEventListener('change', () => { b.filter = filter.value === 'all' ? 'all' : 'free'; b.pages1 = 1; b.scroll1.left = 0; app.render(); });
  col.append(h('div', { class: 'bd-head' }, h('h3', { class: 'bd-h' }, '投稿', h('small', { dataset: { key: 'bd-left-sub' } }, '表示の多い順')), filter));
  col.append(searchBox(app));
  col.append(chipsRow(app, false));
  const ctx = postCtx(app);
  const list = postList(ctx, { chip: sanitizeChip(b.chip1, postChips(app)), query: b.query1, filter: b.filter, limit: b.pages1 * BOARD.pageSize });
  // 一覧から消えた行のチェックは外す
  const listed = new Set(list.ids);
  b.sel = new Set([...b.sel].filter((id) => listed.has(id)));
  if (b.anchor && !listed.has(b.anchor)) b.anchor = null;
  const scroll = h('div', { class: 'bd-scroll', dataset: { keep: 'lscroll1', key: 'bd-lscroll', dndScroll: '', total: String(list.total) } });
  const q = b.query1.trim();
  scroll.append(h('p', { class: 'bd-note', dataset: { key: 'bd-post-note' } },
    q ? `「${q}」：${list.total}件` : open ? `「＋」かドラッグで、開いたまとまりに足せます（${list.total}件）` : `右のまとまりへドラッグ・チェックでまとめて（${list.total}件）`));
  const env = { open, ids: list.ids, stars: ctx.bookmarkIds };
  for (const it of list.items) scroll.append(postRow(app, it, env));
  if (!list.items.length) scroll.append(h('p', { class: 'empty bd-empty' }, q ? '見つかりませんでした' : b.filter === 'all' ? 'ここに出す投稿はありません' : 'まだ入っていない投稿はありません'));
  if (list.more) scroll.append(btn(`もっと見る（あと ${list.more}件）`, () => { b.pages1 += 1; app.render(); }, 'btn btn-small btn-ghost bd-more-btn', { 'data-key': 'bd-more-list' }));
  col.append(scroll);
  // チェックした投稿の操作（一覧の下にいつも見える）
  const picked = list.ids.filter((id) => b.sel.has(id));
  if (picked.length) {
    col.append(h('div', { class: 'bd-selbar', dataset: { key: 'bd-selbar' }, attrs: { role: 'group', 'aria-label': '選んだ投稿' } },
      h('span', { class: 'bd-selbar-n', dataset: { key: 'bd-sel-count' } }, `${picked.length}件を選択中`),
      btn('まとまりにする', () => askGroup(app, picked), 'btn btn-small btn-red', { 'data-key': 'bd-make-group', title: '選んだ投稿で新しいまとまりを作ります（名前を付けられます）' }),
      btn('解除', () => { b.sel = new Set(); b.anchor = null; app.render(); }, 'btn btn-small bd-selbar-clear', { 'data-key': 'bd-sel-clear', title: 'チェックをすべて外します（Esc）' })));
  }
  // 開いたまとまりから持ってきたときの案内（ドラッグ中だけ出る）
  col.append(h('div', { class: 'bd-drop-note', attrs: { 'aria-hidden': 'true' } }, h('span', {}, 'ここで離すとこのまとまりから外します')));
  return col;
}

function postRow(app, it, env) {
  const b = ui(app);
  const { id } = it;
  const x = postText(app, id);
  const checked = b.sel.has(id);
  const group = it.group ? app.topicsById.get(it.group) : null;
  const sel = b.preview && b.preview.kind === 'post' && b.preview.id === id;
  const row = h('div', {
    class: `bd-post is-list${it.inOpen ? ' is-in' : ''}${checked ? ' is-checked' : ''}${sel ? ' is-sel' : ''}`, tabIndex: 0,
    dataset: { key: `lp-${id}`, card: 'lpost', post: id },
    attrs: { role: 'button', 'aria-label': `${x.text.slice(0, 60)}${it.inOpen ? '（入っています）' : group ? `（「${group.name}」に入っています）` : ''}` },
  });
  // チェック（Shift を押しながらで、前に押した行との間をまとめて）。まわりの余白も押せる
  const cb = h('input', { type: 'checkbox', class: 'bd-chk-in', checked, disabled: it.inOpen, dataset: { key: `chk-${id}` }, attrs: { 'aria-label': 'この投稿を選ぶ（Shift を押しながらで、前に選んだ行との間をまとめて）' } });
  const chk = h('label', { class: `bd-chk${it.inOpen ? ' is-off' : ''}` }, cb);
  chk.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (it.inOpen) return;
    const r = toggleSelect(b.sel, b.anchor, env.ids, id, e.shiftKey);
    b.sel = r.sel;
    b.anchor = r.anchor;
    b.focusKey = `chk-${id}`;
    app.render();
  });
  const grip = h('span', { class: `bd-grip${it.inOpen ? ' is-off' : ''}`, attrs: { 'aria-hidden': 'true', title: 'つかんで右のまとまりへ' } }, '⋮⋮');
  row.append(...[chk, grip, thumbOf(app, id)].filter(Boolean),
    h('div', { class: 'bd-ptx' },
      h('div', { class: 'bd-pt' }, env.stars.has(id) ? h('span', { class: 'bd-star', attrs: { title: 'ブックマークした投稿' } }, '★') : null, x.text),
      h('div', { class: 'bd-pm' }, x.meta, it.inOpen ? '・入っています' : null,
        group && !it.inOpen ? h('span', { class: 'bd-from', dataset: { key: `in-${id}` }, attrs: { title: `いまは「${group.name}」に入っています。ほかのまとまりへ置くと移ります` } }, `▸ ${group.name}に入っています`) : null)));
  if (!it.inOpen) {
    if (env.open) {
      const add = h('button', { type: 'button', class: 'bd-rd bd-add', dataset: { key: `addp-${id}` }, attrs: { 'aria-label': `「${env.open.name}」に足す`, title: `開いている「${env.open.name}」の最後に足す${group ? `（「${group.name}」から移ります）` : ''}` } }, '＋');
      add.addEventListener('click', (e) => { e.stopPropagation(); addPost(app, env.open.id, id, null); });
      row.append(add);
    }
    makeDraggable(app, row, grip, { kind: 'post', id, ids: dragIds(b.sel, env.ids, id), source: 'list' });
  }
  row.addEventListener('click', (e) => {
    if (e.target.closest('button, a, input, label') || Date.now() < b.quietUntil) return;
    showPreview(app, { kind: 'post', id, addable: !it.inOpen });
  });
  return row;
}

/** 右: まとまりの一覧（「＋ 新しいまとまり」→ 作ったもの → 自動のもの） */
function groupsCol(app, wk) {
  const b = ui(app);
  const col = h('section', { class: 'bd-col bd-right bd-groups', attrs: { 'aria-label': 'まとまり' }, dataset: { keep: 'groups' } });
  col.append(h('div', { class: 'bd-head' },
    h('h3', { class: 'bd-h' }, 'まとまり', h('small', {}, '押すと中の投稿を開く')),
    btn('② 番組に並べる →', () => setStep(app, 2), 'btn btn-small btn-ghost bd-back', { 'data-key': 'bd-go-2', title: 'できたまとまりを、番組の流れ（メイン・カテゴリ別・雑談）に並べます' })));
  const list = groupList({ week: wk, topics: app.visibleTopics }, { limit: b.gpages * BOARD.pageSize });
  const scroll = h('div', { class: 'bd-scroll', dataset: { keep: 'rscroll1', key: 'bd-rscroll', dndScroll: '', total: String(list.total) } });
  // 新しいまとまり: 投稿をここへドラッグ（押すと、選んだ投稿から／空のまとまりを作る）
  const n = b.sel.size;
  const zone = h('div', {
    class: 'bd-zone is-new', tabIndex: 0, dataset: { drop: 'newgroup', key: 'zone-new', card: 'newzone' },
    attrs: { role: 'button', title: n ? `選んだ ${n}件で新しいまとまりを作ります` : '投稿をここへドラッグすると新しいまとまりになります。押すと空のまとまりを作れます' },
  }, n ? `＋ 新しいまとまり（選んだ ${n}件で作る）` : narrow() ? '＋ 新しいまとまり（押すと空のまとまりを作ります）' : '＋ 新しいまとまり（ここに投稿をドラッグ）');
  zone.addEventListener('click', () => {
    if (Date.now() < b.quietUntil) return;
    if (b.sel.size) askGroup(app, [...b.sel]);
    else { app.ui.nameDlg = { mode: 'new', name: '', genre: 'night' }; app.render(); }
  });
  scroll.append(zone);
  const box = h('div', { class: 'bd-list' });
  const items = [...list.items];
  // 開いているまとまりがページの外へ出たときも見えるように
  if (b.open1 && !items.some((x) => x.id === b.open1) && app.topicsById.has(b.open1)) items.push({ id: b.open1, made: app.topicsById.get(b.open1).kind === 'manual', place: placeOf(wk, b.open1) });
  for (const it of items) {
    const t = app.topicsById.get(it.id);
    if (t) box.append(groupCard(app, wk, t, it));
  }
  scroll.append(box);
  if (!list.total) scroll.append(h('p', { class: 'empty bd-empty', dataset: { key: 'bd-groups-empty' } }, 'まとまりはまだありません。投稿を右へドラッグして作ります'));
  if (list.more) scroll.append(btn(`もっと見る（あと ${list.more}件）`, () => { b.gpages += 1; app.render(); }, 'btn btn-small btn-ghost bd-more-btn', { 'data-key': 'bd-more-groups' }));
  col.append(scroll);
  return col;
}

/** ①のまとまりのカード（投稿を置くと足せる。押すとその場で開く。番組に入っていても薄くしない） */
function groupCard(app, wk, t, it) {
  const b = ui(app);
  const open = b.open1 === t.id;
  const flash = b.flash && b.flash.id === t.id && Date.now() - b.flash.at < 1600;
  const card = h('div', {
    class: `bd-card is-group${open ? ' is-open-head' : ''}${flash && !open ? ' is-flash' : ''}`, tabIndex: 0,
    dataset: { key: `grp-${t.id}`, card: 'group', topic: t.id },
    attrs: { role: 'button', 'aria-expanded': String(open), 'aria-label': `${t.name}（${metaText(t)}）。${it.made ? '自分で作ったまとまり' : '自動のまとまり'}${it.place ? `。番組の${it.place.label}に入っています` : ''}。押すと${open ? '閉じます' : '中の投稿を開きます'}` },
  });
  card.append(h('span', { class: `bd-stripe g-${t.genre}` }),
    h('div', { class: 'bd-tx' },
      h('div', { class: 'bd-ttl' }, h('span', { class: 'bd-name' }, t.name),
        h('span', { class: `bd-kind${it.made ? ' is-made' : ''}`, dataset: { key: `kind-${t.id}` }, attrs: { title: it.made ? '自分で作ったまとまり' : '自動でまとまったもの（同じ話題の投稿）' } }, it.made ? '作った' : '自動'),
        it.place ? h('span', { class: 'bd-place', dataset: { key: `place-${t.id}` }, attrs: { title: `番組の「${it.place.label}」に入っています` } }, it.place.label) : null,
        ...cardMarks(app, t)),
      h('div', { class: 'bd-meta', dataset: { key: `gmeta-${t.id}` } }, metaText(t))),
    h('span', { class: 'bd-chev', attrs: { 'aria-hidden': 'true' } }));
  const outer = open ? h('div', { class: `bd-open${flash ? ' is-flash' : ''}`, dataset: { key: 'bd-open' } }) : card;
  outer.dataset.drop = `topic:${t.id}`;
  outer.dataset.flowId = t.id;
  card.addEventListener('click', (e) => {
    if (e.target.closest('button, a') || Date.now() < b.quietUntil) return;
    toggleOpen(app, t.id);
  });
  const menu = (px, py) => openMenu(app, groupMenuItems(app, t), px, py, `grp-${t.id}`);
  card.addEventListener('contextmenu', (e) => { e.preventDefault(); menu(e.clientX, e.clientY); });
  onLongPress(app, card, menu);
  if (!open) return card;
  outer.append(card, openBody(app, wk, t));
  return outer;
}

// ---------------------------------------------------------------- プレビュー（1400px 以上は 3 列目、それより狭いと左の列の上に出る）

function previewCol(app, wk, isWide) {
  const b = ui(app);
  const pv = b.preview;
  const pane = h('section', { class: 'bd-col bd-preview', attrs: { 'aria-label': 'プレビュー' }, dataset: { keep: 'preview' } });
  pane.append(h('div', { class: 'bd-head' },
    h('h3', { class: 'bd-h' }, 'プレビュー', h('small', {}, 'X の表示')),
    pv ? btn(isWide ? '閉じる' : '← 閉じる', () => { b.preview = null; app.render(); }, 'btn btn-small btn-ghost bd-back', { 'data-key': 'bd-preview-close' }) : null));
  const scroll = h('div', { class: 'bd-scroll bd-pv-scroll', dataset: { keep: 'pscroll' } });
  if (!pv) {
    const help = b.step === 1
      ? ['ドラッグ：左の投稿を右のまとまりへ（「＋ 新しいまとまり」へ置くと新しく作る）', 'チェック：何件か選んで「まとまりにする」（チェックした行をつかむと、まとめて動く）', '右のカードを押す：その場で開いて、投稿を並べ替え・追加・外す', 'できたら上の「② まとまりを番組に並べる」へ', '元に戻す：Ctrl+Z ／ やり直す：Ctrl+Shift+Z']
      : ['ドラッグ：左のカードを右へ入れる・右の中で並べ替える・左へ戻すと外れる', '「＋」：押して入れ先を選ぶ（ドラッグなしでも入れられます）', '右のカードを押す：その場で開いて、投稿を並べ替え・追加', '元に戻す：Ctrl+Z ／ やり直す：Ctrl+Shift+Z'];
    scroll.append(h('div', { class: 'pv-empty', dataset: { key: 'bd-pv-empty' } }, h('p', {}, b.step === 1 ? '投稿やカードを押すと、ここに中身（X の表示）が出ます。' : 'カードを押すと、ここに中身（X の表示）が出ます。'),
      h('ul', { class: 'pv-help' }, help.map((x) => h('li', {}, x)))));
  } else if (pv.kind === 'topic') scroll.append(topicPreview(app, wk, pv));
  else scroll.append(postPreview(app, pv));
  pane.append(scroll);
  return pane;
}

function embedBox(app, id) {
  if (isImageItem(id)) {
    const imgId = id.slice(4);
    const m = (app.weekState().images || []).find((x) => x.id === imgId) || {};
    const d = app.imageData(imgId);
    if (!d) app.loadImage(imgId).catch(() => {});
    return h('div', { class: 'pv-post', dataset: { keep: `pp:${id}${d ? ':ok' : ''}` } }, d ? h('img', { class: 'li-img', src: d.url, alt: m.caption || '追加した画像' }) : h('p', { class: 'muted' }, '画像を読み込み中…'), m.caption ? h('p', { class: 'muted' }, m.caption) : null);
  }
  const p = app.postsById.get(id);
  const own = p ? postCard(p, { refTs: app.ds.refTs, refYear: refYear(app), embedder: null, noActions: true, bm: bmInfo(app, p.id) }) : metaCard(id, app.linkMetaOf(id), statusUrl(id), null);
  return h('div', { class: 'pv-post', dataset: { keep: `pp:${id}` } }, app.ui.view !== 'card' ? embedHost(id, own, 'pv-embed') : own);
}

function topicPreview(app, wk, pv) {
  const b = ui(app);
  const t = app.topicsById.get(pv.id);
  const box = h('div', { class: 'pv-body', dataset: { keep: `pvb:t:${pv.id}` } });
  if (!t) { box.append(h('p', {}, 'まとまりが見つかりません')); return box; }
  const at = placeOf(wk, t.id);
  const items = app.itemsFor(t);
  const cur = pv.item && items.includes(pv.item) ? pv.item : items[0] || null;
  box.append(h('div', { class: `pv-head g-${t.genre}` }, genreSticker(t.genre, { small: true }),
    h('b', { class: 'pv-title', dataset: { key: 'bd-pv-title' } }, t.name),
    h('span', { class: 'tcard-marks' }, topicMarks(app, t)),
    at ? h('span', { class: 'badge badge-carry' }, at.label) : null));
  box.append(h('p', { class: 'stats' }, statsLine(t)));
  const add = h('button', { type: 'button', class: 'btn btn-small btn-red', dataset: { key: 'bd-pv-add' }, attrs: { 'aria-haspopup': 'menu' } }, '＋ 番組に入れる');
  add.addEventListener('click', () => { const r = add.getBoundingClientRect(); openMenu(app, addMenuItems(app, t), r.left, r.bottom + 4, 'bd-pv-add'); });
  box.append(h('div', { class: 'row' },
    at ? btn('番組の流れで見る', () => { b.preview = wide() ? b.preview : null; goToPlaced(app, t.id); }, 'btn btn-small', { 'data-key': 'bd-pv-goto' }) : add,
    btn('名前を変える', () => openRename(app, t.id), 'btn btn-small btn-ghost', { 'data-key': 'bd-pv-rename' })));
  if (items.length > 1) {
    const i = items.indexOf(cur);
    const step = (d) => { const id = items[i + d]; if (id) { b.preview = { ...pv, item: id }; app.render(); } };
    box.append(h('div', { class: 'row bd-pv-nav' },
      btn('前へ', () => step(-1), 'btn btn-small btn-ghost', { 'data-key': 'bd-pv-prev', disabled: i <= 0 }),
      h('span', { class: 'muted', dataset: { key: 'bd-pv-pos' } }, `${i + 1} / ${items.length}${i === 0 ? '（代表）' : ''}`),
      btn('次へ', () => step(1), 'btn btn-small btn-ghost', { 'data-key': 'bd-pv-next', disabled: i >= items.length - 1 })));
  }
  if (cur) box.append(embedBox(app, cur));
  else box.append(h('p', { class: 'muted' }, 'まだ投稿がありません。'));
  return box;
}

function postPreview(app, pv) {
  const t = openTopic(app);
  const p = app.postsById.get(pv.id);
  const box = h('div', { class: 'pv-body', dataset: { keep: `pvb:p:${pv.id}` } });
  const inTopic = t ? app.itemsFor(t).includes(pv.id) : false;
  box.append(h('div', { class: 'row' },
    t && !inTopic ? btn(`＋「${t.name}」に足す`, () => { addPost(app, t.id, pv.id, null); }, 'btn btn-small btn-red', { 'data-key': 'bd-pv-addpost' }) : null,
    t && inTopic ? h('span', { class: 'badge badge-carry' }, `「${t.name}」に入っています`) : null,
    h('a', { href: statusUrl(pv.id), target: '_blank', rel: 'noopener noreferrer', class: 'btn btn-small btn-ghost' }, 'X で開く')));
  if (p || !isImageItem(pv.id)) box.append(embedBox(app, pv.id));
  return box;
}

// ================================================================ キー操作

/** かんたん編成のキー（Ctrl+Z／Ctrl+Shift+Z・Enter で開く・Alt+↑↓ で動かす・Delete で外す・F2 で名前・Esc でチェックを外す）。処理したら true */
export function boardKeydown(app, e) {
  const b = ui(app);
  const mod = e.ctrlKey || e.metaKey;
  const typing = isEditable(e.target);
  if (mod && !typing && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) app.redo(); else app.undo(); return true; }
  if (mod && !typing && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); app.redo(); return true; }
  if (document.querySelector('#view dialog[open]')) return false;
  if (app.ui.menu) { if (e.key === 'Escape') { closeMenu(app); return true; } return false; }
  if (typing) return false;
  if (e.key === 'Escape' && !isDragging()) {
    if (b.preview && !wide()) { b.preview = null; app.render(); return true; }
    if (b.step === 1 && b.sel.size) { b.sel = new Set(); b.anchor = null; app.render(); return true; }
    return false;
  }
  const card = e.target && e.target.closest ? e.target.closest('[data-card]') : null;
  if (!card) return false;
  const kind = card.dataset.card;
  const wk = app.weekState();
  const menuAt = (items, key) => { const r = card.getBoundingClientRect(); openMenu(app, items, r.left + 40, r.bottom - 6, key); };
  if ((e.key === 'Enter' || e.key === ' ') && e.target === card) { e.preventDefault(); card.click(); return true; }
  if (kind === 'material' || kind === 'flow' || kind === 'group') {
    const id = card.dataset.topic;
    const t = app.topicsById.get(id);
    if (!t) return false;
    if (e.key === 'F2') { e.preventDefault(); openRename(app, id); return true; }
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); menuAt(kind === 'group' ? groupMenuItems(app, t) : topicMenuItems(app, t), card.dataset.key); return true; }
    if (kind === 'flow') {
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        const target = stepTarget(wk, id, e.key === 'ArrowDown' ? 1 : -1);
        if (target) placeTopic(app, id, target);
        return true;
      }
      if (e.key === 'Delete') { e.preventDefault(); unplace(app, id); return true; }
    }
    return false;
  }
  if (kind === 'post') {
    const t = openTopic(app);
    const id = card.dataset.post;
    if (!t) return false;
    const items = app.itemsFor(t);
    const i = items.indexOf(id);
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const j = i + (e.key === 'ArrowDown' ? 1 : -1);
      if (i >= 0 && j >= 0 && j < items.length) setOrder(app, t.id, moveItemTo(items, id, j), '投稿を並べ替えました（先頭が代表投稿）');
      return true;
    }
    if (e.key === 'Delete') { e.preventDefault(); app.removeItem(t, id, isImageItem(id) ? null : REMOVED_TEXT); return true; }
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); menuAt(postMenuItems(app, t, id), card.dataset.key); return true; }
  }
  return false;
}

/** メニューの外を押したら閉じる */
export function boardPointerDown(app, e) {
  if (app.ui.menu && !e.target.closest('.ctx-menu')) { app.ui.menu = null; app.render(); }
}

/** 貼り付けた画像を入れる話題（開いている話題） */
export function boardPasteTopic(app) {
  const t = openTopic(app);
  return t ? t.id : null;
}
