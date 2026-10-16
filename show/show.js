// 配信番組サイト（/show/）のエントリ。データ読み込み・状態・保存・画面切替（#plan / #live / #onair / #review）。
import { normalizeDataset, parseTimestamp, formatDateTime } from '../assets/js/core.js';
import { createEmbedder } from '../assets/js/embed.js';
import { TEXT, VIEW_PREF_KEY, SIDE_PREF_KEY } from './js/config.js';
import {
  showWeekOf, weekByKey, shiftWeekKey, listWeeks, postsInWeek, buildTopics, indexTopics, buildCues, getWeek,
  defaultWeek, newSince, liveReduce, carriedTopicIds, syncCarriedOut, weekLabel, compareIds, bookmarkList, usedPostIdsOf,
  partitionTopics, serializeSaved, parseSaved, shelveTopic, unshelveTopic, trashTopic, restoreTrash, hidePost, unhidePost,
} from './js/logic.js';
import { loadSaved, saveState, openSync } from './js/store.js';
import { h, clear, isEditable, startEmbeds } from './js/dom.js';
import { patchView } from './js/patch.js';
import { renderPlan, planKeydown } from './js/views/plan.js';
import { renderLive, tickLive, liveKeydown } from './js/views/live.js';
import { renderOnair, tickOnair } from './js/views/onair.js';
import { renderReview } from './js/views/review.js';

const ROUTES = ['plan', 'live', 'onair', 'review'];
const $ = (id) => document.getElementById(id);

const app = {
  ds: null,
  postsById: new Map(),
  bookmarks: null, // null = 機能非表示
  isSample: false,
  saved: null,
  weekKey: null,
  week: null,
  weeks: [],
  topics: [],
  visibleTopics: [],
  shelvedTopics: [],
  trashedTopics: [],
  topicsById: new Map(),
  cues: [],
  newInfo: null,
  weekPostIds: [],
  route: 'plan',
  ui: { filter: 'all', query: '', shown: 30, openScript: new Set(), bmMode: 'week', view: loadViewPref(), sideClosed: loadSidePref() },
  bmFlags: new Map(),
  embedder: null,
  ready: false,
  clusterCache: {},
};
window.__show = app; // E2E・デバッグ用

/** 候補・ブックマーク・進行の表示（'embed' 既定 / 'card'）。localStorage が使えなくても動く */
function loadViewPref() {
  try { return localStorage.getItem(VIEW_PREF_KEY) === 'card' ? 'card' : 'embed'; } catch { return 'embed'; }
}
/** 構成と台本のサイドパネルをたたんでいるか（localStorage に保持） */
function loadSidePref() {
  try { return localStorage.getItem(SIDE_PREF_KEY) === 'closed'; } catch { return false; }
}
app.setSideClosed = (closed) => {
  app.ui.sideClosed = Boolean(closed);
  try { localStorage.setItem(SIDE_PREF_KEY, closed ? 'closed' : 'open'); } catch { /* 保存できなくても切り替える */ }
  app.render();
};
app.setView = (v) => {
  app.ui.view = v === 'card' ? 'card' : 'embed';
  try { localStorage.setItem(VIEW_PREF_KEY, app.ui.view); } catch { /* 保存できなくても表示は切り替える */ }
  app.render();
};

// ================================================================ データ

async function fetchJson(url) {
  const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} を取得できませんでした（${res.status}）`);
  try { return await res.json(); } catch { throw new Error(`${url} の形式が正しくありません`); }
}

async function loadData() {
  const tryLoad = async (base) => {
    const [posts, bookmarks] = await Promise.allSettled([fetchJson(`${base}posts.json`), fetchJson(`${base}bookmarks.json`)]);
    if (posts.status !== 'fulfilled') throw posts.reason;
    const ds = normalizeDataset(posts.value); // 形式不正は例外
    // ブックマークで取り込まれた投稿の印（normalizeDataset は未知のフィールドを落とすので別に持つ）
    const bmFlags = new Map();
    for (const p of posts.value.posts) {
      if (p && p.in_bookmarks === true) bmFlags.set(String(p.id), { below: p.below_threshold === true });
    }
    return {
      ds,
      bmFlags,
      bookmarks: bookmarks.status === 'fulfilled' ? normalizeBookmarks(bookmarks.value) : null,
    };
  };
  try {
    return { ...(await tryLoad('../data/')), isSample: false };
  } catch (err) {
    const r = await tryLoad('../sample/show/');
    return { ...r, isSample: true, sampleReason: err && err.message ? err.message : '' };
  }
}

/** bookmarks.json: { generated_at, bookmarks: [{ id, url, bookmarked_at }] }。不正なら null（機能非表示） */
function normalizeBookmarks(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.bookmarks)) return null;
  const seen = new Set();
  return raw.bookmarks
    .filter((b) => b && /^\d{5,25}$/.test(String(b.id)))
    .map((b) => ({ id: String(b.id), url: typeof b.url === 'string' ? b.url : null, ts: parseTimestamp(typeof b.bookmarked_at === 'string' ? b.bookmarked_at : '') }))
    .filter((b) => (seen.has(b.id) ? false : seen.add(b.id)));
}

// ================================================================ 計算

/** 番組週のブックマーク（ブックマークした日時が週内。日時が無ければ投稿日時で判定） */
function weekBookmarks() {
  if (!app.bookmarks || !app.week) return [];
  return bookmarkList(app.bookmarks, app.week, app.postsById, new Set(), 'week');
}

function recompute() {
  const wk = getWeek(app.saved, app.weekKey);
  const weekPosts = postsInWeek(app.ds.posts, app.week);
  const inWeek = new Set(weekPosts.map((p) => p.id));
  const bms = weekBookmarks();
  const personalIds = new Set(wk.personal.map((p) => p.id));
  // 手入力とブックマークで同じ id は 1 つ（下の重複除去）。★の印は週の外のブックマークにも付ける
  const bookmarkIds = new Set((app.bookmarks || []).map((b) => b.id));
  const extraPosts = [];
  const missingIds = [];
  for (const id of [...personalIds, ...bms.map((b) => b.id)]) {
    const p = app.postsById.get(id);
    if (p) { if (!inWeek.has(id) && !extraPosts.includes(p)) extraPosts.push(p); } else if (!missingIds.includes(id)) missingIds.push(id);
  }
  const prevKey = shiftWeekKey(app.weekKey, -1);
  const carried = prevKey ? getWeek(app.saved, prevKey).carriedOut : [];
  app.topics = buildTopics({
    posts: weekPosts, extraPosts, missingIds: missingIds.sort(compareIds), personalIds, bookmarkIds, carried,
    postsById: app.postsById, dict: app.saved.dict, overrides: wk.overrides, refTs: app.ds.refTs, cache: app.clusterCache,
    hiddenPostIds: new Set(app.saved.hiddenPosts.map((x) => x.id)),
  });
  app.topicsById = indexTopics(app.topics);
  // 候補に出す話題（片付け・削除を除く）
  const part = partitionTopics(app.topics, wk, app.saved.trash);
  app.visibleTopics = part.visible;
  app.shelvedTopics = part.shelved;
  app.trashedTopics = part.trashed;
  app.cues = buildCues(wk.rundown, app.topicsById);
  app.weekPostIds = [...weekPosts.map((p) => p.id), ...extraPosts.map((p) => p.id)];
  app.newInfo = newSince(wk, app.weekPostIds, app.topics);
}

app.weekState = () => getWeek(app.saved, app.weekKey);
app.prevWeekKey = () => shiftWeekKey(app.weekKey, -1);
app.nextWeekKey = () => shiftWeekKey(app.weekKey, 1);
app.weekBookmarks = weekBookmarks;

// ================================================================ 状態の更新・保存

let saveTimer = null;
let sync = null;

function ensureWeek() {
  if (!app.saved.weeks[app.weekKey]) app.saved.weeks[app.weekKey] = defaultWeek();
  return app.saved.weeks[app.weekKey];
}

/**
 * 状態を変える。mut(week, saved) で書き換え、保存・同期・再描画。
 * opts: { topics: 話題を作り直す, render: 再描画, debounce: 保存を遅らせる（文字入力） }
 */
app.update = (mut, opts = {}) => {
  const { topics = false, render = true, debounce = false } = opts;
  const wk = ensureWeek();
  mut(wk, app.saved);
  if (topics) recompute();
  else app.cues = buildCues(wk.rundown, app.topicsById);
  if (debounce) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 400);
  } else persist();
  if (render) renderRoute();
};

function persist() {
  clearTimeout(saveTimer);
  if (app.route === 'onair') return; // 映す用は読むだけ
  app.saved.activeWeek = app.weekKey;
  const r = saveState(app.saved, app.weekKey);
  if (r.ok) {
    app.saved = r.state;
    setSaveStatus(r.pruned ? '容量が一杯のため古い週の保存を整理しました' : `自動保存 ${formatDateTime(null, Math.floor(r.state.savedAt / 1000))}`, r.pruned ? 'warn' : 'ok');
  } else setSaveStatus(r.error, 'error');
  if (sync) sync.post(app.saved);
}

/** 読み込んだ保存データで置き換える（書き出しファイルの読み込み） */
app.replaceSaved = (state) => {
  app.saved = state;
  if (state.activeWeek && app.weeks.some((w) => w.key === state.activeWeek)) setWeek(state.activeWeek, false);
  app.clusterCache = {};
  recompute();
  persist();
  renderRoute();
};

/** 進行の操作（読んだ・飛ばす・来週へ・戻す・開始・移動・リセット） */
app.liveAction = (type, extra = {}) => {
  app.update((wk) => {
    const prev = wk.live;
    wk.live = liveReduce(prev, { type, now: Date.now(), ...extra }, app.cues);
    const ids = carriedTopicIds(wk.live, app.cues);
    wk.carriedOut = syncCarriedOut(wk.carriedOut, app.topicsById, ids, app.weekKey, wk.script);
    wk.usedPostIds = usedPostIdsOf(wk.live, app.cues, app.topicsById);
  });
};

// ================================================================ 整理（片付け・削除）と元に戻す

let toastTimer = null;
/** 画面下のお知らせ（「元に戻す」つき）。onUndo が無ければ文だけ */
function toast(text, onUndo = null) {
  let el = $('toast');
  if (!el) {
    el = h('div', { id: 'toast', class: 'toast', attrs: { role: 'status', 'aria-live': 'polite' } });
    document.body.append(el);
  }
  clear(el);
  el.append(h('span', { class: 'toast-text' }, text));
  if (onUndo) {
    el.append(h('button', { type: 'button', class: 'btn btn-small toast-undo', dataset: { key: 'toast-undo' }, on: { click: () => { hide(); onUndo(); } } }, '元に戻す'));
  }
  el.hidden = false;
  const hide = () => { el.hidden = true; clearTimeout(toastTimer); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hide, 8000);
}
app.toast = toast;

/** 操作の前の状態を覚えておき、直後のトーストから「元に戻す」 */
function withUndo(message, mutate) {
  const before = serializeSaved(app.saved);
  app.update(mutate, { topics: true });
  toast(message, () => {
    const r = parseSaved(before);
    if (r.ok) { app.replaceSaved(r.state); toast('元に戻しました'); }
  });
}

app.shelve = (topic) => withUndo(`「${topic.name}」を片付けました（この週の候補から外しました）`, (w) => {
  Object.assign(w, shelveTopic(w, topic, Date.now()));
});
app.unshelve = (topicId) => {
  let placed = false;
  app.update((w) => { const r = unshelveTopic(w, topicId); Object.assign(w, r.week); placed = r.placed; }, { topics: true });
  toast(placed ? '候補に戻し、元の枠にも戻しました' : '候補に戻しました');
};
app.trash = (topic) => withUndo(`「${topic.name}」を削除しました（ゴミ箱へ。今後の週にも出しません）`, (w, s) => {
  const r = trashTopic(s, w, topic, app.weekKey, Date.now());
  s.trash = r.saved.trash;
  Object.assign(w, r.week);
});
app.restoreTrash = (ids) => {
  let placed = 0;
  app.update((w, s) => {
    for (const id of ids) {
      const r = restoreTrash(s, w, id, app.weekKey);
      s.trash = r.saved.trash;
      Object.assign(w, r.week);
      if (r.placed) placed++;
    }
  }, { topics: true });
  toast(placed ? `ゴミ箱から戻しました（${placed}件は元の枠にも戻しました）` : 'ゴミ箱から戻しました');
};
app.hidePost = (postId, topicName) => withUndo('投稿を削除しました（どの話題にも出しません。ゴミ箱から戻せます）', (w, s) => {
  s.hiddenPosts = hidePost(s, postId, app.weekKey, Date.now(), topicName).hiddenPosts;
});
app.unhidePost = (postId) => {
  app.update((w, s) => { s.hiddenPosts = unhidePost(s, postId).hiddenPosts; }, { topics: true });
  toast('投稿を戻しました');
};
app.restoreAllTrash = () => {
  const ids = app.saved.trash.map((x) => x.id);
  app.restoreTrash(ids);
  app.update((w, s) => { s.hiddenPosts = []; }, { topics: true });
};

function setSaveStatus(text, kind = 'ok') {
  const el = $('save-status');
  if (!el) return;
  el.textContent = text;
  el.dataset.kind = kind;
}
app.setSaveStatus = setSaveStatus;

// ================================================================ 週

function setWeek(key, save = true) {
  const w = weekByKey(key);
  if (!w) return;
  app.weekKey = w.key;
  app.week = w;
  app.ui.shown = 30;
  if (save && app.saved) { app.saved.activeWeek = w.key; persist(); }
}

function renderWeekPicker() {
  const sel = $('week-select');
  clear(sel);
  for (const w of app.weeks) {
    const isCur = w.key === app.weeks[0].key;
    const isNext = w.key === app.nextOfCurrent;
    const label = `${w.key.slice(5).replace('-', '/')} 配信${isCur ? '（今週）' : isNext ? '（来週・データ待ち）' : ''}`;
    sel.append(h('option', { value: w.key, selected: w.key === app.weekKey, attrs: { title: weekLabel(w) } }, label));
  }
}

// ================================================================ 画面

function currentRoute() {
  const r = location.hash.replace(/^#/, '');
  return ROUTES.includes(r) ? r : 'plan';
}

let lastFocusKey = null;

function renderRoute() {
  if (!app.ready) return;
  app.route = currentRoute();
  document.body.dataset.route = app.route;
  for (const a of document.querySelectorAll('.screen-tabs a')) {
    if (a.dataset.route === app.route) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  $('week-range').textContent = weekLabel(app.week);
  renderWeekPicker();
  const root = $('view');
  // 再描画してもフォーカスを失わないよう、data-key でたどる
  const active = document.activeElement;
  lastFocusKey = active && root.contains(active) && active.dataset ? active.dataset.key || null : null;
  const view = { plan: renderPlan, live: renderLive, onair: renderOnair, review: renderReview }[app.route];
  // 同じ画面・同じ週の再描画は差し替え（patch.js）で、表示済みの X 埋め込みを作り直さない
  const old = root.firstElementChild;
  const sameScreen = old && old.dataset.keep && old.dataset.keep === `${app.route}:${app.weekKey}`;
  if (!sameScreen && app.embedder) app.embedder.reset();
  app.afterRender = null;
  const fresh = view(app);
  if (!(sameScreen && patchView(old, fresh))) { clear(root); root.append(fresh); }
  startEmbeds(root, app.embedder);
  if (app.afterRender) app.afterRender();
  if (lastFocusKey) {
    const el = root.querySelector(`[data-key="${CSS.escape(lastFocusKey)}"]`);
    if (el && !el.disabled) el.focus({ preventScroll: true });
  }
  document.title = `${{ plan: '編成', live: '進行', onair: '映す用', review: '振り返り' }[app.route]}｜${app.saved.showName}`;
}
app.render = renderRoute;

// ほかのタブからの変更（映す用は進行に追従。入力中のタブは入力が終わってから描き直す）
let pendingRemote = false;
function onRemoteState(state) {
  app.saved = state;
  if (state.activeWeek && state.activeWeek !== app.weekKey && weekByKey(state.activeWeek) && app.weeks.some((w) => w.key === state.activeWeek)) setWeek(state.activeWeek, false);
  recompute();
  if (isEditable(document.activeElement) && app.route !== 'onair') { pendingRemote = true; return; }
  renderRoute();
}
document.addEventListener('focusout', () => {
  if (!pendingRemote) return;
  setTimeout(() => { if (!isEditable(document.activeElement)) { pendingRemote = false; renderRoute(); } }, 0);
});

// ================================================================ 起動

async function main() {
  const main = $('main');
  $('reload').addEventListener('click', () => location.reload());
  try {
    const d = await loadData();
    app.ds = d.ds;
    app.bookmarks = d.bookmarks;
    app.bmFlags = d.bmFlags;
    app.isSample = d.isSample;
    app.postsById = new Map(d.ds.posts.map((p) => [p.id, p]));
    if (d.isSample) {
      $('sample-banner').hidden = false;
      $('sample-banner').querySelector('strong').textContent = TEXT.sampleBanner;
      $('sample-reason').textContent = d.sampleReason || '';
    }
  } catch (err) {
    $('loading').hidden = true;
    $('error').hidden = false;
    $('error-detail').textContent = err && err.message ? err.message : String(err);
    main.setAttribute('aria-busy', 'false');
    return;
  }
  const loaded = loadSaved();
  app.saved = loaded.state;
  if (loaded.note) setSaveStatus(loaded.note, 'warn');

  const refTs = app.ds.refTs ?? Math.floor(Date.now() / 1000);
  const cur = showWeekOf(refTs);
  app.weeks = listWeeks(refTs, app.ds.minTs, 8);
  const next = weekByKey(shiftWeekKey(cur.key, 1));
  app.nextOfCurrent = next.key;
  app.weeks = [next, ...app.weeks].sort((a, b) => (a.key < b.key ? 1 : -1));
  // 保存された週（範囲内）か、データの週
  const want = app.saved.activeWeek && app.weeks.some((w) => w.key === app.saved.activeWeek) ? app.saved.activeWeek : cur.key;
  setWeek(want, false);
  $('data-time').textContent = app.ds.refTs ? `データ ${formatDateTime(app.ds.generated_at, app.ds.refTs)} 時点` : 'データの時刻 不明';

  app.embedder = createEmbedder({ getTheme: () => 'dark' });
  recompute();
  sync = openSync(onRemoteState);

  $('week-select').addEventListener('change', (e) => {
    setWeek(e.target.value);
    recompute();
    renderRoute();
  });
  window.addEventListener('hashchange', renderRoute);
  document.addEventListener('keydown', (e) => {
    if (app.route === 'live') liveKeydown(app, e);
    else if (app.route === 'plan') planKeydown(app, e);
  });
  // 開いたメニュー（番組に入れる ▾ / …）は外側をクリックしたら閉じる
  document.addEventListener('click', (e) => {
    for (const d of document.querySelectorAll('details.menu[open]')) if (!d.contains(e.target)) d.open = false;
  });
  setInterval(() => {
    if (app.route === 'live') tickLive(app);
    else if (app.route === 'onair') tickOnair(app);
  }, 1000);
  window.addEventListener('resize', () => { if (app.route === 'onair') tickOnair(app, true); });

  $('loading').hidden = true;
  $('app').hidden = false;
  main.setAttribute('aria-busy', 'false');
  app.ready = true;
  renderRoute();
}

main();
