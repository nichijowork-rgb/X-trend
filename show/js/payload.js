// OBS オーバーレイ（show/overlay.html）へ送るデータ（段階2）。DOM 非依存（node:test から import される）。
// オーバーレイは OBS の中のブラウザで動き、こちらの保存データを読めないので、表示に必要なものをすべて含めた
// 「自己完結」の形にする。送り手（進行画面）は変化時＋数秒おきに同じものを再送し、受け手は seq で古いものを無視する。
//
// 形（v: 1）:
// {
//   v: 1, type: 'state', sid（送り手の起動ごとの id）, seq（送り手の通し番号）, at（作った時刻 ms）,
//   show:   { name, title },
//   live:   { started, finished, index, total },
//   corner: { key, name, sub, color, n, of } | null,          … color はジャンルキー（main/host/kyaba/kabuki/night/general/review/white）
//   topic:  { id, name, genre, color, stats: { count, totalImp, maxImp, maxPace } } | null,
//   next:   { name, corner } | null,                            … 次の話題（無ければ次のコーナー名）
//   card:   { visible, post: { id, user, text, created, metrics: { impression_count, like_count, retweet_count }, thumb } | null },
//   title:  { id, text, sub, color, at, duration } | null,      … コーナーが変わった時刻 at から duration ms だけ大きく出す
//   effect: { id, kind, at, params } | null                    … 段階4: 1 回限りの演出（effects.js）。受け手は id で二重に出さない
// }

import { cornerDef, liveShownPost } from './logic.js';

export const PAYLOAD_VERSION = 1;
export const OBS_EVENT_NAME = 'xtrend-show';
export const OVERLAY_CHANNEL = 'xtrend-show-overlay';
export const TITLE_DURATION_MS = 4000;
export const RESEND_MS = 5000;

const PBS = /^https:\/\/pbs\.twimg\.com\//;

/** キューの色（ジャンルキー）。メインは赤、話題はジャンル色、空のコーナーはコーナーの色 */
export function cueColorKey(cue, topicsById) {
  if (!cue) return 'white';
  const def = cornerDef(cue.cornerKey);
  if (cue.kind === 'topic') {
    if (cue.cornerKey === 'main') return 'main';
    const t = topicsById.get(cue.topicId);
    return t ? t.genre : (def ? def.color : 'white');
  }
  return def ? def.color : 'white';
}

/** pbs.twimg.com の小さい画像（name=small）。それ以外は使わない */
export function smallThumb(post) {
  const m = (post && post.media ? post.media : []).find((x) => (x.type === 'photo' ? x.url : x.preview));
  const url = m ? (m.type === 'photo' ? m.url : m.preview) : null;
  if (!url || !PBS.test(url)) return null;
  try {
    const u = new URL(url);
    const ext = /\.(jpe?g|png|webp)$/i.exec(u.pathname);
    if (ext) { u.pathname = u.pathname.slice(0, -ext[0].length); u.searchParams.set('format', ext[1].toLowerCase() === 'jpeg' ? 'jpg' : ext[1].toLowerCase()); }
    u.searchParams.set('name', 'small');
    return u.toString();
  } catch {
    return null;
  }
}

function postInfo(post) {
  if (!post) return null;
  const m = post.metrics || {};
  return {
    id: post.id,
    user: post.user || '',
    text: String(post.text || '').slice(0, 600),
    created: post.created_jst || null,
    metrics: { impression_count: m.impression_count ?? null, like_count: m.like_count ?? null, retweet_count: m.retweet_count ?? null },
    thumb: smallThumb(post),
  };
}

/**
 * 進行状態からペイロードを作る（seq・sid は送り手が付ける）。
 * input: { live, cues, topicsById, postsById, showName, title, cornerChangedAt }
 *  cornerChangedAt: 現在のコーナーに入った時刻（ms）。省略時は live.enteredAt（進行の記録）から。null ならタイトルは出さない
 */
export function buildPayload(input) {
  const { live, cues, topicsById, postsById, showName = '', title = '', now = Date.now() } = input;
  const cue = cues[live.index] || null;
  const entered = cue && live.startedAt != null && live.enteredAt ? live.enteredAt[cue.cornerKey] : null;
  const cornerChangedAt = input.cornerChangedAt !== undefined ? input.cornerChangedAt : (Number.isFinite(entered) ? entered : null);
  const def = cue ? cornerDef(cue.cornerKey) : null;
  const color = cueColorKey(cue, topicsById);
  const topic = cue && cue.kind === 'topic' ? topicsById.get(cue.topicId) || null : null;
  let next = null;
  for (let i = live.index + 1; i < cues.length; i++) {
    const c = cues[i];
    if (live.status && live.status[c.id]) continue;
    if (c.kind === 'topic') { const t = topicsById.get(c.topicId); if (t) { next = { name: t.name, corner: cornerDef(c.cornerKey).name }; break; } }
    else { next = { name: cornerDef(c.cornerKey).name, corner: cornerDef(c.cornerKey).name }; break; }
  }
  const postId = topic ? liveShownPost(live, cue, topic) : null; // 「これを映す」で選んだ投稿（無ければ代表投稿）
  const post = postId && postsById ? postsById.get(postId) || null : null;
  return {
    v: PAYLOAD_VERSION,
    type: 'state',
    at: now,
    show: { name: showName, title },
    live: { started: live.startedAt != null, finished: !cue && cues.length > 0, index: live.index, total: cues.length },
    corner: cue ? { key: cue.cornerKey, name: def.name, sub: def.sub, color, n: cue.n || null, of: cue.of || null } : null,
    topic: topic ? {
      id: topic.id, name: topic.name, genre: topic.genre, color,
      stats: { count: topic.stats.count, totalImp: topic.stats.totalImp ?? null, maxImp: topic.stats.maxImp ?? null, maxPace: topic.stats.maxPace ?? null },
    } : null,
    next,
    card: { visible: live.cardVisible !== false && Boolean(post || postId), post: post ? postInfo(post) : (postId ? { id: postId, user: '', text: '', created: null, metrics: {}, thumb: null } : null) },
    title: cue && cornerChangedAt != null ? { id: `${cue.cornerKey}@${cornerChangedAt}`, text: def.name, sub: def.sub, color: cue.cornerKey === 'main' ? 'main' : def.color, at: cornerChangedAt, duration: TITLE_DURATION_MS } : null,
    effect: input.effect || null,
  };
}

/** 表示に関わる部分が同じか（再送の判定。seq・at は見ない） */
export function samePayload(a, b) {
  if (!a || !b) return false;
  const strip = (p) => JSON.stringify({ ...p, seq: 0, at: 0, sid: '' });
  return strip(a) === strip(b);
}

/**
 * 受け手: 新しいペイロードを使うか。同じ送り手（sid）なら seq が大きいものだけ、
 * 送り手が変わった（進行画面を開き直した）ら at が前より新しいものを使う。
 */
export function shouldAccept(prev, next) {
  if (!next || typeof next !== 'object' || next.v !== PAYLOAD_VERSION || next.type !== 'state') return false;
  if (!prev) return true;
  if (next.sid === prev.sid) return Number(next.seq) > Number(prev.seq);
  return Number(next.at) >= Number(prev.at);
}

/** OBS から来た detail（オブジェクトでも JSON 文字列でもよい）を読む。読めなければ null */
export function readDetail(detail) {
  if (detail == null) return null;
  if (typeof detail === 'string') {
    try { return JSON.parse(detail); } catch { return null; }
  }
  return typeof detail === 'object' ? detail : null;
}

/** タイトルを今出すべきか（コーナーが変わってから duration 以内） */
export function titleVisible(title, now = Date.now()) {
  return Boolean(title && Number.isFinite(title.at) && now - title.at >= -2000 && now - title.at < (title.duration || TITLE_DURATION_MS));
}

/** テスト表示用のペイロード（OBS の配置確認） */
export function demoPayload(now = Date.now()) {
  return {
    v: PAYLOAD_VERSION, type: 'state', sid: 'demo', seq: 1, at: now,
    show: { name: '週刊ヨルニュース', title: '【週刊ヨルニュース】テスト表示' },
    live: { started: true, finished: false, index: 0, total: 3 },
    corner: { key: 'main', name: 'メイン3トピック', sub: '各約15分', color: 'main', n: 1, of: 3 },
    topic: { id: 'demo', name: 'テスト表示：ここに話題名が出ます', genre: 'host', color: 'main', stats: { count: 8, totalImp: 622000, maxImp: 247000, maxPace: 11000 } },
    next: { name: '次の話題の名前', corner: 'メイン3トピック' },
    card: { visible: true, post: { id: '0', user: 'sample_account', text: 'これはテスト表示です。読み上げ中の投稿の本文がここに出ます。長い本文は途中で省略されます。', created: null, metrics: { impression_count: 247000, like_count: 2762, retweet_count: 186 }, thumb: null } },
    title: { id: `demo@${now}`, text: 'メイン3トピック', sub: 'テスト表示', color: 'main', at: now, duration: TITLE_DURATION_MS },
    effect: null,
  };
}
