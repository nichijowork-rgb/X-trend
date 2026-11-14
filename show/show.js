// 配信番組サイト（/show/）のエントリ。データ読み込み・状態・保存・画面切替（#plan / #live / #onair / #review）。
import { normalizeDataset, parseTimestamp, formatDateTime } from '../assets/js/core.js';
import { createEmbedder } from '../assets/js/embed.js';
import { TEXT, VIEW_PREF_KEY, SIDE_PREF_KEY, RANGE_PRESETS } from './js/config.js';
import {
  showWeekOf, weekByKey, shiftWeekKey, listWeeks, postsInWeek, buildTopics, indexTopics, buildCues, getWeek,
  defaultWeek, newSince, liveReduce, carriedTopicIds, syncCarriedOut, weekLabel, compareIds, bookmarkList, usedPostIdsOf,
  partitionTopics, serializeSaved, parseSaved, shelveTopic, unshelveTopic, trashTopic, restoreTrash, hidePost, unhidePost,
  applyGenreOverrides, majorityGenre, pastUsedIds, usedTopicIds, normalizePriorityGenre,
  resolveRange, sanitizeRange, recommendCount, placedPostIds, toJstInput, fromJstInput, topicItemIds, isImageItem, extractStatusIds,
} from './js/logic.js';
import { postTopicMap, recommendGeneral, createHistory, recordHistory, undoHistory, redoHistory, addPostsToTopic } from './js/folders.js';
import { publishLiveState } from './js/events.js';
import { normalizeBotTopics } from './js/bot.js';
import { createAutoSender } from './js/autosend.js';
import { fetchOembed, estimateGenre, sanitizeLinkMeta, OEMBED_GAP_MS } from './js/oembed.js';
import { parseViewerPrefs, openViewer, isXUrl, screenSnapshot, VIEWER_PREF_KEY } from './js/viewer.js';
import { IMAGE_LIMITS, checkImageFile, decodeImage, shrinkImage, canvasEncoder, shortHash, newImageId, validImageDataUrl } from './js/imaging.js';
import { putImage, getImage, deleteImage, imageKeys } from './js/imagestore.js';
import { applyScriptImport } from './js/scriptimport.js';
import { prepareHoldTerms, heldPostsOf, heldTopicsOf, removeHoldTerm } from './js/hold.js';
import { makeEffect, createCooldown, EFFECT_TTL_MS, effectDef } from './js/effects.js';
import { buildFeedback, saveFeedbackToGitHub, parseGhPrefs, GH_PREF_KEY, FEEDBACK_SENT_KEY } from './js/feedback.js';
import { buildPayload, samePayload, OBS_EVENT_NAME, OVERLAY_CHANNEL, RESEND_MS, demoPayload, mediaPlan } from './js/payload.js';
import { createObsClient, parseObsPrefs, OBS_PREF_KEY } from './js/obs.js';
import {
  YT_CHAT_PREF_KEY, CHAT_LOG_MAX, parseChatPrefs, parseVideoId, validKey, looksLikeGoogleKey, createChatPoller, applyChatBatch, ngMatcher, parseNgWords,
  buildChatMessage, sanitizeChatCfg, restorePin, demoChatItem, quotaUnits,
} from './js/ytchat.js';
import { refreshChatPanel } from './js/views/chatui.js';
import { obsStatusLabel, renderObsSetup, refreshObsDialog } from './js/views/obsui.js';
import { loadSaved, saveState, openSync } from './js/store.js';
import { h, clear, isEditable, startEmbeds } from './js/dom.js';
import { patchView } from './js/patch.js';
import { renderPlan, planKeydown, planPointerDown } from './js/views/plan.js';
import { renderLive, tickLive, liveKeydown } from './js/views/live.js';
import { renderOnair, tickOnair } from './js/views/onair.js';
import { renderReview } from './js/views/review.js';

const ROUTES = ['plan', 'live', 'onair', 'review', 'obs-setup'];
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
  pickIds: new Set(), // ボットの雑談おすすめ（show_pick: true）
  pickReasons: new Map(), // show_pick_reason（投稿 id → 理由）
  bot: null, // 段階3: data/show/topics.json（normalizeBotTopics の結果。無ければ null）
  basePostsById: new Map(), // 上書き前の投稿
  postTopic: new Map(),
  recommended: new Set(),
  history: createHistory(),
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
  const tryLoad = async (base, botUrl) => {
    const [posts, bookmarks, botRaw] = await Promise.allSettled([fetchJson(`${base}posts.json`), fetchJson(`${base}bookmarks.json`), fetchJson(botUrl)]);
    if (posts.status !== 'fulfilled') throw posts.reason;
    const ds = normalizeDataset(posts.value); // 形式不正は例外
    // ブックマークで取り込まれた投稿の印（normalizeDataset は未知のフィールドを落とすので別に持つ）
    const bmFlags = new Map();
    const pickIds = new Set();
    const pickReasons = new Map();
    for (const p of posts.value.posts) {
      if (p && p.in_bookmarks === true) bmFlags.set(String(p.id), { below: p.below_threshold === true });
      if (p && p.show_pick === true) { // 段階3: ボットの雑談おすすめ（理由は任意）
        pickIds.add(String(p.id));
        if (typeof p.show_pick_reason === 'string' && p.show_pick_reason.trim()) pickReasons.set(String(p.id), p.show_pick_reason.trim().slice(0, 200));
      }
    }
    // 段階3: ボットの話題まとめ（任意。無い・壊れているときは使わない）
    const bot = botRaw.status === 'fulfilled' ? normalizeBotTopics(botRaw.value) : null;
    return {
      ds,
      bmFlags,
      pickIds,
      pickReasons,
      bot,
      bookmarks: bookmarks.status === 'fulfilled' ? normalizeBookmarks(bookmarks.value) : null,
    };
  };
  try {
    return { ...(await tryLoad('../data/', '../data/show/topics.json')), isSample: false };
  } catch (err) {
    const r = await tryLoad('../sample/show/', '../sample/show/topics.json');
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
  // 対象期間（既定は番組週）でしぼる
  return bookmarkList(app.bookmarks, app.range || app.week, app.postsById, new Set(), 'week');
}

const overrideCache = new Map();

function recompute() {
  const wk = getWeek(app.saved, app.weekKey);
  // 投稿のジャンル上書き（投稿 id ごと・全週）を当てた投稿で話題を作る
  const allPosts = applyGenreOverrides(app.ds.posts, app.saved.genreOverrides, overrideCache);
  app.postsById = allPosts === app.ds.posts ? app.basePostsById : new Map(allPosts.map((p) => [p.id, p]));
  // 対象期間（番組週ごとに選ぶ。既定は番組週）
  app.range = resolveRange(wk.range, app.week, app.ds.refTs);
  const weekPosts = postsInWeek(allPosts, app.range);
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
  const hidden = new Set(app.saved.hiddenPosts.map((x) => x.id));
  // 期間外: 番組構成（メイン枠・メイン候補・コーナー）に入っている話題の投稿は、期間を変えても外さずに残す（「期間外」の印）
  const placedList = [...usedTopicIds(wk.rundown), ...(wk.mainCand || [])];
  // topic:・辞書の話題は「番組週の投稿」だけ照合する（期間の外の古い投稿まで勝手に足さない）
  const candidates = placedList.length && !app.range.isWeek ? postsInWeek(allPosts, app.week).filter((p) => !inWeek.has(p.id)) : [];
  const outsideIds = new Set();
  const addOutside = (ids) => {
    for (const id of ids) {
      if (inWeek.has(id) || outsideIds.has(id) || hidden.has(id)) continue;
      const p = app.postsById.get(id);
      if (!p) continue;
      outsideIds.add(id);
      if (!extraPosts.includes(p)) extraPosts.push(p);
    }
  };
  // URL で追加した投稿があとから posts.json に現れたとき、期間の外でもその話題に残す（「期間外」の印）
  const linkIds = Object.values(wk.topicLinks || {}).flat();
  addOutside(linkIds.filter((id) => app.postsById.has(id)));
  if (placedList.length) addOutside(placedPostIds({ placedIds: placedList, candidates, dict: app.saved.dict, botTopics: app.bot ? app.bot.topics : [], overrides: wk.overrides }));
  const build = (hiddenPostIds) => buildTopics({
    outsideIds,
    posts: weekPosts, extraPosts, missingIds: missingIds.sort(compareIds), personalIds, bookmarkIds, carried,
    postsById: app.postsById, dict: app.saved.dict, overrides: wk.overrides, refTs: app.ds.refTs, cache: app.clusterCache,
    hiddenPostIds, botTopics: app.bot ? app.bot.topics : [], pinnedIds: pinnedTopicIds(wk), priorityGenre: app.saved.priorityGenre,
    postOrder: wk.postOrder, topicLinks: wk.topicLinks,
  });
  app.topics = build(hidden);
  // 類似まとめ（c:）などで話題 id から投稿が分からず構成の話題が消えたときは、期間外の候補も入れて作り直し、その話題の投稿を戻す
  const missing = placedList.filter((id) => !app.topics.some((t) => t.id === id) && !id.startsWith('x:'));
  if (missing.length && candidates.length) {
    const full = buildTopics({ posts: [...weekPosts, ...candidates], dict: app.saved.dict, overrides: wk.overrides, refTs: app.ds.refTs, cache: app.clusterCache, hiddenPostIds: hidden, botTopics: app.bot ? app.bot.topics : [], pinnedIds: pinnedTopicIds(wk), priorityGenre: app.saved.priorityGenre, carried, postsById: app.postsById });
    const before = outsideIds.size;
    for (const t of full) if (missing.includes(t.id)) addOutside(t.postIds);
    if (outsideIds.size > before) app.topics = build(hidden);
  }
  app.outsideIds = outsideIds;
  // 保留する言葉: 一致した投稿は話題から外し（手で置いた話題の投稿・移動・自分で追加したものは除く）、話題名が一致した話題は保留へ
  const prepared = prepareHoldTerms(app.saved.holdTerms);
  const exceptions = new Set(app.saved.holdExceptions);
  const placed = new Set([...usedTopicIds(wk.rundown), ...(wk.mainCand || [])]);
  app.heldPosts = heldPostsOf({
    posts: [...weekPosts, ...extraPosts], topics: app.topics, prepared, exceptions, protectedTopicIds: placed,
    protectedPostIds: new Set([...Object.keys(wk.overrides.moves), ...personalIds, ...outsideIds, ...linkIds]),
    // 台本ファイルの「保留」（投稿 id で指定）
    forced: new Map((wk.scriptHold || []).flatMap((x) => x.postIds.map((id) => [id, `台本：${x.name}`]))),
  });
  for (const id of hidden) app.heldPosts.delete(id);
  if (app.heldPosts.size) app.topics = build(new Set([...hidden, ...app.heldPosts.keys()]));
  app.topicsById = indexTopics(app.topics);
  // 候補に出す話題（片付け・削除・保留を除く）
  const part = partitionTopics(app.topics, wk, app.saved.trash);
  app.heldTopicTerms = heldTopicsOf(part.visible, prepared, exceptions, placed);
  app.heldTopics = part.visible.filter((t) => app.heldTopicTerms.has(t.id));
  app.visibleTopics = part.visible.filter((t) => !app.heldTopicTerms.has(t.id));
  app.shelvedTopics = part.shelved;
  app.trashedTopics = part.trashed;
  app.cues = buildCues(wk.rundown, app.topicsById);
  app.weekPostIds = [...weekPosts.map((p) => p.id), ...extraPosts.map((p) => p.id)];
  app.weekPosts = [...weekPosts, ...extraPosts].filter((p) => !app.heldPosts.has(p.id));
  app.newInfo = newSince(wk, app.weekPostIds, app.topics);
  app.postTopic = postTopicMap(app.topics);
  // 一般のバズのおすすめ件数は期間の日数に比例（7日で 30 件）
  app.recommendN = recommendCount(app.range.days);
  app.recommended = recommendGeneral(app.visibleTopics, app.recommendN, app.pickIds);
  app.rangePostCount = weekPosts.length;
  app.bookmarkPosts = app.bookmarks ? bms.map((b) => app.postsById.get(b.id)).filter(Boolean) : null;
  app.bookmarkPostsAll = app.bookmarks ? app.bookmarks.map((b) => app.postsById.get(b.id)).filter(Boolean) : null;
  app.usedBefore = pastUsedIds(app.saved, app.weekKey);
}

/** ユーザーが手を入れた話題 id（ボットのまとめより優先する。番組構成・メイン候補・名前・ジャンル・結合・移動先・片付け・削除） */
function pinnedTopicIds(wk) {
  const ov = wk.overrides;
  return new Set([
    ...usedTopicIds(wk.rundown), ...(wk.mainCand || []), ...Object.keys(ov.renames), ...Object.keys(ov.genres),
    ...Object.keys(ov.merges), ...Object.values(ov.merges), ...Object.values(ov.moves), ...ov.accepted,
    ...(wk.shelved || []).map((x) => x.topicId), ...app.saved.trash.map((x) => x.topicId),
  ]);
}

// ---------------------------------------------------------------- 段階3: ボットへの修正の書き戻し

/** 今の全修正（feedback/show-feedback.json の中身） */
app.buildFeedback = () => buildFeedback({ saved: app.saved, weekKey: app.weekKey, topics: app.topics, basePostsById: app.basePostsById, nowMs: Date.now() });

app.feedbackSent = () => {
  try {
    const o = JSON.parse(localStorage.getItem(FEEDBACK_SENT_KEY) || 'null');
    return o && Number.isFinite(o.at) ? { at: o.at, via: o.via === 'github' ? 'github' : 'download' } : null;
  } catch { return null; }
};
app.markFeedbackSent = (via) => {
  try { localStorage.setItem(FEEDBACK_SENT_KEY, JSON.stringify({ at: Date.now(), via })); } catch { /* 保存できなくても続ける */ }
  app.render();
};

function loadGhPrefs() {
  try { return parseGhPrefs(localStorage.getItem(GH_PREF_KEY)); } catch { return parseGhPrefs(null); }
}
app.ghPrefs = loadGhPrefs();
app.saveGhPrefs = (v) => {
  app.ghPrefs = parseGhPrefs({ ...app.ghPrefs, ...v });
  try { localStorage.setItem(GH_PREF_KEY, JSON.stringify(app.ghPrefs)); } catch { /* このブラウザでは保存できない（今回だけ使う） */ }
  if (app.autoSend) app.autoSend.setEnabled(autoEnabled());
  updateBotPill();
};
// ---------------------------------------------------------------- ボットへの修正の自動送信（最後の編集から 60 秒・URL 追加は 15 秒・最短 5 分おき）

const AUTOSEND_KEY = 'xtrend-show-autosend';
function loadAutoState() {
  try { const o = JSON.parse(localStorage.getItem(AUTOSEND_KEY) || 'null'); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}
function saveAutoState(st) {
  try { localStorage.setItem(AUTOSEND_KEY, JSON.stringify({ lastSentAt: st.lastSentAt, lastHash: st.lastHash, pendingSince: st.pendingSince })); } catch { /* 保存できなくても動く */ }
}
const autoEnabled = () => Boolean(app.ghPrefs && app.ghPrefs.token && app.ghPrefs.auto !== false);
app.autoSendState = null;
function initAutoSend() {
  const restore = loadAutoState();
  // 確認用（E2E）: 待ち時間を短くする（localStorage xtrend-show-autosend-delays。ふだんは使わない）
  let delays;
  try { const d = JSON.parse(localStorage.getItem('xtrend-show-autosend-delays') || 'null'); if (d && typeof d === 'object') delays = d; } catch { delays = undefined; }
  app.autoSend = createAutoSender({
    enabled: autoEnabled(),
    restore,
    delays,
    getContent: () => (app.saved ? `${JSON.stringify(app.buildFeedback(), null, 2)}\n` : null),
    send: async (content) => {
      const p = app.ghPrefs;
      const r = await saveFeedbackToGitHub({ repo: p.repo, branch: p.branch, token: p.token, content });
      if (r.ok) { try { localStorage.setItem(FEEDBACK_SENT_KEY, JSON.stringify({ at: Date.now(), via: 'github' })); } catch { /* 無視 */ } }
      return r;
    },
    onState: (st) => { app.autoSendState = st; saveAutoState(st); updateBotPill(); },
  });
  app.autoSendState = app.autoSend.state();
  // 前回、送る前にタブを閉じた分があれば知らせて送る
  if (restore.pendingSince && autoEnabled()) { toast('前回送れなかったボットへの修正があります。自動で送ります'); app.autoSend.flush(); }
  updateBotPill();
}
const clock = (ms) => { const d = new Date(ms + 9 * 3600 * 1000); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
/** ヘッダーの小さなピル（編成・進行）: ボット送信の状態 */
function updateBotPill() {
  const pill = $('bot-pill');
  if (!pill) return;
  const st = app.autoSendState;
  const show = (app.route === 'plan' || app.route === 'live') && Boolean(app.ghPrefs && app.ghPrefs.token) && st;
  pill.hidden = !show;
  if (!show) return;
  const label = !st.enabled ? 'ボット送信：自動オフ'
    : st.status === 'sending' ? 'ボット送信：送信中…'
      : st.status === 'pending' ? `ボット送信：送信待ち${st.nextAt ? `（${clock(st.nextAt)}ごろ）` : ''}`
        : st.status === 'error' ? 'ボット送信：失敗（やり直します）'
          : st.status === 'stopped' ? 'ボット送信：止めました（要確認）'
            : st.lastSentAt ? `ボット送信：済 ${clock(st.lastSentAt)}` : 'ボット送信：変更なし';
  pill.textContent = label;
  pill.dataset.state = st.enabled ? st.status : 'off';
  pill.title = st.reason ? `理由：${st.reason}（押すと今すぐ送り直します）` : '押すと今すぐ送ります（自動送信は［ツール…］で切り替え）';
}
app.updateBotPill = updateBotPill;
app.setAutoSend = (on) => {
  app.saveGhPrefs({ auto: Boolean(on) });
  if (app.autoSend) app.autoSend.setEnabled(autoEnabled());
  updateBotPill();
};

/** GitHub の feedback/show-feedback.json に保存（GET で sha → PUT。ぶつかったら 1 回だけやり直す） */
app.sendFeedbackGitHub = async (v) => {
  if (app.ui.fbBusy) return;
  app.saveGhPrefs(v);
  const p = app.ghPrefs;
  app.ui.fbBusy = true;
  app.ui.fbMsg = { kind: 'ok', text: 'GitHub に保存しています…' };
  app.render();
  const content = `${JSON.stringify(app.buildFeedback(), null, 2)}\n`;
  const r = await saveFeedbackToGitHub({ repo: p.repo, branch: p.branch, token: p.token, content });
  app.ui.fbBusy = false;
  if (r.ok) {
    const url = r.commitUrl && /^https:\/\/github\.com\//.test(r.commitUrl) ? r.commitUrl : null;
    app.ui.fbMsg = { kind: 'ok', text: `GitHub に保存しました（${p.repo} の ${p.branch}・feedback/show-feedback.json）。`, url };
    if (app.autoSend) app.autoSend.markSent(content);
    app.markFeedbackSent('github');
  } else {
    app.ui.fbMsg = { kind: 'error', text: `保存できませんでした：${r.message}` };
    app.render();
  }
};

// ---------------------------------------------------------------- 話題の中の並び・自分で追加した画像（進行の改修）

/** 進行の並び（手動順 → 無ければ インプレ順／古い順。データに無い投稿と画像は後ろ） */
app.itemsFor = (topic) => {
  if (!topic || !app.saved) return [];
  const wk = app.weekState();
  const imgs = (wk.images || []).filter((x) => x.topicId === topic.id);
  return topicItemIds(topic, { postsById: app.postsById, order: wk.live.order, manual: wk.postOrder[topic.id] || null, images: imgs });
};
app.topicImages = (topicId) => (app.weekState().images || []).filter((x) => x.topicId === topicId);

/** 話題の中の手動順を保存（先頭が代表投稿。元に戻せる） */
app.setItemOrder = (topicId, list, label = '投稿の並べ替え') => {
  app.edit(label, (w) => { w.postOrder = { ...w.postOrder, [topicId]: [...list] }; });
};
/** 手動順をやめて インプレ順／古い順 に */
app.setLiveOrder = (topicId, order) => {
  const wk = app.weekState();
  if (wk.postOrder[topicId]) app.edit('手動順をやめる', (w) => { const po = { ...w.postOrder }; delete po[topicId]; w.postOrder = po; w.live = liveReduce(w.live, { type: 'order', order }, app.cues); });
  else app.liveAction('order', { order });
};
/** 話題から外す（投稿は 1 件の話題へ、データに無い投稿は外す、画像は消す） */
app.removeItem = (topic, id) => {
  app.edit('話題から外す', (w) => {
    if (isImageItem(id)) w.images = w.images.filter((x) => `img:${x.id}` !== id);
    else if ((topic.missingIds || []).includes(id)) {
      w.overrides.manual = w.overrides.manual.map((m) => (m.id === topic.id ? { ...m, missing: (m.missing || []).filter((x) => x !== id) } : m));
      if (w.topicLinks && w.topicLinks[topic.id]) w.topicLinks = { ...w.topicLinks, [topic.id]: w.topicLinks[topic.id].filter((x) => x !== id) };
    }
    else w.overrides.moves = { ...w.overrides.moves, [id]: `p:${id}` };
    if (w.postOrder[topic.id]) w.postOrder = { ...w.postOrder, [topic.id]: w.postOrder[topic.id].filter((x) => x !== id) };
  }, { toastText: isImageItem(id) ? '画像を外しました' : '話題から外しました（受信箱に戻りました）' });
};
/** この投稿を削除（非表示。画像は外す） */
app.hideItem = (topic, id) => {
  if (isImageItem(id)) { app.removeItem(topic, id); return; }
  app.edit('投稿の削除', (w, s) => {
    s.hiddenPosts = hidePost(s, id, app.weekKey, Date.now(), topic.name).hiddenPosts;
    if (w.postOrder[topic.id]) w.postOrder = { ...w.postOrder, [topic.id]: w.postOrder[topic.id].filter((x) => x !== id) };
  }, { toastText: '投稿を削除しました（どの話題にも出しません。ゴミ箱から戻せます）' });
};

/**
 * まとまりに X の URL から投稿を足す（1 回の編集。Ctrl+Z で戻せる）。
 * 返り値: { result（addPostsToTopic の結果）, invalid（読み取れなかった文字列）} 。別のまとまりにある投稿は move が true のときだけ移す
 */
app.addUrlsToTopic = (topicId, text, move = false) => {
  const t = app.topicsById.get(topicId);
  const ex = extractStatusIds(text);
  if (!t) return { result: null, invalid: ex.invalid };
  let result = null;
  const ids = ex.ids.map((x) => x.id);
  // 移すものがあるかを先に確かめる（ここでは書き換えない）
  const probe = addPostsToTopic(JSON.parse(JSON.stringify(app.weekState())), t, ids, { postsById: app.basePostsById, postTopic: app.postTopic, topicsById: app.topicsById, inRange: new Set(app.weekPosts.map((p) => p.id)), move });
  if (!probe.added.length && !probe.missing.length) return { result: probe, invalid: ex.invalid };
  app.edit(`URL で追加「${t.name}」`, (w) => {
    result = addPostsToTopic(w, t, ids, { postsById: app.basePostsById, postTopic: app.postTopic, topicsById: app.topicsById, inRange: new Set(app.weekPosts.map((p) => p.id)), move });
  }, { autoKind: 'url', toastText: `「${t.name}」に ${probe.added.length + probe.missing.length}件追加しました${probe.missing.length ? `（うちデータに無い投稿 ${probe.missing.length}件は本文を取りに行きます）` : ''}` });
  if (result && result.missing.length) enqueueMeta(result.missing.map((id) => ({ id, week: app.weekKey })));
  return { result, invalid: ex.invalid };
};

// ---------------------------------------------------------------- データに無い投稿の本文・投稿者（X の oEmbed。1 件ずつ 500ms 以上あけて）

const metaQueue = [];
let metaBusy = false;
const metaTried = new Set();
function enqueueMeta(list) {
  for (const x of list) {
    const k = `${x.week}|${x.id}`;
    if (metaTried.has(k) || app.basePostsById.has(x.id)) continue;
    metaTried.add(k);
    metaQueue.push(x);
  }
  runMeta();
}
async function runMeta() {
  if (metaBusy) return;
  metaBusy = true;
  try {
    while (metaQueue.length) {
      const { id, week } = metaQueue.shift();
      let meta;
      try { meta = { ...(await fetchOembed(id)), fetchedAt: Date.now(), error: null }; } catch (err) { meta = { author: '', handle: '', text: '', date: '', fetchedAt: Date.now(), error: (err && err.message) || '取得できませんでした' }; }
      const w = app.saved.weeks[week];
      if (w) {
        w.linkMeta = { ...(w.linkMeta || {}), [id]: sanitizeLinkMeta(meta) };
        persist();
        if (week === app.weekKey) { app.metaVersion = (app.metaVersion || 0) + 1; if (!isEditable(document.activeElement)) renderRoute(); }
      }
      await new Promise((r) => setTimeout(r, OEMBED_GAP_MS));
    }
  } finally { metaBusy = false; }
}
/** 起動時: 本文をまだ取っていないデータに無い投稿（URL で追加・台本）を順に */
function enqueueMissingMeta() {
  const list = [];
  for (const [week, w] of Object.entries(app.saved.weeks || {})) {
    const meta = w.linkMeta || {};
    const ids = [...Object.values(w.topicLinks || {}).flat(), ...((w.overrides && w.overrides.manual) || []).flatMap((m) => m.missing || [])];
    for (const id of ids) if (!meta[id] && !app.basePostsById.has(id)) list.push({ id, week });
  }
  enqueueMeta(list);
}
app.enqueueMissingMeta = enqueueMissingMeta;
/** データに無い投稿の本文・投稿者（今の番組週）。posts.json にあれば null（本物のデータ優先） */
app.linkMetaOf = (id) => {
  if (app.basePostsById.has(id)) return null;
  const w = app.weekState();
  return (w.linkMeta && w.linkMeta[id]) || null;
};
/** データに無い投稿のジャンル（手で変えたらそれ、無ければ本文からの推定）。{ genre, estimated } か null */
app.missingGenre = (id) => {
  const o = app.saved.genreOverrides && app.saved.genreOverrides[id];
  if (o && o.genre) return { genre: o.genre, estimated: false };
  const m = app.linkMetaOf(id);
  if (!m || !m.text) return null;
  const e = estimateGenre(m.text, { dict: app.saved.dict, holdTerms: app.saved.holdTerms });
  return e ? { genre: e.genre, estimated: true, via: e.via } : null;
};

// 画像の中身（IndexedDB）のキャッシュ: id → { url（表示用 object URL）, obs（OBS 用 data URL） }
app.imageCache = new Map();
const imageLoads = new Map();
let imageRenderTimer = null;
app.imageData = (id) => app.imageCache.get(id) || null;
app.loadImage = (id) => {
  if (app.imageCache.has(id)) return Promise.resolve(app.imageCache.get(id));
  if (imageLoads.has(id)) return imageLoads.get(id);
  const pr = getImage(id).then((rec) => {
    if (!rec) throw new Error('画像の中身が見つかりません（別のパソコン・ブラウザで追加した画像です）');
    const v = { url: rec.full ? URL.createObjectURL(rec.full) : rec.obs, obs: rec.obs };
    app.imageCache.set(id, v);
    clearTimeout(imageRenderTimer);
    imageRenderTimer = setTimeout(() => { if (!isEditable(document.activeElement)) renderRoute(); }, 30);
    return v;
  }).finally(() => imageLoads.delete(id));
  imageLoads.set(id, pr);
  return pr;
};

/** 画像を話題に追加（ファイル選択・ドラッグ＆ドロップ・貼り付け）。縮小して IndexedDB へ、情報は保存データへ（元に戻せる） */
app.addImages = async (files, topicId) => {
  const list = [...(files || [])].filter(Boolean);
  if (!list.length || !topicId) return [];
  const added = [];
  const errors = [];
  for (const f of list) {
    const bad = checkImageFile(f);
    if (bad) { errors.push(bad); continue; }
    try {
      const img = await decodeImage(f);
      const srcType = f.type === 'image/png' ? 'image/png' : 'image/jpeg';
      const full = await shrinkImage({ w: img.w, h: img.h, type: srcType }, { maxSide: IMAGE_LIMITS.storeSide, maxBytes: IMAGE_LIMITS.storeBytes }, canvasEncoder(img.source, 'blob'));
      const obs = await shrinkImage({ w: img.w, h: img.h, type: srcType }, { maxSide: IMAGE_LIMITS.obsSide, maxBytes: IMAGE_LIMITS.obsDataUrl }, canvasEncoder(img.source, 'dataurl'));
      const id = newImageId();
      const hash = await shortHash(obs.data);
      await putImage({ id, full: full.data, obs: obs.data, type: full.type, at: Date.now() });
      app.imageCache.set(id, { url: URL.createObjectURL(full.data), obs: obs.data });
      added.push({ id, topicId, caption: '', w: full.w, h: full.h, type: full.type, bytes: full.bytes, hash, at: Date.now() });
    } catch (err) {
      errors.push(err && err.message ? err.message : '画像を追加できませんでした');
    }
  }
  if (added.length) {
    app.edit('画像の追加', (w) => { w.images = [...(w.images || []), ...added]; }, { toastText: `画像を ${added.length}枚追加しました${errors.length ? `（${errors.length}枚は追加できませんでした：${errors[0]}）` : ''}` });
  } else if (errors.length) toast(`画像を追加できませんでした：${errors[0]}`);
  return added;
};
app.setImageCaption = (id, caption) => {
  app.update((w) => { w.images = w.images.map((x) => (x.id === id ? { ...x, caption: String(caption || '').slice(0, 200) } : x)); }, { render: false, debounce: true });
};
/** 書き出しに入れる画像（data URL。保存用の大きさ） */
app.exportImages = async () => {
  const ids = new Set(Object.values(app.saved.weeks).flatMap((w) => (w.images || []).map((x) => x.id)));
  const out = {};
  for (const id of ids) {
    try {
      const rec = await getImage(id);
      if (!rec) continue;
      out[id] = rec.full ? await blobToDataUrl(rec.full) : rec.obs;
      if (rec.obs) out[`${id}:obs`] = rec.obs;
    } catch { /* 読めない画像は飛ばす */ }
  }
  return out;
};
/** 書き出しファイルの画像を取り込む */
app.importImages = async (map) => {
  let n = 0;
  for (const [key, data] of Object.entries(map || {})) {
    if (key.endsWith(':obs') || !/^[a-z0-9]{4,40}$/.test(key) || typeof data !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(data)) continue;
    try {
      const blob = dataUrlToBlob(data);
      const obs = typeof map[`${key}:obs`] === 'string' && validImageDataUrl(map[`${key}:obs`]) ? map[`${key}:obs`] : data;
      await putImage({ id: key, full: blob, obs, type: blob.type, at: Date.now() });
      app.imageCache.delete(key);
      n++;
    } catch { /* 飛ばす */ }
  }
  return n;
};
function dataUrlToBlob(data) {
  const [head, b64] = data.split(',');
  const type = (/^data:([^;]+);/.exec(head) || [])[1] || 'image/jpeg';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(r.error); r.readAsDataURL(blob); });
}
/** 起動時: どの週からも使われていない画像の中身を消す（元に戻すの履歴は再読み込みで消えるので安全） */
async function cleanupImages() {
  try {
    const used = new Set(Object.values(app.saved.weeks).flatMap((w) => (w.images || []).map((x) => x.id)));
    for (const k of await imageKeys()) if (!used.has(k)) await deleteImage(k);
  } catch { /* 使えないブラウザは何もしない */ }
}

// ---------------------------------------------------------------- 投稿を開く専用ウィンドウ（名前付きポップアップ）

app.viewerPrefs = (() => { try { return parseViewerPrefs(localStorage.getItem(VIEWER_PREF_KEY)); } catch { return parseViewerPrefs(null); } })();
app.saveViewerPrefs = (v) => {
  app.viewerPrefs = parseViewerPrefs({ ...app.viewerPrefs, ...v });
  try { localStorage.setItem(VIEWER_PREF_KEY, JSON.stringify(app.viewerPrefs)); } catch { /* 保存できなくても今回は使う */ }
};
/** 進行のリード文の開閉（localStorage） */
app.leadOpen = (() => { try { return localStorage.getItem('xtrend-show-lead-open') === '1'; } catch { return false; } })();
app.setLeadOpen = (open) => {
  app.leadOpen = Boolean(open);
  try { localStorage.setItem('xtrend-show-lead-open', open ? '1' : '0'); } catch { /* 保存できなくても今回は開閉する */ }
};
/** 専用ウィンドウで開く。ブロックされたら日本語で案内 */
app.openViewer = (url) => {
  const ok = openViewer(url, app.viewerPrefs);
  if (!ok) toast('ポップアップがブロックされました。アドレスバー右のアイコン（ポップアップのブロック）から、このサイトのポップアップを「常に許可」にしてください');
  return ok;
};
/** 画面（モニター）の一覧（Chrome の Window Management API。権限の確認が出る）。使えなければ null */
app.loadScreens = async () => {
  if (typeof window.getScreenDetails !== 'function') return null;
  try {
    const d = await window.getScreenDetails();
    app.screens = d.screens.map((x, i) => screenSnapshot(x, i)).filter(Boolean);
    return app.screens;
  } catch { app.screens = null; return null; }
};

/** 貼り付けた画像を入れる話題（進行は今の話題、編成はプレビュー中・開いているまとまり） */
app.pasteTopicId = () => {
  if (app.route === 'live') {
    const cue = app.cues[app.weekState().live.index];
    return cue && cue.kind === 'topic' ? cue.topicId : null;
  }
  if (app.route === 'plan') {
    const u = app.ui;
    const row = (u.rows || []).find((r) => r.key === u.focus);
    if (row && row.type === 'topic') return row.id;
    if (u.folder && u.folder.startsWith('topic:')) return u.folder.slice(6);
  }
  return null;
};

app.recompute = () => recompute(); // 計測・デバッグ用

/** 元のジャンル（上書き前。データのカテゴリから） */
app.origGenreOf = (id) => {
  const p = app.basePostsById.get(id);
  return p ? majorityGenre([p]) : null;
};

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
  publishLive();
  if (render) renderRoute();
};

/** 進行状態の変化を 1 か所から発行（段階2で OBS WebSocket へ流す） */
function publishLive() {
  if (!app.saved || !app.weekKey) return;
  publishLiveState({ weekKey: app.weekKey, live: app.weekState().live, cues: app.cues, topicsById: app.topicsById, itemsFor: app.itemsFor });
  sendOverlay();
}
app.publishLive = publishLive;

// ================================================================ OBS オーバーレイへの送信（段階2）
// 送り手は進行画面（#live）と OBS セットアップ画面だけ。同じブラウザ内は BroadcastChannel、OBS へは WebSocket（emit_event）。
// 変化したときに seq を進めて送り、RESEND_MS ごとに同じものを再送（後から開いたパーツが追いつく）。

// コーナータイトルの時刻は進行の記録（live.enteredAt＝そのコーナーに初めて入った時刻）を使うので、開き直しても出し直さない
const overlay = { sid: Math.random().toString(36).slice(2, 10), seq: 0, last: null, bc: null, effect: null };
try { if ('BroadcastChannel' in window) overlay.bc = new BroadcastChannel(OVERLAY_CHANNEL); } catch { overlay.bc = null; }

function isSender() {
  return app.ready && (app.route === 'live' || app.route === 'obs-setup');
}

function currentPayload() {
  const wk = app.weekState();
  return buildPayload({
    live: wk.live, cues: app.cues, topicsById: app.topicsById, postsById: app.postsById, showName: app.saved.showName,
    title: typeof wk.title === 'string' && wk.title.trim() ? wk.title : '',
    // 段階4: 直近の演出（EFFECT_TTL_MS の間だけ載せる。受け手は id で二重に出さない）
    effect: overlay.effect && Date.now() - overlay.effect.at < EFFECT_TTL_MS ? overlay.effect : null,
    // 進行の並び（手動順・古い順・画像）と画像の情報
    itemsFor: app.itemsFor, imagesById: new Map((wk.images || []).map((x) => [x.id, x])),
  });
}

// 「今の投稿」が画像のとき: 画像の本体（data URL）は id とハッシュで管理し、新しい画像に変わったときと、
// 後から開いたパーツ向けに 30 秒おきにだけ media として付ける（5 秒おきの再送には付けない）
let mediaState = { hash: null, at: 0 };
function withMedia(p, force = false) {
  const post = p && p.card && p.card.post;
  if (!post || post.kind !== 'image' || !post.image) return p;
  const data = app.imageData(post.image.id);
  if (!data || !data.obs) { app.loadImage(post.image.id).then(() => { if (overlay.last === p) transmit(p, true); }).catch(() => {}); return p; }
  const plan = mediaPlan(mediaState, post, Date.now(), force);
  mediaState = plan.state;
  if (!plan.attach) return p;
  return { ...p, media: { id: post.image.id, hash: post.image.hash, dataUrl: data.obs } };
}

function transmit(p, forceMedia = false) {
  const out = withMedia(p, forceMedia);
  app.lastSent = out;
  if (overlay.bc) { try { overlay.bc.postMessage(out); } catch { /* 無視 */ } }
  if (app.obs && app.obs.status().state === 'connected') app.obs.emit(OBS_EVENT_NAME, out).then(() => updateObsPill());
}

function sendOverlay(force = false) {
  if (!isSender() || !app.saved) return;
  const p = currentPayload();
  if (!force && samePayload(p, overlay.last)) return;
  p.sid = overlay.sid;
  p.seq = ++overlay.seq;
  overlay.last = p;
  app.lastPayload = p;
  transmit(p);
}
app.sendOverlay = sendOverlay;

function resendOverlay() {
  if (!isSender()) return;
  if (!overlay.last) { sendOverlay(true); return; }
  transmit(overlay.last);
}

// ---------------------------------------------------------------- 演出（段階4）

const fxCooldown = createCooldown();
/** 演出を出す（パレットのボタン・Shift+1〜6）。同じ演出の 1 秒以内の連打は無視。出したら effect を返す */
app.fireEffect = (kind, params = {}) => {
  if (!effectDef(kind) || !fxCooldown(kind)) return null;
  const e = makeEffect(kind, params);
  if (!e) return null;
  overlay.effect = e;
  app.lastEffect = e;
  sendOverlay();
  // 載せておく時間が過ぎたら外す（次の変化か再送で effect: null になる）
  setTimeout(() => { if (overlay.effect === e) { overlay.effect = null; sendOverlay(); } }, EFFECT_TTL_MS + 50);
  return e;
};
app.fxOpen = (() => { try { return localStorage.getItem('xtrend-show-fx-open') === '1'; } catch { return false; } })();
app.setFxOpen = (open) => {
  app.fxOpen = Boolean(open);
  try { localStorage.setItem('xtrend-show-fx-open', open ? '1' : '0'); } catch { /* 保存できなくても切り替える */ }
  app.render();
};

// ---------------------------------------------------------------- OBS 接続（設定は localStorage）

function loadObsPrefs() {
  try { return parseObsPrefs(localStorage.getItem(OBS_PREF_KEY)); } catch { return parseObsPrefs(null); }
}
app.obsPrefs = loadObsPrefs();
app.obsSavePrefs = (prefs) => {
  app.obsPrefs = { ...app.obsPrefs, ...prefs };
  try { localStorage.setItem(OBS_PREF_KEY, JSON.stringify(app.obsPrefs)); } catch { /* 保存できなくても動く */ }
};

function updateObsPill() {
  const pill = $('obs-pill');
  if (!pill) return;
  const st = app.obs ? app.obs.status() : { state: 'idle' };
  // 進行の固定ヘッダー内のピルも
  for (const x of document.querySelectorAll('[data-obs-pill]')) { x.textContent = obsStatusLabel(st); x.dataset.state = st.state; x.title = st.reason || 'OBS との連動の設定'; }
  pill.hidden = !(app.route === 'live' || app.route === 'obs-setup');
  pill.textContent = obsStatusLabel(st);
  pill.dataset.state = st.state;
  pill.title = st.reason || 'OBS との連動の設定';
}

function ensureObs() {
  if (app.obs) return app.obs;
  app.obs = createObsClient({
    onStatus: (st) => {
      updateObsPill();
      if (st.state === 'connected') { sendOverlay(true); if (chatActive()) sendChat(); }
      if (app.ui.obsDlg) refreshObsDialog(st);
    },
  });
  return app.obs;
}
app.obsConnect = (prefs) => {
  app.obsSavePrefs({ ...prefs, enabled: true });
  ensureObs().connect(app.obsPrefs);
};
app.obsDisconnect = () => {
  app.obsSavePrefs({ enabled: false });
  if (app.obs) app.obs.disconnect();
};
/** テスト表示（見本の話題・投稿カード・コーナータイトル）。数秒後に今の進行状態に戻す */
app.obsTest = () => {
  const p = demoPayload();
  p.sid = overlay.sid;
  p.seq = ++overlay.seq;
  transmit(p);
  const on = app.obs && app.obs.status().state === 'connected';
  toast(on ? 'テスト表示を OBS に送りました（8 秒後に今の進行状態に戻します）' : 'OBS に接続していないので、このブラウザで開いたパーツにだけテスト表示を送りました');
  setTimeout(() => sendOverlay(true), 8000);
};

// ================================================================ YouTube ライブのコメント（読み取り専用・API キー。ytchat.js）
// 取得は画面（ルート）に関係なく続ける。新しいコメントは type: 'chat' のメッセージで OBS（接続中なら）と同じブラウザのパーツへ。
// API キー・設定は localStorage（xtrend-show-ytchat）だけ。コメントの一覧は保存しない（固定コメントだけ 3 時間まで復元）。

function loadChatPrefs() {
  try { return parseChatPrefs(localStorage.getItem(YT_CHAT_PREF_KEY)); } catch { return parseChatPrefs(null); }
}
app.chatPrefs = loadChatPrefs();
// 確認用（E2E）: 取得間隔の最短を短くする（localStorage xtrend-show-ytchat-fast＝ms。ふだんは使わない）
const chatFastMs = (() => { try { const n = Number(localStorage.getItem('xtrend-show-ytchat-fast')); return Number.isFinite(n) && n > 0 ? n : null; } catch { return null; } })();
app.chat = {
  status: 'idle', reason: '', code: '', videoId: null, log: [], count: 0, hidden: new Set(), banned: new Set(),
  calls: { videos: 0, messages: 0 }, pin: restorePin(app.chatPrefs), demoUntil: 0,
};
app.chatOpen = (() => { try { return localStorage.getItem('xtrend-show-ytchat-open') === '1'; } catch { return false; } })();
let chatPoller = null;
let chatNg = ngMatcher(parseNgWords(app.chatPrefs.ng));
const chatWire = { sid: Math.random().toString(36).slice(2, 10), seq: 0 };

const chatRunning = () => ['starting', 'running', 'retrying'].includes(app.chat.status);
function chatActive() {
  return chatRunning() || Boolean(app.chat.pin) || app.chat.demoUntil > Date.now();
}
app.chatRunning = chatRunning;
app.chatUnits = () => quotaUnits(app.chat.calls);
function chatCfg() {
  const p = app.chatPrefs;
  return sanitizeChatCfg({ top: p.top, lanes: p.lanes, laneH: p.laneH, size: p.size, speed: p.speed, flow: p.flow });
}
/** オーバーレイへ（同じブラウザは BroadcastChannel、OBS は接続中なら emit_event）。add・remove が無くても固定・設定は毎回載る */
function sendChat({ add = [], remove = [] } = {}) {
  const msg = buildChatMessage({ sid: chatWire.sid, seq: ++chatWire.seq, at: Date.now(), add, remove, pin: app.chat.pin, cfg: chatCfg() });
  app.lastChatSent = msg;
  if (overlay.bc) { try { overlay.bc.postMessage(msg); } catch { /* 無視 */ } }
  if (app.obs && app.obs.status().state === 'connected') app.obs.emit(OBS_EVENT_NAME, msg);
}
function resendChat() {
  if (chatActive()) sendChat();
}
function refreshChat() {
  if (app.ready && app.route === 'live') refreshChatPanel(app);
}
app.refreshChat = refreshChat;
function saveChatPrefs() {
  try { localStorage.setItem(YT_CHAT_PREF_KEY, JSON.stringify(app.chatPrefs)); } catch { /* 保存できなくても動く */ }
}
/** 設定を保存（NG ワードを変えたら一覧の印を付け直し、NG になったものは画面から消す） */
app.chatSavePrefs = (patch) => {
  app.chatPrefs = parseChatPrefs({ ...app.chatPrefs, ...patch });
  saveChatPrefs();
  if (patch && 'ng' in patch) {
    chatNg = ngMatcher(parseNgWords(app.chatPrefs.ng));
    const remove = [];
    app.chat.log = app.chat.log.map((e) => {
      const word = chatNg(e) || null;
      if (word && !e.ng) remove.push(e.id);
      return word === e.ng ? e : { ...e, ng: word };
    });
    if (app.chat.pin && remove.includes(app.chat.pin.id)) setChatPin(null);
    if (remove.length) sendChat({ remove });
  }
  if (chatPoller) chatPoller.setInterval(chatFastMs || app.chatPrefs.interval);
  sendChat();
  refreshChat();
};
app.setChatOpen = (open) => {
  app.chatOpen = Boolean(open);
  try { localStorage.setItem('xtrend-show-ytchat-open', open ? '1' : '0'); } catch { /* 保存できなくても切り替える */ }
  app.render();
};
function setChatPin(item) {
  app.chat.pin = item ? { id: item.id, kind: item.kind, text: item.text, name: item.name, icon: item.icon, amount: item.amount, color: item.color, at: Date.now() } : null;
  app.chatPrefs = { ...app.chatPrefs, pin: app.chat.pin, pinnedAt: app.chat.pin ? Date.now() : null };
  saveChatPrefs();
}
/** 一覧から固定（NG・画面から消したものは固定できない） */
app.chatPin = (id) => {
  const e = app.chat.log.find((x) => x.id === id);
  if (!e || e.ng || app.chat.hidden.has(id)) return;
  setChatPin(e);
  sendChat();
  refreshChat();
};
app.chatUnpin = () => {
  setChatPin(null);
  sendChat();
  refreshChat();
};
/** 画面から消す（流れていれば消し、これから流さない。固定中なら外す） */
app.chatHide = (id) => {
  app.chat.hidden.add(id);
  if (app.chat.pin && app.chat.pin.id === id) setChatPin(null);
  sendChat({ remove: [id] });
  refreshChat();
};
app.chatSetFlow = (on) => {
  app.chatPrefs = { ...app.chatPrefs, flow: Boolean(on) };
  saveChatPrefs();
  sendChat();
  refreshChat();
};
function ensureObsForChat() {
  if (app.obsPrefs.enabled && app.obsPrefs.auto && !app.obs) ensureObs().connect(app.obsPrefs);
}
function onChatBatch(norm, { backlog }) {
  const r = applyChatBatch(app.chat.log, norm.events, { backlog, ng: chatNg, hidden: app.chat.hidden, banned: app.chat.banned, max: CHAT_LOG_MAX });
  app.chat.log = r.log;
  app.chat.count += r.added;
  for (const b of r.banned) app.chat.banned.add(b);
  if (app.chat.pin && r.removed.includes(app.chat.pin.id)) setChatPin(null);
  const add = app.chatPrefs.flow ? r.flow : [];
  if (add.length || r.removed.length) sendChat({ add, remove: r.removed });
  refreshChat();
}
/** 開始（url を省略したら前回の URL） */
app.chatStart = (url) => {
  const input = String(url != null ? url : app.chatPrefs.url || '').trim();
  const fail = (reason) => { app.chat.status = 'error'; app.chat.reason = reason; app.chat.code = 'setup'; refreshChat(); toast(`コメント：${reason}`); return false; };
  if (!validKey(app.chatPrefs.key)) return fail('API キーが未設定です（「⚙ 設定」で入れてください）');
  if (!looksLikeGoogleKey(app.chatPrefs.key)) return fail('API キーの形が違います（「AIza」で始まるキーを「⚙ 設定」で入れ直してください）');
  const id = parseVideoId(input);
  if (!id) return fail('配信の URL を読み取れませんでした（https://www.youtube.com/live/… や youtu.be/… の形）');
  app.chatPrefs = { ...app.chatPrefs, url: input };
  saveChatPrefs();
  if (chatPoller) chatPoller.stop();
  if (app.chat.videoId !== id) { app.chat.log = []; app.chat.count = 0; app.chat.hidden = new Set(); app.chat.banned = new Set(); }
  app.chat.videoId = id;
  chatPoller = createChatPoller({
    key: app.chatPrefs.key, videoId: id, interval: chatFastMs || app.chatPrefs.interval,
    fetchImpl: (u, o) => fetch(u, o),
    onUnits: (kind) => { app.chat.calls[kind] = (app.chat.calls[kind] || 0) + 1; },
    onStatus: (st) => {
      const was = app.chat.status;
      Object.assign(app.chat, { status: st.status, reason: st.reason, code: st.code });
      if (st.status === 'error' && was !== 'error') toast(`コメント：${st.reason}`);
      refreshChat();
    },
    onBatch: onChatBatch,
  });
  chatPoller.start();
  ensureObsForChat();
  sendChat();
  return true;
};
app.chatStop = () => {
  if (chatPoller) chatPoller.stop();
  chatPoller = null;
  app.chat.status = 'stopped';
  app.chat.reason = '';
  refreshChat();
};
app.chatToggle = (url) => (chatRunning() ? app.chatStop() : app.chatStart(url));
/** 見本を流す（API を使わない。OBS・このブラウザのパーツの確認用。一覧にも「見本」で入る） */
app.chatDemo = () => {
  const now = Date.now();
  const n = 10;
  app.chat.demoUntil = now + n * 800 + 3000;
  ensureObsForChat();
  for (let i = 0; i < n; i++) {
    setTimeout(() => {
      const it = demoChatItem(i, Date.now(), 'sample');
      onChatBatch({ events: [{ type: 'add', item: it }] }, { backlog: false });
    }, i * 800);
  }
  const on = app.obs && app.obs.status().state === 'connected';
  toast(on ? '見本のコメントを OBS に流しています' : '見本のコメントを流しています（OBS に接続していないので、このブラウザで開いたパーツにだけ）');
};

// ================================================================ 元に戻す・やり直す（編成のすべての編集操作）

function updateHistoryButtons() {
  for (const b of document.querySelectorAll('[data-key="undo"]')) { b.disabled = !app.history.past.length; b.title = app.history.past.length ? `元に戻す：${app.history.past[app.history.past.length - 1].label}（Ctrl+Z）` : '元に戻す（Ctrl+Z）'; }
  for (const b of document.querySelectorAll('[data-key="redo"]')) { b.disabled = !app.history.future.length; b.title = app.history.future.length ? `やり直す：${app.history.future[0].label}（Ctrl+Shift+Z / Ctrl+Y）` : 'やり直す（Ctrl+Shift+Z / Ctrl+Y）'; }
}
app.updateHistoryButtons = updateHistoryButtons;

/**
 * 編集操作（元に戻せる）。label は「元に戻す」の説明。opts は app.update と同じ（既定で話題を作り直す）。
 * toastText を渡すと「元に戻す」つきのお知らせを出す。
 */
app.edit = (label, mut, opts = {}) => {
  const before = serializeSaved(app.saved);
  app.history = recordHistory(app.history, label, before);
  app.update(mut, { topics: true, ...opts });
  if (opts.toastText) toast(opts.toastText, () => app.undo());
  updateHistoryButtons();
  // ボットへの修正の自動送信（トークンを設定しているときだけ。中身が同じなら送らない）
  if (app.autoSend) app.autoSend.notify(opts.autoKind || 'edit');
};

function restoreSnap(snap) {
  const r = parseSaved(snap);
  if (!r.ok) return false;
  app.saved = r.state;
  recompute();
  persist();
  publishLive();
  renderRoute();
  return true;
}

app.undo = () => {
  const r = undoHistory(app.history, serializeSaved(app.saved));
  if (!r) { toast('元に戻せる操作はありません'); return; }
  app.history = r.history;
  restoreSnap(r.snap);
  toast(`元に戻しました：${r.label}`);
  updateHistoryButtons();
};
app.redo = () => {
  const r = redoHistory(app.history, serializeSaved(app.saved));
  if (!r) { toast('やり直せる操作はありません'); return; }
  app.history = r.history;
  restoreSnap(r.snap);
  toast(`やり直しました：${r.label}`);
  updateHistoryButtons();
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
  app.history = recordHistory(app.history, 'ファイルの読み込み', serializeSaved(app.saved));
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

app.shelve = (topic) => app.edit(`片付け「${topic.name}」`, (w) => {
  Object.assign(w, shelveTopic(w, topic, Date.now()));
  w.mainCand = (w.mainCand || []).filter((x) => x !== topic.id);
}, { toastText: `「${topic.name}」を片付けました（この週の候補から外しました）` });
app.unshelve = (topicId) => {
  let placed = false;
  app.edit('片付けから戻す', (w) => { const r = unshelveTopic(w, topicId); Object.assign(w, r.week); placed = r.placed; });
  toast(placed ? '候補に戻し、元の枠にも戻しました' : '候補に戻しました');
};
app.trash = (topic) => app.edit(`削除「${topic.name}」`, (w, s) => {
  const r = trashTopic(s, w, topic, app.weekKey, Date.now());
  s.trash = r.saved.trash;
  Object.assign(w, r.week);
  w.mainCand = (w.mainCand || []).filter((x) => x !== topic.id);
}, { toastText: `「${topic.name}」を削除しました（ゴミ箱へ。今後の週にも出しません）` });
app.restoreTrash = (ids) => {
  let placed = 0;
  app.edit('ゴミ箱から戻す', (w, s) => {
    for (const id of ids) {
      const r = restoreTrash(s, w, id, app.weekKey);
      s.trash = r.saved.trash;
      Object.assign(w, r.week);
      if (r.placed) placed++;
    }
  });
  toast(placed ? `ゴミ箱から戻しました（${placed}件は元の枠にも戻しました）` : 'ゴミ箱から戻しました');
};
app.hidePost = (postId, topicName) => app.edit('投稿の削除', (w, s) => {
  s.hiddenPosts = hidePost(s, postId, app.weekKey, Date.now(), topicName).hiddenPosts;
}, { toastText: '投稿を削除しました（どの話題にも出しません。ゴミ箱から戻せます）' });
// ---------------------------------------------------------------- 台本ファイル（xtrend-script）の取り込み

/** 取り込む（指定の番組週へ切り替え → 1 回の編集として当てる。Ctrl+Z で元に戻せる） */
app.importScript = (script) => {
  if (script.week !== app.weekKey) {
    const w = weekByKey(script.week);
    if (!w) return null;
    if (!app.weeks.some((x) => x.key === w.key)) app.weeks = [...app.weeks, w].sort((a, b) => (a.key < b.key ? 1 : -1));
    setWeek(w.key);
    recompute();
  }
  let result = null;
  app.edit('台本の取り込み', (w, s) => { result = applyScriptImport(w, s, script, { postsById: app.basePostsById }); },
    { toastText: '台本を取り込みました（Ctrl+Z で元に戻せます）' });
  app.ui.folder = 'slot:0';
  app.ui.query = '';
  app.render();
  return result;
};

// ---------------------------------------------------------------- 保留する言葉・優先ジャンル（保存・書き出しに含む）

/** 保留から戻す（その投稿・話題だけ。言葉に一致しても保留しない例外に入れる） */
app.unhold = (ids) => {
  const list = [...new Set(ids.map(String))];
  app.edit('保留から戻す', (w, s) => { s.holdExceptions = [...new Set([...s.holdExceptions, ...list])].slice(-5000); }, { toastText: `保留から ${list.length}件戻しました` });
};
app.removeHoldTerm = (term) => {
  app.edit(`保留の言葉「${term}」を外す`, (w, s) => { s.holdTerms = removeHoldTerm(s.holdTerms, term); }, { toastText: `「${term}」を保留する言葉から外しました` });
};
app.setHoldTerms = (terms) => {
  app.edit('保留する言葉の変更', (w, s) => { s.holdTerms = terms; });
};
app.setPriorityGenre = (g) => {
  app.edit('優先ジャンルの変更', (w, s) => { s.priorityGenre = normalizePriorityGenre(g); });
};

app.unhidePost = (postId) => {
  app.edit('投稿を戻す', (w, s) => { s.hiddenPosts = unhidePost(s, postId).hiddenPosts; });
  toast('投稿を戻しました');
};
app.restoreAllTrash = () => {
  app.edit('ゴミ箱をすべて戻す', (w, s) => {
    for (const e of [...s.trash]) {
      const r = restoreTrash(s, w, e.id, app.weekKey);
      s.trash = r.saved.trash;
      Object.assign(w, r.week);
    }
    s.hiddenPosts = [];
  });
  toast('ゴミ箱をすべて戻しました');
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

/** 対象期間の選択（編成・振り返りで表示。番組週ごとに保存） */
function renderRangePicker() {
  const box = $('range-box');
  if (!box) return;
  box.hidden = !(app.route === 'plan' || app.route === 'review');
  const sel = $('range-select');
  const wk = app.weekState();
  const r = sanitizeRange(wk.range);
  clear(sel);
  for (const x of RANGE_PRESETS) sel.append(h('option', { value: x.mode, selected: x.mode === (app.ui.rangeDraft ? 'custom' : r.mode) }, x.label));
  const custom = Boolean(app.ui.rangeDraft) || r.mode === 'custom';
  $('range-custom').hidden = !custom;
  if (custom && document.activeElement !== $('range-from') && document.activeElement !== $('range-to')) {
    $('range-from').value = toJstInput(r.mode === 'custom' ? r.from : app.range.start);
    $('range-to').value = r.mode === 'custom' && r.to != null ? toJstInput(r.to) : '';
  }
  sel.title = app.range ? `対象：${app.range.label}` : '';
  $('range-label').textContent = app.range ? `対象：${app.range.label}（投稿 ${app.rangePostCount ?? 0}件）` : '';
}

app.setRange = (range) => {
  app.ui.rangeDraft = false;
  const r = sanitizeRange(range);
  app.edit('対象期間の変更', (w) => { w.range = r; }, { toastText: '対象期間を変えました（編成はそのまま残っています）' });
};

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
  $('week-range').textContent = app.range && !app.range.isWeek ? `（番組週 ${weekLabel(app.week)}）` : weekLabel(app.week);
  renderRangePicker();
  renderWeekPicker();
  const root = $('view');
  // 再描画してもフォーカスを失わないよう、data-key でたどる
  const active = document.activeElement;
  lastFocusKey = active && root.contains(active) && active.dataset ? active.dataset.key || null : null;
  const view = { plan: renderPlan, live: renderLive, onair: renderOnair, review: renderReview, 'obs-setup': renderObsSetup }[app.route];
  // 同じ画面・同じ週の再描画は差し替え（patch.js）で、表示済みの X 埋め込みを作り直さない
  const old = root.firstElementChild;
  const sameScreen = old && old.dataset.keep && old.dataset.keep === `${app.route}:${app.weekKey}`;
  if (!sameScreen && app.embedder) app.embedder.reset();
  app.afterRender = null;
  const fresh = view(app);
  if (!(sameScreen && patchView(old, fresh))) { clear(root); root.append(fresh); }
  // 編成画面は画面の高さいっぱいに（ヘッダーの高さを CSS へ）
  const hdr = document.querySelector('.sh-header');
  if (hdr) document.documentElement.style.setProperty('--hdr', `${hdr.offsetHeight + (document.getElementById('sample-banner')?.hidden ? 0 : document.getElementById('sample-banner').offsetHeight)}px`);
  if (app.afterRender) app.afterRender();
  if (app.route === 'live') refreshChatPanel(app);
  startEmbeds(root, app.embedder);
  updateHistoryButtons();
  if (lastFocusKey) {
    const el = root.querySelector(`[data-key="${CSS.escape(lastFocusKey)}"]`);
    if (el && !el.disabled) el.focus({ preventScroll: true });
  }
  document.title = `${{ plan: '編成', live: '進行', onair: '映す用', review: '振り返り', 'obs-setup': 'OBS セットアップ' }[app.route]}｜${app.saved.showName}`;
  // 進行画面に来たら（前に接続していれば）OBS へつなぐ。状態ピル
  if ((app.route === 'live' || app.route === 'obs-setup') && app.obsPrefs.enabled && app.obsPrefs.auto && !app.obs) ensureObs().connect(app.obsPrefs);
  updateObsPill();
  updateBotPill();
  sendOverlay();
}
app.render = renderRoute;

// ほかのタブからの変更（映す用は進行に追従。入力中のタブは入力が終わってから描き直す）
let pendingRemote = false;
function onRemoteState(state) {
  app.saved = state;
  if (state.activeWeek && state.activeWeek !== app.weekKey && weekByKey(state.activeWeek) && app.weeks.some((w) => w.key === state.activeWeek)) setWeek(state.activeWeek, false);
  recompute();
  publishLive();
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
    app.pickIds = d.pickIds || new Set();
    app.pickReasons = d.pickReasons || new Map();
    app.bot = d.bot || null;
    app.isSample = d.isSample;
    app.basePostsById = new Map(d.ds.posts.map((p) => [p.id, p]));
    app.postsById = app.basePostsById;
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
  publishLive();
  sync = openSync(onRemoteState);

  $('week-select').addEventListener('change', (e) => {
    setWeek(e.target.value);
    recompute();
    renderRoute();
  });
  window.addEventListener('hashchange', renderRoute);
  // 「X で開く」などの X のリンクは、新しいタブではなく専用ウィンドウ（位置・大きさは設定）で開く
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || !isXUrl(a.href) || !(app.route === 'live' || app.route === 'plan' || app.route === 'review')) return;
    e.preventDefault();
    app.openViewer(a.href);
  });
  // 画像の貼り付け（Ctrl+V）: 進行は今の話題、編成はプレビュー中の話題へ
  document.addEventListener('paste', (e) => {
    const files = [...((e.clipboardData && e.clipboardData.files) || [])].filter((f) => /^image\//.test(f.type));
    if (!files.length) return;
    const tid = app.pasteTopicId ? app.pasteTopicId() : null;
    if (!tid) return;
    e.preventDefault();
    app.addImages(files, tid);
  });
  document.addEventListener('keydown', (e) => {
    if (app.route === 'live') liveKeydown(app, e);
    else if (app.route === 'plan') planKeydown(app, e);
  });
  document.addEventListener('pointerdown', (e) => { if (app.route === 'plan') planPointerDown(app, e); }, true);
  // 開いたメニュー（番組に入れる ▾ / …）は外側をクリックしたら閉じる
  document.addEventListener('click', (e) => {
    for (const d of document.querySelectorAll('details.menu[open]')) if (!d.contains(e.target)) d.open = false;
  });
  setInterval(() => {
    if (app.route === 'live') tickLive(app);
    else if (app.route === 'onair') tickOnair(app);
  }, 1000);
  setInterval(resendOverlay, RESEND_MS);
  setInterval(resendChat, RESEND_MS);
  $('obs-pill').addEventListener('click', () => { app.ui.obsDlg = true; renderRoute(); });
  $('bot-pill').addEventListener('click', () => {
    const st = app.autoSendState;
    if (!app.autoSend) return;
    if (st && (st.status === 'error' || st.status === 'stopped') && st.reason) toast(`ボットへの送信：${st.reason}${st.status === 'stopped' ? '（［ツール…］の「GitHub に直接保存」でトークンを確かめてください）' : ''}`);
    if (!autoEnabled()) { toast('自動送信はオフです（［ツール…］→「ボット（Grok）に修正を送る」）'); return; }
    app.autoSend.flush(true);
  });
  $('range-select').addEventListener('change', (e) => {
    const mode = e.target.value;
    if (mode === 'custom') { app.ui.rangeDraft = true; renderRangePicker(); $('range-from').focus(); return; }
    app.setRange({ mode });
  });
  const applyCustom = () => {
    const from = fromJstInput($('range-from').value);
    const to = fromJstInput($('range-to').value);
    if (from == null) { $('range-msg').textContent = '開始の日時を入れてください'; return; }
    if (to != null && to <= from) { $('range-msg').textContent = '終了は開始より後にしてください'; return; }
    $('range-msg').textContent = '';
    app.setRange({ mode: 'custom', from, to });
  };
  $('range-apply').addEventListener('click', applyCustom);
  for (const id of ['range-from', 'range-to']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyCustom(); } });
  window.addEventListener('resize', () => { if (app.route === 'onair') tickOnair(app, true); });
  // 編成の並び方（3 列／一覧⇄プレビューの切替／木の引き出し）は画面幅で決めるので、境目をまたいだら描き直す
  if (typeof matchMedia === 'function') {
    for (const q of ['(min-width: 1400px)', '(max-width: 760px)']) {
      const mq = matchMedia(q);
      const onChange = () => { if (app.route === 'plan' && app.ready) renderRoute(); };
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange); else if (typeof mq.addListener === 'function') mq.addListener(onChange);
    }
  }

  $('loading').hidden = true;
  $('app').hidden = false;
  main.setAttribute('aria-busy', 'false');
  app.ready = true;
  setTimeout(cleanupImages, 3000);
  initAutoSend();
  setTimeout(enqueueMissingMeta, 1500);
  renderRoute();
}

main();
