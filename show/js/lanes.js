// 流れるコメントの列（レーン）の割り当て。DOM 非依存（node:test から import）。
// すべてのコメントは同じ速さ（画面の幅 ÷ speed 秒）で右から左へ流れるので、前のコメントの「お尻」が画面に入り、
// さらに LANE_GAP だけ進んだら次を同じ列に出せる（追いつかない）。空いている列を上から選び、空きが無ければ待たせる。
// 固定コメントが出ている間は、その箱と高さが重なる列には新しいコメントを入れない（流れているものはそのまま裏を通る）。

export const LANE_GAP = 40;
export const STAGE_W = 1920;
export const QUEUE_MAX = 40;

/** i 番目の列の上端（y） */
export function laneY(cfg, i) {
  return cfg.top + i * cfg.laneH;
}

/** rect（{ y, h }。固定コメントの箱）と高さが重なる列の番号 */
export function lanesOverlapping(cfg, rect) {
  const out = [];
  if (!rect || !(rect.h > 0) || !Number.isFinite(rect.y)) return out;
  for (let i = 0; i < cfg.lanes; i++) {
    const y = laneY(cfg, i);
    if (y < rect.y + rect.h && rect.y < y + cfg.laneH) out.push(i);
  }
  return out;
}

/** 速さ（px/ms） */
export function pxPerMs(cfg, stageW = STAGE_W) {
  return stageW / (Math.max(0.5, cfg.speed) * 1000);
}
/** 幅 width のコメントが右端から左端の外まで流れきる時間（ms） */
export function travelMs(width, cfg, stageW = STAGE_W) {
  return Math.round((stageW + Math.max(0, width)) / pxPerMs(cfg, stageW));
}
/** 同じ列に次を出せるまでの時間（ms）。動きを減らす設定（calm）では表示している間ずっと */
export function laneBusyMs(width, cfg, { calm = false, stageW = STAGE_W } = {}) {
  if (calm) return Math.round(Math.max(0.5, cfg.speed) * 1000);
  return Math.ceil((Math.max(0, width) + LANE_GAP) / pxPerMs(cfg, stageW));
}

/**
 * 列の空き具合と待ち行列。
 * enqueue(item) → あふれて捨てた古いもの（配列）／take(now, blocked) → { item, lane } か null／occupy(lane, until, id)／
 * release(id, now)（消したコメントがその列の最後なら空ける）／remove(id)（待ち行列から外す）／clear()／resize(n)
 */
export function createLaneScheduler({ lanes = 4, queueMax = QUEUE_MAX } = {}) {
  let free = Array(Math.max(1, lanes)).fill(0);
  let lastId = Array(free.length).fill(null);
  const queue = [];
  const pickLane = (now, blocked) => {
    const b = new Set(blocked || []);
    for (let i = 0; i < free.length; i++) if (!b.has(i) && free[i] <= now) return i;
    return -1;
  };
  return {
    get lanes() { return free.length; },
    get queued() { return queue.length; },
    resize(n) {
      const m = Math.max(1, n);
      free = Array.from({ length: m }, (_, i) => free[i] || 0);
      lastId = Array.from({ length: m }, (_, i) => lastId[i] || null);
    },
    enqueue(item) {
      queue.push(item);
      const dropped = [];
      while (queue.length > queueMax) dropped.push(queue.shift());
      return dropped;
    },
    pickLane,
    take(now, blocked) {
      if (!queue.length) return null;
      const lane = pickLane(now, blocked);
      if (lane < 0) return null;
      return { item: queue.shift(), lane };
    },
    occupy(lane, until, id = null) {
      if (lane < 0 || lane >= free.length) return;
      free[lane] = Math.max(free[lane], until);
      lastId[lane] = id;
    },
    release(id, now) {
      const i = lastId.indexOf(id);
      if (i >= 0) { free[i] = Math.min(free[i], now); lastId[i] = null; }
    },
    remove(id) {
      const i = queue.findIndex((x) => x && x.id === id);
      if (i >= 0) queue.splice(i, 1);
      return i >= 0;
    },
    clear() { queue.length = 0; },
    state() { return { free: [...free], queue: queue.map((x) => x && x.id) }; },
  };
}
