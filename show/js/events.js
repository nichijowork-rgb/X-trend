// 進行状態の変化を 1 か所から発行する（段階2で OBS WebSocket へ流すための口）。
// 発行するもの: 現在のコーナー・現在の話題・投稿カードの表示/非表示（と、その時点の進行状態のまとめ）。
// 受け取り方: onShowEvent(fn) か、window の 'xtrend-show' イベント（detail に同じもの）。
// DOM 非依存の部分（liveSnapshot / diffSnapshot）は node:test から使える。

import { cornerDef } from './logic.js';

const listeners = new Set();
let last = null;
export const eventLog = []; // 直近の発行（デバッグ・E2E 用。最大 50 件）

/** 進行状態のまとめ（OBS 側が必要とする最小限） */
export function liveSnapshot({ weekKey, live, cues, topicsById }) {
  const cue = cues[live.index] || null;
  const topic = cue && cue.kind === 'topic' ? topicsById.get(cue.topicId) : null;
  return {
    week: weekKey,
    started: live.startedAt != null,
    finished: !cue && cues.length > 0,
    index: live.index,
    total: cues.length,
    cueId: cue ? cue.id : null,
    corner: cue ? { key: cue.cornerKey, name: cornerDef(cue.cornerKey).name } : null,
    topic: topic ? { id: topic.id, name: topic.name, genre: topic.genre, n: cue.n, of: cue.of } : null,
    postId: topic ? (topic.stats.topPostId || topic.linkId || null) : null,
    cardVisible: live.cardVisible !== false,
  };
}

/** 前回との違い（'corner' | 'topic' | 'card' | 'progress'） */
export function diffSnapshot(prev, next) {
  if (!prev) return ['corner', 'topic', 'card', 'progress'];
  const out = [];
  if ((prev.corner && prev.corner.key) !== (next.corner && next.corner.key) || prev.week !== next.week) out.push('corner');
  if ((prev.topic && prev.topic.id) !== (next.topic && next.topic.id) || prev.cueId !== next.cueId) out.push('topic');
  if (prev.cardVisible !== next.cardVisible || prev.postId !== next.postId) out.push('card');
  if (prev.index !== next.index || prev.started !== next.started || prev.finished !== next.finished || prev.total !== next.total) out.push('progress');
  return out;
}

export function onShowEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 状態が変わったときだけ発行する（変わっていなければ何もしない） */
export function publishLiveState(input) {
  const snap = liveSnapshot(input);
  const changed = diffSnapshot(last, snap);
  last = snap;
  if (!changed.length) return null;
  const evt = { type: 'live-state', changed, state: snap, at: Date.now() };
  eventLog.push(evt);
  if (eventLog.length > 50) eventLog.shift();
  for (const fn of listeners) { try { fn(evt); } catch { /* 受け手の失敗は無視 */ } }
  try { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('xtrend-show', { detail: evt })); } catch { /* 無視 */ }
  return evt;
}

/** テスト用 */
export function resetLiveEvents() {
  last = null;
  eventLog.length = 0;
}
