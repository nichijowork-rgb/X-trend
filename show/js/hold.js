// 保留する言葉（YouTuber 関連など）。DOM 非依存（node:test から import される）。
// 本文・アカウント・話題名に言葉が一致した投稿・話題は、編成画面で「保留」フォルダへ入れ、候補・おすすめ・受信箱・仕分けモードに出さない。
// 手で番組構成（メイン1〜3・メイン候補・カテゴリ別・雑談）に入れた話題・手で作ったまとまり・移動した投稿・自分で追加した投稿・
// 持ち越しの話題は保留しない（手作業が優先）。戻した投稿・話題（holdExceptions）も保留しない。

import { normalizeForMatch, containsWord } from './logic.js';

/** 言葉の一覧を照合用に（空・重複を除く） */
export function prepareHoldTerms(terms) {
  const seen = new Set();
  const out = [];
  for (const t of terms || []) {
    if (typeof t !== 'string') continue;
    const term = t.trim();
    const norm = normalizeForMatch(term);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push({ term, norm });
  }
  return out;
}

/** 文字列のどれかに一致した最初の言葉（元の表記）。無ければ null */
export function matchHoldTerm(texts, prepared) {
  if (!prepared.length) return null;
  const hays = texts.filter((x) => typeof x === 'string' && x).map(normalizeForMatch);
  for (const p of prepared) if (hays.some((h) => containsWord(h, p.norm))) return p.term;
  return null;
}

/** 投稿が一致する言葉（本文・@アカウント） */
export function postHoldTerm(post, prepared) {
  if (!post) return null;
  return matchHoldTerm([post.text, post.user ? `@${post.user}` : ''], prepared);
}

/**
 * 保留する投稿（1 回目の話題づくりの結果から決める）。
 * input: { posts, topics, prepared, exceptions: Set, protectedTopicIds: Set, protectedPostIds: Set }
 * 返り値: Map（投稿 id → 一致した言葉）
 */
export function heldPostsOf(input) {
  const { posts = [], topics = [], prepared = [], exceptions = new Set(), protectedTopicIds = new Set(), protectedPostIds = new Set() } = input;
  const out = new Map();
  if (!prepared.length) return out;
  const safe = new Set(protectedPostIds);
  for (const t of topics) if (protectedTopicIds.has(t.id) || t.kind === 'manual' || t.kind === 'carried') for (const id of t.postIds) safe.add(id);
  for (const p of posts) {
    if (!p || safe.has(p.id) || exceptions.has(p.id) || out.has(p.id)) continue;
    const term = postHoldTerm(p, prepared);
    if (term) out.set(p.id, term);
  }
  return out;
}

/** 話題名が一致して保留する話題（手で置いた・作った・持ち越し・戻した話題は除く）。Map（話題 id → 言葉） */
export function heldTopicsOf(topics, prepared, exceptions = new Set(), protectedTopicIds = new Set()) {
  const out = new Map();
  if (!prepared.length) return out;
  for (const t of topics) {
    if (protectedTopicIds.has(t.id) || exceptions.has(t.id) || t.kind === 'manual' || t.kind === 'carried') continue;
    const term = matchHoldTerm([t.name], prepared);
    if (term) out.set(t.id, term);
  }
  return out;
}

/** 言葉を外す（大文字小文字・全角半角の違いも同じ言葉として外す） */
export function removeHoldTerm(terms, term) {
  const n = normalizeForMatch(String(term || '').trim());
  return (terms || []).filter((t) => normalizeForMatch(String(t).trim()) !== n);
}

/** 入力（「、」・改行区切り）→ 言葉の一覧（1 語 40 字・200 語まで） */
export function parseHoldTerms(text) {
  return prepareHoldTerms(String(text || '').split(/[,、，\n]/).map((x) => x.trim().slice(0, 40))).map((x) => x.term).slice(0, 200);
}
