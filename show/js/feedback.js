// 段階3: ボットへの修正の書き戻し（feedback/show-feedback.json）。DOM 非依存（node:test から import される）。
// 毎回「今の全修正」を出す（前回からの差分ではない＝何度送っても同じ内容。冪等）。
//
// 形:
// { generated_at, week,
//   genre_overrides: [{ id, genre（カテゴリ名）, was: [元のカテゴリ] }],
//   topic_edits: [{ topic_id, source: 'bot'|'site', name, genre, post_ids, deleted, edits: ['rename'|'genre'|'posts'|'merge'|'new'|'shelve'|'delete'], merged_from? }],
//   removed_posts: [{ id, reason: 'trash'|'hidden', topic_id? }] }
//  - topic_id はボットの話題ならボットの id（サイトの 'g:' を外したもの）、サイトの話題はサイトの id（d:辞書 / t:話題名 / c:類似 / m:手動 …）
//  - 書き込み先は BOT.feedbackPath（feedback/）に固定。data/ には書かない

import { BOT } from './config.js';
import { categoryOfGenre, genreOfCategory, compareIds } from './logic.js';

/** サイトの話題 id → { topic_id, source } */
export function feedbackTopicId(siteId) {
  const s = String(siteId || '');
  const m = /^(?:k:)?g:(.+)$/.exec(s);
  return m ? { topic_id: m[1], source: 'bot' } : { topic_id: s, source: 'site' };
}

/** JST の ISO 時刻（秒まで） */
export function jstIso(ms) {
  return `${new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 19)}+09:00`;
}

const sortIds = (ids) => [...new Set(ids.map(String))].sort(compareIds);

/**
 * input: { saved, weekKey, topics（その週に作った話題すべて）, basePostsById（上書き前の投稿）, nowMs }
 */
export function buildFeedback(input) {
  const { saved, weekKey, topics = [], basePostsById = new Map(), nowMs = Date.now() } = input;
  const wk = (saved.weeks && saved.weeks[weekKey]) || {};
  const ov = wk.overrides || {};
  const renames = ov.renames || {};
  const genres = ov.genres || {};
  const shelved = new Set((wk.shelved || []).map((x) => x.topicId));

  const genre_overrides = Object.entries(saved.genreOverrides || {})
    .map(([id, o]) => {
      const base = basePostsById.get(id);
      const was = base ? (base.categories || []).filter((c) => genreOfCategory(c)) : [];
      return { id, genre: categoryOfGenre(o.genre), was: was.length ? was : (o.from ? [categoryOfGenre(o.from)] : []) };
    })
    .sort((a, b) => compareIds(a.id, b.id));

  const edits = [];
  for (const t of topics) {
    const e = [];
    if (typeof renames[t.id] === 'string' && renames[t.id].trim()) e.push('rename');
    if (genres[t.id]) e.push('genre');
    if (t.movedIn || t.movedOut) e.push('posts');
    if (t.mergedFrom && t.mergedFrom.length) e.push('merge');
    if (t.kind === 'manual') e.push('new');
    if (shelved.has(t.id)) e.push('shelve');
    if (!e.length) continue;
    const { topic_id, source } = feedbackTopicId(t.id);
    const out = { topic_id, source, name: t.name, genre: categoryOfGenre(t.genre), post_ids: sortIds(t.postIds), deleted: false, edits: e };
    if (t.mergedFrom && t.mergedFrom.length) out.merged_from = t.mergedFrom.map((x) => feedbackTopicId(x).topic_id).sort();
    edits.push(out);
  }
  const removed = new Map();
  for (const x of saved.trash || []) {
    const { topic_id, source } = feedbackTopicId(x.topicId);
    edits.push({ topic_id, source, name: x.name || '', genre: categoryOfGenre(x.genre), post_ids: sortIds(x.postIds || []), deleted: true, edits: ['delete'], week: x.week || null });
    for (const id of x.postIds || []) if (!removed.has(String(id))) removed.set(String(id), { id: String(id), reason: 'trash', topic_id });
  }
  for (const x of saved.hiddenPosts || []) if (!removed.has(String(x.id))) removed.set(String(x.id), { id: String(x.id), reason: 'hidden' });
  edits.sort((a, b) => (a.topic_id < b.topic_id ? -1 : a.topic_id > b.topic_id ? 1 : Number(a.deleted) - Number(b.deleted)));
  return {
    generated_at: jstIso(nowMs),
    week: weekKey,
    genre_overrides,
    topic_edits: edits,
    removed_posts: [...removed.values()].sort((a, b) => compareIds(a.id, b.id)),
  };
}

/** 中身が同じか（generated_at は見ない） */
export function sameFeedback(a, b) {
  const strip = (x) => JSON.stringify({ ...x, generated_at: '' });
  return Boolean(a && b) && strip(a) === strip(b);
}

/** 件数のまとめ（画面表示用） */
export function feedbackCounts(fb) {
  return { genres: fb.genre_overrides.length, topics: fb.topic_edits.filter((x) => !x.deleted).length, deleted: fb.topic_edits.filter((x) => x.deleted).length, posts: fb.removed_posts.length };
}

// ================================================================ GitHub に直接保存（任意）

export const GH_PREF_KEY = 'xtrend-show-github';
export const FEEDBACK_SENT_KEY = 'xtrend-show-feedback-sent';
const API = 'https://api.github.com';

export function parseGhPrefs(raw) {
  let o = null;
  try { o = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { o = null; }
  const ok = o && typeof o === 'object';
  return {
    repo: ok && validRepo(o.repo) ? o.repo : BOT.defaultRepo,
    branch: ok && validBranch(o.branch) ? o.branch : BOT.defaultBranch,
    token: ok && typeof o.token === 'string' ? o.token.trim().slice(0, 300) : '',
  };
}

export const validRepo = (s) => typeof s === 'string' && /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(s) && !s.includes('..');
export const validBranch = (s) => typeof s === 'string' && /^[A-Za-z0-9._\/-]{1,200}$/.test(s) && !s.includes('..') && !s.startsWith('/') && !s.endsWith('/');

/** UTF-8 の文字列 → base64 */
export function b64utf8(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

class GhError extends Error {
  constructor(message, status = null) { super(message); this.status = status; }
}

/** HTTP の状態 → 日本語の理由（トークンの中身は出さない） */
export function githubErrorText(status, { rateLimited = false, phase = 'put' } = {}) {
  if (status === 401) return 'トークンが正しくないか、有効期限が切れています。トークンを作り直して入れ直してください';
  if (status === 403 && rateLimited) return 'GitHub の回数制限にかかりました。しばらく待ってからもう一度押してください';
  if (status === 403) return '権限が足りません。トークンの「Repository access」でこのリポジトリを選び、「Contents」を Read and write にしてください';
  if (status === 404) return 'リポジトリかブランチが見つからないか、トークンにこのリポジトリへの権限がありません（リポジトリ名・ブランチ名・トークンの対象を確認）';
  if (status === 409 || status === 422) return 'ほかの更新とぶつかりました。もう一度押してください';
  if (status == null) return '通信できませんでした（インターネット接続か、ブラウザの拡張機能による遮断を確認）';
  return `GitHub への保存に失敗しました（${phase === 'get' ? '読み込み' : '書き込み'}・コード ${status}）`;
}

/**
 * feedback/show-feedback.json を GitHub に保存（Contents API）。
 * GET で今の sha を取り（無ければ新規）、PUT で更新。409/422（ぶつかった）は sha を取り直して 1 回だけやり直す。
 * 返り値: { ok: true, commitUrl, created } ／ 失敗は { ok: false, status, message }
 */
export async function saveFeedbackToGitHub({ fetchImpl = globalThis.fetch, repo, branch, token, content, nowMs = Date.now() }) {
  if (!validRepo(repo)) return { ok: false, status: null, message: 'リポジトリは「持ち主/名前」の形で入れてください' };
  if (!validBranch(branch)) return { ok: false, status: null, message: 'ブランチ名が正しくありません' };
  if (!token) return { ok: false, status: null, message: 'トークンを入れてください' };
  const path = BOT.feedbackPath;
  if (!/^feedback\//.test(path)) return { ok: false, status: null, message: '書き込み先が正しくありません' };
  const url = `${API}/repos/${repo}/contents/${path}`;
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
  const call = async (method, u, body) => {
    try {
      return await fetchImpl(u, { method, headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    } catch {
      throw new GhError(githubErrorText(null), null);
    }
  };
  const fail = (res, phase) => {
    const rl = res.headers && typeof res.headers.get === 'function' && res.headers.get('x-ratelimit-remaining') === '0';
    return new GhError(githubErrorText(res.status, { rateLimited: rl, phase }), res.status);
  };
  const getSha = async () => {
    const res = await call('GET', `${url}?ref=${encodeURIComponent(branch)}`);
    if (res.status === 404) return null; // まだ無い（新規作成）
    if (!res.ok) throw fail(res, 'get');
    const j = await res.json().catch(() => ({}));
    return typeof j.sha === 'string' ? j.sha : null;
  };
  const body = (sha) => ({ message: `feedback: show edits ${jstIso(nowMs)}`, content: b64utf8(content), branch, ...(sha ? { sha } : {}) });
  try {
    let sha = await getSha();
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await call('PUT', url, body(sha));
      if (res.ok) {
        const j = await res.json().catch(() => ({}));
        return { ok: true, created: res.status === 201, commitUrl: j && j.commit && typeof j.commit.html_url === 'string' ? j.commit.html_url : null };
      }
      if ((res.status === 409 || res.status === 422) && attempt === 0) { sha = await getSha(); continue; }
      throw fail(res, 'put');
    }
    throw new GhError(githubErrorText(409), 409);
  } catch (err) {
    return { ok: false, status: err instanceof GhError ? err.status : null, message: err instanceof GhError ? err.message : githubErrorText(null) };
  }
}
