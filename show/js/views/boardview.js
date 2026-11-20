// ① 編成（準備）— かんたん編成（#plan）。左＝素材（今週の話題）、右＝番組の流れ（メイン・メイン候補・カテゴリ別・雑談）。
// カードをドラッグして入れる・並べ替える・左へ戻して外す。「＋」で入れ先を選ぶ。右のカードを押すとその場で開き、投稿を並べ替え・追加できる。
// 画面半分（960px）で 2 列、1400px 以上は右にプレビューの列、760px 以下は 1 列（素材／番組の切り替え）。
// くわしい整理（片付け・ゴミ箱・保留・仕分けなど）は従来のフォルダの画面（#plan-folders）で。保存データは同じ。
// 置いた結果は board.js の resolveDrop → folders.js の applyDrop など（フォルダの画面と同じ関数）で作る。文字はすべて textContent。
import { formatCompact, formatDateTime } from '../../../assets/js/core.js';
import { sizedImageUrl } from '../../../assets/js/media.js';
import { BOARD, CHECKPOINTS, GENRES, NIGHT_GENRES, TEXT } from '../config.js';
import { autoTitle, recordCheckpoint, statusUrl, leadText, isImageItem, assignTopic, setMainSlot, removeTopic, cornerDef, genreLabel, moveItemTo } from '../logic.js';
import { applyDrop, createEmptyGroup, renameTopic, addPostsToTopic, placeOf } from '../folders.js';
import {
  boardChips, sanitizeChip, genreShort, materialList, flowSections, flowMinutes, formatHm, resolveDrop, stepTarget, addTargets,
  autoDraftPlan, draftSummary, addablePosts, oldestFirst,
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
      chip: typeof pref.chip === 'string' ? pref.chip : 'rec', query: '', pages: 1,
      open: null, left: 'material', addQuery: '', addChip: 'all', addPages: 1, itemPages: 1,
      tab: 'material', preview: null, flash: null, scroll: { left: 0, right: 0 }, scrollTo: null, focusKey: null, quietUntil: 0,
    };
  }
  return u.board;
}

function savePref(b) {
  try { localStorage.setItem(BOARD.prefKey, JSON.stringify({ chip: b.chip })); } catch { /* 保存できなくても動く */ }
}

const topicRow = (id) => ({ key: `t:${id}`, type: 'topic', id });
const nameOf = (app, id) => (app.topicsById.get(id) || {}).name || '話題';
const applyCtx = (app) => ({ topicsById: app.topicsById, postTopic: app.postTopic, postsById: app.postsById, weekKey: app.weekKey, now: Date.now() });

function openTopic(app) {
  const b = ui(app);
  return b.open ? app.topicsById.get(b.open) || null : null;
}
const isAddMode = (app) => Boolean(openTopic(app)) && ui(app).left === 'addable';

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
    { toastText: `「${nameOf(app, topicId)}」を番組から外しました（素材に戻りました）` });
}

/** 片付ける・削除（フォルダの画面の「片付け」「ゴミ箱」から戻せる） */
function putAway(app, topicId, where) {
  const b = ui(app);
  const name = nameOf(app, topicId);
  if (b.open === topicId) { b.open = null; b.left = 'material'; }
  if (b.preview && b.preview.kind === 'topic' && b.preview.id === topicId) b.preview = null;
  app.edit(where === 'trash' ? `削除「${name}」` : `片付け「${name}」`, (w, s) => { applyDrop(w, s, [topicRow(topicId)], where, applyCtx(app)); },
    { toastText: where === 'trash' ? `「${name}」を削除しました（「フォルダで整理」のゴミ箱から戻せます）` : `「${name}」を片付けました（この週の素材から外しました。「フォルダで整理」の片付けから戻せます）` });
}

function setTopicGenre(app, topicId, genre) {
  app.edit(`ジャンル変更：${genreLabel(genre)}`, (w) => { w.overrides.genres[topicId] = genre; }, { toastText: `「${nameOf(app, topicId)}」のジャンルを「${genreLabel(genre)}」にしました` });
}

/** 開いた話題の並びを決める（先頭が代表投稿） */
function setOrder(app, topicId, order, text) {
  app.edit('投稿の並べ替え', (w) => { w.postOrder = { ...w.postOrder, [topicId]: [...order] }; }, { toastText: text });
}

/** 投稿を話題に足す（index の位置へ。ほかの話題にある投稿は移す） */
function addPost(app, topicId, postId, index = null) {
  const t = app.topicsById.get(topicId);
  if (!t) return;
  const items = app.itemsFor(t);
  if (items.includes(postId)) { app.toast('もうこの話題に入っています'); return; }
  const from = app.postTopic.get(postId);
  const ft = from && from !== t.id ? app.topicsById.get(from) : null;
  let result = null;
  app.edit(`投稿を足す「${t.name}」`, (w) => {
    result = addPostsToTopic(w, t, [postId], { postsById: app.basePostsById, postTopic: app.postTopic, topicsById: app.topicsById, inRange: new Set(app.weekPosts.map((p) => p.id)), move: true, now: Date.now() });
    if (!result.added.length && !result.missing.length) return;
    const at = index == null ? items.length : Math.max(0, Math.min(items.length, index));
    w.postOrder = { ...w.postOrder, [t.id]: [...items.slice(0, at), postId, ...items.slice(at)] };
    // 1 件だけの話題として番組に入っていた投稿を移したら、その空になった話題は番組から外す
    if (ft && ft.postIds.length <= 1 && !(ft.missingIds || []).length) { w.rundown = removeTopic(w.rundown, ft.id); w.mainCand = (w.mainCand || []).filter((x) => x !== ft.id); }
  }, { render: false });
  if (!result || (!result.added.length && !result.missing.length)) {
    app.history = { ...app.history, past: app.history.past.slice(0, -1) };
    app.toast('足せませんでした');
  } else app.toast(`「${t.name}」に足しました${result.moved.length && ft ? `（「${ft.name}」から移しました）` : ''}`, () => app.undo());
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
  else if (a.type === 'removePost') { const t = app.topicsById.get(a.topicId); if (t) app.removeItem(t, a.itemId, isImageItem(a.itemId) ? null : '話題から外しました（素材に戻りました）'); }
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

/** 右クリック・長押し・メニューキー: 話題のカード */
function topicMenuItems(app, t) {
  const b = ui(app);
  const placed = placeOf(app.weekState(), t.id);
  const items = [];
  if (placed) {
    items.push({ label: b.open === t.id ? '閉じる' : '開く（中の投稿を見る）', key: 'bd-ctx-open', run: () => toggleOpen(app, t.id) });
    items.push({ label: '番組から外す（素材に戻す）', key: 'bd-ctx-unplace', hint: 'Del', run: () => unplace(app, t.id) });
  }
  items.push({ label: 'プレビュー（X の表示）', key: 'bd-ctx-preview', run: () => showPreview(app, { kind: 'topic', id: t.id, item: null }) });
  items.push(...addMenuItems(app, t).map((x) => (x.heading ? { heading: placed ? '入れる所を変える' : '番組に入れる' } : { ...x, key: x.key.replace('bd-to-', 'bd-ctx-to-') })));
  items.push({ sep: true });
  items.push({ label: '名前を変える', key: 'bd-ctx-rename', hint: 'F2', run: () => openRename(app, t.id) });
  items.push({ heading: 'ジャンル' });
  for (const g of GENRES) items.push({ label: g.label, key: `bd-ctx-genre-${g.key}`, disabled: g.key === t.genre, run: () => setTopicGenre(app, t.id, g.key) });
  items.push({ sep: true });
  items.push({ label: '片付ける（この週は使わない）', key: 'bd-ctx-shelf', run: () => putAway(app, t.id, 'shelf') });
  items.push({ label: '削除（ゴミ箱へ）', key: 'bd-ctx-trash', danger: true, run: () => putAway(app, t.id, 'trash') });
  return items;
}

/** 開いた話題の中の 1 件 */
function postMenuItems(app, t, id) {
  const items = app.itemsFor(t);
  const i = items.indexOf(id);
  const out = [
    { label: '先頭へ（代表にする）', key: 'bd-ctx-top', disabled: i === 0, run: () => setOrder(app, t.id, moveItemTo(items, id, 0), '先頭（代表投稿）にしました') },
    { label: '末尾へ', key: 'bd-ctx-bottom', disabled: i === items.length - 1, run: () => setOrder(app, t.id, moveItemTo(items, id, items.length), '末尾へ移しました') },
    { label: 'この話題から外す', key: 'bd-ctx-remove-post', hint: 'Del', run: () => app.removeItem(t, id, isImageItem(id) ? null : '話題から外しました（素材に戻りました）') },
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
      title: '話題の名前を変える', okLabel: '変える', name: d.name, onClose: close,
      onOk: (name) => { u.nameDlg = null; if (t) app.edit(`名前の変更「${name}」`, (w) => renameTopic(w, t, name), { toastText: '名前を変えました' }); else app.render(); },
    });
  }
  return nameDialog({
    title: '新しい話題を作る', okLabel: '作る', name: d.name || '', genre: d.genre || 'night', genres: GENRES, onClose: close,
    onOk: (name, g) => {
      u.nameDlg = null;
      const label = String(name || '').trim() || '新しい話題';
      const ck = NIGHT_GENRES.includes(g) ? 'category' : 'chat';
      let id = null;
      app.edit('新しい話題', (w) => { id = createEmptyGroup(w, label, g, Date.now()); w.rundown = assignTopic(w.rundown, id, ck) || w.rundown; }, { render: false });
      if (id && app.topicsById.has(id)) { b.open = id; b.left = 'addable'; b.addQuery = ''; b.addChip = 'all'; b.addPages = 1; b.itemPages = 1; b.tab = 'flow'; b.flash = { id, at: Date.now() }; b.scrollTo = id; }
      app.toast(`話題「${label}」を作って「${cornerDef(ck).name}」に入れました。左の投稿を「＋」かドラッグで足してください`, () => app.undo());
      app.render();
    },
  });
}

// ================================================================ 描画

export function renderBoard(app) {
  const b = ui(app);
  const wk = app.weekState();
  // 開いている話題・プレビューが無くなっていたら閉じる（元に戻す・データの更新など）
  if (b.open && !(app.topicsById.has(b.open) && placeOf(wk, b.open))) { b.open = null; b.left = 'material'; }
  if (b.preview && b.preview.kind === 'topic' && !app.topicsById.has(b.preview.id)) b.preview = null;
  const isWide = wide();
  const isNarrow = narrow();
  const panel = !isWide && Boolean(b.preview);
  const root = h('div', { class: `bd${isWide ? ' is-wide' : ''}${isNarrow ? ' is-narrow' : ''}${panel ? ' is-panel' : ''}`, dataset: { keep: `plan:${app.weekKey}`, tab: b.tab } });
  root.append(topBar(app, wk));
  if (isNarrow) root.append(tabSwitch(app));
  const cols = h('div', { class: 'bd-cols', dataset: { keep: 'cols' } });
  cols.append(leftCol(app, wk, panel), rightCol(app, wk));
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
    const want = add ? b.addQuery : b.query;
    if (input.value !== want && document.activeElement !== input) input.value = want;
    input.placeholder = add ? '投稿を検索（本文・@アカウント）' : '検索（話題名・本文・@アカウント）';
  }
  // 列ごとのスクロール位置を保つ
  for (const [key, side] of [['bd-lscroll', 'left'], ['bd-rscroll', 'right']]) {
    const el = document.querySelector(`#view [data-key="${key}"]`);
    if (!el) continue;
    if (!el.__bdBound) { el.__bdBound = true; el.addEventListener('scroll', () => { ui(app).scroll[side] = el.scrollTop; }, { passive: true }); }
    if (Math.abs(el.scrollTop - b.scroll[side]) > 1) el.scrollTop = b.scroll[side];
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
  const titleInput = h('input', { class: 'input input-sm input-title', type: 'text', value: currentTitle(app), maxLength: 200, dataset: { key: 'title' }, attrs: { autocomplete: 'off', 'aria-label': '配信タイトル', title: isAuto ? '配信タイトル（メインの話題から自動で作っています。書き換えできます）' : '配信タイトル' } });
  titleInput.addEventListener('input', () => app.update((w) => { w.title = titleInput.value === auto ? null : titleInput.value; }, { render: false, debounce: true }));
  titleInput.addEventListener('change', () => app.render());
  const last = wk.checkpoints[wk.checkpoints.length - 1];
  const cpLabel = last ? `前回のチェック：${CHECKPOINTS.find((c) => c.kind === last.kind)?.label || ''} ${last.recordedAt ? formatDateTime(null, Math.floor(last.recordedAt / 1000)) : ''}（その後の新しい投稿 ${app.newInfo ? app.newInfo.posts.size : 0}件）` : 'チェックを記録すると、それ以降に増えた話題に NEW が付きます';
  const closeMore = (fn) => (e) => { const d = e.currentTarget.closest('details'); if (d) d.open = false; fn(); };
  const more = h('details', { class: 'menu menu-more bd-more' },
    h('summary', { class: 'btn btn-small', dataset: { key: 'bd-more' }, attrs: { 'aria-label': 'そのほかの操作', title: '新しい話題・チェックの記録・ツール・フォルダで整理' } }, '…'),
    h('div', { class: 'menu-list' },
      h('button', { type: 'button', class: 'menu-item', dataset: { key: 'bd-new-topic' }, on: { click: closeMore(() => { u.nameDlg = { mode: 'new', name: '', genre: 'night' }; app.render(); }) } }, '＋ 新しい話題を作る'),
      CHECKPOINTS.map((cp) => h('button', {
        type: 'button', class: 'menu-item', dataset: { key: `cp-${cp.kind}` },
        on: { click: closeMore(() => app.edit(`チェックポイント（${cp.label}）`, (w) => { Object.assign(w, recordCheckpoint(w, cp.kind, app.ds.generated_at, app.weekPostIds, app.topics.map((t) => t.id), Date.now())); }, { toastText: `${cp.label}のチェックを記録しました（これ以降に増えた話題に NEW が付きます）` })) },
      }, `チェックを記録：${cp.label}（${cp.when}）`)),
      h('p', { class: 'menu-note' }, cpLabel),
      h('button', { type: 'button', class: 'menu-item', dataset: { key: 'tools-open' }, on: { click: closeMore(() => { u.tools = true; app.render(); }) } }, 'ツール…（番組名・書き出し・ボットへの修正 など）'),
      h('a', { class: 'menu-item', href: '#plan-folders', dataset: { key: 'bd-folders' } }, 'フォルダで整理（くわしい画面）')));
  return h('header', { class: 'bd-top' },
    h('label', { class: 'bd-titlebox' }, h('span', { class: 'sr-only' }, '配信タイトル'), titleInput),
    isAuto ? null : btn('自動に戻す', () => app.update((w) => { w.title = null; }), 'btn btn-small btn-ghost', { 'data-key': 'title-auto', title: 'タイトルをメインの話題から自動で作る形に戻します' }),
    btn('おまかせで下書き', () => autoDraft(app), 'btn btn-small btn-red', { 'data-key': 'bd-draft', title: '空いている所（メインの空き枠・空のカテゴリ別・空の雑談）だけ、おすすめの話題で埋めます。入っているものは動かしません' }),
    btn('↶ 元に戻す', () => app.undo(), 'btn btn-small', { 'data-key': 'undo', disabled: !app.history.past.length }),
    btn('↷ やり直す', () => app.redo(), 'btn btn-small bd-redo', { 'data-key': 'redo', disabled: !app.history.future.length }),
    more);
}

/** 760px 以下: 素材／番組の切り替え */
function tabSwitch(app) {
  const b = ui(app);
  const wk = app.weekState();
  const n = flowSections(wk).reduce((s, x) => s + x.ids.filter(Boolean).length, 0);
  const one = (key, label) => btn(label, () => { b.tab = key; b.preview = null; app.render(); }, `bd-tab${b.tab === key ? ' is-on' : ''}`, { 'data-key': `bd-tab-${key}`, 'aria-pressed': String(b.tab === key) });
  return h('div', { class: 'bd-tabs', attrs: { role: 'group', 'aria-label': '表示する列' } }, one('material', isAddMode(app) ? '足せる投稿' : '素材'), one('flow', `番組の流れ（${n}）`));
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
  const input = h('input', { class: 'input input-sm', type: 'search', dataset: { key: 'bd-search' }, attrs: { autocomplete: 'off', 'aria-label': '素材を検索', placeholder: '検索（話題名・本文・@アカウント）' } });
  let timer = null;
  // 打った字はすぐ状態に入れる（描き直しだけ少し待つ。待つ間にチップを押しても、打った字が元に戻らない）
  const store = () => {
    const b = ui(app);
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

function chipsRow(app, addMode) {
  const b = ui(app);
  const row = h('div', { class: 'bd-chips', attrs: { role: 'group', 'aria-label': addMode ? '投稿のジャンル' : '素材のしぼり込み' } });
  const list = addMode
    ? [{ key: 'all', label: 'すべて' }, ...GENRES.map((g) => ({ key: g.key, label: genreShort(g.key), genre: g.key }))]
    : boardChips({ hasBookmarks: app.bookmarkPosts != null, newCount: app.newInfo ? app.newInfo.topics.size : 0 });
  const cur = addMode ? b.addChip : sanitizeChip(b.chip, list);
  for (const c of list) {
    row.append(h('button', {
      type: 'button', class: `bd-chip${c.key === 'new' ? ' is-new' : ''}`, dataset: { key: `bd-chip-${c.key}` }, attrs: { 'aria-pressed': String(cur === c.key) },
      on: { click: () => {
        if (addMode) { b.addChip = c.key; b.addPages = 1; } else { b.chip = c.key; b.pages = 1; savePref(b); }
        b.scroll.left = 0;
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
  const col = h('section', { class: `bd-col bd-left${hidden ? ' is-hidden' : ''}${addMode ? ' is-add' : ''}`, attrs: { 'aria-label': addMode ? '足せる投稿' : '素材' }, dataset: { keep: 'left', drop: 'material' } });
  col.append(h('div', { class: 'bd-head' },
    h('h3', { class: 'bd-h' }, '素材', h('small', { dataset: { key: 'bd-left-sub' } }, addMode ? `「${t.name}」に足せる投稿` : '今週の話題（おすすめ順）')),
    addMode ? btn('← 素材に戻る', () => { b.left = 'material'; b.scroll.left = 0; app.render(); }, 'btn btn-small btn-ghost bd-back', { 'data-key': 'bd-back-material', title: '話題の一覧に戻ります（開いた話題はそのまま）' })
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
    h('span', { class: 'for-topic' }, 'ここで離すと番組から外します（素材に戻ります）'),
    h('span', { class: 'for-post' }, 'ここで離すとこの話題から外します')));
  return col;
}

function fillMaterial(app, wk, scroll) {
  const b = ui(app);
  const chips = boardChips({ hasBookmarks: app.bookmarkPosts != null, newCount: app.newInfo ? app.newInfo.topics.size : 0 });
  const list = materialList(matCtx(app), { chip: sanitizeChip(b.chip, chips), query: b.query, limit: b.pages * BOARD.pageSize });
  scroll.dataset.total = String(list.total);
  if (b.query.trim()) scroll.append(h('p', { class: 'bd-note', dataset: { key: 'bd-search-note' } }, `「${b.query.trim()}」：${list.total}件（話題名が合うもの → 中の投稿が合うもの）`));
  for (const it of list.items) {
    const t = app.topicsById.get(it.id);
    if (t) scroll.append(materialCard(app, wk, t, it));
  }
  if (!list.items.length) scroll.append(h('p', { class: 'empty bd-empty' }, b.query.trim() ? '見つかりませんでした' : 'ここに出す話題はありません'));
  if (list.more) scroll.append(btn(`もっと見る（あと ${list.more}件）`, () => { b.pages += 1; app.render(); }, 'btn btn-small btn-ghost bd-more-btn', { 'data-key': 'bd-more-list' }));
}

/** カードの印（★・NEW・雑談おすすめ・Grok・持ち越し・期間外） */
function cardMarks(app, t) {
  const out = [];
  if (t.bookmarkCount) out.push(h('span', { class: 'bd-mark is-star', attrs: { title: `ブックマークした投稿 ${t.bookmarkCount}件` } }, `★${t.bookmarkCount > 1 ? t.bookmarkCount : ''}`));
  if (app.newInfo && app.newInfo.topics.has(t.id)) out.push(h('span', { class: 'bd-mark is-new', attrs: { title: '前回のチェックのあとに増えた話題' } }, 'NEW'));
  if (t.postIds.some((id) => app.pickIds.has(id))) out.push(h('span', { class: 'bd-mark is-pick', attrs: { title: '雑談おすすめ（Grok）' } }, '雑談おすすめ'));
  if (t.bot) out.push(h('span', { class: `bd-mark is-bot${t.bot.low ? ' is-low' : ''}`, attrs: { title: t.bot.low ? 'Grok のまとめ（要確認）' : 'Grok のまとめ' } }, t.bot.low ? 'Grok?' : 'Grok'));
  if (t.kind === 'carried') out.push(h('span', { class: 'bd-mark', attrs: { title: '先週から持ち越した話題' } }, '持ち越し'));
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
  scroll.append(h('p', { class: 'bd-note' }, b.addQuery.trim() ? `「${b.addQuery.trim()}」：${list.total}件` : `「＋」か、右の開いた話題へドラッグで足せます（${genreShort(t.genre)}の投稿が先・表示の多い順）`));
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
  const x = h('button', { type: 'button', class: 'bd-rd bd-x', dataset: { key: `unplace-${t.id}` }, attrs: { 'aria-label': `「${t.name}」を番組から外す`, title: '番組から外す（素材に戻ります。Ctrl+Z で戻せます）' } }, '✕');
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
    one ? '投稿を足すには、上の「足せる投稿」で「＋」' : (shown.length ? '＋ 左の投稿をここへ' : '左の投稿を「＋」かドラッグで足してください')));
  body.append(list);
  if (items.length > shown.length) body.append(btn(`残り ${items.length - shown.length}件を表示`, () => { b.itemPages += 1; app.render(); }, 'btn btn-small btn-ghost bd-more-btn', { 'data-key': 'bd-more-items' }));
  const file = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'sr-only', id: `bd-img-file-${t.id}`, dataset: { key: 'bd-img-file' } });
  file.addEventListener('change', () => { const fs = [...(file.files || [])]; file.value = ''; app.addImages(fs, t.id); });
  body.append(h('div', { class: 'bd-mini' },
    btn('プレビュー（X の表示）', () => showPreview(app, { kind: 'topic', id: t.id, item: null }), 'btn btn-small', { 'data-key': 'bd-preview' }),
    btn('URL から投稿を追加', () => { app.ui.urlDlg = { topicId: t.id, text: '' }; app.render(); }, 'btn btn-small btn-ghost', { 'data-key': 'bd-url-add', title: 'X の投稿の URL を貼って、この話題に足します' }),
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
  const rm = h('button', { type: 'button', class: 'bd-rd bd-x', dataset: { key: `rm-${id}` }, attrs: { 'aria-label': 'この話題から外す', title: 'この話題から外す（Ctrl+Z で戻せます）' } }, '✕');
  rm.addEventListener('click', (e) => { e.stopPropagation(); app.removeItem(t, id, isImageItem(id) ? null : '話題から外しました（素材に戻りました）'); });
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
    scroll.append(h('div', { class: 'pv-empty', dataset: { key: 'bd-pv-empty' } }, h('p', {}, 'カードを押すと、ここに中身（X の表示）が出ます。'),
      h('ul', { class: 'pv-help' },
        h('li', {}, 'ドラッグ：左のカードを右へ入れる・右の中で並べ替える・左へ戻すと外れる'),
        h('li', {}, '「＋」：押して入れ先を選ぶ（ドラッグなしでも入れられます）'),
        h('li', {}, '右のカードを押す：その場で開いて、投稿を並べ替え・追加'),
        h('li', {}, '元に戻す：Ctrl+Z ／ やり直す：Ctrl+Shift+Z'))));
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
  if (!t) { box.append(h('p', {}, '話題が見つかりません')); return box; }
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

/** かんたん編成のキー（Ctrl+Z／Ctrl+Shift+Z・Enter で開く・Alt+↑↓ で動かす・Delete で外す・F2 で名前）。処理したら true */
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
    return false;
  }
  const card = e.target && e.target.closest ? e.target.closest('[data-card]') : null;
  if (!card) return false;
  const kind = card.dataset.card;
  const wk = app.weekState();
  const menuAt = (items, key) => { const r = card.getBoundingClientRect(); openMenu(app, items, r.left + 40, r.bottom - 6, key); };
  if ((e.key === 'Enter' || e.key === ' ') && e.target === card) { e.preventDefault(); card.click(); return true; }
  if (kind === 'material' || kind === 'flow') {
    const id = card.dataset.topic;
    const t = app.topicsById.get(id);
    if (!t) return false;
    if (e.key === 'F2') { e.preventDefault(); openRename(app, id); return true; }
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); menuAt(topicMenuItems(app, t), card.dataset.key); return true; }
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
    if (e.key === 'Delete') { e.preventDefault(); app.removeItem(t, id, isImageItem(id) ? null : '話題から外しました（素材に戻りました）'); return true; }
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
