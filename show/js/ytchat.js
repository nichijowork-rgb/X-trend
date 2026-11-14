// YouTube ライブのコメント（YouTube Data API v3・読み取り専用・API キーだけ。OAuth・Cookie は使わない）。DOM 非依存（node:test から import）。
// 流れ: 進行画面（show.js）が videos.list で activeLiveChatId を取り（URL が空ならチャンネルから今の配信を探し）→
//       liveChat/messages/stream（プッシュ型。だめなら liveChat/messages を数秒おき）で読む →
//       コメント一覧（ログ）に入れ、新しいものだけ OBS のオーバーレイ（part=comments）へ type: 'chat' のメッセージで送る。
// 書き込み（投稿・削除・BAN）はしない。API キーは googleapis にだけ送る（ログ・書き出しには入れない）。
import { clampRect } from './layoutgeo.js';

export const YT_CHAT_PREF_KEY = 'xtrend-show-ytchat';
export const YT_API = 'https://www.googleapis.com/youtube/v3';
export const YT_QUOTA_DAILY = 10000;
/** 1 回あたりの消費（見積もり用）: videos.list 1・liveChatMessages.list 5・stream は 1 接続 5・channels 1・playlistItems 1・search 100 */
export const YT_UNITS = Object.freeze({ videos: 1, messages: 5, stream: 5, channels: 1, playlistItems: 1, search: 100 });
/** 取得方式: auto＝プッシュ（stream）→だめなら数秒おき／poll＝数秒おきだけ */
export const CHAT_MODES = Object.freeze(['auto', 'poll']);
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
/** 流れる範囲（帯）と固定コメントの箱の既定値（1920×1080 の座標。固定の高さは中身しだい） */
export const CHAT_BAND_DEFAULT = Object.freeze({ x: 0, y: 660, w: 1920, h: 248 });
export const CHAT_PIN_DEFAULT = Object.freeze({ x: 655, y: 600, w: 1170, size: 34, lines: 2 });
/** 互換用（固定コメントの箱の既定の位置） */
export const CHAT_PIN_BOX = Object.freeze({ x: CHAT_PIN_DEFAULT.x, y: CHAT_PIN_DEFAULT.y, w: CHAT_PIN_DEFAULT.w });
/** 流れ方の既定値（レイアウト調整で変えられる）: 帯・列の数・文字の大きさ・速さ（帯を横切る秒数）・固定コメント・流すか */
export const CHAT_CFG_DEFAULTS = Object.freeze({ band: CHAT_BAND_DEFAULT, lanes: 4, size: 34, speed: 8, pin: CHAT_PIN_DEFAULT, flow: true });
/** 設定の範囲 [最小, 最大] と最小の大きさ */
export const CHAT_CFG_LIMITS = Object.freeze({
  lanes: [1, 12], size: [16, 96], speed: [3, 30], pinSize: [16, 96], pinLines: [1, 3],
  bandMinW: 200, bandMinH: 30, laneMinH: 24, pinMinW: 300, pinMaxY: 1020,
});
export const CHAT_DEFAULTS = Object.freeze({ key: '', url: '', channel: '', channelInfo: null, mode: 'auto', interval: 6000, ng: '', pin: null, pinnedAt: null });
/** アイコンとして使ってよい画像の置き場所（YouTube のプロフィール画像） */
export const YT_IMAGE_HOSTS = Object.freeze(['yt3.ggpht.com', 'yt4.ggpht.com', 'yt3.googleusercontent.com', 'lh3.googleusercontent.com']);
/** スーパーチャットの色（tier 1〜7。YouTube の色に近い値） */
const TIER_COLORS = ['#1e88e5', '#00e5ff', '#1de9b6', '#ffca28', '#f57c00', '#e91e63', '#e62117'];

const ID_RE = /^[\x21-\x7e]{1,200}$/;
const CHANNEL_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VIDEO_RE = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
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
  // stream の応答は配列で包まれている（[{"error":{…}}]）
  const b = Array.isArray(body) ? body[0] : body;
  const e = b && typeof b === 'object' && b.error && typeof b.error === 'object' ? b.error : {};
  const reasons = new Set();
  for (const x of Array.isArray(e.errors) ? e.errors : []) if (x && typeof x.reason === 'string') reasons.add(x.reason);
  for (const x of Array.isArray(e.details) ? e.details : []) if (x && typeof x.reason === 'string') reasons.add(x.reason);
  const has = (...r) => r.some((x) => reasons.has(x));
  const keyMsg = (s, known = true) => ({ code: 'key', stop: true, known, message: `API キーの設定を確認してください：${s}` });
  const r = classifyKnown(has, keyMsg, status);
  if (r) return { known: true, ...r };
  if (has('rateLimitExceeded', 'userRateLimitExceeded', 'backendError', 'internalError', 'RATE_LIMIT_EXCEEDED') || status === 429 || status >= 500) return { code: 'busy', stop: false, known: false, message: 'YouTube が混み合っています（自動でやり直します）' };
  if (status === 404) return { code: 'ended', stop: true, known: false, message: 'コメント欄が見つかりません（配信が始まっていない・終わった・URL が違う）' };
  if (status === 400 || status === 401 || status === 403) return keyMsg(`キーか設定が正しくありません（${status}）`, false);
  return { code: 'other', stop: true, known: false, message: `コメントを取得できませんでした（${status}）` };
}

/** 理由（reason）で分かる、やり直しても直らないエラー */
function classifyKnown(has, keyMsg, status) {
  if (has('quotaExceeded', 'dailyLimitExceeded', 'dailyLimitExceededUnreg')) return { code: 'quota', stop: true, message: '今日の YouTube API の上限（1 日 10,000）に達しました。日本時間の 16〜17 時ごろに戻ります' };
  if (has('liveChatEnded')) return { code: 'ended', stop: true, message: '配信のチャットが終わっています（コメントの取得を止めました）' };
  if (has('liveChatDisabled')) return { code: 'ended', stop: true, message: 'この配信はチャットがオフです' };
  if (has('liveChatNotFound', 'videoNotFound')) return { code: 'ended', stop: true, message: 'コメント欄が見つかりません（配信が始まっていない・終わった・URL が違う）' };
  if (has('keyInvalid', 'API_KEY_INVALID', 'keyExpired', 'API_KEY_EXPIRED')) return keyMsg('キーが正しくありません（コピーし直して入れてください）');
  if (has('accessNotConfigured', 'SERVICE_DISABLED')) return keyMsg('このキーのプロジェクトで「YouTube Data API v3」が有効になっていません');
  if (has('ipRefererBlocked', 'API_KEY_HTTP_REFERRER_BLOCKED', 'refererBlocked', 'API_KEY_SERVICE_BLOCKED')) return keyMsg('キーの制限でこのページが許可されていません（ウェブサイトの制限に https://www.x-yoru-buzz.com/* 、API の制限に YouTube Data API v3）');
  if (has('forbidden') && status === 403) return { code: 'ended', stop: true, message: 'コメント欄を読めません（メンバー限定・非公開の配信など）' };
  return null;
}

/**
 * プッシュ型（stream）の接続がエラーで返ったとき: stop（止める＝やり直しても直らない）／fallback（数秒おきの取得に切り替え）／retry（つなぎ直す）。
 * 上限・配信なし・キーの設定（理由が分かるもの）は止める。404・405・501 とそれ以外の 4xx はプッシュが使えないとみて切り替え。混雑はつなぎ直す
 */
export function streamErrorDecision(status, body) {
  const e = classifyApiError(status, body);
  if (e.known && e.stop) return { action: 'stop', error: e };
  if (e.code === 'busy' || e.code === 'network') return { action: 'retry', error: e };
  if (status >= 400 && status < 500) return { action: 'fallback', error: e };
  return { action: 'retry', error: e };
}

const enc = encodeURIComponent;
export function videosUrl(videoId, key) {
  return `${YT_API}/videos?part=liveStreamingDetails&id=${enc(videoId)}&key=${enc(key)}`;
}
export function messagesUrl(chatId, key, pageToken = null) {
  return `${YT_API}/liveChat/messages?liveChatId=${enc(chatId)}&part=snippet,authorDetails&maxResults=200${pageToken ? `&pageToken=${enc(pageToken)}` : ''}&key=${enc(key)}`;
}
/** プッシュ型（サーバーが開いたままの接続で JSON 配列の要素を少しずつ送ってくる） */
export function streamUrl(chatId, key, pageToken = null) {
  return `${YT_API}/liveChat/messages/stream?liveChatId=${enc(chatId)}&part=snippet,authorDetails&maxResults=200${pageToken ? `&pageToken=${enc(pageToken)}` : ''}&key=${enc(key)}`;
}

/** 使った量の見積もり（単位）。calls: { videos, messages, stream, channels, playlistItems, search } */
export function quotaUnits(calls) {
  const c = calls || {};
  let n = 0;
  for (const [k, u] of Object.entries(YT_UNITS)) n += (Number(c[k]) || 0) * u;
  return n;
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

/** 帯（流れる範囲）: 画面の中・最小の大きさ */
export function clampBand(b) {
  return clampRect(b, { minW: CHAT_CFG_LIMITS.bandMinW, minH: CHAT_CFG_LIMITS.bandMinH }, CHAT_BAND_DEFAULT);
}
/** 固定コメントの箱: x・y・幅（高さは中身しだい）・文字の大きさ・行数（1〜3） */
export function clampPinBox(p) {
  const L = CHAT_CFG_LIMITS;
  const D = CHAT_PIN_DEFAULT;
  const src = p && typeof p === 'object' ? p : {};
  const r = clampRect({ x: src.x, y: src.y, w: src.w, h: 1 }, { minW: L.pinMinW, minH: 1, H: L.pinMaxY + 1 }, { x: D.x, y: D.y, w: D.w, h: 1 });
  return { x: r.x, y: r.y, w: r.w, size: clampNum(src.size, L.pinSize, D.size), lines: clampNum(src.lines, L.pinLines, D.lines) };
}
/** 固定コメントの箱の高さの目安（実際は中身しだい。レイアウト調整で実物が測れないときに使う） */
export function pinBoxHeight(pin) {
  const p = pin || CHAT_PIN_DEFAULT;
  return Math.round(18 + 16 + 8 + 28 + p.lines * p.size * 1.3);
}
/** 1 列の高さ */
export function laneHeightOf(cfg) {
  return cfg.band.h / cfg.lanes;
}

/**
 * 流れ方の設定（オーバーレイでも使う）。範囲外は丸める。
 * 古い形（top・lanes・laneH）は帯 { x: 0, y: top, w: 1920, h: lanes × laneH } に移す。1 列が 24px 未満になる列は減らす
 */
export function sanitizeChatCfg(o) {
  const src = o && typeof o === 'object' ? o : {};
  const L = CHAT_CFG_LIMITS;
  const D = CHAT_CFG_DEFAULTS;
  let lanes = clampNum(src.lanes, L.lanes, D.lanes);
  let band;
  if (src.band && typeof src.band === 'object') band = clampBand(src.band);
  else if (src.top != null || src.laneH != null) {
    const laneH = clampNum(src.laneH, [L.laneMinH, 200], D.band.h / D.lanes);
    band = clampBand({ x: 0, y: clampNum(src.top, [0, 1080 - L.bandMinH], D.band.y), w: 1920, h: lanes * laneH });
  } else band = { ...D.band };
  lanes = Math.max(1, Math.min(lanes, Math.floor(band.h / L.laneMinH)));
  return {
    band, lanes, size: clampNum(src.size, L.size, D.size), speed: clampNum(src.speed, L.speed, D.speed, 0.5),
    pin: clampPinBox(src.pin), flow: src.flow !== false,
  };
}

/** オーバーレイの URL での上書き（&top= &lanes= &laneh= &size= &speed=）。ov: { top, lanes, laneH, size, speed } */
export function applyChatOverrides(cfg, ov) {
  if (!ov || !Object.keys(ov).length) return cfg;
  const c = { ...cfg, band: { ...cfg.band } };
  const laneH = ov.laneH != null ? ov.laneH : laneHeightOf(cfg);
  if (ov.lanes != null) c.lanes = ov.lanes;
  if (ov.lanes != null || ov.laneH != null) c.band.h = Math.round(c.lanes * laneH);
  if (ov.top != null) c.band.y = ov.top;
  if (ov.size != null) c.size = ov.size;
  if (ov.speed != null) c.speed = ov.speed;
  return sanitizeChatCfg(c);
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
  // pin は固定したコメント（id つき）。レイアウトは layout（古い保存は top・lanes・laneH・size・speed が直下）
  const pin = o.pin && typeof o.pin === 'object' && o.pin.id ? wireItem(o.pin, CHAT_PIN_MAX) : null;
  const cfg = sanitizeChatCfg({ ...(o.layout && typeof o.layout === 'object' ? o.layout : { top: o.top, lanes: o.lanes, laneH: o.laneH, size: o.size, speed: o.speed }), flow: o.flow });
  const ci = o.channelInfo && typeof o.channelInfo === 'object' ? o.channelInfo : null;
  return {
    key: typeof o.key === 'string' ? o.key.trim().slice(0, 200) : '',
    url: typeof o.url === 'string' ? o.url.trim().slice(0, 400) : '',
    channel: typeof o.channel === 'string' ? o.channel.trim().slice(0, 200) : '',
    channelInfo: ci && typeof ci.id === 'string' && CHANNEL_ID_RE.test(ci.id) && typeof ci.uploads === 'string' && /^[A-Za-z0-9_-]{2,64}$/.test(ci.uploads)
      ? { input: cleanText(ci.input, 200), id: ci.id, uploads: ci.uploads, title: cleanText(ci.title, 100) } : null,
    mode: CHAT_MODES.includes(o.mode) ? o.mode : 'auto',
    interval,
    ng: typeof o.ng === 'string' ? o.ng.slice(0, 5000) : '',
    layout: { band: cfg.band, lanes: cfg.lanes, size: cfg.size, speed: cfg.speed, pin: cfg.pin },
    flow: cfg.flow,
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
 *         onStatus(st), onBatch(norm, { backlog }), onUnits(kind: 'videos'|'messages'),
 *         chatId（分かっていれば videos.list を省く）, pageToken（続きから）, backlogDone（最初の応答も流す＝プッシュから切り替えたとき） }
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
  let chatId = opts.chatId || null;
  let page = opts.pageToken || null;
  let first = true;
  let fails = 0;
  let starts = 0;
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
      // 止めていた間の分は流さない（ログだけ）。プッシュから切り替えた最初の 1 回だけは続きなので流す
      first = starts++ === 0 ? !opts.backlogDone : true;
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
    pageToken() { return page; },
  };
}

// ---------------------------------------------------------------- プッシュ型（liveChat/messages/stream）
// 応答の本文は JSON の配列が少しずつ届く: `[{…}\n,{…}\n,…]`。エラーも同じ形（[{"error":{…}}]、4xx）。
// 要素が 1 つそろうたびに取り出す（文字列の中の " \ [ ] { } は数えない）。

/** 少しずつ届く JSON 配列（または単体のオブジェクト）から、そろった要素を順に取り出す。push(text) → 要素の配列 */
export function createJsonArrayParser() {
  let buf = '';
  let pos = 0;
  let mode = 0; // 0: 始まり待ち／1: 配列の中／2: 単体のオブジェクト／3: 終わり
  let start = -1; // 要素の始まり（buf の中）
  let depth = 0;
  let inStr = false;
  let esc = false;
  let prim = false; // 数字・true などの要素
  let bad = 0;
  const emit = (out, end) => {
    try { out.push(JSON.parse(buf.slice(start, end))); } catch { bad++; }
    buf = buf.slice(end);
    pos = -1;
    start = -1;
    prim = false;
  };
  return {
    push(text) {
      const out = [];
      buf += text;
      for (; pos < buf.length; pos++) {
        const ch = buf[pos];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') { inStr = false; if (start >= 0 && depth === 0 && mode === 1) emit(out, pos + 1); }
          continue;
        }
        if (mode === 3) continue;
        if (mode === 0) {
          if (ch === '[') { mode = 1; buf = buf.slice(pos + 1); pos = -1; }
          else if (ch === '{') { mode = 2; start = pos; depth = 1; }
          else if (!/\s|\ufeff/.test(ch)) { mode = 3; bad++; }
          continue;
        }
        if (start < 0) {
          if (ch === ']' && mode === 1) { mode = 3; continue; }
          if (ch === ',' || /\s/.test(ch)) continue;
          start = pos;
          if (ch === '{' || ch === '[') depth = 1;
          else if (ch === '"') { depth = 0; inStr = true; }
          else { depth = 0; prim = true; }
          continue;
        }
        if (prim) {
          if (ch === ',' || ch === ']' || /\s/.test(ch)) { const c = ch; emit(out, pos); if (c === ']') mode = 3; }
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{' || ch === '[') depth++;
        else if (ch === '}' || ch === ']') {
          depth--;
          if (depth === 0) { const single = mode === 2; emit(out, pos + 1); if (single) mode = 3; }
        }
      }
      return out;
    },
    /** 終わり: 途中で切れた要素があれば truncated */
    end() {
      const out = [];
      if (prim && start >= 0) emit(out, buf.length);
      return { items: out, truncated: start >= 0, bad, closed: mode === 3 };
    },
  };
}

/** バイト列（Uint8Array）を受け取る版（UTF-8 の文字が途中で切れても大丈夫） */
export function createStreamBodyReader() {
  const dec = new TextDecoder('utf-8');
  const parser = createJsonArrayParser();
  return {
    push(bytes) { return parser.push(dec.decode(bytes, { stream: true })); },
    end() {
      const rest = parser.push(dec.decode());
      const e = parser.end();
      return { ...e, items: rest.concat(e.items) };
    },
  };
}

/** つなぎ直すまでの待ち（失敗が続くと 0→1→2→5→10→15 秒） */
export const STREAM_BACKOFF_MS = Object.freeze([0, 1000, 2000, 5000, 10000, 15000]);
/** 接続は 5 秒に 1 回まで・何も届かないまま 120 秒たったらつなぎ直す・30 秒の間に要素なしの接続が 3 回で切り替え */
export const STREAM_LIMITS = Object.freeze({ gapMs: 5000, idleMs: 120000, emptyWindowMs: 30000, emptyMax: 3 });

async function apiGet(fetchImpl, url, signal) {
  let res;
  try {
    res = await fetchImpl(url, { method: 'GET', referrerPolicy: 'origin', credentials: 'omit', cache: 'no-store', signal });
  } catch {
    return { network: true };
  }
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, ok: res.ok, body };
}

/**
 * コメントの取得（プッシュ型→だめなら数秒おき）。
 * opts: createChatPoller と同じ ＋ mode（'auto'｜'poll'）・chatId・gapMs・idleMs
 * st: { status, reason, code, via: 'stream'|'poll'|null, fallback: ''（切り替えた理由）}
 * 自動（auto）: stream につなぎ、最初の要素（開始前のコメント）はログだけ・あとの要素は流す。nextPageToken を覚え、
 * 切れたら続きからつなぎ直す（失敗が続けば 0→1→2→5→10→15 秒、接続は 5 秒に 1 回まで）。120 秒なにも届かなければつなぎ直す。
 * 最初の接続で通信・CORS の失敗、404/405/501・理由の分からない 4xx、30 秒の間に要素なしで 3 回切れたら、数秒おきに切り替える。
 * 上限・配信なし・キーの設定は止める。
 */
export function createChatClient(opts) {
  const fetchImpl = opts.fetchImpl;
  const now = opts.now || (() => Date.now());
  const setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer || ((t) => clearTimeout(t));
  const gapMs = opts.gapMs ?? STREAM_LIMITS.gapMs;
  const idleMs = opts.idleMs ?? STREAM_LIMITS.idleMs;
  const mode = opts.mode === 'poll' ? 'poll' : 'auto';
  let st = { status: 'idle', reason: '', code: '', via: null, fallback: '' };
  let stopped = true;
  let run = 0;
  let chatId = opts.chatId || null;
  let page = null;
  let gotAny = false;
  let fails = 0;
  let lastConnect = -Infinity;
  let empties = [];
  let timer = null;
  let idle = null;
  let ctrl = null;
  let poller = null;
  let interval = opts.interval;
  const set = (patch) => { st = { ...st, ...patch }; if (opts.onStatus) opts.onStatus({ ...st }); };
  const units = (k) => { if (opts.onUnits) opts.onUnits(k); };
  const alive = (myRun) => !stopped && myRun === run;
  function clearAll() {
    clearTimer(timer); timer = null;
    clearTimer(idle); idle = null;
    if (ctrl) { try { ctrl.abort(); } catch { /* 無視 */ } ctrl = null; }
  }
  function fail(err) {
    stopped = true;
    clearAll();
    set({ status: 'error', reason: err.message, code: err.code || '' });
  }
  function toPoll(reason, myRun) {
    if (!alive(myRun)) return;
    clearAll();
    set({ via: 'poll', fallback: reason });
    poller = createChatPoller({
      ...opts, chatId, pageToken: page, backlogDone: gotAny, interval,
      onStatus: (s) => { if (alive(myRun)) set({ ...s, via: 'poll' }); },
      onBatch: (n, o) => { if (alive(myRun) && opts.onBatch) opts.onBatch(n, o); },
      onUnits: (k) => { if (alive(myRun)) units(k); },
    });
    poller.start();
  }
  async function resolve(myRun) {
    let tries = 0;
    while (!chatId && alive(myRun)) {
      ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const r = await apiGet(fetchImpl, videosUrl(opts.videoId, opts.key), ctrl ? ctrl.signal : undefined);
      if (!alive(myRun)) return false;
      if (!r.network) units('videos');
      const err = r.network ? classifyApiError(0, null) : (!r.ok ? classifyApiError(r.status, r.body) : null);
      if (err) {
        if (err.stop) { fail(err); return false; }
        set({ status: 'retrying', reason: err.message, code: err.code });
        await new Promise((res) => { timer = setTimer(res, RETRY_MS[Math.min(tries++, RETRY_MS.length - 1)]); });
        continue;
      }
      const found = liveChatIdOf(r.body);
      if (found.error) { fail(found.error); return false; }
      chatId = found.id;
    }
    return alive(myRun);
  }
  function reconnect(myRun, failed) {
    if (!alive(myRun)) return;
    fails = failed ? fails + 1 : 0;
    const delay = STREAM_BACKOFF_MS[Math.min(fails, STREAM_BACKOFF_MS.length - 1)];
    timer = setTimer(() => connect(myRun), delay);
  }
  function armIdle(myRun) {
    clearTimer(idle);
    idle = setTimer(() => { if (alive(myRun) && ctrl) { try { ctrl.abort(); } catch { /* 無視 */ } } }, idleMs);
  }
  async function connect(myRun) {
    timer = null;
    if (!alive(myRun)) return;
    const wait = lastConnect + gapMs - now();
    if (wait > 0) { timer = setTimer(() => connect(myRun), wait); return; }
    lastConnect = now();
    ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let res;
    try {
      res = await fetchImpl(streamUrl(chatId, opts.key, page), { method: 'GET', referrerPolicy: 'origin', credentials: 'omit', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
    } catch {
      if (!alive(myRun)) return;
      // 最初の接続から通らない（CORS・通信）→ 数秒おきへ。届いたことがあれば つなぎ直す
      if (!gotAny) { toPoll('プッシュが使えないため', myRun); return; }
      set({ status: 'retrying', reason: 'つながりません（つなぎ直しています）', code: 'network' });
      reconnect(myRun, true);
      return;
    }
    if (!alive(myRun)) return;
    units('stream');
    if (!res.ok) {
      let body = null;
      try { const t = await res.text(); const p = createJsonArrayParser(); body = p.push(t)[0] || null; } catch { body = null; }
      if (!alive(myRun)) return;
      const d = streamErrorDecision(res.status, body);
      if (d.action === 'stop') { fail(d.error); return; }
      if (d.action === 'fallback') { toPoll('プッシュが使えないため', myRun); return; }
      set({ status: 'retrying', reason: d.error.message, code: d.error.code });
      reconnect(myRun, true);
      return;
    }
    if (st.status !== 'running' || st.via !== 'stream') set({ status: 'running', reason: '', code: '', via: 'stream', fallback: '' });
    let delivered = 0;
    let stopNow = false;
    const handle = (el) => {
      if (stopNow || !alive(myRun)) return;
      if (el && typeof el === 'object' && el.error) {
        const d = streamErrorDecision(Number(el.error.code) || 400, el);
        stopNow = true;
        if (d.action === 'stop') fail(d.error);
        else if (d.action === 'fallback') toPoll('プッシュが使えないため', myRun);
        else { set({ status: 'retrying', reason: d.error.message, code: d.error.code }); reconnect(myRun, true); }
        return;
      }
      const norm = normalizeChatResponse(el, now());
      const backlog = !gotAny;
      gotAny = true;
      delivered++;
      fails = 0;
      if (norm.next) page = norm.next;
      try { if (opts.onBatch) opts.onBatch(norm, { backlog }); } catch { /* 受け手の失敗で止めない */ }
      if (norm.offline) { stopNow = true; fail({ code: 'ended', message: '配信が終わりました（コメントの取得を止めました）' }); }
    };
    const rd = createStreamBodyReader();
    armIdle(myRun);
    try {
      const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (!alive(myRun) || stopNow) { try { reader.cancel(); } catch { /* 無視 */ } return; }
          armIdle(myRun);
          if (done) break;
          for (const el of rd.push(value)) handle(el);
          if (stopNow) { try { reader.cancel(); } catch { /* 無視 */ } return; }
        }
      } else {
        const t = await res.text();
        if (!alive(myRun)) return;
        for (const el of rd.push(new TextEncoder().encode(t))) handle(el);
      }
      for (const el of rd.end().items) handle(el);
    } catch {
      // 切れた・120 秒なにも届かず止めた → 下でつなぎ直す
    }
    clearTimer(idle);
    idle = null;
    if (!alive(myRun) || stopNow) return;
    if (!delivered) {
      const t = now();
      empties = empties.filter((x) => t - x <= STREAM_LIMITS.emptyWindowMs).concat(t);
      if (empties.length >= STREAM_LIMITS.emptyMax) { toPoll('プッシュが続かないため', myRun); return; }
    }
    reconnect(myRun, !delivered);
  }
  return {
    async start() {
      if (!stopped) return;
      stopped = false;
      const myRun = ++run;
      fails = 0;
      gotAny = false;
      empties = [];
      if (mode === 'poll') {
        set({ status: 'starting', reason: '', code: '', via: 'poll', fallback: '' });
        toPoll('', myRun);
        return;
      }
      set({ status: 'starting', reason: '', code: '', via: 'stream', fallback: '' });
      if (!(await resolve(myRun))) return;
      connect(myRun);
    },
    stop() {
      stopped = true;
      run++;
      clearAll();
      if (poller) { poller.stop(); poller = null; }
      set({ status: 'stopped', reason: '', code: '' });
    },
    setInterval(ms) { if (Number(ms) > 0) { interval = Number(ms); if (poller) poller.setInterval(ms); } },
    status() { return { ...st }; },
    pageToken() { return poller ? poller.pageToken() : page; },
  };
}

// ---------------------------------------------------------------- チャンネルから今の配信を探す
// チャンネル（@ハンドル・URL・UC… の ID）→ channels.list（1）でアップロードの再生リスト → playlistItems（1）＋ videos（1）で
// 「始まっていて終わっていない・チャットあり」の配信を選ぶ。無ければ search.list（100。5 分に 1 回まで）。見つかるまで 30 秒おき・15 分であきらめる。

/** チャンネルの入力 → { handle: '@x' } か { id: 'UC…' }。読めなければ null */
export function parseChannelInput(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  const handleOk = (h) => (/^@[\p{L}\p{N}._-]{3,30}$/u.test(h) ? { handle: h } : null);
  if (s.startsWith('@')) return handleOk(s);
  if (CHANNEL_ID_RE.test(s)) return { id: s };
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
  if (host !== 'youtube.com') return null;
  const seg = u.pathname.split('/').filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
  if (seg[0] && seg[0].startsWith('@')) return handleOk(seg[0]);
  if (seg[0] === 'channel' && CHANNEL_ID_RE.test(seg[1] || '')) return { id: seg[1] };
  return null;
}

export function channelsUrl(ch, key) {
  const q = ch.id ? `id=${enc(ch.id)}` : `forHandle=${enc(ch.handle)}`;
  return `${YT_API}/channels?part=snippet,contentDetails&${q}&key=${enc(key)}`;
}
/** channels.list の応答 → { id, uploads, title } か { error } */
export function channelInfoOf(body) {
  const it = body && Array.isArray(body.items) ? body.items[0] : null;
  const id = it && typeof it.id === 'string' && CHANNEL_ID_RE.test(it.id) ? it.id : null;
  const up = it && it.contentDetails && it.contentDetails.relatedPlaylists && it.contentDetails.relatedPlaylists.uploads;
  if (!id || typeof up !== 'string' || !/^[A-Za-z0-9_-]{2,64}$/.test(up)) return { error: { code: 'ended', stop: true, message: 'チャンネルが見つかりません（@ハンドルか URL を確かめてください）' } };
  return { id, uploads: up, title: cleanText(it.snippet && it.snippet.title, 100) };
}
export function playlistItemsUrl(playlistId, key) {
  return `${YT_API}/playlistItems?part=contentDetails&playlistId=${enc(playlistId)}&maxResults=10&key=${enc(key)}`;
}
export function videosDetailUrl(ids, key) {
  return `${YT_API}/videos?part=snippet,liveStreamingDetails&id=${ids.map(enc).join(',')}&maxResults=50&key=${enc(key)}`;
}
export function searchLiveUrl(channelId, key) {
  return `${YT_API}/search?part=id&channelId=${enc(channelId)}&eventType=live&type=video&maxResults=5&key=${enc(key)}`;
}
/** playlistItems・search の応答 → 動画 ID の配列 */
export function videoIdsOf(body) {
  const out = [];
  for (const it of body && Array.isArray(body.items) ? body.items : []) {
    const v = (it && it.contentDetails && it.contentDetails.videoId) || (it && it.id && typeof it.id === 'object' && it.id.videoId);
    if (typeof v === 'string' && VIDEO_RE.test(v) && !out.includes(v)) out.push(v);
  }
  return out.slice(0, 50);
}
/** videos.list（snippet,liveStreamingDetails）の応答 → いま配信中（始まっていて終わっていない・チャットあり）でいちばん新しいもの。無ければ null */
export function pickActiveLive(body) {
  let best = null;
  for (const it of body && Array.isArray(body.items) ? body.items : []) {
    const d = it && it.liveStreamingDetails;
    if (!d || !d.actualStartTime || d.actualEndTime) continue;
    if (typeof d.activeLiveChatId !== 'string' || !ID_RE.test(d.activeLiveChatId)) continue;
    if (typeof it.id !== 'string' || !VIDEO_RE.test(it.id)) continue;
    const startedAt = Date.parse(d.actualStartTime);
    if (!Number.isFinite(startedAt)) continue;
    if (!best || startedAt > best.startedAt) best = { videoId: it.id, chatId: d.activeLiveChatId, title: cleanText(it.snippet && it.snippet.title, 100), startedAt };
  }
  return best;
}

export const FINDER_LIMITS = Object.freeze({ cheapMs: 30000, searchMs: 300000, giveUpMs: 900000 });
export const FINDER_WAIT_TEXT = '配信を探しています…（始まってから見つかるまで数分かかることがあります。限定公開の配信は URL を貼ってください）';

/**
 * チャンネルの今の配信を探す。opts: { key, channel（parseChannelInput の結果）, cached（{ id, uploads, title }）, fetchImpl, now, setTimer, clearTimer,
 *   onStatus(st), onFound({ videoId, chatId, title }), onChannel(info), onUnits(kind), cheapMs, searchMs, giveUpMs }
 */
export function createLiveFinder(opts) {
  const fetchImpl = opts.fetchImpl;
  const now = opts.now || (() => Date.now());
  const setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer || ((t) => clearTimeout(t));
  const L = { ...FINDER_LIMITS, ...Object.fromEntries(['cheapMs', 'searchMs', 'giveUpMs'].filter((k) => opts[k] > 0).map((k) => [k, opts[k]])) };
  let info = opts.cached && opts.cached.id && opts.cached.uploads ? opts.cached : null;
  let st = { status: 'idle', reason: '', code: '' };
  let stopped = true;
  let run = 0;
  let timer = null;
  let ctrl = null;
  let startedAt = 0;
  let lastSearch = -Infinity;
  let searches = 0;
  const set = (patch) => { st = { ...st, ...patch }; if (opts.onStatus) opts.onStatus({ ...st }); };
  const alive = (myRun) => !stopped && myRun === run;
  async function get(url, kind, myRun) {
    ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const r = await apiGet(fetchImpl, url, ctrl ? ctrl.signal : undefined);
    if (!alive(myRun)) return { aborted: true };
    if (!r.network && opts.onUnits) opts.onUnits(kind);
    if (r.network) return { error: classifyApiError(0, null) };
    if (!r.ok) return { error: classifyApiError(r.status, r.body), status: r.status };
    return { body: r.body };
  }
  function fail(err) { stopped = true; clearTimer(timer); timer = null; set({ status: 'error', reason: err.message, code: err.code || '' }); }
  async function liveOf(ids, myRun) {
    if (!ids.length) return null;
    const r = await get(videosDetailUrl(ids, opts.key), 'videos', myRun);
    if (r.aborted) return undefined;
    if (r.error) return r;
    return pickActiveLive(r.body);
  }
  async function attempt(myRun) {
    timer = null;
    if (!alive(myRun)) return;
    let problem = null;
    if (!info) {
      const r = await get(channelsUrl(opts.channel, opts.key), 'channels', myRun);
      if (r.aborted) return;
      if (r.error) { if (r.error.stop && r.error.code !== 'busy') { fail(r.status === 404 ? channelInfoOf(null).error : r.error); return; } problem = r.error; }
      else {
        const ci = channelInfoOf(r.body);
        if (ci.error) { fail(ci.error); return; }
        info = ci;
        if (opts.onChannel) opts.onChannel(info);
      }
    }
    let found = null;
    if (info) {
      // 安い方法（2 単位）: アップロードの再生リスト → videos
      const r = await get(playlistItemsUrl(info.uploads, opts.key), 'playlistItems', myRun);
      if (r.aborted) return;
      let ids = [];
      if (r.error) { if (r.error.known && r.error.stop) { fail(r.error); return; } if (r.error.code === 'network' || r.error.code === 'busy') problem = r.error; }
      else ids = videoIdsOf(r.body);
      const v = await liveOf(ids, myRun);
      if (v === undefined) return;
      if (v && v.error) { if (v.error.stop) { fail(v.error); return; } problem = v.error; }
      else found = v;
      // 見つからなければ検索（100 単位。5 分に 1 回まで）
      if (!found && now() - lastSearch >= L.searchMs) {
        lastSearch = now();
        searches++;
        const s2 = await get(searchLiveUrl(info.id, opts.key), 'search', myRun);
        if (s2.aborted) return;
        if (s2.error) { if (s2.error.stop) { fail(s2.error); return; } problem = s2.error; }
        else {
          const v2 = await liveOf(videoIdsOf(s2.body), myRun);
          if (v2 === undefined) return;
          if (v2 && v2.error) { if (v2.error.stop) { fail(v2.error); return; } problem = v2.error; }
          else found = v2;
        }
      }
    }
    if (!alive(myRun)) return;
    if (found) { stopped = true; set({ status: 'found', reason: '', code: '' }); if (opts.onFound) opts.onFound(found); return; }
    if (now() - startedAt >= L.giveUpMs) { fail({ code: 'ended', message: '15 分探しても配信が見つかりませんでした（始まっているなら、配信の URL を貼って「開始」してください）' }); return; }
    set({ status: 'searching', reason: problem ? `${FINDER_WAIT_TEXT}（${problem.message}）` : FINDER_WAIT_TEXT, code: problem ? problem.code : '' });
    timer = setTimer(() => attempt(myRun), L.cheapMs);
  }
  return {
    start() {
      if (!stopped) return;
      stopped = false;
      const myRun = ++run;
      startedAt = now();
      set({ status: 'searching', reason: FINDER_WAIT_TEXT, code: '' });
      attempt(myRun);
    },
    stop() {
      stopped = true;
      run++;
      clearTimer(timer);
      timer = null;
      if (ctrl) { try { ctrl.abort(); } catch { /* 無視 */ } }
      set({ status: 'stopped', reason: '', code: '' });
    },
    status() { return { ...st }; },
    searches() { return searches; },
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
