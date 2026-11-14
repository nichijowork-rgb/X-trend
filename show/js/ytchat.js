// YouTube ライブのコメント（YouTube Data API v3・読み取り専用・API キーだけ。OAuth・Cookie は使わない）。DOM 非依存（node:test から import）。
// 流れ: 進行画面（show.js）が videos.list で activeLiveChatId を取り → liveChat/messages を数秒おきに読む →
//       コメント一覧（ログ）に入れ、新しいものだけ OBS のオーバーレイ（part=comments）へ type: 'chat' のメッセージで送る。
// 書き込み（投稿・削除・BAN）はしない。API キーは googleapis にだけ送る（ログ・書き出しには入れない）。

export const YT_CHAT_PREF_KEY = 'xtrend-show-ytchat';
export const YT_API = 'https://www.googleapis.com/youtube/v3';
export const YT_QUOTA_DAILY = 10000;
/** 1 回あたりの消費（見積もり用）: videos.list 1・liveChatMessages.list 5 */
export const YT_UNITS = Object.freeze({ videos: 1, messages: 5 });
/** 取得間隔の選択肢（ms）。YouTube の pollingIntervalMillis の方が長ければそちら */
export const CHAT_INTERVALS = Object.freeze([5000, 6000, 8000, 10000, 15000]);
export const CHAT_LOG_MAX = 300;
/** 画面に流す本文の長さ（超えたら …） */
export const CHAT_SCREEN_MAX = 60;
/** 固定コメントの本文（2 行まで。CSS でも省略） */
export const CHAT_PIN_MAX = 140;
/** これより古いコメントはオーバーレイで流さない（後から開いたソースが昔のものを流さない） */
export const CHAT_STALE_MS = 30000;
/** 固定コメントは前回の起動から 3 時間以内なら復元する（先週の固定が急に出ないように） */
export const CHAT_PIN_RESTORE_MS = 3 * 3600 * 1000;
/** 固定コメントの箱（1920×1080 の座標。高さは中身しだい） */
export const CHAT_PIN_BOX = Object.freeze({ x: 655, y: 600, w: 1170 });
/** 流れ方の既定値（あとで変えられる設定） */
export const CHAT_CFG_DEFAULTS = Object.freeze({ top: 660, lanes: 4, laneH: 62, size: 34, speed: 8, flow: true });
/** 設定の範囲 [最小, 最大] */
export const CHAT_CFG_LIMITS = Object.freeze({ top: [0, 1040], lanes: [1, 12], laneH: [30, 200], size: [16, 96], speed: [3, 30] });
export const CHAT_DEFAULTS = Object.freeze({ key: '', url: '', interval: 6000, ng: '', pin: null, pinnedAt: null, ...CHAT_CFG_DEFAULTS });
/** アイコンとして使ってよい画像の置き場所（YouTube のプロフィール画像） */
export const YT_IMAGE_HOSTS = Object.freeze(['yt3.ggpht.com', 'yt4.ggpht.com', 'yt3.googleusercontent.com', 'lh3.googleusercontent.com']);
/** スーパーチャットの色（tier 1〜7。YouTube の色に近い値） */
const TIER_COLORS = ['#1e88e5', '#00e5ff', '#1de9b6', '#ffca28', '#f57c00', '#e91e63', '#e62117'];

const ID_RE = /^[\x21-\x7e]{1,200}$/;
const CHANNEL_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VIDEO_RE = /^[A-Za-z0-9_-]{11}$/;
// 制御文字・ゼロ幅・向きを変える文字（表示を崩す）を外す
const BAD_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** 文字を整える: 改行・タブは空白、制御文字などは削除、前後の空白を落とし、max 文字（コードポイント）まで */
export function cleanText(s, max = 500) {
  const t = String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(BAD_CHARS, '').replace(/ {2,}/g, ' ').trim();
  const cp = Array.from(t);
  return cp.length > max ? cp.slice(0, max).join('') : t;
}

/** 画面用の短い本文（max 文字を超えたら最後を … に） */
export function screenText(s, max = CHAT_SCREEN_MAX) {
  const cp = Array.from(cleanText(s, 2000));
  return cp.length > max ? `${cp.slice(0, Math.max(1, max - 1)).join('')}…` : cp.join('');
}

/**
 * 配信の URL（または 11 文字の動画 ID）から動画 ID を取る。読めなければ null。
 * watch?v= / youtu.be/ / /live/ID / /shorts/ID / /embed/ID / studio.youtube.com/video/ID/livestreaming / m.youtube.com
 */
export function parseVideoId(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  if (VIDEO_RE.test(s)) return s;
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const seg = u.pathname.split('/').filter(Boolean);
  const ok = (v) => (typeof v === 'string' && VIDEO_RE.test(v) ? v : null);
  if (host === 'youtu.be') return ok(seg[0]);
  if (host === 'studio.youtube.com') return seg[0] === 'video' ? ok(seg[1]) : null;
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    if (seg[0] === 'watch') return ok(u.searchParams.get('v'));
    if (['live', 'shorts', 'embed', 'v'].includes(seg[0])) return ok(seg[1]);
    if (seg.length === 0) return ok(u.searchParams.get('v'));
  }
  return null;
}

/** API キーの形（Google の API キーは英数字と _ - で 39 文字前後） */
export function validKey(k) {
  return typeof k === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(k);
}

/** Google の API キーらしいか（「AIza」で始まり、英数字と _ - だけ。ふつうは 39 文字）。保存前の確かめ用 */
export function looksLikeGoogleKey(k) {
  return typeof k === 'string' && /^AIza[A-Za-z0-9_-]{30,45}$/.test(k);
}

/** プロフィール画像の URL（https の YouTube の画像置き場だけ。ほかは null＝頭文字の丸） */
export function safeIcon(url) {
  if (typeof url !== 'string' || url.length > 600) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !YT_IMAGE_HOSTS.includes(u.hostname)) return null;
    return u.href;
  } catch { return null; }
}

/** 頭文字（@ を外した最初の 1 文字）。アイコンが無いときの丸に使う */
export function initialOf(name) {
  const c = Array.from(String(name || '').replace(/^@/, '').trim())[0];
  return c ? c.toUpperCase() : '?';
}

/** 背景色に合わせた文字色（明るい色なら黒） */
export function inkFor(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const lin = (c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.4 ? '#111111' : '#ffffff';
}

const tierColor = (t) => { const n = Number(t); return Number.isInteger(n) && n >= 1 ? TIER_COLORS[Math.min(n, TIER_COLORS.length) - 1] : TIER_COLORS[0]; };

/** liveChat/messages の 1 件 → 出来事（add / delete / ban）。対象外は null */
export function normalizeChatItem(it, now = Date.now()) {
  if (!it || typeof it !== 'object') return null;
  const sn = it.snippet && typeof it.snippet === 'object' ? it.snippet : {};
  const type = sn.type;
  if (type === 'messageDeletedEvent') {
    const id = sn.messageDeletedDetails && sn.messageDeletedDetails.deletedMessageId;
    return typeof id === 'string' && ID_RE.test(id) ? { type: 'delete', id } : null;
  }
  if (type === 'userBannedEvent') {
    const d = sn.userBannedDetails || {};
    const ch = (d.bannedUserDetails && d.bannedUserDetails.channelId) || (sn.bannedUserDetails && sn.bannedUserDetails.channelId);
    return typeof ch === 'string' && CHANNEL_RE.test(ch) ? { type: 'ban', channelId: ch } : null;
  }
  let kind;
  let text = '';
  let amount = '';
  let color = null;
  if (type === 'textMessageEvent') {
    kind = 'text';
    text = sn.displayMessage ?? (sn.textMessageDetails && sn.textMessageDetails.messageText);
  } else if (type === 'superChatEvent') {
    kind = 'super';
    const d = sn.superChatDetails || {};
    text = d.userComment || '';
    amount = d.amountDisplayString || '';
    color = tierColor(d.tier);
  } else if (type === 'superStickerEvent') {
    kind = 'sticker';
    const d = sn.superStickerDetails || {};
    text = 'スーパーステッカー';
    amount = d.amountDisplayString || '';
    color = tierColor(d.tier);
  } else return null;
  const id = typeof it.id === 'string' && ID_RE.test(it.id) ? it.id : null;
  if (!id) return null;
  const a = it.authorDetails && typeof it.authorDetails === 'object' ? it.authorDetails : {};
  const ch = typeof a.channelId === 'string' && CHANNEL_RE.test(a.channelId) ? a.channelId : (typeof sn.authorChannelId === 'string' && CHANNEL_RE.test(sn.authorChannelId) ? sn.authorChannelId : '');
  const t = cleanText(text, 500);
  if (kind === 'text' && !t) return null;
  const published = Date.parse(sn.publishedAt);
  return {
    type: 'add',
    item: {
      id, kind, text: t,
      name: cleanText(a.displayName, 80) || '（名前なし）',
      icon: safeIcon(a.profileImageUrl),
      channelId: ch,
      amount: cleanText(amount, 30),
      color,
      owner: a.isChatOwner === true,
      mod: a.isChatModerator === true,
      member: a.isChatSponsor === true,
      publishedAt: Number.isFinite(published) ? published : null,
      at: now,
    },
  };
}

/** liveChat/messages の応答 → { events, next, pollMs, offline }。壊れた項目は飛ばす */
export function normalizeChatResponse(json, now = Date.now()) {
  const o = json && typeof json === 'object' ? json : {};
  const events = [];
  for (const it of Array.isArray(o.items) ? o.items.slice(0, 2000) : []) {
    const ev = normalizeChatItem(it, now);
    if (ev) events.push(ev);
  }
  const poll = Number(o.pollingIntervalMillis);
  return {
    events,
    next: typeof o.nextPageToken === 'string' && o.nextPageToken && o.nextPageToken.length <= 1000 ? o.nextPageToken : null,
    pollMs: o.pollingIntervalMillis != null && Number.isFinite(poll) && poll >= 0 ? Math.min(poll, 120000) : null,
    offline: Boolean(o.offlineAt),
  };
}

/** videos.list の応答 → { id }（activeLiveChatId）か { error } */
export function liveChatIdOf(body) {
  const it = body && Array.isArray(body.items) ? body.items[0] : null;
  if (!it || typeof it !== 'object') return { error: { code: 'ended', stop: true, message: '動画が見つかりません（URL が違うか、非公開・削除された動画です）' } };
  const d = it.liveStreamingDetails;
  if (!d || typeof d !== 'object') return { error: { code: 'ended', stop: true, message: 'この動画はライブ配信ではありません（配信の URL を入れてください）' } };
  const id = typeof d.activeLiveChatId === 'string' && ID_RE.test(d.activeLiveChatId) ? d.activeLiveChatId : null;
  if (!id) return { error: { code: 'ended', stop: true, message: d.actualEndTime ? '配信は終わっています（コメントは取れません）' : '配信がまだ始まっていないか、チャットがオフです（始まってからもう一度「開始」）' } };
  return { id };
}

/**
 * API のエラー → { code, stop, message }。stop: true は自動で止める（やり直しても直らない）。
 * code: quota（今日の上限）／ended（配信・チャットが無い）／key（API キーの設定）／busy・network（自動でやり直す）／other
 */
export function classifyApiError(status, body) {
  if (!status) return { code: 'network', stop: false, message: 'つながりません（ネットの状態を確認してください。自動でやり直します）' };
  const e = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : {};
  const reasons = new Set();
  for (const x of Array.isArray(e.errors) ? e.errors : []) if (x && typeof x.reason === 'string') reasons.add(x.reason);
  for (const x of Array.isArray(e.details) ? e.details : []) if (x && typeof x.reason === 'string') reasons.add(x.reason);
  const has = (...r) => r.some((x) => reasons.has(x));
  const keyMsg = (s) => ({ code: 'key', stop: true, message: `API キーの設定を確認してください：${s}` });
  if (has('quotaExceeded', 'dailyLimitExceeded', 'dailyLimitExceededUnreg')) return { code: 'quota', stop: true, message: '今日の YouTube API の上限（1 日 10,000）に達しました。日本時間の 16〜17 時ごろに戻ります' };
  if (has('liveChatEnded')) return { code: 'ended', stop: true, message: '配信のチャットが終わっています（コメントの取得を止めました）' };
  if (has('liveChatDisabled')) return { code: 'ended', stop: true, message: 'この配信はチャットがオフです' };
  if (has('liveChatNotFound', 'videoNotFound')) return { code: 'ended', stop: true, message: 'コメント欄が見つかりません（配信が始まっていない・終わった・URL が違う）' };
  if (has('keyInvalid', 'API_KEY_INVALID', 'keyExpired', 'API_KEY_EXPIRED')) return keyMsg('キーが正しくありません（コピーし直して入れてください）');
  if (has('accessNotConfigured', 'SERVICE_DISABLED')) return keyMsg('このキーのプロジェクトで「YouTube Data API v3」が有効になっていません');
  if (has('ipRefererBlocked', 'API_KEY_HTTP_REFERRER_BLOCKED', 'refererBlocked', 'API_KEY_SERVICE_BLOCKED')) return keyMsg('キーの制限でこのページが許可されていません（ウェブサイトの制限に https://www.x-yoru-buzz.com/* 、API の制限に YouTube Data API v3）');
  if (has('forbidden') && status === 403) return { code: 'ended', stop: true, message: 'コメント欄を読めません（メンバー限定・非公開の配信など）' };
  if (has('rateLimitExceeded', 'userRateLimitExceeded', 'backendError', 'internalError', 'RATE_LIMIT_EXCEEDED') || status === 429 || status >= 500) return { code: 'busy', stop: false, message: 'YouTube が混み合っています（自動でやり直します）' };
  if (status === 404) return { code: 'ended', stop: true, message: 'コメント欄が見つかりません（配信が始まっていない・終わった・URL が違う）' };
  if (status === 400 || status === 401 || status === 403) return keyMsg(`キーか設定が正しくありません（${status}）`);
  return { code: 'other', stop: true, message: `コメントを取得できませんでした（${status}）` };
}

const enc = encodeURIComponent;
export function videosUrl(videoId, key) {
  return `${YT_API}/videos?part=liveStreamingDetails&id=${enc(videoId)}&key=${enc(key)}`;
}
export function messagesUrl(chatId, key, pageToken = null) {
  return `${YT_API}/liveChat/messages?liveChatId=${enc(chatId)}&part=snippet,authorDetails&maxResults=200${pageToken ? `&pageToken=${enc(pageToken)}` : ''}&key=${enc(key)}`;
}

/** 使った量の見積もり（単位）。calls: { videos, messages } */
export function quotaUnits(calls) {
  const c = calls || {};
  return (Number(c.videos) || 0) * YT_UNITS.videos + (Number(c.messages) || 0) * YT_UNITS.messages;
}
/** 取得間隔 ms のとき 1 時間で使う量の見積もり */
export function quotaPerHour(intervalMs) {
  const ms = Math.max(1000, Number(intervalMs) || 6000);
  return Math.ceil(3600000 / ms) * YT_UNITS.messages;
}

// ---------------------------------------------------------------- NG ワード

/** 照合用に整える（全角/半角をそろえ NFKC、小文字） */
export function normalizeNg(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase();
}
/** 「、」「,」・改行区切りの NG ワード → 配列（重複・空は除く。200 語・1 語 50 字まで） */
export function parseNgWords(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text ?? '').split(/[,，、\n\r]+/)) {
    const w = cleanText(raw, 50);
    const k = normalizeNg(w);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(w);
    if (out.length >= 200) break;
  }
  return out;
}
/** NG ワードの照合関数（本文・名前のどちらかに含まれたらその語、無ければ null） */
export function ngMatcher(words) {
  const list = (words || []).map((w) => [w, normalizeNg(w)]).filter(([, k]) => k);
  if (!list.length) return () => null;
  return (item) => {
    const s = normalizeNg(`${item && item.text ? item.text : ''}\n${item && item.name ? item.name : ''}`);
    for (const [w, k] of list) if (s.includes(k)) return w;
    return null;
  };
}

// ---------------------------------------------------------------- ログ（コメント一覧）

/**
 * 取得した出来事をログへ。log は古い→新しい順。backlog（最初の応答）はログだけで流さない。
 * opts: { backlog, ng（照合関数）, hidden（画面から消した id の Set）, banned（BAN された channelId の Set）, max }
 * 返り値: { log, flow（流すもの）, removed（画面・ログから消す id）, banned（新しく BAN された channelId）, added（ログに入った数） }
 */
export function applyChatBatch(log, events, opts = {}) {
  const { backlog = false, ng = null, hidden = new Set(), banned = new Set(), max = CHAT_LOG_MAX } = opts;
  let list = Array.isArray(log) ? log.slice() : [];
  const ids = new Set(list.map((x) => x.id));
  let flow = [];
  const removed = [];
  const newBans = [];
  let added = 0;
  const bans = new Set(banned);
  for (const ev of events || []) {
    if (!ev) continue;
    if (ev.type === 'add' && ev.item) {
      const it = ev.item;
      if (ids.has(it.id) || (it.channelId && bans.has(it.channelId))) continue;
      const word = typeof ng === 'function' ? ng(it) : null;
      const entry = { ...it, ng: word || null };
      if (backlog) entry.backlog = true;
      list.push(entry);
      ids.add(it.id);
      added++;
      if (!backlog && !word && !hidden.has(it.id)) flow.push(entry);
    } else if (ev.type === 'delete') {
      if (ids.has(ev.id)) { list = list.filter((x) => x.id !== ev.id); ids.delete(ev.id); }
      flow = flow.filter((x) => x.id !== ev.id);
      if (!removed.includes(ev.id)) removed.push(ev.id);
    } else if (ev.type === 'ban') {
      if (!bans.has(ev.channelId)) { bans.add(ev.channelId); newBans.push(ev.channelId); }
      const gone = list.filter((x) => x.channelId === ev.channelId).map((x) => x.id);
      if (gone.length) {
        const g = new Set(gone);
        list = list.filter((x) => !g.has(x.id));
        for (const id of gone) { ids.delete(id); if (!removed.includes(id)) removed.push(id); }
        flow = flow.filter((x) => !g.has(x.id));
      }
    }
  }
  if (list.length > max) list = list.slice(list.length - max);
  return { log: list, flow, removed, banned: newBans, added };
}

// ---------------------------------------------------------------- 設定

const clampNum = (v, [min, max], def, step = 1) => {
  const n = Number(v);
  if (v === '' || v == null || !Number.isFinite(n)) return def;
  const r = Math.round(n / step) * step;
  return Math.min(max, Math.max(min, Number(r.toFixed(2))));
};

/** 流れ方の設定（オーバーレイでも使う）。範囲外は丸める。帯が画面からはみ出す列は減らす */
export function sanitizeChatCfg(o) {
  const src = o && typeof o === 'object' ? o : {};
  const L = CHAT_CFG_LIMITS;
  const D = CHAT_CFG_DEFAULTS;
  const top = clampNum(src.top, L.top, D.top);
  const laneH = clampNum(src.laneH, L.laneH, D.laneH);
  let lanes = clampNum(src.lanes, L.lanes, D.lanes);
  lanes = Math.max(1, Math.min(lanes, Math.floor((1080 - top) / laneH)));
  return { top, lanes, laneH, size: clampNum(src.size, L.size, D.size), speed: clampNum(src.speed, L.speed, D.speed, 0.5), flow: src.flow !== false };
}

/** オーバーレイへ送る形のコメント（画面に要るものだけ・短く） */
export function wireItem(it, max = CHAT_SCREEN_MAX) {
  if (!it || typeof it !== 'object' || typeof it.id !== 'string' || !ID_RE.test(it.id)) return null;
  const kind = ['text', 'super', 'sticker'].includes(it.kind) ? it.kind : 'text';
  const color = typeof it.color === 'string' && /^#[0-9a-f]{6}$/i.test(it.color) ? it.color.toLowerCase() : null;
  return {
    id: it.id, kind, text: screenText(it.text, max), name: cleanText(it.name, 40), icon: safeIcon(it.icon),
    amount: cleanText(it.amount, 30), color: kind === 'text' ? null : color, at: Number.isFinite(it.at) ? it.at : null,
  };
}

/** 保存している設定（localStorage）を読む。壊れた値は既定値 */
export function parseChatPrefs(raw) {
  let o = null;
  try { o = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { o = null; }
  if (!o || typeof o !== 'object') o = {};
  const interval = CHAT_INTERVALS.includes(Number(o.interval)) ? Number(o.interval) : CHAT_DEFAULTS.interval;
  const pin = o.pin ? wireItem(o.pin, CHAT_PIN_MAX) : null;
  return {
    key: typeof o.key === 'string' ? o.key.trim().slice(0, 200) : '',
    url: typeof o.url === 'string' ? o.url.trim().slice(0, 400) : '',
    interval,
    ng: typeof o.ng === 'string' ? o.ng.slice(0, 5000) : '',
    ...sanitizeChatCfg(o),
    pin,
    pinnedAt: pin && Number.isFinite(o.pinnedAt) ? o.pinnedAt : null,
  };
}

/** 保存していた固定コメントを使うか（固定してから CHAT_PIN_RESTORE_MS 以内だけ） */
export function restorePin(prefs, now = Date.now()) {
  return prefs && prefs.pin && Number.isFinite(prefs.pinnedAt) && now - prefs.pinnedAt < CHAT_PIN_RESTORE_MS ? prefs.pin : null;
}

// ---------------------------------------------------------------- オーバーレイとのやりとり（type: 'chat'）

export const CHAT_MSG_VERSION = 1;

/** 送るメッセージ: { v:1, type:'chat', sid, seq, at, add, remove, pin, cfg } */
export function buildChatMessage({ sid, seq, at = Date.now(), add = [], remove = [], pin = null, cfg = null }) {
  return {
    v: CHAT_MSG_VERSION, type: 'chat', sid: String(sid || ''), seq: Number(seq) || 0, at,
    add: add.map((x) => wireItem(x)).filter(Boolean),
    remove: remove.filter((x) => typeof x === 'string' && ID_RE.test(x)),
    pin: pin ? wireItem(pin, CHAT_PIN_MAX) : null,
    cfg: cfg ? sanitizeChatCfg(cfg) : null,
  };
}

/**
 * 受け手（オーバーレイ）: add は id で重複を除き（覚えるのは max 件まで）、CHAT_STALE_MS より古いものは流さない。
 * remove・pin・cfg は毎回反映（同じ送り手の古い seq のものは pin・cfg を変えない）。
 * accept(msg, now) → { add, remove, pin（undefined＝変えない／null＝外す）, cfg（null＝変えない） } か null
 */
export function createChatReceiver({ max = 600, staleMs = CHAT_STALE_MS } = {}) {
  const seen = new Set();
  let last = null; // { sid, seq, at }
  return {
    accept(msg, now = Date.now()) {
      if (!msg || typeof msg !== 'object' || msg.v !== CHAT_MSG_VERSION || msg.type !== 'chat') return null;
      // 時計が大きくずれている（OBS が別のパソコン）ときは送った時刻を基準に
      const skew = Number.isFinite(msg.at) && Math.abs(now - msg.at) > 60000;
      const ref = skew ? msg.at : now;
      const add = [];
      for (const raw of Array.isArray(msg.add) ? msg.add.slice(0, 200) : []) {
        const it = wireItem(raw);
        if (!it || seen.has(it.id)) continue;
        seen.add(it.id);
        if (seen.size > max) seen.delete(seen.values().next().value);
        if (it.at == null || ref - it.at > staleMs) continue;
        add.push(it);
      }
      const remove = (Array.isArray(msg.remove) ? msg.remove.slice(0, 500) : []).filter((x) => typeof x === 'string' && ID_RE.test(x));
      const seq = Number(msg.seq) || 0;
      const at = Number(msg.at) || 0;
      const newer = !last || (msg.sid === last.sid ? seq > last.seq : at >= last.at);
      if (newer) last = { sid: msg.sid, seq, at };
      return {
        add,
        remove,
        pin: newer ? (msg.pin ? wireItem(msg.pin, CHAT_PIN_MAX) : null) : undefined,
        cfg: newer && msg.cfg ? sanitizeChatCfg(msg.cfg) : null,
      };
    },
    seen: () => seen.size,
  };
}

// ---------------------------------------------------------------- 取得（videos.list → liveChat/messages を繰り返す）

const RETRY_MS = [2000, 5000, 10000, 20000, 30000];

/**
 * opts: { key, videoId, interval（最短の間隔 ms）, fetchImpl, now, setTimer, clearTimer,
 *         onStatus(st), onBatch(norm, { backlog }), onUnits(kind: 'videos'|'messages') }
 * st: { status: 'idle'|'starting'|'running'|'retrying'|'stopped'|'error', reason, code }
 * 最初の応答（backlog）は onBatch に backlog: true で渡す（流さずログだけ）。
 * 通信の失敗・混雑は 2→5→10→20→30 秒でやり直し、上限・キー・配信なしは止める。
 */
export function createChatPoller(opts) {
  const fetchImpl = opts.fetchImpl;
  const now = opts.now || (() => Date.now());
  const setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer || ((t) => clearTimeout(t));
  let interval = Number(opts.interval) || CHAT_DEFAULTS.interval;
  let st = { status: 'idle', reason: '', code: '' };
  let timer = null;
  let ctrl = null;
  let stopped = true;
  let chatId = null;
  let page = null;
  let first = true;
  let fails = 0;
  let run = 0; // start ごとの番号（止めたあとの応答を捨てる）
  const set = (patch) => { st = { ...st, ...patch }; if (opts.onStatus) opts.onStatus({ ...st }); };

  async function call(url, kind, myRun) {
    ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let res;
    try {
      res = await fetchImpl(url, { method: 'GET', referrerPolicy: 'origin', credentials: 'omit', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
    } catch {
      return myRun === run && !stopped ? { error: classifyApiError(0, null) } : { aborted: true };
    }
    if (myRun !== run || stopped) return { aborted: true };
    if (opts.onUnits) opts.onUnits(kind);
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (myRun !== run || stopped) return { aborted: true };
    if (!res.ok) return { error: classifyApiError(res.status, body) };
    return { body };
  }
  function fail(err) {
    stopped = true;
    clearTimer(timer);
    timer = null;
    set({ status: 'error', reason: err.message, code: err.code });
  }
  function retry(err, myRun) {
    fails++;
    set({ status: 'retrying', reason: err.message, code: err.code });
    timer = setTimer(() => step(myRun), RETRY_MS[Math.min(fails, RETRY_MS.length) - 1]);
  }
  async function step(myRun) {
    timer = null;
    if (stopped || myRun !== run) return;
    if (!chatId) {
      const r = await call(videosUrl(opts.videoId, opts.key), 'videos', myRun);
      if (r.aborted) return;
      if (r.error) { if (r.error.stop) fail(r.error); else retry(r.error, myRun); return; }
      const found = liveChatIdOf(r.body);
      if (found.error) { fail(found.error); return; }
      chatId = found.id;
    }
    const r = await call(messagesUrl(chatId, opts.key, page), 'messages', myRun);
    if (r.aborted) return;
    if (r.error) { if (r.error.stop) fail(r.error); else retry(r.error, myRun); return; }
    fails = 0;
    const norm = normalizeChatResponse(r.body, now());
    const backlog = first;
    first = false;
    if (norm.next) page = norm.next;
    if (st.status !== 'running') set({ status: 'running', reason: '', code: '' });
    try { if (opts.onBatch) opts.onBatch(norm, { backlog }); } catch { /* 受け手の失敗で止めない */ }
    if (norm.offline) { fail({ code: 'ended', message: '配信が終わりました（コメントの取得を止めました）' }); return; }
    timer = setTimer(() => step(myRun), Math.max(norm.pollMs || 0, interval));
  }
  return {
    start() {
      if (!stopped) return;
      stopped = false;
      run++;
      fails = 0;
      first = true; // 止めていた間の分は流さない（ログだけ）
      set({ status: 'starting', reason: '', code: '' });
      step(run);
    },
    stop() {
      stopped = true;
      run++;
      clearTimer(timer);
      timer = null;
      if (ctrl) { try { ctrl.abort(); } catch { /* 無視 */ } }
      set({ status: 'stopped', reason: '', code: '' });
    },
    setInterval(ms) { if (Number(ms) > 0) interval = Number(ms); },
    status() { return { ...st }; },
  };
}

// ---------------------------------------------------------------- 見本（API を使わない確認用。名前は架空）

export const CHAT_SAMPLES = Object.freeze([
  { name: '@sample_mio', text: 'こんばんは！今日も楽しみにしてました' },
  { name: '@yoru_neko', text: 'その話きになる〜' },
  { name: '@kabuki_taro', text: 'ホストコールの件、続報ほしいです' },
  { name: '@sakura_fan', text: '今週もおつかれさまです！', kind: 'super', amount: '¥1,000', tier: 4 },
  { name: '@night_owl_22', text: 'わかる' },
  { name: '@tokyo_nights', text: '初見です、よろしくお願いします' },
  { name: '@sample_ken', kind: 'sticker', amount: '¥500', tier: 3 },
  { name: '@hana_0707', text: 'いまの話、ほんとにあったの？' },
  { name: '@mochi_mochi', text: '声きこえてます！' },
  { name: '@shinjuku_walker', text: '長いコメントのテストです。画面に流すときは 60 文字をこえたところで省略されるので、最後まで出ないことがあります' },
  { name: '@yoru_buzz_fan', text: '草' },
  { name: '@nana_chan', text: 'まってました👏', kind: 'super', amount: '¥5,000', tier: 6 },
]);

/** 見本のコメント（i 番目。id は時刻つきで毎回別） */
export function demoChatItem(i, now = Date.now(), tag = 'demo') {
  const s = CHAT_SAMPLES[((i % CHAT_SAMPLES.length) + CHAT_SAMPLES.length) % CHAT_SAMPLES.length];
  const kind = s.kind || 'text';
  return {
    id: `${tag}-${now.toString(36)}-${i}`, kind, text: kind === 'sticker' ? 'スーパーステッカー' : s.text, name: s.name, icon: null, channelId: `${tag}-${s.name.slice(1)}`,
    amount: s.amount || '', color: kind === 'text' ? null : tierColor(s.tier), owner: false, mod: false, member: false, publishedAt: now, at: now, sample: true,
  };
}
/** 見本の固定コメント */
export function demoChatPin(now = Date.now()) {
  return { id: `demo-pin-${now.toString(36)}`, kind: 'text', text: '固定コメントの見本です。進行画面のコメント一覧で［固定］を押すと、ここに大きく出ます。2 行をこえると省略されます', name: '@sample_mio', icon: null, amount: '', color: null, at: now };
}
