// 配信番組サイト（/show/）のエントリ。データ読み込み・状態・保存・画面切替（#plan / #live / #onair / #review）。
import { normalizeDataset, normalizeReports, parseTimestamp, formatDateTime } from '../assets/js/core.js';
import { createEmbedder } from '../assets/js/embed.js';
import { TEXT } from './js/config.js';
import {
  showWeekOf, weekByKey, shiftWeekKey, listWeeks, postsInWeek, buildTopics, indexTopics, buildCues, getWeek,
  defaultWeek, newSince, liveReduce, carriedTopicIds, syncCarriedOut, weekLabel, compareIds, bookmarkList, usedPostIdsOf,
} from './js/logic.js';
import { loadSaved, saveState, openSync } from './js/store.js';
import { h, clear, isEditable } from './js/dom.js';
import { renderPlan } from './js/views/plan.js';
import { renderLive, tickLive, liveKeydown } from './js/views/live.js';
import { renderOnair, tickOnair } from './js/views/onair.js';
import { renderReview } from './js/views/review.js';

const ROUTES = ['plan', 'live', 'onair', 'review'];
const $ = (id) => document.getElementById(id);

const app = {
  ds: null,
  postsById: new Map(),
  reports: null,
  bookmarks: null, // null = 機能非表示
  isSample: false,
  saved: null,
  weekKey: null,
  week: null,
  weeks: [],
  topics: [],
  topicsById: new Map(),
  cues: [],
  newInfo: null,
  weekPostIds: [],
  route: 'plan',
  ui: { filter: 'all', query: '', shown: 30, openScript: new Set(), bmMode: 'week' },
  bmFlags: new Map(),
  embedder: null,
  ready: false,
  clusterCache: {},
};
window.__show = app; // E2E・デバッグ用

// ================================================================ データ

async function fetchJson(url) {
  const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} を取得できませんでした（${res.status}）`);
  try { return await res.json(); } catch { throw new Error(`${url} の形式が正しくありません`); }
}

async function loadData() {
  const tryLoad = async (base) => {
    const [posts, reports, bookmarks] = await Promise.allSettled([
      fetchJson(`${base}posts.json`), fetchJson(`${base}reports.json`), fetchJson(`${base}bookmarks.json`),
    ]);
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
      reports: reports.status === 'fulfilled' ? normalizeReports(reports.value) : null,
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
  });
  app.topicsById = indexTopics(app.topics);
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
  clear(root);
  const view = { plan: renderPlan, live: renderLive, onair: renderOnair, review: renderReview }[app.route];
  app.afterRender = null;
  root.append(view(app));
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
    app.reports = d.reports;
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
  document.addEventListener('keydown', (e) => { if (app.route === 'live') liveKeydown(app, e); });
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

// 見出しフォント（Google Fonts）が読めたら印を付ける。読めなければシステムの太字のまま
try {
  if (document.fonts && document.fonts.load) {
    document.fonts.load('1em "Dela Gothic One"', '番組').then((list) => { if (list && list.length) document.documentElement.classList.add('has-display-font'); }, () => {});
  }
} catch { /* 無視 */ }

main();
