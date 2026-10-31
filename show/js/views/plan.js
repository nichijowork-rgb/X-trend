// ① 編成（準備）画面 — フォルダ型（v2 段階1）。
// 左: フォルダの木（番組構成・まとまり・受信箱・★ブックマーク・NEW・片付け・ゴミ箱）
// 右: 選んだフォルダの中身（行リスト・仮想スクロール）＋プレビュー（X 埋め込み。960px では一覧⇄プレビュー切替、1400px 以上は 3 列）
// 上: 常設の検索・元に戻す/やり直す・仕分けモード・チェックポイント・ツール
// 操作: ドラッグ＆ドロップ（pointer events）・複数選択（Ctrl/⌘・Shift・チェック・Ctrl+A）・一括操作バー・右クリックメニュー・「移動先…」
import { formatDateTime, formatCompact } from '../../../assets/js/core.js';
import { CHECKPOINTS, GENRES, PLAN_V2 } from '../config.js';
import {
  recordCheckpoint, autoTitle, weekLabel, genreLabel, statusUrl, postGenre, setPostGenre, canBeMain, cornerDef,
  leadText, mainSlots, totalMinutes, scorePoints,
} from '../logic.js';
import {
  folderRows, buildTree, selectClick, selectAllRows, pruneSelection, isDropTarget, applyDrop, makeGroup, createEmptyGroup,
  renameTopic, isFolderTopic, placeOf, isNightGenre, topicsOfRows,
} from '../folders.js';
import { h, btn, badge, field, postCard, linkCard, genreSticker, embedHost, isEditable } from '../dom.js';
import { scriptFor, topicMarks, refYear, mainTopics, currentTitle, bmInfo, statsLine, botMarks, pickReason } from './common.js';
import { beginPointer, isDragging } from './dnd.js';
import { contextMenu, moveDialog, nameDialog } from './menu.js';
import { toolsDialog } from './tools.js';
import { startSort, sortDialog, sortKeydown } from './sortmode.js';

const ROW_H = PLAN_V2.rowHeight;
const wide = () => typeof matchMedia === 'function' && matchMedia('(min-width: 1400px)').matches;
const narrow = () => typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches;

const FOLDER_NAMES = {
  cand: 'メイン候補', 'corner:category': 'カテゴリ別ニュース', 'corner:chat': '雑談（一般のバズ）',
  'group:night': 'まとまり：夜職', 'group:general': 'まとまり：一般のバズ', inbox: '受信箱（未整理）',
  bookmarks: '★ブックマーク', new: 'NEW（前回のチェック以降）', shelf: '片付け', hold: '保留（保留する言葉に一致）', trash: 'ゴミ箱', search: '検索結果',
};

function ui(app) {
  const u = app.ui;
  if (!u.folder) u.folder = 'inbox';
  if (!u.treeOpen) u.treeOpen = new Set(['group:night']);
  if (!u.sel) u.sel = { sel: new Set(), anchor: null };
  if (u.query == null) u.query = '';
  return u;
}

function folderCtx(app) {
  return {
    week: app.weekState(), saved: app.saved, topics: app.visibleTopics, topicsById: app.topicsById, postsById: app.postsById,
    weekPosts: app.weekPosts || [], shelvedTopics: app.shelvedTopics, trashedTopics: app.trashedTopics,
    newPostIds: app.newInfo ? app.newInfo.posts : new Set(), bookmarkPosts: app.bookmarkPosts, pickIds: app.pickIds,
    bookmarkRows: app.ui.bmAll ? app.bookmarkPostsAll : app.bookmarkPosts,
    generalAll: Boolean(app.ui.generalAll), query: app.ui.query, postTopic: app.postTopic, recommended: app.recommended,
    heldTopics: app.heldTopics || [], heldPosts: app.heldPosts || new Map(),
  };
}

function curKey(app) {
  return app.ui.query.trim() ? 'search' : app.ui.folder;
}

function folderName(app, key) {
  if (key.startsWith('slot:')) return `メイン${Number(key.slice(5)) + 1}`;
  if (key.startsWith('topic:')) { const t = app.topicsById.get(key.slice(6)); return t ? `まとまり「${t.name}」` : 'まとまり'; }
  return FOLDER_NAMES[key] || key;
}

/** 現在のフォルダの行（描画のたびに作る。選択の掃除もここで） */
function computeRows(app) {
  const u = ui(app);
  if (u.folder.startsWith('topic:') && !app.topicsById.has(u.folder.slice(6))) u.folder = 'inbox';
  const key = curKey(app);
  const r = folderRows(folderCtx(app), key);
  u.rows = r.rows;
  u.rowsInfo = r;
  u.rowsKey = key;
  u.rowsQuery = u.query;
  u.sel = pruneSelection(u.sel, r.rows);
  if (u.focus && !r.rows.some((x) => x.key === u.focus)) u.focus = null;
  return r;
}

function selectedRows(app) {
  const u = app.ui;
  return u.rows.filter((r) => u.sel.sel.has(r.key));
}

/** 操作の対象（選択中。無ければ押した行） */
function targetRows(app, row) {
  const u = app.ui;
  if (row && !u.sel.sel.has(row.key)) return [row];
  const sel = selectedRows(app);
  return sel.length ? sel : (row ? [row] : []);
}

function dropCtx(app) {
  return { topicsById: app.topicsById, postTopic: app.postTopic, postsById: app.postsById, weekKey: app.weekKey, now: Date.now() };
}

/** 行をフォルダへ（ドロップ・移動先・メニュー共通。元に戻せる） */
export function moveRows(app, rows, target) {
  const movable = rows.filter((r) => r.type === 'post' || r.type === 'topic');
  if (!movable.length) return;
  let res = null;
  app.edit(`移動：${folderName(app, target.split('#')[0])}`, (w, s) => { res = applyDrop(w, s, movable, target, dropCtx(app)); }, { render: false });
  if (res && !res.ok) {
    // 何も変わらなかったら履歴を取り消す
    app.history = { ...app.history, past: app.history.past.slice(0, -1) };
    app.toast(res.message);
  } else if (res) {
    app.ui.sel = { sel: new Set(), anchor: null };
    app.toast(res.message, () => app.undo());
  }
  app.render();
}

function setGenre(app, rows, genre) {
  const posts = rows.filter((r) => r.type === 'post').map((r) => r.id);
  const topics = rows.filter((r) => r.type === 'topic').map((r) => r.id);
  app.edit(`ジャンル変更：${genreLabel(genre)}`, (w, s) => {
    if (posts.length) setPostGenre(s, posts, genre, Date.now(), app.origGenreOf);
    for (const id of topics) w.overrides.genres[id] = genre;
  }, { toastText: `${rows.length}件のジャンルを「${genreLabel(genre)}」にしました` });
}

// ================================================================ 描画

export function renderPlan(app) {
  const u = ui(app);
  const wk = app.weekState();
  computeRows(app);
  const isWide = wide();
  const showPreview = isWide || u.pane === 'preview';
  const root = h('div', { class: `plan2${isWide ? ' is-wide' : ''}${u.pane === 'preview' && !isWide ? ' is-preview' : ''}${u.treeDrawer ? ' is-drawer' : ''}`, dataset: { keep: `plan:${app.weekKey}` } });
  root.append(topBar(app, wk));
  const body = h('div', { class: 'plan2-body', dataset: { keep: 'body' } });
  body.append(treePane(app, wk));
  body.append(listPane(app, wk, !isWide && u.pane === 'preview'));
  if (showPreview) body.append(previewPane(app, wk));
  root.append(body);
  root.append(h('p', { id: 'drag-status', class: 'sr-only', attrs: { role: 'status', 'aria-live': 'polite' } }));
  // ダイアログ・メニュー
  if (u.sort) root.append(sortDialog(app));
  else if (u.move) root.append(moveDlg(app));
  else if (u.nameDlg) root.append(nameDlg(app));
  else if (u.tools) root.append(toolsDialog(app));
  if (u.menu) root.append(contextMenu(u.menu.items, u.menu.x, u.menu.y, () => { u.menu = null; app.render(); }));
  app.afterRender = () => {
    for (const d of document.querySelectorAll('#view dialog[data-modal]')) if (!d.open && typeof d.showModal === 'function') d.showModal();
    refreshList(app);
  };
  return root;
}

// ---------------------------------------------------------------- 上の帯

function topBar(app, wk) {
  const u = app.ui;
  const auto = autoTitle(app.saved.showName, mainTopics(app).map((t) => t.name));
  const isAuto = !(typeof wk.title === 'string' && wk.title.trim());
  const titleInput = h('input', { class: 'input input-sm input-title', type: 'text', value: currentTitle(app), maxLength: 200, dataset: { key: 'title' }, attrs: { autocomplete: 'off', 'aria-label': '配信タイトル' } });
  titleInput.addEventListener('input', () => app.update((w) => { w.title = titleInput.value === auto ? null : titleInput.value; }, { render: false, debounce: true }));
  titleInput.addEventListener('change', () => app.render());
  const search = h('input', { class: 'input plan-search', type: 'search', value: u.query, placeholder: '検索（本文・@アカウント・話題名。スペースで AND）', dataset: { key: 'search' }, attrs: { 'aria-label': '今週の投稿を検索', autocomplete: 'off' } });
  search.addEventListener('input', () => {
    u.query = search.value;
    u.sel = { sel: new Set(), anchor: null };
    clearTimeout(search._t);
    search._t = setTimeout(() => app.render(), 150);
  });
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape' && search.value) { e.preventDefault(); search.value = ''; u.query = ''; app.render(); } });
  const last = wk.checkpoints[wk.checkpoints.length - 1];
  const cpLabel = last ? `${CHECKPOINTS.find((c) => c.kind === last.kind)?.label || ''} ${last.recordedAt ? formatDateTime(null, Math.floor(last.recordedAt / 1000)) : ''}` : '未記録';
  const cpMenu = h('details', { class: 'menu menu-cp' },
    h('summary', { class: 'btn btn-small menu-btn', dataset: { key: 'cp-menu' } }, `チェック：${cpLabel}`),
    h('div', { class: 'menu-list' },
      h('p', { class: 'menu-note' }, '押すと今のデータ時刻を記録し、それ以降に増えた投稿に NEW が付きます。'),
      CHECKPOINTS.map((cp) => h('button', {
        type: 'button', class: 'menu-item', dataset: { key: `cp-${cp.kind}` },
        on: { click: () => app.edit(`チェックポイント（${cp.label}）`, (w) => { Object.assign(w, recordCheckpoint(w, cp.kind, app.ds.generated_at, app.weekPostIds, app.topics.map((t) => t.id), Date.now())); }) },
      }, `${cp.label}（${cp.when}）を記録`)),
      last ? h('p', { class: 'menu-note' }, `前回：データ ${last.dataAt ? formatDateTime(last.dataAt, null) : '不明'} 時点・その後の新しい投稿 ${app.newInfo ? app.newInfo.posts.size : 0}件`) : null));
  return h('header', { class: 'plan-top' },
    h('div', { class: 'pt-row' },
      btn('≡ フォルダ', () => { u.treeDrawer = !u.treeDrawer; app.render(); }, 'btn btn-small btn-ghost tree-drawer-btn', { 'data-key': 'tree-drawer', 'aria-expanded': String(Boolean(u.treeDrawer)) }),
      h('h2', { class: 'pt-title' }, `${app.weekKey.slice(5).replace('-', '/')}(土) の編成`),
      h('span', { class: 'pt-sub' }, `投稿 ${app.weekPostIds.length}件・まとまり ${app.visibleTopics.filter(isFolderTopic).length}`),
      h('label', { class: 'pt-titlebox' }, h('span', { class: 'sr-only' }, '配信タイトル'), titleInput),
      isAuto ? null : btn('自動に戻す', () => app.update((w) => { w.title = null; }), 'btn btn-small btn-ghost', { 'data-key': 'title-auto' })),
    h('div', { class: 'pt-row' },
      search,
      h('span', { class: 'pt-tools' },
        btn('↶ 元に戻す', () => app.undo(), 'btn btn-small', { 'data-key': 'undo', disabled: !app.history.past.length }),
        btn('↷ やり直す', () => app.redo(), 'btn btn-small', { 'data-key': 'redo', disabled: !app.history.future.length }),
        btn('仕分けモード', () => startSort(app, u.rows, folderName(app, curKey(app))), 'btn btn-small btn-red', { 'data-key': 'sort-start', title: '今のフォルダの投稿を 1 件ずつ振り分けます（1/2/3/G/X/→/←）' }),
        cpMenu,
        btn('ツール…', () => { u.tools = true; app.render(); }, 'btn btn-small btn-ghost', { 'data-key': 'tools-open', title: '番組名・書き出し/読み込み・URL の追加・話題辞書・表示の切替' }))));
}

// ---------------------------------------------------------------- フォルダの木

function treePane(app, wk) {
  const u = app.ui;
  const nodes = buildTree(folderCtx(app), u.treeOpen);
  const active = curKey(app);
  const tree = h('nav', { class: 'tree', attrs: { 'aria-label': 'フォルダ' }, dataset: { keep: 'tree' } });
  const ul = h('ul', { class: 'tree-list', attrs: { role: 'tree', 'aria-label': 'フォルダ' } });
  for (const n of nodes) {
    if (n.group) { ul.append(h('li', { class: 'tree-head', attrs: { role: 'presentation' } }, n.label)); continue; }
    const isActive = n.key === active;
    const open = () => {
      u.folder = n.key;
      u.query = '';
      u.sel = { sel: new Set(), anchor: null };
      u.focus = null;
      u.pane = 'list';
      u.treeDrawer = false;
      if (n.hasChildren && !u.treeOpen.has(n.key)) u.treeOpen.add(n.key);
      app.render();
    };
    const label = h('button', {
      type: 'button', class: 'tree-label', dataset: { key: `folder-${n.key}` },
      attrs: { 'aria-current': isActive ? 'true' : null, title: n.sub ? `${n.label}：${n.sub}` : n.label },
      on: { click: open },
    },
    n.genre ? h('span', { class: `tree-dot g-${n.genre}`, attrs: { 'aria-hidden': 'true' } }) : null,
    h('span', { class: 'tree-name' }, n.label, n.sub ? h('span', { class: 'tree-sub' }, n.sub) : null),
    n.bot ? h('span', { class: `tree-bot${n.bot === 'low' ? ' is-low' : ''}`, attrs: { title: n.bot === 'low' ? 'Grok のまとめ（要確認）' : 'Grok のまとめ' } }, n.bot === 'low' ? 'G?' : 'G') : null,
    n.count != null ? h('span', { class: 'tree-count' }, String(n.count)) : null);
    if (n.topicId) {
      label.addEventListener('dblclick', (e) => { e.preventDefault(); openRename(app, n.topicId); });
      label.addEventListener('contextmenu', (e) => { e.preventDefault(); openMenu(app, [{ key: `t:${n.topicId}`, type: 'topic', id: n.topicId }], e.clientX, e.clientY, { fromTree: true }); });
    }
    const li = h('li', {
      class: `tree-node depth-${n.depth}${isActive ? ' is-active' : ''}`, attrs: { role: 'treeitem', 'aria-level': String(n.depth + 1), 'aria-expanded': n.hasChildren ? String(Boolean(n.open)) : null, 'aria-selected': String(isActive) },
    },
    n.hasChildren ? btn(n.open ? '▾' : '▸', () => { if (u.treeOpen.has(n.key)) u.treeOpen.delete(n.key); else u.treeOpen.add(n.key); app.render(); }, 'tree-toggle', { 'aria-label': n.open ? 'たたむ' : 'ひらく', 'data-key': `toggle-${n.key}` }) : h('span', { class: 'tree-toggle-sp' }),
    label);
    if (n.drop) li.dataset.drop = n.key;
    ul.append(li);
  }
  tree.append(ul);
  return h('aside', { class: 'tree-pane', attrs: { 'aria-label': 'フォルダの一覧' }, dataset: { keep: 'tree-pane' } }, tree);
}

// ---------------------------------------------------------------- 行リスト（仮想スクロール）

function listPane(app, wk, hidden) {
  const u = app.ui;
  const key = curKey(app);
  const info = u.rowsInfo;
  const pane = h('section', { class: `list-pane${hidden ? ' is-hidden' : ''}`, attrs: { 'aria-label': '一覧' }, dataset: { keep: 'list-pane' } });
  const generalToggle = (key === 'inbox' || key === 'group:general')
    ? btn(u.generalAll ? `一般のバズ：すべて表示中（おすすめだけにする）` : `一般のバズ：おすすめ ${PLAN_V2.generalRecommendN}件だけ（すべて表示）`,
      () => { u.generalAll = !u.generalAll; app.render(); }, 'btn btn-small btn-ghost', { 'data-key': 'general-toggle', 'aria-pressed': String(Boolean(u.generalAll)), title: '一般のバズは話題性の高い順の上位だけを表示しています' })
    : null;
  const head = h('div', { class: 'lp-head' },
    h('h3', { class: 'lp-title', dataset: { key: 'folder-title' } }, folderName(app, key), h('span', { class: 'lp-count' }, `${info.rows.length}件${info.hidden ? `（ほか一般のバズ ${info.hidden}件は隠し中）` : ''}`)),
    h('div', { class: 'lp-tools' },
      generalToggle,
      key === 'bookmarks' ? btn(u.bmAll ? `すべて（${(app.bookmarkPostsAll || []).length}件）を表示中（今週だけにする）` : `今週の分だけ（すべて表示）`, () => { u.bmAll = !u.bmAll; app.render(); }, 'btn btn-small btn-ghost', { 'data-key': 'bm-toggle', 'aria-pressed': String(Boolean(u.bmAll)), title: '今週＝ブックマークした日時が今週（日時が無いものは投稿日時）。数値はブックマーク時点' }) : null,
      btn('＋新しいまとまり', () => { u.nameDlg = { mode: 'new', name: '', genre: 'night' }; app.render(); }, 'btn btn-small', { 'data-key': 'new-group' }),
      info.rows.length ? btn('すべて選択', () => { u.sel = selectAllRows(u.rows); app.render(); }, 'btn btn-small btn-ghost', { 'data-key': 'select-all' }) : null));
  pane.append(head);
  if (key.startsWith('corner:') || key === 'cand' || key.startsWith('slot:')) pane.append(cornerSettings(app, wk, key));
  if (!info.rows.length) {
    const empty = h('p', { class: 'empty lp-empty' }, emptyText(key));
    if (isDropTarget(key)) empty.dataset.drop = key;
    pane.append(empty);
  }
  // 仮想スクロールの入れ物（中身は refreshList が描く。差し替えでは残す）
  const vlist = h('div', {
    class: 'vlist', tabIndex: 0, attrs: { role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': `${folderName(app, key)}の一覧`, 'data-keep-leaf': '' },
    dataset: { keep: 'vlist' },
  });
  pane.append(vlist);
  const sel = selectedRows(app);
  if (sel.length) pane.append(bulkBar(app, sel));
  return pane;
}

function emptyText(key) {
  if (key.startsWith('slot:')) return 'まだ空きです。まとまりや投稿をここ（左のメイン枠）へドラッグしてください。';
  if (key === 'cand' || key.startsWith('corner:')) return 'まだありません。左のこのフォルダへドラッグするか、「移動先…」で入れてください。';
  if (key === 'search') return '見つかりませんでした';
  return '該当なし';
}

/** コーナーの時間・メモ（番組構成のフォルダ） */
function cornerSettings(app, wk, key) {
  if (key === 'cand') return h('p', { class: 'lp-note' }, 'メイン1〜3に入れる前の置き場（夜職の話題だけ）。左のメイン1〜3へドラッグして決めます。');
  const ck = key.startsWith('slot:') ? 'main' : key.slice(7);
  const c = wk.rundown.corners.find((x) => x.key === ck);
  const min = h('input', { class: 'input input-min', type: 'number', min: 0, max: 240, value: String(c.min), dataset: { key: `min-${ck}` }, attrs: { 'aria-label': `${cornerDef(ck).name}の時間（分）` } });
  min.addEventListener('change', () => {
    const v = Math.round(Number(min.value));
    if (!Number.isFinite(v) || v < 0 || v > 240) { min.value = String(c.min); return; }
    app.edit('時間の変更', (w) => { w.rundown.corners.find((x) => x.key === ck).min = v; }, { topics: false });
  });
  const note = h('textarea', { class: 'input', rows: 1, value: wk.notes[ck] || '', placeholder: 'コーナーのメモ（自分用）', dataset: { key: `note-${ck}` } });
  note.addEventListener('input', () => app.update((w) => { w.notes[ck] = note.value; }, { render: false, debounce: true }));
  const total = totalMinutes(wk.rundown);
  return h('div', { class: 'lp-corner' },
    h('label', { class: 'min-box' }, h('span', {}, `${cornerDef(ck).name}`), min, h('span', {}, '分')),
    h('span', { class: 'muted' }, `合計 ${total}分`),
    note);
}

function rowGenre(app, row) {
  if (row.type === 'post') return postGenre(app.postsById.get(row.id));
  if (row.type === 'topic') { const t = app.topicsById.get(row.id); return t ? t.genre : 'night'; }
  if (row.type === 'trash') { const e = app.saved.trash.find((x) => x.id === row.id); return e ? e.genre : 'night'; }
  if (row.type === 'heldPost') return postGenre(app.postsById.get(row.id));
  if (row.type === 'heldTopic') { const t = app.topicsById.get(row.id); return t ? t.genre : 'night'; }
  return 'review';
}

function rowLabel(app, row) {
  if (row.type === 'post') { const p = app.postsById.get(row.id); return p ? (p.text || '（本文なし）').replace(/\s+/g, ' ') : `データに無い投稿（ID ${row.id}）`; }
  if (row.type === 'topic') { const t = app.topicsById.get(row.id); return t ? t.name : '話題'; }
  if (row.type === 'trash') { const e = app.saved.trash.find((x) => x.id === row.id); return e ? `話題：${e.name}` : '話題'; }
  if (row.type === 'heldTopic') { const t = app.topicsById.get(row.id); return t ? `まとまり：${t.name}` : '話題'; }
  if (row.type === 'heldPost') { const p = app.postsById.get(row.id); return p ? (p.text || '（本文なし）').replace(/\s+/g, ' ') : `ID ${row.id}`; }
  const p = app.postsById.get(row.id);
  return `投稿：${p ? p.text.replace(/\s+/g, ' ') : `ID ${row.id}`}`;
}

/** 1 行の要素 */
function rowEl(app, row, index) {
  const u = app.ui;
  const key = curKey(app);
  const selected = u.sel.sel.has(row.key);
  const genre = rowGenre(app, row);
  const el = h('div', {
    class: `row-item${selected ? ' is-selected' : ''}${u.focus === row.key ? ' is-focus' : ''}`,
    id: `row-${index}`, attrs: { role: 'option', 'aria-selected': String(selected) },
    dataset: { rowKey: row.key, index: String(index) },
  });
  el.style.top = `${index * ROW_H}px`;
  // ドロップ先（並べ替え・まとまりへ移す）
  if (row.type === 'topic') {
    if (key === 'cand' || key.startsWith('corner:')) el.dataset.drop = `${key}#${index}`;
    else if (key.startsWith('slot:')) el.dataset.drop = key;
    else el.dataset.drop = `topic:${row.id}`;
  }
  const check = h('input', { type: 'checkbox', class: 'row-check', checked: selected, tabIndex: -1, attrs: { 'aria-label': '選ぶ' }, dataset: { key: `check-${row.key}` } });
  check.addEventListener('click', (e) => { e.stopPropagation(); u.sel = selectClick(u.sel, u.rows, index, { ctrl: true, shift: e.shiftKey }); app.render(); });
  const handle = h('span', { class: 'drag-handle', attrs: { 'aria-hidden': 'true', title: 'ドラッグで移動' } }, '⋮⋮');
  let title = rowLabel(app, row);
  let meta = [];
  if (row.type === 'post') {
    const p = app.postsById.get(row.id);
    const t = app.topicsById.get(app.postTopic.get(row.id));
    if (p) meta.push(h('span', { class: 'rm-user' }, `@${p.user}`), h('span', { class: 'rm-imp' }, formatCompact(p.metrics.impression_count)));
    if (bmInfo(app, row.id)) meta.push(h('span', { class: 'rm-star', attrs: { title: 'ブックマーク（数値はブックマーク時点）' } }, '★'));
    if (app.usedBefore && app.usedBefore.has(row.id)) meta.push(h('span', { class: 'rm-tag', attrs: { title: '前の配信で読んだ投稿' } }, '使用済み'));
    if (p && p._genreOverride) meta.push(h('span', { class: 'rm-tag', attrs: { title: 'ジャンルを上書きしています' } }, `${genreLabel(p._genreOverride)}に変更`));
    if (t && isFolderTopic(t) && key !== `topic:${t.id}`) meta.push(h('span', { class: 'rm-topic' }, `▸ ${t.name}`));
    const pl = t ? placeOf(app.weekState(), t.id) : null;
    if (pl) meta.push(h('span', { class: 'rm-place' }, pl.label));
    if (app.newInfo && app.newInfo.posts.has(row.id)) meta.push(h('span', { class: 'rm-new' }, 'NEW'));
    const pr = pickReason(app, row.id);
    if (pr != null) meta.push(h('span', { class: 'rm-pick', attrs: { title: pr ? `雑談おすすめ（Grok）：${pr}` : '雑談おすすめ（Grok）' } }, pr ? `雑談おすすめ：${pr}` : '雑談おすすめ'));
  } else if (row.type === 'topic') {
    const t = app.topicsById.get(row.id);
    if (t) {
      meta.push(h('span', { class: 'rm-kind' }, 'まとまり'), h('span', {}, `${t.stats.count}件`), h('span', { class: 'rm-imp' }, `合計${formatCompact(t.stats.totalImp)}`));
      if (t.bookmarkCount) meta.push(h('span', { class: 'rm-star' }, `★${t.bookmarkCount}`));
      const pl = placeOf(app.weekState(), t.id);
      if (pl && !key.startsWith('slot:') && key !== pl.key) meta.push(h('span', { class: 'rm-place' }, pl.label));
      if (t.suggested) meta.push(h('span', { class: 'rm-suggest' }, '同じ話題かも？'));
      if (t.kind === 'carried') meta.push(h('span', { class: 'rm-tag' }, '持ち越し'));
      if (t.bot) meta.push(...botMarks(t, true));
      const pick = t.postIds.find((id) => app.pickIds.has(id));
      if (pick) { const pr = pickReason(app, pick); meta.push(h('span', { class: 'rm-pick', attrs: { title: pr || '雑談おすすめ（Grok）' } }, pr ? `雑談おすすめ：${pr}` : '雑談おすすめ')); }
      const nw = app.newInfo && app.newInfo.topics.get(t.id);
      if (nw != null) meta.push(h('span', { class: 'rm-new' }, 'NEW'));
    }
  } else if (row.type === 'heldPost' || row.type === 'heldTopic') {
    const term = holdTermOfRow(app, row);
    const p = row.type === 'heldPost' ? app.postsById.get(row.id) : null;
    if (p) meta.push(h('span', { class: 'rm-user' }, `@${p.user}`), h('span', { class: 'rm-imp' }, formatCompact(p.metrics.impression_count)));
    meta.push(h('span', { class: 'rm-hold', attrs: { title: '保留する言葉に一致（ツールで変えられます）' } }, `保留：${term || '言葉'}`));
  } else {
    meta.push(h('span', { class: 'muted' }, row.type === 'trash' ? 'ゴミ箱の話題' : 'ゴミ箱の投稿'));
  }
  const more = h('button', { type: 'button', class: 'row-more', tabIndex: -1, attrs: { 'aria-label': '操作' }, dataset: { key: `more-${row.key}` } }, '…');
  more.addEventListener('click', (e) => { e.stopPropagation(); const r = more.getBoundingClientRect(); openMenu(app, targetRows(app, row), r.left, r.bottom, { row }); });
  el.append(handle, check, h('span', { class: `row-color g-${genre}`, attrs: { title: genreLabel(genre) } }),
    h('div', { class: 'row-main' }, h('div', { class: `row-title${row.type === 'topic' ? ' is-topic' : ''}` }, title), h('div', { class: 'row-meta' }, meta)),
    more);
  const draggable = row.type === 'post' || row.type === 'topic';
  const onDown = (handleMode) => (e) => {
    if (e.target.closest('input, button:not(.drag-handle), a')) return;
    if (!draggable) { if (e.pointerType === 'mouse') { /* クリックは click で */ } return; }
    beginPointer(e, {
      handle: handleMode,
      getRows: () => targetRows(app, row),
      label: (rows) => (rows.length === 1 ? rowLabel(app, rows[0]).slice(0, 30) : `${rowLabel(app, rows[0]).slice(0, 18)} ほか`),
      canDrop: (k, rows) => canDropOn(app, k, rows),
      onDrop: (k, rows) => moveRows(app, rows, k),
      onClick: (ev) => clickRow(app, row, index, ev),
    });
  };
  el.addEventListener('pointerdown', onDown(false));
  handle.addEventListener('pointerdown', (e) => { e.stopPropagation(); onDown(true)(e); });
  if (!draggable) el.addEventListener('click', (ev) => clickRow(app, row, index, ev));
  el.addEventListener('dblclick', (e) => {
    if (e.target.closest('input, button')) return;
    if (row.type === 'topic') openFolder(app, row.id);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!u.sel.sel.has(row.key)) { u.sel = { sel: new Set([row.key]), anchor: index }; }
    openMenu(app, targetRows(app, row), e.clientX, e.clientY, { row });
  });
  return el;
}

function canDropOn(app, key, rows) {
  if (!isDropTarget(key)) return false;
  const base = key.split('#')[0];
  if (base.startsWith('topic:')) {
    const id = base.slice(6);
    if (rows.every((r) => r.type === 'topic' && r.id === id)) return false;
    return true;
  }
  if (/^slot:|^cand$/.test(base)) {
    const ids = topicsOfRows(rows, app.postTopic);
    return ids.some((id) => canBeMain(app.topicsById.get(id)));
  }
  return true;
}

function clickRow(app, row, index, e) {
  const u = app.ui;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl || e.shiftKey) {
    u.sel = selectClick(u.sel, u.rows, index, { ctrl, shift: e.shiftKey });
  } else {
    u.sel = { sel: new Set([row.key]), anchor: index };
    u.focus = row.key;
    if (!wide()) u.pane = 'preview';
  }
  u.focus = row.key;
  app.render();
}

function openFolder(app, topicId) {
  const u = app.ui;
  u.folder = `topic:${topicId}`;
  u.query = '';
  u.sel = { sel: new Set(), anchor: null };
  u.focus = null;
  u.pane = 'list';
  const t = app.topicsById.get(topicId);
  if (t) u.treeOpen.add(isNightGenre(t.genre) ? 'group:night' : 'group:general');
  app.render();
}

/** 仮想スクロール: 見えている行だけ描く */
function refreshList(app) {
  const vlist = document.querySelector('#view .vlist');
  if (!vlist) return;
  const u = app.ui;
  if (vlist.__key !== u.rowsKey) { vlist.scrollTop = 0; vlist.__key = u.rowsKey; }
  vlist.__app = app;
  if (!vlist.__bound) {
    vlist.__bound = true;
    vlist.addEventListener('scroll', () => { if (!vlist.__raf) vlist.__raf = requestAnimationFrame(() => { vlist.__raf = null; drawWindow(vlist); }); });
    vlist.addEventListener('keydown', (e) => listKeydown(vlist.__app, e));
  }
  drawWindow(vlist);
}

function drawWindow(vlist) {
  const app = vlist.__app;
  const u = app.ui;
  const rows = u.rows || [];
  let inner = vlist.firstElementChild;
  if (!inner) { inner = h('div', { class: 'vlist-inner' }); vlist.append(inner); }
  inner.style.height = `${rows.length * ROW_H}px`;
  const top = vlist.scrollTop;
  const hgt = vlist.clientHeight || 600;
  const from = Math.max(0, Math.floor(top / ROW_H) - 6);
  const to = Math.min(rows.length, Math.ceil((top + hgt) / ROW_H) + 6);
  while (inner.firstChild) inner.firstChild.remove();
  for (let i = from; i < to; i++) inner.append(rowEl(app, rows[i], i));
  const fi = rows.findIndex((r) => r.key === u.focus);
  if (fi >= 0) vlist.setAttribute('aria-activedescendant', `row-${fi}`); else vlist.removeAttribute('aria-activedescendant');
}

function scrollToIndex(vlist, i) {
  const top = i * ROW_H;
  if (top < vlist.scrollTop) vlist.scrollTop = top;
  else if (top + ROW_H > vlist.scrollTop + vlist.clientHeight) vlist.scrollTop = top + ROW_H - vlist.clientHeight;
}

function listKeydown(app, e) {
  const u = app.ui;
  const rows = u.rows || [];
  if (!rows.length) return;
  const vlist = e.currentTarget;
  let i = rows.findIndex((r) => r.key === u.focus);
  const go = (j, extend) => {
    j = Math.max(0, Math.min(rows.length - 1, j));
    if (extend) u.sel = selectClick(u.sel, rows, j, { shift: true });
    else u.sel = { sel: new Set([rows[j].key]), anchor: j };
    u.focus = rows[j].key;
    scrollToIndex(vlist, j);
    app.render();
  };
  if (e.key === 'ArrowDown') { e.preventDefault(); go(i < 0 ? 0 : i + 1, e.shiftKey); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); go(i < 0 ? 0 : i - 1, e.shiftKey); }
  else if (e.key === 'Home') { e.preventDefault(); go(0, e.shiftKey); }
  else if (e.key === 'End') { e.preventDefault(); go(rows.length - 1, e.shiftKey); }
  else if (e.key === ' ' && i >= 0) { e.preventDefault(); u.sel = selectClick(u.sel, rows, i, { ctrl: true }); app.render(); }
  else if (e.key === 'Enter' && i >= 0) {
    e.preventDefault();
    if (rows[i].type === 'topic' && !e.shiftKey) openFolder(app, rows[i].id);
    else { u.pane = 'preview'; app.render(); }
  } else if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && i >= 0) {
    e.preventDefault();
    const el = vlist.querySelector(`[data-row-key="${CSS.escape(rows[i].key)}"]`);
    const r = el ? el.getBoundingClientRect() : vlist.getBoundingClientRect();
    openMenu(app, targetRows(app, rows[i]), r.left + 40, r.bottom, { row: rows[i] });
  } else if (e.key === 'Delete' && selectedRows(app).length) { e.preventDefault(); moveRows(app, selectedRows(app), 'trash'); }
}

// ---------------------------------------------------------------- 一括操作バー

function bulkBar(app, sel) {
  const u = app.ui;
  const genreMenu = h('details', { class: 'menu menu-up' },
    h('summary', { class: 'btn btn-small menu-btn', dataset: { key: 'bulk-genre' } }, 'ジャンル変更 ▴'),
    h('div', { class: 'menu-list' }, GENRES.map((g) => h('button', { type: 'button', class: 'menu-item', dataset: { key: `bulk-genre-${g.key}` }, on: { click: () => setGenre(app, sel, g.key) } }, g.label))));
  const movable = sel.filter((r) => r.type === 'post' || r.type === 'topic');
  const restorable = sel.filter((r) => r.type === 'trash' || r.type === 'hidden' || r.type === 'heldPost' || r.type === 'heldTopic');
  return h('div', { class: 'bulk-bar', attrs: { role: 'toolbar', 'aria-label': '選んだものの一括操作' } },
    h('b', { class: 'bulk-count', dataset: { key: 'bulk-count' } }, `${sel.length}件選択中`),
    movable.length ? [
      btn('移動先…', () => { u.move = { rows: movable }; app.render(); }, 'btn btn-small', { 'data-key': 'bulk-move' }),
      btn('まとまりにする', () => { u.nameDlg = { mode: 'group', rows: movable, name: '', genre: null }; app.render(); }, 'btn btn-small', { 'data-key': 'bulk-group' }),
      genreMenu,
      btn('片付け', () => moveRows(app, movable, 'shelf'), 'btn btn-small btn-ghost', { 'data-key': 'bulk-shelf' }),
      btn('削除', () => moveRows(app, movable, 'trash'), 'btn btn-small btn-ghost btn-danger', { 'data-key': 'bulk-trash' }),
    ] : null,
    restorable.length ? btn('戻す', () => restoreRows(app, restorable), 'btn btn-small', { 'data-key': 'bulk-restore' }) : null,
    btn('選択解除', () => { u.sel = { sel: new Set(), anchor: null }; app.render(); }, 'btn btn-small btn-ghost', { 'data-key': 'bulk-clear' }));
}

/** 保留になった言葉（行） */
function holdTermOfRow(app, row) {
  if (row.type === 'heldPost') return app.heldPosts ? app.heldPosts.get(row.id) || '' : '';
  if (row.type === 'heldTopic') return app.heldTopicTerms ? app.heldTopicTerms.get(row.id) || '' : '';
  return '';
}

function restoreRows(app, rows) {
  const tr = rows.filter((r) => r.type === 'trash').map((r) => r.id);
  const hid = rows.filter((r) => r.type === 'hidden').map((r) => r.id);
  const held = rows.filter((r) => r.type === 'heldPost' || r.type === 'heldTopic').map((r) => r.id);
  if (held.length) app.unhold(held);
  if (tr.length) app.restoreTrash(tr);
  for (const id of hid) app.unhidePost(id);
  app.ui.sel = { sel: new Set(), anchor: null };
  app.render();
}

// ---------------------------------------------------------------- 右クリックメニュー・移動先・名前

function openMenu(app, rows, x, y, opts = {}) {
  app.ui.menu = { items: menuItems(app, rows, opts), x, y };
  app.render();
}

function menuItems(app, rows, opts) {
  const u = app.ui;
  const one = rows.length === 1 ? rows[0] : null;
  if (rows.every((r) => r.type === 'heldPost' || r.type === 'heldTopic')) {
    const terms = [...new Set(rows.map((r) => holdTermOfRow(app, r)).filter(Boolean))];
    return [
      { label: `保留から戻す（${rows.length}件。この${rows.length === 1 && rows[0].type === 'heldTopic' ? '話題' : '投稿'}だけ）`, key: 'ctx-unhold', run: () => restoreRows(app, rows) },
      ...terms.map((t) => ({ label: `言葉「${t}」を保留リストから外す`, key: 'ctx-unhold-term', run: () => app.removeHoldTerm(t) })),
    ];
  }
  if (rows.every((r) => r.type === 'trash' || r.type === 'hidden')) {
    return [{ label: `戻す（${rows.length}件）`, key: 'ctx-restore', run: () => restoreRows(app, rows) }];
  }
  const topicIds = topicsOfRows(rows, app.postTopic);
  const mainOk = topicIds.some((id) => canBeMain(app.topicsById.get(id)));
  const items = [];
  if (one && !opts.fromTree) items.push({ label: 'プレビューを見る', key: 'ctx-preview', run: () => { u.focus = one.key; u.pane = 'preview'; app.render(); } });
  if (one && one.type === 'topic') items.push({ label: 'フォルダを開く', key: 'ctx-open', run: () => openFolder(app, one.id) });
  items.push({ heading: '番組に入れる' });
  for (let k = 0; k < 3; k++) items.push({ label: `メイン${k + 1}`, key: `ctx-slot-${k}`, disabled: !mainOk, title: mainOk ? null : '一般のバズはメインに入れません', run: () => moveRows(app, rows, `slot:${k}`) });
  items.push({ label: 'メイン候補', key: 'ctx-cand', disabled: !mainOk, run: () => moveRows(app, rows, 'cand') });
  items.push({ label: 'カテゴリ別ニュース', key: 'ctx-category', run: () => moveRows(app, rows, 'corner:category') });
  items.push({ label: '雑談（一般のバズ）', key: 'ctx-chat', run: () => moveRows(app, rows, 'corner:chat') });
  items.push({ sep: true });
  items.push({ label: '移動先…', key: 'ctx-move', hint: 'M', run: () => { u.move = { rows }; app.render(); } });
  items.push({ label: 'まとまりにする', key: 'ctx-group', run: () => { u.nameDlg = { mode: 'group', rows, name: '', genre: null }; app.render(); } });
  if (one && one.type === 'topic') items.push({ label: '名前を変える', key: 'ctx-rename', hint: 'F2', run: () => openRename(app, one.id) });
  items.push({ heading: 'ジャンル' });
  for (const g of GENRES) items.push({ label: g.label, key: `ctx-genre-${g.key}`, run: () => setGenre(app, rows, g.key) });
  items.push({ sep: true });
  items.push({ label: '受信箱に戻す（まとまり・番組構成から外す）', key: 'ctx-inbox', run: () => moveRows(app, rows, 'inbox') });
  items.push({ label: '片付ける（この週は使わない）', key: 'ctx-shelf', run: () => moveRows(app, rows, 'shelf') });
  items.push({ label: '削除（ゴミ箱へ）', key: 'ctx-trash', danger: true, hint: 'Del', run: () => moveRows(app, rows, 'trash') });
  if (one && one.type === 'post') items.push({ label: 'X で開く', key: 'ctx-x', run: () => window.open(statusUrl(one.id), '_blank', 'noopener,noreferrer') });
  return items;
}

function moveTargets(app, rows) {
  const wk = app.weekState();
  const ids = topicsOfRows(rows, app.postTopic);
  const mainOk = ids.some((id) => canBeMain(app.topicsById.get(id)));
  const slots = mainSlots(wk.rundown);
  const t = (id) => app.topicsById.get(id);
  const list = [
    ...slots.map((id, k) => ({ key: `slot:${k}`, label: `メイン${k + 1}`, sub: id && t(id) ? t(id).name : '空き', group: '番組構成', disabled: !mainOk, genre: 'main' })),
    { key: 'cand', label: 'メイン候補', group: '番組構成', disabled: !mainOk, genre: 'main' },
    { key: 'corner:category', label: 'カテゴリ別ニュース', group: '番組構成', genre: 'night' },
    { key: 'corner:chat', label: '雑談（一般のバズ）', group: '番組構成', genre: 'general' },
    { key: 'inbox', label: '受信箱（まとまり・番組構成から外す）', group: '整理' },
    { key: 'shelf', label: '片付け（この週は使わない）', group: '整理' },
    { key: 'trash', label: 'ゴミ箱（削除）', group: '整理' },
  ];
  for (const x of app.visibleTopics.filter(isFolderTopic)) {
    if (rows.length === 1 && rows[0].type === 'topic' && rows[0].id === x.id) continue;
    list.push({ key: `topic:${x.id}`, label: x.name, sub: `${genreLabel(x.genre)}・${x.stats.count}件`, group: 'まとまりへ移す', genre: x.genre });
  }
  return list;
}

function moveDlg(app) {
  const u = app.ui;
  const rows = u.move.rows;
  return moveDialog({
    title: `${rows.length}件の移動先`,
    targets: moveTargets(app, rows),
    onPick: (key) => { u.move = null; moveRows(app, rows, key); },
    onClose: () => { u.move = null; app.render(); },
  });
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
  const d = u.nameDlg;
  const close = () => { u.nameDlg = null; app.render(); };
  if (d.mode === 'rename') {
    const t = app.topicsById.get(d.topicId);
    return nameDialog({
      title: 'まとまりの名前を変える', okLabel: '変える', name: d.name, onClose: close,
      onOk: (name) => { u.nameDlg = null; if (t) app.edit(`名前の変更「${name}」`, (w) => renameTopic(w, t, name)); else app.render(); },
    });
  }
  if (d.mode === 'group') {
    const posts = d.rows.filter((r) => r.type === 'post').map((r) => app.postsById.get(r.id)).filter(Boolean);
    const genre = posts.length ? postGenre(posts[0]) : 'night';
    return nameDialog({
      title: `${d.rows.length}件をまとまりにする`, okLabel: 'まとまりにする', name: d.name, genre, genres: GENRES, onClose: close,
      onOk: (name, g) => {
        u.nameDlg = null;
        let id = null;
        app.edit('まとまりにする', (w) => { id = makeGroup(w, d.rows, { ...dropCtx(app) }, { name, genre: g }); }, { render: false });
        u.sel = { sel: new Set(), anchor: null };
        app.toast('まとまりにしました', () => app.undo());
        if (id && app.topicsById.has(id)) openFolder(app, id); else app.render();
      },
    });
  }
  return nameDialog({
    title: '新しいまとまり（空のフォルダ）', okLabel: '作る', name: d.name, genre: d.genre || 'night', genres: GENRES, onClose: close,
    onOk: (name, g) => {
      u.nameDlg = null;
      let id = null;
      app.edit('新しいまとまり', (w) => { id = createEmptyGroup(w, name, g, Date.now()); }, { render: false });
      app.toast('まとまりを作りました。投稿をここへドラッグしてください', () => app.undo());
      if (id && app.topicsById.has(id)) openFolder(app, id); else app.render();
    },
  });
}

// ---------------------------------------------------------------- プレビュー

function previewPane(app, wk) {
  const u = app.ui;
  const row = u.rows.find((r) => r.key === u.focus) || null;
  const pane = h('section', { class: 'preview-pane', attrs: { 'aria-label': 'プレビュー' }, dataset: { keep: 'preview' } });
  pane.append(h('div', { class: 'pv-top' },
    btn('← 一覧へ', () => { u.pane = 'list'; app.render(); }, 'btn btn-small btn-ghost pv-back', { 'data-key': 'preview-back' })));
  if (!row) {
    pane.append(h('div', { class: 'pv-empty' }, h('p', {}, '行を選ぶと、ここに中身（X の埋め込み）が出ます。'),
      h('ul', { class: 'pv-help' },
        h('li', {}, 'ドラッグ：行を左のフォルダへ（タッチは ⋮⋮ をつまむ）'),
        h('li', {}, '複数選択：Ctrl（⌘）＋クリック・Shift＋クリック・チェック・Ctrl+A'),
        h('li', {}, '右クリック・「…」：番組に入れる／移動先／ジャンル／片付け／削除'),
        h('li', {}, '元に戻す：Ctrl+Z ／ やり直す：Ctrl+Shift+Z・Ctrl+Y'),
        h('li', {}, '名前を変える：まとまりをダブルクリック（左の木）か F2'))));
    return pane;
  }
  if (row.type === 'post') pane.append(postPreview(app, wk, row));
  else if (row.type === 'topic') pane.append(topicPreview(app, wk, row));
  else if (row.type === 'heldPost' || row.type === 'heldTopic') pane.append(heldPreview(app, row));
  else pane.append(h('div', { class: 'pv-body' }, h('p', {}, rowLabel(app, row)), btn('戻す', () => restoreRows(app, [row]), 'btn btn-small', { 'data-key': 'pv-restore' })));
  return pane;
}

/** 保留の行のプレビュー（理由と、戻す・言葉を外す） */
function heldPreview(app, row) {
  const term = holdTermOfRow(app, row);
  const box = h('div', { class: 'pv-body', dataset: { keep: `pv:${row.key}` } });
  box.append(h('p', { class: 'hold-note', dataset: { key: 'pv-hold-note' } }, h('b', {}, '保留中'), `：保留する言葉「${term}」に一致したので、候補・おすすめ・受信箱に出していません。`));
  box.append(h('div', { class: 'row' },
    btn(row.type === 'heldTopic' ? 'この話題を戻す' : 'この投稿を戻す', () => restoreRows(app, [row]), 'btn btn-small', { 'data-key': 'pv-unhold' }),
    term ? btn(`言葉「${term}」を外す`, () => app.removeHoldTerm(term), 'btn btn-small btn-ghost', { 'data-key': 'pv-unhold-term' }) : null));
  if (row.type === 'heldPost') {
    const p = app.postsById.get(row.id);
    if (p) box.append(h('div', { class: 'pv-post' }, postCard(p, { refTs: app.ds.refTs, refYear: refYear(app), noActions: true, bm: bmInfo(app, p.id) })));
  } else {
    const t = app.topicsById.get(row.id);
    if (t) box.append(h('p', { class: 'pv-title' }, t.name), h('p', { class: 'stats' }, statsLine(t)));
  }
  return box;
}

function genreSelect(app, rows, cur, key) {
  const sel = h('select', { class: 'input input-sm', dataset: { key }, attrs: { 'aria-label': 'ジャンル' } }, GENRES.map((g) => h('option', { value: g.key, selected: g.key === cur }, g.label)));
  sel.addEventListener('change', () => setGenre(app, rows, sel.value));
  return sel;
}

function postPreview(app, wk, row) {
  const u = app.ui;
  const p = app.postsById.get(row.id);
  const t = app.topicsById.get(app.postTopic.get(row.id));
  const genre = postGenre(p);
  const box = h('div', { class: 'pv-body', dataset: { keep: `pv:${row.key}` } });
  box.append(h('div', { class: `pv-head g-${genre}` }, genreSticker(genre, { small: true }),
    h('b', { class: 'pv-title' }, p ? `@${p.user}` : `ID ${row.id}`),
    t && isFolderTopic(t) ? h('button', { type: 'button', class: 'pv-link', dataset: { key: 'pv-open-topic' }, on: { click: () => openFolder(app, t.id) } }, `▸ まとまり「${t.name}」`) : null,
    p && p._genreOverride ? h('span', { class: 'badge badge-me' }, `ジャンル上書き（元：${genreLabel(app.origGenreOf(row.id))}）`) : null));
  const pr = pickReason(app, row.id);
  if (pr != null) box.append(pickNote(pr));
  const own = p ? postCard(p, { refTs: app.ds.refTs, refYear: refYear(app), embedder: null, noActions: true, bm: bmInfo(app, p.id) }) : linkCard(row.id, statusUrl(row.id), null);
  box.append(h('div', { class: 'pv-post', dataset: { keep: `pp:${row.id}` } }, app.ui.view !== 'card' ? embedHost(row.id, own, 'pv-embed') : own));
  box.append(h('div', { class: 'pv-actions' },
    field('ジャンル', genreSelect(app, [row], genre, 'pv-genre')),
    h('div', { class: 'row' },
      btn('移動先…', () => { u.move = { rows: [row] }; app.render(); }, 'btn btn-small', { 'data-key': 'pv-move' }),
      btn('まとまりにする', () => { u.nameDlg = { mode: 'group', rows: [row], name: '', genre: null }; app.render(); }, 'btn btn-small', { 'data-key': 'pv-group' }),
      btn('片付け', () => moveRows(app, [row], 'shelf'), 'btn btn-small btn-ghost', { 'data-key': 'pv-shelf' }),
      btn('削除', () => moveRows(app, [row], 'trash'), 'btn btn-small btn-ghost btn-danger', { 'data-key': 'pv-trash' }),
      h('a', { href: statusUrl(row.id), target: '_blank', rel: 'noopener noreferrer', class: 'btn btn-small btn-ghost' }, 'X で開く'))));
  return box;
}

/** 雑談おすすめ（show_pick）の理由 */
function pickNote(reason) {
  return h('p', { class: 'pick-note', dataset: { key: 'pv-pick' } }, h('b', {}, '雑談おすすめ（Grok）'), reason ? `：${reason}` : '');
}

function topicPreview(app, wk, row) {
  const u = app.ui;
  const t = app.topicsById.get(row.id);
  const box = h('div', { class: 'pv-body', dataset: { keep: `pv:${row.key}` } });
  if (!t) { box.append(h('p', {}, '話題が見つかりません')); return box; }
  const pl = placeOf(wk, t.id);
  box.append(h('div', { class: `pv-head g-${t.genre}` }, genreSticker(t.genre, { small: true }),
    h('b', { class: 'pv-title', dataset: { key: 'pv-topic-title' }, on: { dblclick: () => openRename(app, t.id) }, attrs: { title: 'ダブルクリックで名前を変える' } }, t.name),
    h('span', { class: 'tcard-marks' }, topicMarks(app, t)),
    pl ? h('span', { class: 'badge badge-carry' }, pl.label) : null));
  box.append(h('p', { class: 'stats' }, statsLine(t), t.score != null ? h('span', { class: 'stat' }, '話題性 ', h('b', {}, `${scorePoints(t.score)}点`)) : null));
  if (t.bot && t.bot.low) box.append(h('p', { class: 'bot-check', dataset: { key: 'pv-bot-check' } }, '⚠ Grok のまとめ方の確からしさが低い話題です（', t.bot.confidence != null ? `${Math.round(t.bot.confidence * 100)}%` : '不明', '）。違う投稿が混ざっていないか確認してください。'));
  const picks = t.postIds.filter((id) => app.pickIds.has(id));
  if (picks.length) box.append(pickNote(pickReason(app, picks[0]) || ''));
  const acts = h('div', { class: 'row' },
    btn('フォルダを開く', () => openFolder(app, t.id), 'btn btn-small', { 'data-key': 'pv-open' }),
    btn('移動先…', () => { u.move = { rows: [row] }; app.render(); }, 'btn btn-small', { 'data-key': 'pv-move' }),
    btn('名前を変える', () => openRename(app, t.id), 'btn btn-small btn-ghost', { 'data-key': 'pv-rename' }),
    btn('片付け', () => moveRows(app, [row], 'shelf'), 'btn btn-small btn-ghost', { 'data-key': 'pv-shelf' }),
    btn('削除', () => moveRows(app, [row], 'trash'), 'btn btn-small btn-ghost btn-danger', { 'data-key': 'pv-trash' }));
  box.append(acts, field('ジャンル', genreSelect(app, [row], t.genre, 'pv-genre')));
  if (t.suggested) {
    box.append(h('div', { class: 'suggest-row' }, h('span', {}, '同じ話題かも？（自動でまとめました）'),
      btn('まとめる（採用）', () => app.edit('まとめを採用', (w) => { w.overrides.accepted = [...new Set([...w.overrides.accepted, t.id])]; }), 'btn btn-small btn-dark', { 'data-key': 'pv-accept' }),
      btn('バラす', () => app.edit('まとめをバラす', (w) => { w.overrides.split = [...new Set([...w.overrides.split, t.id])]; }), 'btn btn-small btn-dark', { 'data-key': 'pv-split' })));
  }
  // 台本
  const sc = scriptFor(app, t.id);
  const auto = leadText(t, app.postsById, app.ds.refTs);
  const botLead = Boolean(t.bot && t.bot.summary);
  const lead = h('textarea', { class: 'input', rows: 3, value: typeof sc.lead === 'string' && sc.lead.trim() ? sc.lead : auto, dataset: { key: 'pv-lead' } });
  lead.addEventListener('input', () => app.update((w) => { w.script[t.id] = { ...scriptFor(app, t.id), lead: lead.value === auto ? null : lead.value }; }, { render: false, debounce: true }));
  const points = h('textarea', { class: 'input', rows: 2, value: sc.points, dataset: { key: 'pv-points' }, placeholder: '話すポイント（自分用）' });
  points.addEventListener('input', () => app.update((w) => { w.script[t.id] = { ...scriptFor(app, t.id), points: points.value }; }, { render: false, debounce: true }));
  box.append(h('details', { class: 'pv-script', open: Boolean(u.scriptOpen) },
    h('summary', { on: { click: () => { u.scriptOpen = !u.scriptOpen; } } }, '台本（リード文・話すポイント）'),
    field('リード文', lead, botLead ? '（Grok のまとめ。書き換えできます）' : '（数字からの自動下書き。書き換えできます）'),
    botLead && !(typeof sc.lead === 'string' && sc.lead.trim()) ? h('p', { class: 'lead-mark-line' }, h('span', { class: 'lead-mark' }, 'Grok のまとめ'), 'リード文はボットの下書きです') : null,
    field('話すポイント', points)));
  // 代表投稿
  const id = t.stats.topPostId || t.linkId || null;
  if (id) {
    const p = app.postsById.get(id);
    const own = p ? postCard(p, { refTs: app.ds.refTs, refYear: refYear(app), noActions: true, bm: bmInfo(app, p.id) }) : linkCard(id, statusUrl(id), null);
    box.append(h('h4', { class: 'pv-sub' }, `代表投稿（${t.stats.count}件中）`),
      h('div', { class: 'pv-post', dataset: { keep: `pp:${id}` } }, app.ui.view !== 'card' ? embedHost(id, own, 'pv-embed') : own));
  }
  return box;
}

// ================================================================ キー操作（編成画面）

/** 編成画面のキー（元に戻す・やり直す・Ctrl+A・F2・仕分けモード）。処理したら true */
export function planKeydown(app, e) {
  if (app.ui.sort && sortKeydown(app, e)) return true;
  const mod = e.ctrlKey || e.metaKey;
  const typing = isEditable(e.target);
  if (mod && !typing && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) app.redo(); else app.undo(); return true; }
  if (mod && !typing && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); app.redo(); return true; }
  if (document.querySelector('#view dialog[open]')) return false;
  if (app.ui.menu && e.key === 'Escape') { app.ui.menu = null; app.render(); return true; }
  if (typing) return false;
  if (mod && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); app.ui.sel = selectAllRows(app.ui.rows || []); app.render(); return true; }
  if (e.key === 'F2') {
    const row = (app.ui.rows || []).find((r) => r.key === app.ui.focus);
    const tid = row && row.type === 'topic' ? row.id : (app.ui.folder.startsWith('topic:') ? app.ui.folder.slice(6) : null);
    if (tid) { e.preventDefault(); openRename(app, tid); return true; }
  }
  if ((e.key === 'm' || e.key === 'M') && !mod && selectedRows(app).length) { e.preventDefault(); app.ui.move = { rows: selectedRows(app) }; app.render(); return true; }
  if (e.key === 'Escape' && !isDragging()) {
    if (app.ui.pane === 'preview' && !wide()) { app.ui.pane = 'list'; app.render(); return true; }
    if (app.ui.sel.sel.size) { app.ui.sel = { sel: new Set(), anchor: null }; app.render(); return true; }
  }
  return false;
}

/** メニューの外を押したら閉じる */
export function planPointerDown(app, e) {
  if (app.ui.menu && !e.target.closest('.ctx-menu')) { app.ui.menu = null; app.render(); }
}

export { narrow };
