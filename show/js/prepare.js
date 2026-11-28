// 「整理開始」: GitHub を通してボット（Grok bot。クラウドで動く）に整理をお願いする（サイト側）。DOM 非依存（node:test から import される）。
// しくみ（合言葉などの新しい秘密は使わない。修正の自動送信と同じ GitHub のトークン・ブランチを使う）:
//   1. サイト → feedback/show-feedback.json（今の修正）を書く → feedback/prepare-request.json（お願い）を書く
//      取り消すときは同じ id で "cancel": true にして書き直す
//   2. ボット → data/show/status.json（進み具合・結果）・data/posts.json・data/show/topics.json・data/show/draft.json を保存
//   3. サイト → status.json を GitHub の API で見に行く（30 秒おき・10 分すぎたら 60 秒おき・3 時間であきらめる。リロードしても続ける）
//      自分の id が done になったら、その commit の posts・topics・draft を読み、空いている所だけに下書きを入れる
// ボットがいなくても動く（トークンが無い・お願いを書けないときは、今あるデータで下書きを作る）。
// ここにあるもの: お願い・取り消しの形／status.json を読む／次に見に行くまでの時間・どうするか／下書きファイル（draft.json）を読む／
// 下書き → 番組の流れに入れる案（空いている所だけ）／届いた投稿を posts.json に足す。

import { BOARD, GENRE_PRIORITY, NIGHT_GENRES } from './config.js';
import { canBeMain, mainSlots, categoryOfGenre } from './logic.js';
import { placedTopicIds, isNightGenre } from './folders.js';
import { botTopicId } from './bot.js';

export const PREPARE = Object.freeze({
  app: 'xtrend-prepare',
  statusApp: 'xtrend-prepare-status',
  v: 1,
  requestPath: 'feedback/prepare-request.json',
  statusPath: 'data/show/status.json',
  postsPath: 'data/posts.json',
  topicsPath: 'data/show/topics.json',
  draftPath: 'data/show/draft.json',
  /** 待っているお願い（リロードしても続ける）・前にお願いした時刻 */
  pendingKey: 'xtrend-show-prepare',
  lastKey: 'xtrend-show-prepare-last',
  /** 反映した（か、見送った）ボットの自動整理の request_id */
  autoSeenKey: 'xtrend-show-prepare-auto-seen',
  /** 前のお願いからこの時間は、聞いてからお願いする */
  tooSoonMs: 10 * 60 * 1000,
  /** status.json を見に行く間隔（はじめの 10 分は 30 秒おき、そのあと 60 秒おき、3 時間であきらめる） */
  poll: Object.freeze({ first: 30 * 1000, later: 60 * 1000, switchAt: 10 * 60 * 1000, giveUp: 3 * 60 * 60 * 1000, noReply: 10 * 60 * 1000, idle: 5 * 60 * 1000 }),
  /** data/show/draft.json を（お願いなしで）使うのは、同じ番組週で、これより新しいときだけ */
  draftFreshMs: 12 * 60 * 60 * 1000,
  stages: Object.freeze(['collect', 'metrics', 'feedback', 'group', 'draft', 'push']),
});

export const STAGE_LABELS = Object.freeze({
  collect: '最新の投稿を集めています', metrics: '表示数を更新しています', feedback: 'サイトの修正を反映しています',
  group: 'まとまりを作っています', draft: '番組の流れの下書きを作っています', push: 'GitHub に保存しています',
});

// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const text = (v, max = 300) => (typeof v === 'string' ? v.replace(CTRL, ' ').trim().slice(0, max) : '');
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
const pad = (n) => String(n).padStart(2, '0');

// ================================================================ お願い

/** UNIX 秒 → 「2026-11-28T01:00:00+09:00」 */
export function isoJst(ts) {
  if (!Number.isFinite(ts)) return null;
  const d = new Date((ts + 9 * 3600) * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+09:00`;
}

/** お願いの id: p-yyyymmdd-hhmm-xxxx（日時は日本時間） */
export function newRequestId(nowMs, rand = Math.random) {
  const d = new Date(nowMs + 9 * 3600 * 1000);
  const r = Array.from({ length: 4 }, () => '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(rand() * 36) % 36]).join('');
  return `p-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}-${r}`;
}

/** 優先ジャンル（設定）→ カテゴリ名の順（優先ジャンルが先、残りはいつもの順） */
export function genrePriorityNames(priorityGenre) {
  const order = [...new Set([...(NIGHT_GENRES.includes(priorityGenre) ? [priorityGenre] : []), ...GENRE_PRIORITY.order, ...NIGHT_GENRES])];
  return order.map((g) => categoryOfGenre(g));
}

/** 話題 id → ボットに渡す id（ボットの話題は g: を外す。ほかはそのまま） */
export const toBotTopicId = (id) => (typeof id === 'string' && id.startsWith('g:') ? id.slice(2) : id);

/**
 * feedback/prepare-request.json の中身。
 * input: { id, nowMs, force, week: { key, start, end }（UNIX 秒）, range: { start, end }, priorityGenre,
 *          placedIds（番組の流れ・メイン候補に入っている話題 id）, manualTopics（手で作ったまとまり [{ id, name, postIds }]）,
 *          feedbackGeneratedAt（いっしょに書いた show-feedback.json の generated_at）}
 */
export function buildPrepareRequest(input) {
  const { id, nowMs, force = false, week, range, priorityGenre = GENRE_PRIORITY.default, placedIds = [], manualTopics = [], feedbackGeneratedAt = null } = input;
  return {
    app: PREPARE.app,
    v: PREPARE.v,
    id,
    requested_at: isoJst(Math.floor(nowMs / 1000)),
    force: Boolean(force),
    cancel: false,
    week: { key: week.key, from: isoJst(week.start), to: isoJst(week.end) },
    range: { from: isoJst(range.start), to: isoJst(range.end) },
    rules: {
      main_slots: 3,
      main_night_only: true,
      genre_priority: genrePriorityNames(priorityGenre),
      category_count: BOARD.draftCategory,
      chat_count: BOARD.draftChat,
      min_posts_for_main: 2,
    },
    keep: {
      placed_topic_ids: [...new Set(placedIds)].map(toBotTopicId),
      manual_topics: manualTopics.map((t) => ({ id: t.id, name: t.name, post_ids: [...(t.postIds || [])] })),
    },
    feedback_generated_at: feedbackGeneratedAt,
  };
}

/** 取り消し: 同じ id で cancel: true にして書き直す */
export function cancelRequest(req, nowMs) {
  return { ...req, cancel: true, cancelled_at: isoJst(Math.floor(nowMs / 1000)) };
}

// ================================================================ 待っているお願い（localStorage）

/** 保存した「待っているお願い」を読む。返り値: { id, requestedAt（ms）, force } か null */
export function parsePending(raw) {
  let o = null;
  try { o = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { o = null; }
  if (!o || typeof o !== 'object') return null;
  const id = text(o.id, 80);
  if (!/^p-\d{8}-\d{4}-[0-9a-z]{4}$/.test(id) || !Number.isFinite(o.requestedAt)) return null;
  return { id, requestedAt: o.requestedAt, force: o.force === true, request: o.request && typeof o.request === 'object' ? o.request : null };
}

/** 前のお願いからまだ間がないか。返り値: 残り分（なければ 0） */
export function tooSoonMinutes(lastMs, nowMs, windowMs = PREPARE.tooSoonMs) {
  if (!Number.isFinite(lastMs) || !Number.isFinite(nowMs)) return 0;
  const left = lastMs + windowMs - nowMs;
  return left > 0 && left <= windowMs ? Math.max(1, Math.ceil(left / 60000)) : 0;
}

/** 次に status.json を見に行くまで（ms）。あきらめる時間をすぎたら null。delays で上書きできる（確認用） */
export function pollDelay(elapsedMs, delays = {}) {
  const p = { ...PREPARE.poll, ...Object.fromEntries(Object.entries(delays || {}).filter(([, v]) => Number.isFinite(v) && v > 0)) };
  if (!Number.isFinite(elapsedMs) || elapsedMs >= p.giveUp) return null;
  return elapsedMs < p.switchAt ? p.first : p.later;
}

// ================================================================ status.json

const STATES = new Set(['queued', 'running', 'done', 'error', 'cancelled', 'busy']);
const STAGES = new Set(PREPARE.stages);

/** data/show/status.json を読む。形が違えば null。文字は短く切り、制御文字を除く（画面には textContent で出す） */
export function parseStatus(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.app !== PREPARE.statusApp || raw.v !== PREPARE.v || !STATES.has(raw.state)) return null;
  const r = raw.result && typeof raw.result === 'object' ? raw.result : null;
  const e = raw.error && typeof raw.error === 'object' ? raw.error : null;
  const commit = r && typeof r.commit === 'string' && /^[0-9a-f]{7,40}$/i.test(r.commit.trim()) ? r.commit.trim() : null;
  return {
    requestId: text(raw.request_id, 80) || null,
    state: raw.state,
    stage: STAGES.has(raw.stage) ? raw.stage : null,
    message: text(raw.message, 300),
    startedAt: text(raw.started_at, 40) || null,
    updatedAt: text(raw.updated_at, 40) || null,
    finishedAt: text(raw.finished_at, 40) || null,
    etaMin: num(raw.eta_min, 0, 24 * 60),
    result: r ? { commit, dataGeneratedAt: text(r.data_generated_at, 40) || null, newPosts: num(r.new_posts, 0, 1e7), topics: num(r.topics, 0, 1e6) } : null,
    error: e ? { code: text(e.code, 40) || 'internal', message: text(e.message, 300), retryAfterMin: num(e.retry_after_min, 0, 24 * 60) } : null,
  };
}

/**
 * 見に行った status と待っているお願いから、どうするかを決める。
 * opts: { delays（確認用の上書き）, keepWaiting（「返事がありません」のあと「待ち続ける」を選んだ）}
 * 返り値: { action: 'wait'|'done'|'error'|'busy'|'cancelled'|'noreply'|'giveup', ours（自分のお願いの知らせか）, other（ほかの整理が動いている）}
 *  - お願いから 10 分たっても自分の id の知らせが無ければ noreply（ボットが起動していないかも）
 */
export function decide(status, pending, nowMs, opts = {}) {
  const { delays = {}, keepWaiting = false } = opts;
  if (!pending) return { action: 'wait', ours: false, other: false };
  const elapsed = nowMs - pending.requestedAt;
  if (pollDelay(elapsed, delays) == null) return { action: 'giveup', ours: false, other: false };
  if (!status || status.requestId !== pending.id) {
    const other = Boolean(status && (status.state === 'running' || status.state === 'queued'));
    const p = { ...PREPARE.poll, ...Object.fromEntries(Object.entries(delays || {}).filter(([, v]) => Number.isFinite(v) && v > 0)) };
    return { action: !keepWaiting && elapsed >= p.noReply ? 'noreply' : 'wait', ours: false, other };
  }
  if (status.state === 'done') return { action: 'done', ours: true, other: false };
  if (status.state === 'error') return { action: 'error', ours: true, other: false };
  if (status.state === 'busy') return { action: 'busy', ours: true, other: false };
  if (status.state === 'cancelled') return { action: 'cancelled', ours: true, other: false };
  return { action: 'wait', ours: true, other: false };
}

/** ボットの自動整理（request_id が auto-…）が終わっていて、まだ反映も見送りもしていないか */
export function autoFinished(status, seenId) {
  return Boolean(status && status.state === 'done' && status.requestId && status.requestId.startsWith('auto-') && status.requestId !== seenId && status.result);
}

/** 「19:42」（日本時間）。読めなければ '' */
export function hhmm(iso, parseTs) {
  const ts = iso && parseTs ? parseTs(iso) : null;
  if (ts == null) return '';
  const d = new Date((ts + 9 * 3600) * 1000);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 板の上に出す短い一文（「ボットが整理中：まとまりを作っています（19:42 更新）」） */
export function statusLine(status, { ours = true, parseTs } = {}) {
  if (!status) return ours ? 'ボットにお願いしました（受け付けを待っています）' : '';
  const at = hhmm(status.updatedAt, parseTs);
  const what = status.message || (status.stage ? STAGE_LABELS[status.stage] : '');
  const tail = `${at ? `（${at} 更新${status.etaMin != null && status.state === 'running' ? `・あと ${status.etaMin}分ほど` : ''}）` : ''}`;
  if (!ours) return `ボットがほかの整理をしています${what ? `：${what}` : ''}${tail}`;
  if (status.state === 'queued') return `ボットが受け付けました（順番を待っています）${tail}`;
  if (status.state === 'running') return `ボットが整理中${what ? `：${what}` : ''}${tail}`;
  if (status.state === 'done') return `ボットの整理が終わりました${tail}`;
  if (status.state === 'cancelled') return 'ボットの整理を取り消しました';
  if (status.state === 'busy') return busyText(status);
  return `ボットの整理が止まりました${status.error && status.error.message ? `：${status.error.message}` : ''}`;
}

/** busy の説明（ほかの整理が動いている／少し前に実行した） */
export function busyText(status) {
  const e = status && status.error ? status.error : null;
  const m = e && e.retryAfterMin ? `（あと${e.retryAfterMin}分）` : '';
  if (e && e.code === 'too_soon') return `少し前に実行しました${m}`;
  return `ボットはほかの整理をしています${m}`;
}

/** エラーの説明（ボットの文＋もう一度できるまで） */
export function errorText(status) {
  const e = status && status.error ? status.error : null;
  const base = e && e.message ? e.message : 'ボットでエラーが起きました';
  return `${base}${e && e.retryAfterMin ? `（${e.retryAfterMin}分後にもう一度できます）` : ''}`;
}

// ================================================================ 下書き（data/show/draft.json）

/** 下書きの形を確かめる。返り値: { generatedAt, week, requestId, main: [{ id, reason }], category, chat } か null */
export function normalizeDraft(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const list = (v, max) => {
    const out = [];
    for (const x of Array.isArray(v) ? v.slice(0, 50) : []) {
      const id = x && typeof x === 'object' ? text(x.topic_id, 100) : '';
      if (id && !out.some((y) => y.id === id)) out.push({ id, reason: text(x.reason, 200) || null });
      if (out.length >= max) break;
    }
    return out;
  };
  if (!['main', 'category', 'chat'].some((k) => Array.isArray(raw[k]))) return null;
  return {
    generatedAt: text(raw.generated_at, 40) || null,
    week: text(raw.week, 20) || null,
    requestId: text(raw.request_id, 80) || null,
    main: list(raw.main, 3),
    category: list(raw.category, BOARD.draftCategory),
    chat: list(raw.chat, BOARD.draftChat),
  };
}

/**
 * 下書きファイルを使えるか。同じ番組週で、作られてから 12 時間以内だけ（requestId を渡したら、そのお願いの結果なら古さは見ない）。
 * 返り値: { ok: true, draft } ／ { ok: false, reason: 'shape'|'week'|'stale' }
 */
export function parseDraftFile(raw, { weekKey, nowMs, maxAgeMs = PREPARE.draftFreshMs, parseTs, requestId = null }) {
  const d = normalizeDraft(raw);
  if (!d) return { ok: false, reason: 'shape' };
  if (d.week !== weekKey) return { ok: false, reason: 'week' };
  if (requestId && d.requestId === requestId) return { ok: true, draft: d };
  const ts = d.generatedAt && parseTs ? parseTs(d.generatedAt) : null;
  if (ts == null || nowMs - ts * 1000 > maxAgeMs || ts * 1000 - nowMs > 10 * 60 * 1000) return { ok: false, reason: 'stale' };
  return { ok: true, draft: d };
}

/**
 * 下書き → 番組の流れに入れる案（board.js の autoDraftPlan と同じ形）。空いている所だけ:
 * メインは空いている枠に順に、カテゴリ別・雑談はそのコーナーが空のときだけ。
 * topic_id は「g:<id>」（ボットのまとまり）。無い・使えない（保留・片付け・削除）・番組に入っている・決まりに合わない
 * （一般のバズをメイン／夜職を雑談／一般をカテゴリ別）ものは飛ばす。
 * ctx: { week, topicsById, visibleIds（使えるまとまり id の Set）}
 * 返り値: { main: [{ slot, id }], category: [id], chat: [id], empty, skipped（飛ばした数）, reasons（id → 理由）}
 */
export function draftToPlan(draft, ctx) {
  const { week, topicsById = new Map(), visibleIds = null } = ctx;
  const used = placedTopicIds(week);
  const slots = mainSlots(week.rundown);
  const emptySlots = slots.map((id, k) => (id ? -1 : k)).filter((k) => k >= 0);
  const corner = (k) => (week.rundown.corners.find((c) => c.key === k) || { items: [] }).items.filter(Boolean);
  const empty = { main: emptySlots.length, category: corner('category').length === 0, chat: corner('chat').length === 0 };
  const plan = { main: [], category: [], chat: [], empty, skipped: 0, reasons: new Map() };
  const pick = (x, ok) => {
    const id = botTopicId(x.id);
    const t = topicsById.get(id);
    if (!t || (visibleIds && !visibleIds.has(id)) || used.has(id) || !ok(t)) { plan.skipped += 1; return null; }
    used.add(id);
    if (x.reason) plan.reasons.set(id, x.reason);
    return id;
  };
  if (!draft) return plan;
  let k = 0;
  for (const x of draft.main) {
    if (k >= emptySlots.length) break;
    const id = pick(x, (t) => canBeMain(t));
    if (id) plan.main.push({ slot: emptySlots[k++], id });
  }
  if (empty.category) for (const x of draft.category) { if (plan.category.length >= BOARD.draftCategory) break; const id = pick(x, (t) => isNightGenre(t.genre)); if (id) plan.category.push(id); }
  if (empty.chat) for (const x of draft.chat) { if (plan.chat.length >= BOARD.draftChat) break; const id = pick(x, (t) => !isNightGenre(t.genre)); if (id) plan.chat.push(id); }
  return plan;
}

// ================================================================ 届いた投稿を足す

const POST_ID = /^\d{5,25}$/;

/**
 * posts.json（読み込んだままの形）に、ボットの posts を id で足す（同じ id は新しいほうに置きかえ。ほかはそのまま）。
 * generatedAt が新しければ generated_at も進める（parseTs で比べる）。
 * 返り値: { raw（新しい posts.json の形）, added（新しく増えた数）, replaced }
 */
export function mergePosts(baseRaw, incoming, generatedAt = null, parseTs = () => null) {
  const base = baseRaw && Array.isArray(baseRaw.posts) ? baseRaw : { posts: [] };
  const byId = new Map();
  base.posts.forEach((p, i) => { if (p && p.id != null) byId.set(String(p.id), i); });
  const posts = [...base.posts];
  let added = 0;
  let replaced = 0;
  for (const p of Array.isArray(incoming) ? incoming : []) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
    const id = typeof p.id === 'string' ? p.id.trim() : (Number.isSafeInteger(p.id) ? String(p.id) : '');
    if (!POST_ID.test(id)) continue;
    const post = { ...p, id };
    if (byId.has(id)) { posts[byId.get(id)] = post; replaced += 1; } else { byId.set(id, posts.length); posts.push(post); added += 1; }
  }
  const g0 = parseTs(base.generated_at);
  const g1 = parseTs(generatedAt);
  const newer = g1 != null && (g0 == null || g1 > g0);
  return { raw: { ...base, posts, ...(newer ? { generated_at: generatedAt } : {}) }, added, replaced };
}
