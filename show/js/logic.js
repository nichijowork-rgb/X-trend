// 配信番組サイト — 純粋関数（DOM 非依存）。ブラウザ（ES module）と node:test の両方から import される。
// ここには document / window / fetch / localStorage を書かないこと。

import { formatCompact, formatPace, viewsPerHour, jstParts, parseTimestamp, UNKNOWN } from '../../assets/js/core.js';
import {
  SHOW_DEFAULTS, GENRES, GENRE_KEYS, NIGHT_GENRES, CORNERS, DEFAULT_DICT, SCORE_WEIGHTS, SIMILARITY, MAIN_SUGGEST_TIERS, GROUPED_MIN_POSTS, MAIN_NIGHT_ONLY,
  TERM_PREFIXES, SCHEMA_VERSION, CHECKPOINTS,
} from './config.js';

const JST = 9 * 3600;
const WEEK = 7 * 86400;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const pad2 = (n) => String(n).padStart(2, '0');

// ================================================================ 番組週

/**
 * 基準時刻（データの generated_at）を含む番組週。
 * 番組週 = 前回配信（前週 土 1:00 JST）以上 〜 今回配信（土 1:00 JST）未満。
 * 返り値: { key: 'YYYY-MM-DD'（今回配信の日付）, start, end }（UNIX 秒）
 */
export function showWeekOf(refTs, bc = SHOW_DEFAULTS.broadcast) {
  if (!isNum(refTs)) return null;
  const p = jstParts(refTs);
  // その日の配信時刻（JST）
  let t = Math.floor(Date.UTC(p.y, p.m - 1, p.d, bc.hour, bc.minute) / 1000) - JST;
  const wd = new Date((t + JST) * 1000).getUTCDay();
  t += ((bc.weekday - wd + 7) % 7) * 86400;
  if (t <= refTs) t += WEEK; // 配信時刻ちょうどは次の週
  return weekFromEnd(t);
}

function weekFromEnd(end) {
  const p = jstParts(end);
  return { key: `${p.y}-${pad2(p.m)}-${pad2(p.d)}`, start: end - WEEK, end };
}

/** 'YYYY-MM-DD'（配信日）から番組週。不正なら null */
export function weekByKey(key, bc = SHOW_DEFAULTS.broadcast) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const [y, m, d] = key.split('-').map(Number);
  const end = Math.floor(Date.UTC(y, m - 1, d, bc.hour, bc.minute) / 1000) - JST;
  if (!isNum(end)) return null;
  const w = weekFromEnd(end);
  const wd = new Date((end + JST) * 1000).getUTCDay();
  return w.key === key && wd === bc.weekday ? w : null;
}

/** 隣の番組週のキー（n=1 で翌週、-1 で前週） */
export function shiftWeekKey(key, n) {
  const w = weekByKey(key);
  return w ? weekFromEnd(w.end + n * WEEK).key : null;
}

/** 選べる番組週（新しい順）。基準時刻の週から、最古の投稿の週まで（最大 limit 週） */
export function listWeeks(refTs, minTs, limit = 8) {
  const cur = showWeekOf(refTs);
  if (!cur) return [];
  const out = [cur];
  let w = cur;
  while (out.length < limit && isNum(minTs) && w.start > minTs) {
    w = weekFromEnd(w.start);
    out.push(w);
  }
  return out;
}

/** 番組週の投稿（start ≦ ts ＜ end） */
export function postsInWeek(posts, week) {
  if (!week) return [];
  return (posts || []).filter((p) => isNum(p.ts) && p.ts >= week.start && p.ts < week.end);
}

/** 「10/10(土) 1:00」 */
export function formatJstShort(ts) {
  const p = jstParts(ts);
  if (!p) return UNKNOWN;
  const wd = '日月火水木金土'[new Date((ts + JST) * 1000).getUTCDay()];
  return `${p.m}/${p.d}(${wd}) ${p.hh}:${pad2(p.mm)}`;
}

/** 番組週の表示「10/10(土) 1:00 〜 10/17(土) 1:00」 */
export function weekLabel(week) {
  return week ? `${formatJstShort(week.start)} 〜 ${formatJstShort(week.end)}` : UNKNOWN;
}

// ================================================================ URL → 投稿 id

const STATUS_RE = /^https?:\/\/(?:www\.|mobile\.|m\.)?(?:x|twitter)\.com\/(?:[A-Za-z0-9_]{1,30}|i(?:\/web)?)\/status(?:es)?\/(\d{5,25})(?:[/?#].*)?$/i;

/**
 * 貼り付けたテキスト（複数行・スペース区切り可）から投稿 id を取り出す。
 * x.com / twitter.com の status URL と、数字だけの id を受け付ける。
 * 返り値: { ids: [{ id, url }], invalid: [読み取れなかった文字列] }（重複は除く・順番は保つ）
 */
export function extractStatusIds(text) {
  const ids = [];
  const invalid = [];
  const seen = new Set();
  const tokens = String(text ?? '').split(/[\s　]+/).map((t) => t.trim()).filter(Boolean);
  for (const tok of tokens) {
    let id = null;
    const m = STATUS_RE.exec(tok);
    if (m) id = m[1];
    else if (/^\d{10,25}$/.test(tok)) id = tok;
    if (!id) { invalid.push(tok); continue; }
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push({ id, url: m ? tok.split(/[?#]/)[0] : statusUrl(id) });
  }
  return { ids, invalid };
}

export function statusUrl(id) {
  return `https://x.com/i/web/status/${id}`;
}

// ================================================================ 言葉の一致

/** 照合用の正規化（NFKC・小文字。半角カナ・全角英数もそろう） */
export function normalizeForMatch(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase();
}

const KATA = /[\u30A1-\u30FA\u30FC]/;

/**
 * hay（正規化済み）に word（正規化済み）が「言葉として」含まれるか。
 * word がカタカナで始まるなら直前、カタカナで終わるなら直後がカタカナでないこと（アルコール≠コール）。
 */
export function containsWord(hay, word) {
  if (!word) return false;
  const startK = KATA.test(word[0]);
  const endK = KATA.test(word[word.length - 1]);
  let from = 0;
  for (;;) {
    const i = hay.indexOf(word, from);
    if (i < 0) return false;
    const before = i > 0 ? hay[i - 1] : '';
    const after = hay[i + word.length] || '';
    if (!(startK && before && KATA.test(before)) && !(endK && after && KATA.test(after))) return true;
    from = i + 1;
  }
}

/**
 * matched_terms の整理。topic: は話題名、quote: は外して言葉、report:/manual/inherit: は使わない。
 * 返り値: { words: [正規化済み], topics: [話題名（元の表記）] }
 */
export function cleanTerms(terms) {
  const words = [];
  const topics = [];
  for (const raw of Array.isArray(terms) ? terms : []) {
    if (typeof raw !== 'string') continue;
    let t = raw.trim();
    if (!t) continue;
    if (t.startsWith(TERM_PREFIXES.topic)) {
      const name = t.slice(TERM_PREFIXES.topic.length).trim();
      if (name && !topics.includes(name)) topics.push(name);
      continue;
    }
    if (TERM_PREFIXES.ignore.some((p) => t === p || t.startsWith(p))) continue;
    for (const p of TERM_PREFIXES.strip) if (t.startsWith(p)) t = t.slice(p.length).trim();
    const n = normalizeForMatch(t);
    if (n && !words.includes(n)) words.push(n);
  }
  return { words, topics };
}

/** 投稿の照合用キャッシュ */
function matchInfo(post) {
  const ct = cleanTerms(post.matched_terms);
  const text = normalizeForMatch(post.text);
  return {
    text,
    terms: ct.words.join('|'),
    termWords: ct.words,
    tags: ct.topics,
    user: String(post.user || '').toLowerCase(),
    mentions: mentionsOf(post.text),
    night: isNightPost(post),
  };
}

/**
 * 辞書の1項目との一致数（言葉は1、関係者は2）。0 なら不一致。nightOnly の項目は夜職の投稿（info.night）だけ。
 * people: '@abc' はアカウント名・本文の @abc、それ以外は本文・根拠語・アカウント名に含まれるか。
 */
export function dictHits(entry, info) {
  if (entry.nightOnly && info.night === false) return 0; // 夜職の投稿だけに当てる項目
  const prep = entry._n || prepareDictEntry(entry)._n;
  let hits = 0;
  for (const n of prep.words) {
    if (containsWord(info.text, n) || containsWord(info.terms, n)) hits += 1;
  }
  for (const n of prep.people) {
    if (n.startsWith('@')) {
      const u = n.slice(1);
      if (u && (info.user === u || info.mentions.includes(u))) hits += 2;
    } else if (containsWord(info.text, n) || containsWord(info.terms, n) || (info.user && info.user === n)) {
      hits += 2;
    }
  }
  return hits;
}

/** 辞書項目の言葉を正規化して _n に持たせた複製（照合を速くする） */
export function prepareDictEntry(entry) {
  const norm = (list) => (list || []).map((w) => normalizeForMatch(w).trim()).filter(Boolean);
  return { ...entry, _n: { words: norm(entry.words), people: norm(entry.people) } };
}

/** 一番よく一致する辞書項目（同点は辞書の順）。無ければ null */
export function bestDictEntry(dict, info) {
  let best = null;
  let bestHits = 0;
  for (const e of dict || []) {
    const h = dictHits(e, info);
    if (h > bestHits) { best = e; bestHits = h; }
  }
  return best;
}

// ================================================================ 類似度

const URL_IN_TEXT = /https?:\/\/\S+/g;

/** 本文 → 文字 bigram の集合（URL・@・記号・空白を除く） */
export function bigrams(text) {
  const s = normalizeForMatch(text).replace(URL_IN_TEXT, ' ').replace(/@[a-z0-9_]+/g, ' ');
  const chars = s.match(/[\p{L}\p{N}]/gu) || [];
  const set = new Set();
  for (let i = 0; i + 1 < chars.length; i++) set.add(chars[i] + chars[i + 1]);
  return set;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function makeUnionFind(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); };
  return { find, union };
}

/**
 * 類似まとめ（辞書に入らなかった投稿用）。3段階で、段階をまたいで鎖のようにつながらないようにする。
 *  1. 本文の文字 bigram の類似（Jaccard）… 夜職・一般のバズとも
 *  2. 同じアカウントの投稿 … 夜職のみ（一般のバズのニュースアカウント等は話題がばらばらなため）
 *  3. @で言及した相手の投稿（関係者）… 夜職のみ
 * 夜職と一般のバズはつながない。
 * 返り値: [{ ids: [postId], reasons: ['similar'|'same_user'|'related'] }]（2件以上のまとまりだけ）
 */
export function similarClusters(posts, opts = SIMILARITY) {
  const n = posts.length;
  if (n < 2) return [];
  const info = posts.map((p) => ({ bucket: isNightPost(p) ? 'n' : 'g', user: String(p.user || '').toLowerCase(), mentions: mentionsOf(p.text) }));
  const sets = posts.map((p) => bigrams(p.text));
  const df = new Map();
  for (const s of sets) for (const g of s) df.set(g, (df.get(g) || 0) + 1);
  const maxDf = Math.max(opts.maxDfMin, Math.ceil(n * opts.maxDfRatio));
  const filtered = sets.map((s) => new Set([...s].filter((g) => df.get(g) <= maxDf)));
  const postings = new Map();
  filtered.forEach((s, i) => {
    if (s.size < opts.minBigrams) return;
    for (const g of s) { if (!postings.has(g)) postings.set(g, []); postings.get(g).push(i); }
  });
  const uf = makeUnionFind(n);
  for (let i = 0; i < n; i++) {
    if (filtered[i].size < opts.minBigrams) continue;
    const counts = new Map();
    for (const g of filtered[i]) for (const j of postings.get(g) || []) if (j > i) counts.set(j, (counts.get(j) || 0) + 1);
    for (const [j, c] of counts) {
      if (info[i].bucket !== info[j].bucket) continue;
      if (c / (filtered[i].size + filtered[j].size - c) >= opts.minJaccard) uf.union(i, j);
    }
  }
  const out = [];
  const taken = new Set();
  const collect = (find, reason) => {
    const groups = new Map();
    for (let i = 0; i < n; i++) {
      if (taken.has(i)) continue;
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(i);
    }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      g.forEach((i) => taken.add(i));
      out.push({ ids: g.map((i) => posts[i].id), reasons: [reason] });
    }
  };
  collect(uf.find, 'similar');
  // 2. 同じアカウント（夜職のみ）
  const uf2 = makeUnionFind(n);
  const firstOf = new Map();
  info.forEach((x, i) => {
    if (taken.has(i) || x.bucket !== 'n' || !x.user) return;
    if (firstOf.has(x.user)) uf2.union(firstOf.get(x.user), i);
    else firstOf.set(x.user, i);
  });
  collect(uf2.find, 'same_user');
  // 3. 関係者（@言及した相手の投稿。夜職のみ）
  const uf3 = makeUnionFind(n);
  const byUser = new Map();
  info.forEach((x, i) => { if (!taken.has(i) && x.bucket === 'n' && x.user && !byUser.has(x.user)) byUser.set(x.user, i); });
  info.forEach((x, i) => {
    if (taken.has(i) || x.bucket !== 'n') return;
    for (const m of x.mentions) {
      const j = byUser.get(m);
      if (j != null && j !== i) uf3.union(i, j);
    }
  });
  collect(uf3.find, 'related');
  return out;
}

function mentionsOf(text) {
  return [...normalizeForMatch(text).matchAll(/@([a-z0-9_]{1,15})/g)].map((m) => m[1]);
}

// ================================================================ 話題

/** カテゴリ → ジャンル */
export function genreOfCategory(cat) {
  const g = GENRES.find((x) => x.cats.includes(cat));
  return g ? g.key : null;
}

/** ジャンル → データ上のカテゴリ名（上書き用） */
export function categoryOfGenre(g) {
  const x = GENRES.find((y) => y.key === g);
  return x ? x.cats[0] : '夜職その他';
}

/** 投稿 1 件のジャンル（上書きがあればそれ） */
export function postGenre(post) {
  if (!post) return 'general';
  return post._genreOverride || majorityGenre([post]);
}

/**
 * 投稿のジャンル上書きを当てる。上書きのある投稿だけ複製して categories を差し替える（元は _origCategories）。
 * cache（Map）を渡すと同じ複製を使い回す。
 */
export function applyGenreOverrides(posts, overrides, cache = new Map()) {
  if (!overrides || !Object.keys(overrides).length) return posts;
  return posts.map((p) => {
    const o = p && overrides[p.id];
    if (!o) return p;
    const key = `${p.id}:${o.genre}`;
    let c = cache.get(key);
    if (!c || c._base !== p) {
      c = { ...p, categories: [categoryOfGenre(o.genre), ...p.categories.filter((x) => !genreOfCategory(x))], _origCategories: p.categories, _genreOverride: o.genre, _base: p };
      cache.set(key, c);
    }
    return c;
  });
}

/**
 * 投稿のジャンルを上書き（投稿 id ごと・全週に効く）。元のジャンルと同じなら上書きを消す。
 * origGenreOf(id) で元のジャンル（データのカテゴリから）を引く。saved を書き換えて返す。
 */
export function setPostGenre(saved, ids, genre, nowMs, origGenreOf) {
  if (!GENRE_KEYS.includes(genre)) return saved;
  const next = { ...(saved.genreOverrides || {}) };
  for (const id of ids) {
    if (!ID_RE.test(String(id))) continue;
    const from = origGenreOf ? origGenreOf(id) : null;
    if (from && from === genre) delete next[id];
    else next[id] = { genre, at: isNum(nowMs) ? nowMs : null, from: from || null };
  }
  saved.genreOverrides = next;
  return saved;
}

/** ジャンル上書きの一覧（段階3でボットへ返す形） */
export function genreOverrideList(saved) {
  return Object.entries(saved.genreOverrides || {}).map(([id, o]) => ({ id, genre: o.genre, from: o.from, at: o.at }))
    .sort((a, b) => compareIds(a.id, b.id));
}

export function isNightPost(post) {
  return (post.categories || []).some((c) => NIGHT_GENRES.includes(genreOfCategory(c)));
}

/** 投稿群のジャンル（夜職4種の多数決。夜職が無ければ一般のバズ） */
export function majorityGenre(posts) {
  const counts = new Map();
  for (const p of posts) {
    for (const c of p.categories || []) {
      const g = genreOfCategory(c);
      if (g && NIGHT_GENRES.includes(g)) counts.set(g, (counts.get(g) || 0) + 1);
    }
  }
  let best = null;
  let bestN = 0;
  for (const g of NIGHT_GENRES) if ((counts.get(g) || 0) > bestN) { best = g; bestN = counts.get(g); }
  return best || 'general';
}

export function genreLabel(key) {
  if (key === 'main') return 'メイン';
  const g = GENRES.find((x) => x.key === key);
  return g ? g.label : '一般のバズ';
}

/** id の大小（数字の桁数→辞書順）。snowflake は古いほど小さい */
export function compareIds(a, b) {
  const x = String(a);
  const y = String(b);
  if (x.length !== y.length) return x.length - y.length;
  return x < y ? -1 : x > y ? 1 : 0;
}

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\uFE0F\u200D\u20E3]/gu;
const EDGE_JUNK = /^[\s\p{P}\p{S}ー〜～]+|[\s\p{P}\p{S}〜～]+$/gu;

/**
 * 本文から話題名に使う短い句（最大 len 字）。先頭の【…】タグ・URL・@・絵文字・記号を除き、
 * 最初の意味のある句（。！？改行などで区切った 4 字以上）を使う。本文が【…】だけならその中身。
 */
export function topicPhrase(text, len = 20) {
  const raw = String(text || '').replace(URL_IN_TEXT, ' ').replace(/[@＠][A-Za-z0-9_]{1,15}/g, ' ').replace(EMOJI, '');
  const tags = [];
  let body = raw.replace(/^[\s]*(?:[【\[［〔《≪][^】\]］〕》≫\n]{0,40}[】\]］〕》≫][\s]*)+/u, (m) => {
    for (const x of m.matchAll(/[【\[［〔《≪]([^】\]］〕》≫\n]{0,40})[】\]］〕》≫]/gu)) tags.push(x[1]);
    return '';
  });
  const clean = (x) => x.replace(/[【】\[\]［］〔〕《》≪≫]/g, ' ').replace(/\s+/g, ' ').replace(EDGE_JUNK, '').trim();
  const parts = body.split(/[。！？!?\n]|(?:\s{2,})/).map(clean).filter((x) => [...x].length >= 4);
  let phrase = parts[0] || '';
  if (!phrase) phrase = tags.map(clean).find((x) => x) || clean(body) || '';
  // 片方だけ残ったかっこは外す（「『診断』を公開」→ 先頭を削った結果の『 なし 』）
  for (const [o, c] of [['「', '」'], ['『', '』'], ['（', '）'], ['(', ')'], ['“', '”']]) {
    if (phrase.split(o).length !== phrase.split(c).length) phrase = phrase.split(o).join('').split(c).join('');
  }
  phrase = phrase.replace(EDGE_JUNK, '').trim();
  const chars = [...phrase];
  if (!chars.length) return '（本文なし）';
  return chars.length > len ? chars.slice(0, len).join('') + '…' : phrase;
}

function snippet(text) {
  return topicPhrase(text, 20);
}

const GENERIC_WORDS = new Set(['ホスト', 'キャバ', 'キャバ嬢', 'キャバクラ', '夜職', '歌舞伎町', 'ホストクラブ', '新宿'].map(normalizeForMatch));

/**
 * 話題の統計。表示数が不明な投稿は合計に入れず unknown に数える。
 * 返り値: { count, totalImp|null, unknownImp, maxImp|null, topPostId, maxPace|null, pacePostId, latestTs }
 */
export function topicStats(posts, refTs) {
  let total = 0;
  let known = 0;
  let maxImp = null;
  let topPostId = null;
  let maxPace = null;
  let pacePostId = null;
  let latestTs = null;
  for (const p of posts) {
    const imp = p.metrics ? p.metrics.impression_count : null;
    if (isNum(imp)) {
      total += imp;
      known++;
      if (maxImp == null || imp > maxImp) { maxImp = imp; topPostId = p.id; }
    }
    const v = viewsPerHour(p, refTs);
    if (v && (maxPace == null || v.perHour > maxPace)) { maxPace = v.perHour; pacePostId = p.id; }
    if (isNum(p.ts) && (latestTs == null || p.ts > latestTs)) latestTs = p.ts;
  }
  if (!topPostId && posts.length) topPostId = [...posts].sort((a, b) => (b.ts ?? -Infinity) - (a.ts ?? -Infinity))[0].id;
  return {
    count: posts.length,
    totalImp: known ? total : null,
    unknownImp: posts.length - known,
    maxImp,
    topPostId,
    maxPace,
    pacePostId,
    latestTs,
  };
}

/**
 * 話題性スコア（対数。単発の巨大インプレが勝ちすぎないように）。表示数がすべて不明なら null（並べ替えでは末尾）。
 * log10(1 + 合計表示 + 最大伸びペース×paceHours) + perDoublePosts×log2(投稿数) + perBookmark×ブックマーク件数
 */
export function topicScore(stats, w = SCORE_WEIGHTS, bookmarkCount = 0) {
  if (!stats || stats.totalImp == null) return null;
  const base = Math.log10(1 + stats.totalImp + (stats.maxPace || 0) * w.paceHours);
  const posts = Math.min(Math.log2(Math.max(1, stats.count)), w.maxPostsLog2);
  const bm = Math.min(Math.max(0, bookmarkCount || 0), w.maxBookmarks);
  return base + w.perDoublePosts * posts + w.perBookmark * bm;
}

/** 画面表示用の点数（スコア×10 を四捨五入）。不明は null */
export function scorePoints(score) {
  return score == null ? null : Math.round(score * 10);
}

/** 「まとまった話題」か（投稿が GROUPED_MIN_POSTS 件以上、または持ち越し・手動・自分で貼った話題） */
export function isGroupedTopic(t) {
  if (!t) return false;
  if (['carried', 'manual', 'link'].includes(t.kind)) return true;
  return (t.stats ? t.stats.count : t.postIds.length) >= GROUPED_MIN_POSTS || t.personalPaste === true;
}

/** スコア順（null は末尾）→ 最大表示 → id */
export function sortTopics(topics) {
  return [...topics].sort((a, b) => {
    const sa = a.score;
    const sb = b.score;
    if (sa == null && sb != null) return 1;
    if (sb == null && sa != null) return -1;
    if (sa != null && sb != null && sb !== sa) return sb - sa;
    const ma = a.stats.maxImp ?? -1;
    const mb = b.stats.maxImp ?? -1;
    if (mb !== ma) return mb - ma;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function emptyOverrides() {
  return { renames: {}, genres: {}, moves: {}, merges: {}, accepted: [], split: [], manual: [] };
}

/**
 * 番組週の話題を作る。
 * input: {
 *   posts       … 番組週の投稿（normalizeDataset 済み）
 *   extraPosts  … 個人で追加した投稿のうち posts.json にあるもの（週の外でも入れる）
 *   missingIds  … 個人で追加したが posts.json に無い id（リンクだけの話題になる）
 *   personalIds / bookmarkIds … 印を付けるための id 集合
 *   carried     … 前週から持ち越した話題のスナップショット [{ topicId, name, genre, postIds, fromWeek }]
 *   postsById   … 全投稿の Map（持ち越し話題の投稿を引く）
 *   dict, overrides, refTs
 *   cache       … 任意。{} を渡すと類似まとめの結果を使い回す
 *   hiddenPostIds … 削除（非表示）にした投稿 id（どの話題にも入れない）
 * }
 * 返り値: 話題の配列（スコア順）
 */
export function buildTopics(input) {
  const {
    posts = [], extraPosts = [], missingIds = [], personalIds = new Set(), bookmarkIds = new Set(),
    carried = [], postsById = new Map(), dict = [], refTs = null,
  } = input;
  const ov = { ...emptyOverrides(), ...(input.overrides || {}) };
  const byId = new Map();
  // 削除（非表示）にした投稿は最初から入れない
  const hiddenPosts = input.hiddenPostIds instanceof Set ? input.hiddenPostIds : new Set(input.hiddenPostIds || []);
  for (const p of [...posts, ...extraPosts]) if (p && p.id && !byId.has(p.id) && !hiddenPosts.has(p.id)) byId.set(p.id, p);
  const topics = new Map();
  const where = new Map(); // postId → topicId
  const add = (tid, base, postId) => {
    if (!topics.has(tid)) topics.set(tid, { id: tid, postIds: [], reasons: [], ...base });
    if (postId != null) {
      topics.get(tid).postIds.push(postId);
      where.set(postId, tid);
    }
  };

  // 1. 前週からの持ち越し（優先）
  for (const c of carried) {
    if (!c || !c.topicId) continue;
    const tid = 'k:' + c.topicId;
    add(tid, { kind: 'carried', autoName: c.name || '持ち越しの話題', fixedGenre: c.genre || null, carriedFrom: c.fromWeek || null, linkId: (c.linkIds || [])[0] || null });
    for (const pid of c.postIds || []) {
      const p = byId.get(pid) || postsById.get(pid);
      if (p && !where.has(pid) && !hiddenPosts.has(pid)) { byId.set(pid, p); add(tid, {}, pid); }
    }
  }

  // 2. データ側の話題名（matched_terms の topic:）→ 3. 話題辞書
  const prepared = dict.map(prepareDictEntry);
  const rest = [];
  for (const p of byId.values()) {
    if (where.has(p.id)) continue;
    const info = matchInfo(p);
    if (info.tags.length) { add('t:' + info.tags[0], { kind: 'tag', autoName: info.tags[0] }, p.id); continue; }
    const e = bestDictEntry(prepared, info);
    if (e) { add('d:' + e.id, { kind: 'dict', autoName: e.name, fixedGenre: GENRE_KEYS.includes(e.genre) ? e.genre : null, dictId: e.id }, p.id); continue; }
    rest.push(p);
  }

  // 4. 類似まとめ（提案）・1件ずつ
  const splitSet = new Set(ov.split);
  // 類似まとめは重いので、同じ投稿の組み合わせなら input.cache（{ key, value }）を使い回す
  const cacheKey = rest.map((p) => p.id).join(',');
  let clusters;
  if (input.cache && input.cache.key === cacheKey) clusters = input.cache.value;
  else {
    clusters = similarClusters(rest);
    if (input.cache) { input.cache.key = cacheKey; input.cache.value = clusters; }
  }
  for (const g of clusters) {
    const anchor = [...g.ids].sort(compareIds)[0];
    const tid = 'c:' + anchor;
    if (splitSet.has(tid)) continue;
    add(tid, { kind: 'cluster', autoName: null, reasons: g.reasons });
    for (const pid of g.ids) add(tid, {}, pid);
  }
  for (const p of rest) if (!where.has(p.id)) add('p:' + p.id, { kind: 'single', autoName: null }, p.id);

  // 5. posts.json に無い個人追加（リンクだけ）
  for (const id of missingIds) add('x:' + id, { kind: 'link', autoName: '追加した投稿（中身はXで確認）', linkId: id, fixedGenre: null });

  // 6. 手動の話題
  for (const m of ov.manual) if (m && m.id) add(m.id, { kind: 'manual', autoName: m.name || '新しい話題', fixedGenre: GENRE_KEYS.includes(m.genre) ? m.genre : null });

  // 7. 投稿の移動
  for (const [pid, target] of Object.entries(ov.moves)) {
    const from = where.get(pid);
    if (!from || from === target) continue;
    if (!topics.has(target)) {
      if (target === 'p:' + pid) add(target, { kind: 'single', autoName: null });
      else continue;
    }
    const ft = topics.get(from);
    ft.postIds = ft.postIds.filter((x) => x !== pid);
    topics.get(target).postIds.push(pid);
    where.set(pid, target);
  }

  // 8. 話題の結合（連鎖をたどる・循環は無視。結合済みの話題を指していたら結合先へ）
  const gone = new Map();
  const alive = (id) => {
    const seen = new Set();
    while (!topics.has(id) && gone.has(id) && !seen.has(id)) { seen.add(id); id = gone.get(id); }
    return id;
  };
  const resolve = (tid) => {
    const seen = new Set([tid]);
    let t = tid;
    for (;;) {
      const n = ov.merges[t] ? alive(ov.merges[t]) : null;
      if (!n || !topics.has(n) || seen.has(n)) return t;
      t = n;
      seen.add(t);
    }
  };
  for (const src of Object.keys(ov.merges)) {
    if (!topics.has(src)) continue;
    const dst = resolve(src);
    if (dst === src) continue;
    const s = topics.get(src);
    const d = topics.get(dst);
    d.postIds.push(...s.postIds);
    d.mergedFrom = [...(d.mergedFrom || []), src];
    if (s.linkId && !d.linkIds) d.linkIds = [s.linkId];
    for (const pid of s.postIds) where.set(pid, dst);
    topics.delete(src);
    gone.set(src, dst);
  }

  // 9. 仕上げ（統計・名前・ジャンル・スコア）
  const accepted = new Set(ov.accepted);
  const out = [];
  for (const t of topics.values()) {
    if (!t.postIds.length && !['link', 'manual', 'carried'].includes(t.kind)) continue;
    const tp = t.postIds.map((id) => byId.get(id)).filter(Boolean);
    const stats = topicStats(tp, refTs);
    t.postIds = [...tp].sort((a, b) => (b.metrics?.impression_count ?? -1) - (a.metrics?.impression_count ?? -1)).map((p) => p.id);
    let name = t.autoName;
    if (!name) name = autoTopicName(t, tp, stats, byId);
    t.autoName = name;
    t.name = typeof ov.renames[t.id] === 'string' && ov.renames[t.id].trim() ? ov.renames[t.id].trim() : name;
    const og = ov.genres[t.id];
    t.genre = GENRE_KEYS.includes(og) ? og : (t.fixedGenre || (tp.length ? majorityGenre(tp) : 'night'));
    t.suggested = t.kind === 'cluster' && !accepted.has(t.id);
    t.personal = tp.some((p) => personalIds.has(p.id)) || t.kind === 'link';
    t.personalPaste = t.personal;
    t.bookmarkCount = tp.filter((p) => bookmarkIds.has(p.id)).length + (t.kind === 'link' && bookmarkIds.has(t.linkId) ? 1 : 0);
    t.bookmark = t.bookmarkCount > 0;
    t.stats = stats;
    t.score = topicScore(stats, SCORE_WEIGHTS, t.bookmarkCount);
    delete t.fixedGenre;
    out.push(t);
  }
  return sortTopics(out);
}

function autoTopicName(t, posts, stats, byId) {
  const top = byId.get(stats.topPostId) || posts[0];
  if (t.kind === 'cluster') {
    const users = new Set(posts.map((p) => p.user));
    if (users.size === 1 && posts[0].user) return `@${posts[0].user} の話題`;
    const counts = new Map();
    for (const p of posts) {
      for (const w of cleanTerms(p.matched_terms).words) {
        if (GENERIC_WORDS.has(w)) continue;
        counts.set(w, (counts.get(w) || 0) + 1);
      }
    }
    let best = null;
    let bestN = 1;
    for (const [w, c] of counts) if (c > bestN) { best = w; bestN = c; }
    if (best) {
      // 表記は元の matched_terms から（大文字小文字・ひらがなを保つ）
      for (const p of posts) for (const raw of p.matched_terms || []) {
        const s = String(raw).replace(/^quote:/, '');
        if (normalizeForMatch(s) === best) return s;
      }
      return best;
    }
  }
  if (!top) return '話題';
  const name = snippet(top.text);
  return name === '（本文なし）' && top.user ? `@${top.user} の投稿（本文なし）` : name;
}

/** 一覧から Map（id → 話題） */
export function indexTopics(topics) {
  return new Map(topics.map((t) => [t.id, t]));
}

/**
 * メイン候補。MAIN_SUGGEST_TIERS の順（既定: 夜職で2件以上 → 夜職の単発。一般のバズは出さない）、
 * 同じ段の中はスコア順。すでに使っている話題・スコア不明は除く。
 */
export function suggestMain(topics, usedIds, n = 3, tiers = MAIN_SUGGEST_TIERS) {
  const used = new Set(usedIds || []);
  const pool = sortTopics(topics).filter((t) => !used.has(t.id) && t.score != null);
  const tierOf = (t) => {
    const night = NIGHT_GENRES.includes(t.genre);
    const i = tiers.findIndex((x) => x.night === night && t.stats.count >= x.minPosts);
    return i < 0 ? tiers.length : i;
  };
  return pool.map((t, i) => ({ t, i, tier: tierOf(t) }))
    .filter((x) => x.tier < tiers.length) // どの段にも入らない話題（一般のバズ）はおすすめしない
    .sort((a, b) => a.tier - b.tier || a.i - b.i).slice(0, n).map((x) => x.t);
}

// ================================================================ 文章

/** 自動リード文「今週「◯◯」が話題に。投稿△件、合計◯万インプレ。」 */
export function leadText(topic, postsById, refTs) {
  if (!topic) return '';
  const st = topic.stats || {};
  if (!st.count) return `今週は「${topic.name}」を紹介します。（数値はデータに無いため不明）`;
  const total = st.totalImp == null ? `合計インプレは${UNKNOWN}` : `合計${formatCompact(st.totalImp)}インプレ${st.unknownImp ? '（一部不明）' : ''}`;
  let s = `${topic.kind === 'carried' ? '先週からの持ち越し。' : ''}今週「${topic.name}」が話題に。投稿${st.count}件、${total}。`;
  const pp = st.pacePostId && postsById ? postsById.get(st.pacePostId) : null;
  if (pp && st.count > 0) s += `いちばん伸びた投稿は${formatPace(pp, refTs)}。`;
  return s;
}

/** 自動タイトル「【番組名】話題A／話題B／話題C」 */
export function autoTitle(showName, names) {
  const n = (names || []).map((x) => String(x || '').trim()).filter(Boolean);
  return `【${String(showName || SHOW_DEFAULTS.showName).trim() || SHOW_DEFAULTS.showName}】${n.join('／')}`;
}

// ================================================================ 構成・進行

export function defaultRundown() {
  return { corners: CORNERS.map((c) => ({ key: c.key, min: c.min, items: [] })) };
}

export function cornerDef(key) {
  return CORNERS.find((c) => c.key === key) || null;
}

/** メインに入れてよい話題か（一般のバズは入れない） */
export function canBeMain(topic) {
  return Boolean(topic) && (!MAIN_NIGHT_ONLY || NIGHT_GENRES.includes(topic.genre));
}

/** 末尾の空き枠（null）を落とす */
function trimSlots(items) {
  const out = [...items];
  while (out.length && out[out.length - 1] == null) out.pop();
  return out;
}

/** コーナーから外す（メインは枠の位置を保つため null にする） */
function dropFrom(c, topicId) {
  if (c.key === 'main') c.items = trimSlots(c.items.map((x) => (x === topicId ? null : x)));
  else c.items = c.items.filter((x) => x !== topicId);
}

/**
 * 話題をコーナーへ入れる（他のコーナーからは外す）。メインは最大本数まで（満杯なら null）。
 * メインは「メイン1〜3」の枠で、空き枠（null）があればそこへ入る。index を渡すとその位置へ。
 */
export function assignTopic(rundown, topicId, cornerKey, index = null) {
  const r = cloneRundown(rundown);
  for (const c of r.corners) dropFrom(c, topicId);
  const c = r.corners.find((x) => x.key === cornerKey);
  const def = cornerDef(cornerKey);
  if (!c || !def || (def.kind !== 'main' && def.kind !== 'news')) return r;
  if (def.kind === 'main') {
    const slots = [...c.items];
    while (slots.length < def.maxItems) slots.push(null);
    if (index != null && index >= 0 && index < def.maxItems && slots[index] == null) slots[index] = topicId;
    else {
      const hole = slots.indexOf(null);
      if (hole < 0) return null; // 満杯
      slots[hole] = topicId;
    }
    c.items = trimSlots(slots);
    return r;
  }
  if (index == null || index < 0 || index > c.items.length) c.items.push(topicId);
  else c.items.splice(index, 0, topicId);
  return r;
}

/**
 * メインの枠（0〜2 = メイン1〜3）に入れる。入っていた話題は displaced で返す（メイン候補へ戻す用）。
 * 返り値: { rundown, displaced: topicId | null }
 */
export function setMainSlot(rundown, topicId, slot) {
  const def = cornerDef('main');
  if (!(slot >= 0 && slot < def.maxItems)) return { rundown, displaced: null };
  const r = cloneRundown(rundown);
  const fromMain = r.corners.find((x) => x.key === 'main').items.indexOf(topicId);
  for (const c of r.corners) dropFrom(c, topicId);
  const c = r.corners.find((x) => x.key === 'main');
  const slots = [...c.items];
  while (slots.length < def.maxItems) slots.push(null);
  let displaced = slots[slot] && slots[slot] !== topicId ? slots[slot] : null;
  // メインの中での入れ替え（メイン1 → メイン3 など）は位置を交換する
  if (displaced && fromMain >= 0) { slots[fromMain] = displaced; displaced = null; }
  slots[slot] = topicId;
  c.items = trimSlots(slots);
  return { rundown: r, displaced };
}

/** メインの枠ごとの話題 id（長さ 3。空き枠は null） */
export function mainSlots(rundown) {
  const c = rundown.corners.find((x) => x.key === 'main');
  const out = [...(c ? c.items : [])];
  while (out.length < cornerDef('main').maxItems) out.push(null);
  return out.slice(0, cornerDef('main').maxItems);
}

export function removeTopic(rundown, topicId) {
  const r = cloneRundown(rundown);
  for (const c of r.corners) dropFrom(c, topicId);
  return r;
}

/** コーナー内の位置へ移す（並べ替え。メインは枠の入れ替え） */
export function moveToIndex(rundown, cornerKey, topicId, index) {
  if (cornerKey === 'main') return setMainSlot(rundown, topicId, index).rundown;
  const r = cloneRundown(rundown);
  const c = r.corners.find((x) => x.key === cornerKey);
  if (!c) return r;
  const i = c.items.indexOf(topicId);
  if (i < 0) return assignTopic(rundown, topicId, cornerKey, index) || rundown;
  c.items.splice(i, 1);
  const j = Math.max(0, Math.min(index > i ? index - 1 : index, c.items.length));
  c.items.splice(j, 0, topicId);
  return r;
}

/** コーナー内で並べ替え（delta: -1 上へ / +1 下へ） */
export function moveInCorner(rundown, cornerKey, topicId, delta) {
  const r = cloneRundown(rundown);
  const c = r.corners.find((x) => x.key === cornerKey);
  if (!c) return r;
  const i = c.items.indexOf(topicId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= c.items.length) return r;
  [c.items[i], c.items[j]] = [c.items[j], c.items[i]];
  return r;
}

/** 話題 id の付け替え（結合時など）。重複は除く */
export function replaceTopicId(rundown, from, to) {
  const r = cloneRundown(rundown);
  for (const c of r.corners) {
    const seen = new Set();
    c.items = c.items.map((x) => (x === from ? to : x)).map((x) => (x == null ? null : seen.has(x) ? (c.key === 'main' ? null : undefined) : (seen.add(x), x))).filter((x) => x !== undefined);
    if (c.key === 'main') c.items = trimSlots(c.items);
  }
  return r;
}

function cloneRundown(r) {
  return { corners: r.corners.map((c) => ({ key: c.key, min: c.min, items: [...c.items] })) };
}

/** 構成で使っている話題 id（メインの空き枠は除く） */
export function usedTopicIds(rundown) {
  return rundown.corners.flatMap((c) => c.items).filter(Boolean);
}

/** 合計の分数 */
export function totalMinutes(rundown) {
  return rundown.corners.reduce((s, c) => s + (isNum(c.min) ? c.min : 0), 0);
}

/**
 * 進行の並び（キュー）。話題が入るコーナーは話題ごとに1つ、空なら「未設定」1つ、それ以外はコーナーごとに1つ。
 * 存在しない話題（データ更新で消えた等）は飛ばす。
 */
export function buildCues(rundown, topicsById) {
  const cues = [];
  rundown.corners.forEach((c, ci) => {
    const def = cornerDef(c.key);
    if (!def) return;
    if (def.kind === 'main' || def.kind === 'news') {
      const items = c.items.filter((id) => id && topicsById.has(id));
      if (!items.length) { cues.push({ id: c.key, cornerKey: c.key, cornerIndex: ci, kind: 'empty' }); return; }
      items.forEach((tid, k) => cues.push({ id: `${c.key}:${tid}`, cornerKey: c.key, cornerIndex: ci, kind: 'topic', topicId: tid, n: k + 1, of: items.length }));
    } else {
      cues.push({ id: c.key, cornerKey: c.key, cornerIndex: ci, kind: def.kind });
    }
  });
  return cues;
}

export function defaultLive() {
  // cardVisible: 映す用に投稿カードを出しているか（段階2で OBS のパーツ表示と連動する）
  return { startedAt: null, index: 0, status: {}, history: [], enteredAt: {}, cardVisible: true };
}

const LIVE_STATUS = ['done', 'skipped', 'carried'];

function nextOpen(cues, status, from) {
  for (let i = from; i < cues.length; i++) if (!status[cues[i].id]) return i;
  return cues.length;
}

/**
 * 進行の状態遷移（純粋関数）。action: { type, now }
 *  start  … 計測開始（現在のコーナーに入った時刻も記録）
 *  done   … 読んだ（済）→ 次の未処理へ
 *  skip   … 飛ばす → 次へ
 *  carry  … 来週に回す（話題のときだけ）→ 次へ
 *  back   … 戻す（直前の操作を取り消してそこへ戻る）
 *  goto   … 指定位置へ移動（action.index）
 *  reset  … すべて最初から
 */
export function liveReduce(live, action, cues) {
  const s = { ...defaultLive(), ...live, status: { ...(live && live.status) }, history: [...((live && live.history) || [])], enteredAt: { ...(live && live.enteredAt) } };
  const now = isNum(action.now) ? action.now : null;
  const enter = (st) => {
    const cue = cues[st.index];
    if (cue && st.startedAt != null && now != null && st.enteredAt[cue.cornerKey] == null) st.enteredAt[cue.cornerKey] = now;
    return st;
  };
  s.index = Math.min(Math.max(0, s.index | 0), cues.length);
  switch (action.type) {
    case 'start':
      if (s.startedAt == null && now != null) { s.startedAt = now; s.enteredAt = {}; }
      return enter(s);
    case 'reset':
      return defaultLive();
    case 'done':
    case 'skip':
    case 'carry': {
      const cue = cues[s.index];
      if (!cue) return s;
      if (action.type === 'carry' && cue.kind !== 'topic') return s;
      s.status[cue.id] = action.type === 'done' ? 'done' : action.type === 'skip' ? 'skipped' : 'carried';
      s.history.push(cue.id);
      s.index = nextOpen(cues, s.status, s.index + 1);
      return enter(s);
    }
    case 'back': {
      while (s.history.length) {
        const id = s.history.pop();
        const i = cues.findIndex((c) => c.id === id);
        if (i < 0) continue; // 構成から消えた話題
        delete s.status[id];
        s.index = i;
        return s;
      }
      if (s.index > 0) {
        s.index -= 1;
        const cue = cues[s.index];
        if (cue) delete s.status[cue.id];
      }
      return s;
    }
    case 'goto': {
      const i = action.index | 0;
      if (i >= 0 && i < cues.length) s.index = i;
      return enter(s);
    }
    case 'toggleCard':
      s.cardVisible = typeof action.visible === 'boolean' ? action.visible : !s.cardVisible;
      return s;
    default:
      return s;
  }
}

/** 進行で「読んだ」話題の投稿 id（重複なし） */
export function usedPostIdsOf(live, cues, topicsById) {
  const out = new Set();
  for (const c of cues) {
    if (c.kind !== 'topic' || live.status[c.id] !== 'done') continue;
    const t = topicsById.get(c.topicId);
    if (!t) continue;
    for (const id of t.postIds) out.add(id);
    if (t.linkId) out.add(t.linkId);
  }
  return [...out];
}

/** 指定の番組週より前の配信で読んだ投稿 id の集合（ブックマーク枠の「使用済み」） */
export function pastUsedIds(saved, weekKey) {
  const out = new Set();
  for (const [k, w] of Object.entries(saved.weeks || {})) {
    if (k >= weekKey) continue;
    for (const id of w.usedPostIds || []) out.add(id);
  }
  return out;
}

/**
 * ブックマーク枠の一覧。mode 'week'（既定）: bookmarked_at が番組週内、または bookmarked_at が無く投稿日時が番組週内。
 * mode 'all': すべて。使用済み（前の配信で読んだ）は下へ。元の並び（新しくブックマークした順）は保つ。
 * bookmarks: [{ id, url, ts(bookmarked_at の UNIX 秒 | null) }]
 */
export function bookmarkList(bookmarks, week, postsById, used = new Set(), mode = 'week') {
  const inWeek = (b) => {
    if (!week) return false;
    const t = b.ts != null ? b.ts : (postsById.get(b.id) || {}).ts;
    return t != null && t >= week.start && t < week.end;
  };
  const list = (bookmarks || []).map((b, i) => ({ ...b, i, inWeek: inWeek(b), used: used.has(b.id), post: postsById.get(b.id) || null }));
  const shown = mode === 'all' ? list : list.filter((b) => b.inWeek);
  return shown.sort((a, b) => (a.used - b.used) || (a.i - b.i));
}

/** 進行の状態で「来週に回す」になっている話題 id の集合 */
export function carriedTopicIds(live, cues) {
  const out = new Set();
  for (const c of cues) if (c.kind === 'topic' && live.status[c.id] === 'carried') out.add(c.topicId);
  return out;
}

/** 各キューの状態: 'done' | 'skipped' | 'carried' | 'current' | 'todo' */
export function cueStates(live, cues) {
  return cues.map((c, i) => (live.status[c.id] || (i === live.index ? 'current' : 'todo')));
}

/**
 * タイマー。nowMs は呼び出し側が渡す。
 * drift（秒）: ＋なら押し、−なら巻き。現在のコーナーに入った時刻と予定の開始時刻の差＋コーナーの超過分。
 */
export function computeTimer(live, rundown, cues, nowMs, tolSec = SHOW_DEFAULTS.driftToleranceSec) {
  const totalSec = totalMinutes(rundown) * 60;
  if (!live || live.startedAt == null || !isNum(nowMs)) {
    return { started: false, elapsedSec: 0, totalSec, cornerRemainSec: null, cornerSec: null, driftSec: 0, state: 'idle', finished: false };
  }
  const elapsedSec = Math.max(0, Math.floor((nowMs - live.startedAt) / 1000));
  const cue = cues[live.index];
  if (!cue) {
    const driftSec = elapsedSec - totalSec;
    return { started: true, elapsedSec, totalSec, cornerRemainSec: null, cornerSec: null, driftSec, state: driftState(driftSec, tolSec), finished: true };
  }
  let plannedStart = 0;
  for (let i = 0; i < rundown.corners.length; i++) {
    if (rundown.corners[i].key === cue.cornerKey) break;
    plannedStart += (rundown.corners[i].min || 0) * 60;
  }
  const corner = rundown.corners.find((c) => c.key === cue.cornerKey);
  const cornerSec = ((corner && corner.min) || 0) * 60;
  const entered = isNum(live.enteredAt && live.enteredAt[cue.cornerKey]) ? live.enteredAt[cue.cornerKey] : nowMs;
  const enteredSec = Math.max(0, Math.floor((entered - live.startedAt) / 1000));
  const inCorner = Math.max(0, Math.floor((nowMs - entered) / 1000));
  const driftSec = enteredSec - plannedStart + Math.max(0, inCorner - cornerSec);
  return { started: true, elapsedSec, totalSec, cornerSec, cornerRemainSec: cornerSec - inCorner, driftSec, state: driftState(driftSec, tolSec), finished: false };
}

function driftState(d, tol) {
  if (d > tol) return 'over';
  if (d < -tol) return 'under';
  return 'ok';
}

/** 秒 → 「m:ss」「h:mm:ss」（負は「-」） */
export function formatClock(sec) {
  if (!isNum(sec)) return '--:--';
  const sign = sec < 0 ? '-' : '';
  const a = Math.abs(Math.round(sec));
  const h = Math.floor(a / 3600);
  const m = Math.floor((a % 3600) / 60);
  const s = a % 60;
  return h ? `${sign}${h}:${pad2(m)}:${pad2(s)}` : `${sign}${m}:${pad2(s)}`;
}

// ================================================================ チェックポイント・NEW

/** チェックポイントを記録（直前のものの id 一覧は容量節約のため捨てる） */
export function recordCheckpoint(week, kind, dataAt, postIds, topicIds, nowMs) {
  const cps = (week.checkpoints || []).map((c) => ({ kind: c.kind, dataAt: c.dataAt, recordedAt: c.recordedAt, count: c.count ?? (c.postIds ? c.postIds.length : 0) }));
  cps.push({ kind, dataAt: dataAt || null, recordedAt: nowMs, count: postIds.length, postIds: [...postIds], topicIds: [...topicIds] });
  return { ...week, checkpoints: cps };
}

/** 直近のチェックポイント以降に増えた投稿・話題。チェックが無ければ空 */
export function newSince(week, postIds, topics) {
  const cps = week.checkpoints || [];
  const last = [...cps].reverse().find((c) => Array.isArray(c.postIds));
  if (!last) return { since: null, posts: new Set(), topics: new Map() };
  const seenP = new Set(last.postIds);
  const seenT = new Set(last.topicIds || []);
  const posts = new Set(postIds.filter((id) => !seenP.has(id)));
  const tmap = new Map();
  for (const t of topics) {
    const added = t.postIds.filter((id) => posts.has(id)).length;
    if (!seenT.has(t.id) || added) tmap.set(t.id, added);
  }
  return { since: last, posts, topics: tmap };
}

// ================================================================ 保存データ

export function defaultWeek() {
  return {
    title: null, // null = 自動タイトル
    rundown: defaultRundown(),
    script: {}, // topicId → { lead: string|null, points, question }
    notes: {}, // コーナーごとのメモ（cornerKey → 文字列）
    overrides: emptyOverrides(),
    personal: [], // [{ id, url, addedAt }]
    checkpoints: [],
    live: defaultLive(),
    carriedOut: [], // 来週に回した話題のスナップショット
    usedPostIds: [], // 進行で「読んだ」話題の投稿 id（次の週以降のブックマーク枠で「使用済み」）
    shelved: [], // 片付けた話題（この週は候補に出さない）。[{ topicId, name, genre, postIds, at, corner }]
    mainCand: [], // メイン候補（メイン1〜3に入れる前の置き場）。話題 id の並び
  };
}

export function defaultSaved() {
  return {
    v: SCHEMA_VERSION, showName: SHOW_DEFAULTS.showName, dict: DEFAULT_DICT.map((e) => ({ ...e, words: [...e.words], people: [...e.people] })), weeks: {}, activeWeek: null, savedAt: null,
    trash: [], // 削除した話題（ゴミ箱。今後の週にも出さない）。[{ id, topicId, name, genre, postIds, week, at, corner }]
    hiddenPosts: [], // 削除（非表示）にした投稿。[{ id, week, at, topicName }]
    // 投稿のジャンルの上書き（投稿 id ごと・全週に効く。段階3でボットへ返す）。{ [postId]: { genre, at, from } }
    genreOverrides: {},
  };
}

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const str = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : null);
const strList = (v, max = 500, len = 200) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, len)))].slice(0, max) : []);
const strMap = (v, len = 4000) => {
  const o = obj(v);
  const out = {};
  if (!o) return out;
  for (const [k, x] of Object.entries(o)) if (typeof x === 'string' && k !== '__proto__') out[k] = x.slice(0, len);
  return out;
};
const ID_RE = /^\d{1,25}$/;

function sanitizeDictEntry(e, i) {
  const o = obj(e);
  if (!o) return null;
  const name = str(o.name, 60);
  if (!name || !name.trim()) return null;
  return {
    id: typeof o.id === 'string' && o.id.trim() ? o.id.trim().slice(0, 60) : `u-${i}`,
    name: name.trim(),
    genre: GENRE_KEYS.includes(o.genre) ? o.genre : 'night',
    words: strList(o.words, 50, 40),
    people: strList(o.people, 50, 40),
    // 版 1 の初期辞書には nightOnly が無い → 同じ id の初期値を引き継ぐ
    nightOnly: typeof o.nightOnly === 'boolean' ? o.nightOnly : Boolean((DEFAULT_DICT.find((d) => d.id === o.id) || {}).nightOnly),
  };
}

function sanitizeRundown(v, ver = SCHEMA_VERSION) {
  const base = defaultRundown();
  const o = obj(v);
  if (!o || !Array.isArray(o.corners)) return base;
  const used = new Set();
  for (const c of base.corners) {
    const src = o.corners.find((x) => obj(x) && x.key === c.key);
    if (!src) continue;
    // 版 1（7 コーナー時代）の分数は使わない（構成が変わったため新しい既定 45/30/15 分にする）
    if (ver >= 2 && isNum(src.min) && src.min >= 0 && src.min <= 240) c.min = Math.round(src.min);
    const def = cornerDef(c.key);
    if (def.kind === 'main') {
      // メインは枠（メイン1〜3）。空き枠は null で残す
      const raw = Array.isArray(src.items) ? src.items.slice(0, def.maxItems) : [];
      c.items = trimSlots(raw.map((x) => (typeof x === 'string' && x.trim() && !used.has(x.trim()) ? (used.add(x.trim()), x.trim().slice(0, 200)) : null)));
    } else if (def.kind === 'news') {
      c.items = strList(src.items, 50).filter((x) => (used.has(x) ? false : used.add(x)));
      if (def.maxItems) c.items = c.items.slice(0, def.maxItems);
    }
  }
  return base;
}

function sanitizeLive(v, ver = SCHEMA_VERSION) {
  const o = obj(v);
  const d = defaultLive();
  if (!o) return d;
  d.startedAt = isNum(o.startedAt) ? o.startedAt : null;
  // 版 1 は並びが違うので位置は最初に戻す（済などの状態は今あるコーナーの分だけ残す）
  d.index = ver >= 2 && isNum(o.index) && o.index >= 0 ? Math.floor(o.index) : 0;
  const st = obj(o.status) || {};
  for (const [k, x] of Object.entries(st)) if (LIVE_STATUS.includes(x) && k !== '__proto__' && cornerDef(k.split(':')[0])) d.status[k] = x;
  d.history = strList(o.history, 500).filter((id) => d.status[id]);
  const en = obj(o.enteredAt) || {};
  for (const [k, x] of Object.entries(en)) if (isNum(x) && cornerDef(k)) d.enteredAt[k] = x;
  d.cardVisible = o.cardVisible !== false;
  return d;
}

function sanitizeOverrides(v) {
  const o = obj(v) || {};
  const genres = {};
  for (const [k, x] of Object.entries(obj(o.genres) || {})) if (GENRE_KEYS.includes(x) && k !== '__proto__') genres[k] = x;
  const moves = {};
  for (const [k, x] of Object.entries(obj(o.moves) || {})) if (ID_RE.test(k) && typeof x === 'string') moves[k] = x.slice(0, 200);
  const merges = {};
  for (const [k, x] of Object.entries(obj(o.merges) || {})) if (typeof x === 'string' && x !== k && k !== '__proto__') merges[k] = x.slice(0, 200);
  const manual = (Array.isArray(o.manual) ? o.manual : [])
    .map((m) => obj(m) && typeof m.id === 'string' && m.id.startsWith('m:') ? { id: m.id.slice(0, 60), name: (str(m.name, 80) || '新しい話題').trim() || '新しい話題', genre: GENRE_KEYS.includes(m.genre) ? m.genre : 'night' } : null)
    .filter(Boolean).slice(0, 100);
  return { renames: strMap(o.renames, 80), genres, moves, merges, accepted: strList(o.accepted), split: strList(o.split), manual };
}

function sanitizeScript(v) {
  const out = {};
  for (const [k, x] of Object.entries(obj(v) || {})) {
    const o = obj(x);
    if (!o || k === '__proto__') continue;
    out[k] = { lead: typeof o.lead === 'string' ? o.lead.slice(0, 2000) : null, points: str(o.points, 4000) || '', question: str(o.question, 1000) || '' };
  }
  return out;
}

function sanitizeWeek(v, ver = SCHEMA_VERSION) {
  const o = obj(v);
  const w = defaultWeek();
  if (!o) return w;
  w.title = typeof o.title === 'string' ? o.title.slice(0, 200) : null;
  w.rundown = sanitizeRundown(o.rundown, ver);
  w.script = sanitizeScript(o.script);
  w.notes = Object.fromEntries(Object.entries(strMap(o.notes, 4000)).filter(([k]) => cornerDef(k)));
  w.overrides = sanitizeOverrides(o.overrides);
  const seenP = new Set();
  w.personal = (Array.isArray(o.personal) ? o.personal : [])
    .map((p) => (obj(p) && ID_RE.test(String(p.id)) ? { id: String(p.id), url: typeof p.url === 'string' && /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\//.test(p.url) ? p.url.slice(0, 300) : statusUrl(String(p.id)), addedAt: isNum(p.addedAt) ? p.addedAt : null } : null))
    .filter((p) => p && (seenP.has(p.id) ? false : seenP.add(p.id))).slice(0, 300);
  w.checkpoints = (Array.isArray(o.checkpoints) ? o.checkpoints : [])
    .map((c) => {
      const x = obj(c);
      if (!x || !CHECKPOINTS.some((k) => k.kind === x.kind)) return null;
      const out = { kind: x.kind, dataAt: str(x.dataAt, 60), recordedAt: isNum(x.recordedAt) ? x.recordedAt : null, count: isNum(x.count) ? x.count : null };
      if (Array.isArray(x.postIds)) out.postIds = x.postIds.filter((id) => typeof id === 'string' && ID_RE.test(id)).slice(0, 20000);
      if (Array.isArray(x.topicIds)) out.topicIds = strList(x.topicIds, 20000);
      return out;
    })
    .filter(Boolean).slice(-20);
  w.live = sanitizeLive(o.live, ver);
  w.carriedOut = sanitizeCarried(o.carriedOut);
  w.usedPostIds = (Array.isArray(o.usedPostIds) ? o.usedPostIds : []).filter((id) => typeof id === 'string' && ID_RE.test(id)).slice(0, 5000);
  const seenS = new Set();
  w.shelved = (Array.isArray(o.shelved) ? o.shelved : []).map(sanitizeShelf).filter((x) => x && (seenS.has(x.topicId) ? false : seenS.add(x.topicId))).slice(0, 2000);
  const inRundown = new Set(usedTopicIds(w.rundown));
  w.mainCand = strList(o.mainCand, 200).filter((id) => !inRundown.has(id));
  return w;
}

function sanitizeCarried(v) {
  const seen = new Set();
  return (Array.isArray(v) ? v : [])
    .map((c) => {
      const o = obj(c);
      if (!o || typeof o.topicId !== 'string' || !o.topicId) return null;
      return {
        topicId: o.topicId.slice(0, 200),
        name: (str(o.name, 120) || '持ち越しの話題'),
        genre: GENRE_KEYS.includes(o.genre) ? o.genre : 'night',
        postIds: (Array.isArray(o.postIds) ? o.postIds : []).filter((id) => typeof id === 'string' && ID_RE.test(id)).slice(0, 200),
        linkIds: (Array.isArray(o.linkIds) ? o.linkIds : []).filter((id) => typeof id === 'string' && ID_RE.test(id)).slice(0, 50),
        fromWeek: typeof o.fromWeek === 'string' && weekByKey(o.fromWeek) ? o.fromWeek : null,
        points: str(o.points, 4000) || '',
        via: o.via === 'plan' ? 'plan' : 'live',
      };
    })
    .filter((c) => c && (seen.has(c.topicId) ? false : seen.add(c.topicId)));
}

/**
 * 保存データ（localStorage・書き出しファイル）の読み込み。壊れた値・古い版・未知のフィールドに耐える。
 * 文字列（JSON）でもオブジェクトでもよい。読めなければ既定値。
 * 返り値: { state, ok: boolean, reason?: string }
 */
export function parseSaved(input) {
  let raw = input;
  if (typeof input === 'string') {
    try { raw = JSON.parse(input); } catch { return { state: defaultSaved(), ok: false, reason: 'JSON として読めませんでした' }; }
  }
  const o = obj(raw);
  if (!o) return { state: defaultSaved(), ok: false, reason: '保存データの形式が違います' };
  if (o.app != null && o.app !== 'xtrend-show') return { state: defaultSaved(), ok: false, reason: '番組サイトの保存データではありません' };
  const s = defaultSaved();
  const v = isNum(o.v) ? o.v : 0;
  if (typeof o.showName === 'string' && o.showName.trim()) s.showName = o.showName.trim().slice(0, 60);
  if (Array.isArray(o.dict)) {
    const seen = new Set();
    s.dict = o.dict.map(sanitizeDictEntry).filter((e) => e && (seen.has(e.id) ? false : seen.add(e.id))).slice(0, 200);
  }
  const weeks = obj(o.weeks) || {};
  for (const [k, w] of Object.entries(weeks)) if (weekByKey(k)) s.weeks[k] = sanitizeWeek(w, v);
  s.activeWeek = typeof o.activeWeek === 'string' && weekByKey(o.activeWeek) ? o.activeWeek : null;
  s.savedAt = isNum(o.savedAt) ? o.savedAt : null;
  const seenT = new Set();
  s.trash = (Array.isArray(o.trash) ? o.trash : []).map((x) => {
    const e = sanitizeShelf(x);
    if (!e) return null;
    return { ...e, id: typeof x.id === 'string' && x.id ? x.id.slice(0, 60) : `tr-${e.topicId}`, week: typeof x.week === 'string' && weekByKey(x.week) ? x.week : null };
  }).filter((x) => x && (seenT.has(x.id) ? false : seenT.add(x.id))).slice(0, 3000);
  const seenH = new Set();
  s.hiddenPosts = (Array.isArray(o.hiddenPosts) ? o.hiddenPosts : [])
    .map((x) => (obj(x) && ID_RE.test(String(x.id)) ? { id: String(x.id), week: typeof x.week === 'string' && weekByKey(x.week) ? x.week : null, at: isNum(x.at) ? x.at : null, topicName: str(x.topicName, 120) || '' } : null))
    .filter((x) => x && (seenH.has(x.id) ? false : seenH.add(x.id))).slice(0, 5000);
  for (const [id, x] of Object.entries(obj(o.genreOverrides) || {})) {
    const e = obj(x);
    if (!ID_RE.test(id) || !e || !GENRE_KEYS.includes(e.genre)) continue;
    s.genreOverrides[id] = { genre: e.genre, at: isNum(e.at) ? e.at : null, from: GENRE_KEYS.includes(e.from) ? e.from : null };
  }
  return { state: s, ok: true, reason: v > SCHEMA_VERSION ? '新しい版の保存データです（読める部分だけ読み込みました）' : undefined };
}

/** 保存用の JSON 文字列 */
export function serializeSaved(state, nowMs = null) {
  return JSON.stringify({ app: 'xtrend-show', ...state, v: SCHEMA_VERSION, savedAt: isNum(nowMs) ? nowMs : state.savedAt });
}

/** 容量不足のとき: 新しい番組週だけ残す（keepKey は必ず残す） */
export function pruneWeeks(state, keep, keepKey = null) {
  const keys = Object.keys(state.weeks).sort().reverse();
  const keepSet = new Set(keys.slice(0, keep));
  if (keepKey) keepSet.add(keepKey);
  const weeks = {};
  for (const k of keys) if (keepSet.has(k)) weeks[k] = state.weeks[k];
  // チェックポイントの id 一覧（容量が大きい）は最新週以外から削る
  for (const k of Object.keys(weeks)) {
    if (k === keepKey) continue;
    weeks[k] = { ...weeks[k], checkpoints: weeks[k].checkpoints.map(({ postIds, topicIds, ...c }) => c) };
  }
  return { ...state, weeks };
}

/** 番組週の状態（無ければ既定） */
export function getWeek(state, key) {
  return state.weeks[key] || defaultWeek();
}

/** 話題のスナップショット（来週に回すとき）。via: 'live'（進行で回した）/ 'plan'（編成で回した） */
export function carrySnapshot(topic, weekKey, script, via = 'live') {
  return {
    topicId: topic.kind === 'carried' ? topic.id.replace(/^k:/, '') : topic.id,
    name: topic.name,
    genre: topic.genre,
    postIds: [...topic.postIds],
    linkIds: topic.linkId ? [topic.linkId] : [...(topic.linkIds || [])],
    fromWeek: weekKey,
    points: (script && script.points) || '',
    via,
  };
}

const sameCarry = (c, topicId) => c.topicId === topicId || 'k:' + c.topicId === topicId;

/**
 * 進行の「来週に回す」を来週分の一覧に反映する。
 * liveIds（進行で来週へにした話題 id）に無い進行由来のものは消し、新しいものは足す。編成で回したものは残す。
 */
export function syncCarriedOut(list, topicsById, liveIds, weekKey, scriptMap = {}) {
  const ids = [...liveIds];
  const out = list.filter((c) => c.via === 'plan' || ids.some((id) => sameCarry(c, id)));
  for (const id of ids) {
    const t = topicsById.get(id);
    if (!t || out.some((c) => sameCarry(c, id))) continue;
    out.push(carrySnapshot(t, weekKey, scriptMap[id], 'live'));
  }
  return out;
}

/** 編成画面の「来週に回す」の切り替え */
export function togglePlanCarry(list, topic, weekKey, script) {
  if (list.some((c) => sameCarry(c, topic.id))) return list.filter((c) => !sameCarry(c, topic.id));
  return [...list, carrySnapshot(topic, weekKey, script, 'plan')];
}

export function isCarriedOut(list, topicId) {
  return (list || []).some((c) => sameCarry(c, topicId));
}

// ================================================================ 整理（片付け・削除）と元に戻す
// 用語: 配信で読んだもの＝「済」（進行）。編成の整理で候補から外す＝「片付け」（その週だけ）／「削除」（ゴミ箱。今後の週も出さない）。

function sanitizeShelf(x) {
  const o = obj(x);
  if (!o || typeof o.topicId !== 'string' || !o.topicId) return null;
  const c = obj(o.corner);
  return {
    topicId: o.topicId.slice(0, 200),
    name: str(o.name, 120) || '話題',
    genre: GENRE_KEYS.includes(o.genre) ? o.genre : 'night',
    postIds: (Array.isArray(o.postIds) ? o.postIds : []).filter((id) => typeof id === 'string' && ID_RE.test(id)).slice(0, 500),
    at: isNum(o.at) ? o.at : null,
    corner: c && cornerDef(c.key) && isNum(c.index) ? { key: c.key, index: Math.max(0, Math.floor(c.index)) } : null,
  };
}

function cornerPos(rundown, topicId) {
  for (const c of rundown.corners) {
    const i = c.items.indexOf(topicId);
    if (i >= 0) return { key: c.key, index: i };
  }
  return null;
}

function snapshot(topic, rundown, nowMs) {
  return {
    topicId: topic.id, name: topic.name, genre: topic.genre, postIds: [...topic.postIds],
    at: isNum(nowMs) ? nowMs : null, corner: cornerPos(rundown, topic.id),
  };
}

/** 元の枠に戻す（その枠に空きがあれば元の位置へ。無ければ戻さない＝候補に戻るだけ）。返り値: { rundown, placed } */
export function restoreToCorner(rundown, topicId, corner) {
  if (!corner || usedTopicIds(rundown).includes(topicId)) return { rundown, placed: false };
  const r = assignTopic(rundown, topicId, corner.key, corner.index);
  return r ? { rundown: r, placed: true } : { rundown, placed: false };
}

/** 片付け（この週だけ候補から外す）。構成に入っていれば外し、元の枠を覚えておく */
export function shelveTopic(week, topic, nowMs) {
  if (!topic || week.shelved.some((x) => x.topicId === topic.id)) return week;
  return { ...week, shelved: [...week.shelved, snapshot(topic, week.rundown, nowMs)], rundown: removeTopic(week.rundown, topic.id) };
}

/** 片付けを戻す。返り値: { week, placed } */
export function unshelveTopic(week, topicId) {
  const e = week.shelved.find((x) => x.topicId === topicId);
  if (!e) return { week, placed: false };
  const r = restoreToCorner(week.rundown, topicId, e.corner);
  return { week: { ...week, shelved: week.shelved.filter((x) => x !== e), rundown: r.rundown }, placed: r.placed };
}

/** 削除（ゴミ箱へ。今後の週にも同じ話題を出さない）。返り値: { saved, week } */
export function trashTopic(saved, week, topic, weekKey, nowMs) {
  if (!topic) return { saved, week };
  const id = `tr-${topic.id}-${isNum(nowMs) ? nowMs.toString(36) : 'x'}`;
  const entry = { ...snapshot(topic, week.rundown, nowMs), id, week: weekKey };
  return {
    saved: { ...saved, trash: [...saved.trash.filter((x) => x.topicId !== topic.id), entry] },
    week: { ...week, rundown: removeTopic(week.rundown, topic.id), shelved: week.shelved.filter((x) => x.topicId !== topic.id) },
  };
}

/** ゴミ箱から戻す（削除した週なら元の枠にも戻す）。返り値: { saved, week, placed } */
export function restoreTrash(saved, week, trashId, weekKey) {
  const e = saved.trash.find((x) => x.id === trashId);
  if (!e) return { saved, week, placed: false };
  const r = e.week === weekKey ? restoreToCorner(week.rundown, e.topicId, e.corner) : { rundown: week.rundown, placed: false };
  return { saved: { ...saved, trash: saved.trash.filter((x) => x !== e) }, week: { ...week, rundown: r.rundown }, placed: r.placed };
}

/**
 * 削除済みの話題か。同じ話題 id（辞書の話題・データ側の話題名は週をまたいで同じ id）か、
 * 話題の投稿がすべて削除した話題の投稿に含まれていれば削除済みとみなす（翌週以降も自動で出さない）。
 */
export function isTrashed(topic, trash) {
  if (!topic || !trash || !trash.length) return false;
  const ids = new Set(trash.map((x) => x.topicId));
  if (ids.has(topic.id) || (topic.kind === 'carried' && ids.has(topic.id.replace(/^k:/, '')))) return true;
  if (!topic.postIds.length || topic.kind === 'dict' || topic.kind === 'tag' || topic.kind === 'manual') return false;
  const posts = new Set(trash.flatMap((x) => x.postIds));
  return topic.postIds.every((id) => posts.has(id));
}

/** 候補に出す話題（片付け・削除を除く）と、片付け・削除の一覧 */
export function partitionTopics(topics, week, trash) {
  const shelf = new Set((week.shelved || []).map((x) => x.topicId));
  const visible = [];
  const shelved = [];
  const trashed = [];
  for (const t of topics) {
    if (isTrashed(t, trash)) trashed.push(t);
    else if (shelf.has(t.id)) shelved.push(t);
    else visible.push(t);
  }
  return { visible, shelved, trashed };
}

/** 投稿を削除（非表示）にする／戻す */
export function hidePost(saved, postId, weekKey, nowMs, topicName = '') {
  if (!ID_RE.test(String(postId)) || saved.hiddenPosts.some((x) => x.id === postId)) return saved;
  return { ...saved, hiddenPosts: [...saved.hiddenPosts, { id: String(postId), week: weekKey, at: isNum(nowMs) ? nowMs : null, topicName }] };
}
export function unhidePost(saved, postId) {
  return { ...saved, hiddenPosts: saved.hiddenPosts.filter((x) => x.id !== postId) };
}

// ================================================================ 振り返り・書き出し

/** 振り返りの一覧（読んだ／飛ばした／来週へ） */
export function reviewLists(live, cues) {
  const out = { done: [], skipped: [], carried: [], todo: [] };
  for (const c of cues) {
    const s = live.status[c.id];
    if (s === 'done') out.done.push(c);
    else if (s === 'skipped') out.skipped.push(c);
    else if (s === 'carried') out.carried.push(c);
    else out.todo.push(c);
  }
  return out;
}

function chapterTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

/**
 * 台本のテキスト書き出し。
 * mode: 'public'（告知・概要欄用：見出し・リード・チャプター・投稿URL）/ 'full'（話すポイント・質問・メモも）
 */
export function scriptText({ title, week, rundown, topicsById, script, notes, postsById, refTs, mode = 'public' }) {
  const lines = [title, `配信：${week ? formatJstShort(week.end) : UNKNOWN}〜（約${totalMinutes(rundown)}分）`];
  if (week) lines.push(`対象：${weekLabel(week)} の投稿`);
  lines.push('');
  if (mode === 'public') {
    lines.push('▼ チャプター');
    let t = 0;
    for (const c of rundown.corners) {
      const def = cornerDef(c.key);
      lines.push(`${chapterTime(t)} ${def.name}`);
      t += (c.min || 0) * 60;
    }
    lines.push('');
  }
  for (const c of rundown.corners) {
    const def = cornerDef(c.key);
    lines.push(`■ ${def.name}（${c.min}分）`);
    if (mode === 'full' && notes && notes[c.key]) lines.push(`  メモ：${notes[c.key]}`);
    let k = 0;
    for (const tid of c.items) {
      const t = topicsById.get(tid);
      if (!t) continue;
      k++;
      const sc = script[tid] || {};
      lines.push(`${k}. ${t.name}`);
      const lead = typeof sc.lead === 'string' && sc.lead.trim() ? sc.lead.trim() : leadText(t, postsById, refTs);
      lines.push(`   ${lead}`);
      if (mode === 'full') {
        if (sc.points) lines.push(`   話すポイント：${sc.points.replace(/\n/g, ' / ')}`);
        if (sc.question) lines.push(`   視聴者への質問：${sc.question}`);
      }
      const top = t.stats.topPostId || t.linkId;
      if (top) lines.push(`   ${statusUrl(top)}`);
    }
    lines.push('');
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}

/** 答え合わせ（reports.json weekly）から番組週と最も長く重なるものを選ぶ（重ならなければ最新） */
export function pickWeeklyReport(weekly, week) {
  if (!Array.isArray(weekly) || !weekly.length) return null;
  if (week) {
    let best = null;
    let bestLen = 0;
    for (const w of weekly) {
      const f = parseTimestamp(`${w.from} 00:00`);
      const t = parseTimestamp(`${w.to} 00:00`);
      if (f == null || t == null) continue;
      const len = Math.min(t + 86400, week.end) - Math.max(f, week.start);
      if (len > bestLen) { best = w; bestLen = len; }
    }
    if (best) return best;
  }
  return weekly[0];
}
