// 段階3: Grok ボットの話題まとめ（data/show/topics.json）を読む。DOM 非依存（node:test から import される）。
// すべて任意: ファイルが無い・壊れている・項目が欠けていても、読める分だけ使い、読めなければ null（従来どおり）。
//
// 形: { generated_at, week: { from, to }, topics: [{ id, name, genre, post_ids, summary, confidence }] }
//  - id は週をまたいでも同じ話題なら同じ値。サイトでは話題 id を「g:<id>」にする（持ち越し・削除の判定に使う）
//  - genre はカテゴリ名（ホスト／キャバクラ／歌舞伎町／夜職その他／その他）。その他＝一般のバズ。ジャンルキーも可
//  - summary はリード文の既定値（ユーザーが書き換えたらそちら）。confidence は 0〜1（不明は null）

import { BOT, GENRE_KEYS } from './config.js';
import { genreOfCategory } from './logic.js';

const ID_RE = /^\d{5,25}$/;
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f]/g;

const text = (v, max) => (typeof v === 'string' ? v.replace(CTRL, ' ').trim().slice(0, max) : '');

/** ボットのジャンル（カテゴリ名かキー）→ ジャンルキー。分からなければ null */
export function botGenre(g) {
  if (typeof g !== 'string') return null;
  const s = g.trim();
  if (GENRE_KEYS.includes(s)) return s;
  return genreOfCategory(s);
}

/** 話題 id（サイト側）。ボットの id → 'g:<id>' */
export const botTopicId = (id) => `g:${id}`;

/** topics.json を読む。使える話題が 1 つも無くても形が正しければ { topics: [] }。形が違えば null */
export function normalizeBotTopics(raw, opts = {}) {
  const low = typeof opts.lowConfidence === 'number' ? opts.lowConfidence : BOT.lowConfidence;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.topics)) return null;
  const seen = new Set();
  const topics = [];
  for (const t of raw.topics.slice(0, BOT.maxTopics)) {
    if (!t || typeof t !== 'object') continue;
    const id = text(t.id, 100);
    if (!id || seen.has(id)) continue;
    const postIds = [];
    for (const x of Array.isArray(t.post_ids) ? t.post_ids.slice(0, BOT.maxPostsPerTopic) : []) {
      const s = typeof x === 'string' ? x.trim() : (Number.isSafeInteger(x) ? String(x) : '');
      if (ID_RE.test(s) && !postIds.includes(s)) postIds.push(s);
    }
    if (!postIds.length) continue;
    seen.add(id);
    const c = typeof t.confidence === 'number' && Number.isFinite(t.confidence) ? Math.min(1, Math.max(0, t.confidence)) : null;
    topics.push({
      id,
      name: text(t.name, 80) || null,
      genre: botGenre(t.genre),
      postIds,
      summary: text(t.summary, 600) || null,
      confidence: c,
      low: c != null && c < low,
    });
  }
  const week = raw.week && typeof raw.week === 'object' ? { from: text(raw.week.from, 40) || null, to: text(raw.week.to, 40) || null } : null;
  return { generatedAt: text(raw.generated_at, 40) || null, week, topics };
}
