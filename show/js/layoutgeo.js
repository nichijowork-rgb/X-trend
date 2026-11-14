// レイアウト調整（流れるコメントの帯・固定コメントの箱）の幾何計算。DOM 非依存（node:test から import）。
// 座標はすべて配信画面 1920×1080 の px。矩形は { x, y, w, h }。

export const CANVAS = Object.freeze({ w: 1920, h: 1080 });
export const GRID = 10;
export const SNAP_TOL = 8;
export const HANDLES = Object.freeze(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']);

const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);

/** 画面の中に収め、最小の大きさを守る（整数に丸める） */
export function clampRect(r, { minW = 1, minH = 1, W = CANVAS.w, H = CANVAS.h } = {}, def = { x: 0, y: 0, w: minW, h: minH }) {
  const src = r && typeof r === 'object' ? r : {};
  let w = Math.round(Math.min(W, Math.max(minW, num(src.w, def.w))));
  let h = Math.round(Math.min(H, Math.max(minH, num(src.h, def.h))));
  w = Math.max(Math.min(minW, W), w);
  h = Math.max(Math.min(minH, H), h);
  const x = Math.round(Math.min(W - w, Math.max(0, num(src.x, def.x))));
  const y = Math.round(Math.min(H - h, Math.max(0, num(src.y, def.y))));
  return { x, y, w, h };
}

/** 動かす（画面からはみ出さない） */
export function moveRect(r, dx, dy, bounds = {}) {
  return clampRect({ ...r, x: r.x + dx, y: r.y + dy }, { minW: 1, minH: 1, ...bounds }, r);
}

/**
 * つまみ（nw n ne e se s sw w）で大きさを変える。反対側の辺は動かさない。最小の大きさ・画面の端で止まる。
 * opts: { minW, minH, W, H }
 */
export function resizeRect(r, handle, dx, dy, opts = {}) {
  const { minW = 1, minH = 1, W = CANVAS.w, H = CANVAS.h } = opts;
  let { x, y } = r;
  let x2 = r.x + r.w;
  let y2 = r.y + r.h;
  if (handle.includes('w')) x = Math.min(x2 - minW, Math.max(0, r.x + dx));
  if (handle.includes('e')) x2 = Math.max(x + minW, Math.min(W, x2 + dx));
  if (handle.includes('n')) y = Math.min(y2 - minH, Math.max(0, r.y + dy));
  if (handle.includes('s')) y2 = Math.max(y + minH, Math.min(H, y2 + dy));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(x2 - x), h: Math.round(y2 - y) };
}

/** 値を、近くの目標（端など）か、無ければ grid の倍数にそろえる */
export function snapValue(v, { grid = GRID, targets = [], tol = SNAP_TOL } = {}) {
  let best = null;
  for (const t of targets) {
    const d = Math.abs(t - v);
    if (d <= tol && (best == null || d < Math.abs(best - v))) best = t;
  }
  if (best != null) return best;
  return grid > 1 ? Math.round(v / grid) * grid : v;
}

/** 目標の線（画面の端・参考の箱の辺）: { xs, ys } */
export function snapTargets(boxes = [], { W = CANVAS.w, H = CANVAS.h } = {}) {
  const xs = new Set([0, W]);
  const ys = new Set([0, H]);
  for (const b of boxes) {
    if (!b) continue;
    xs.add(b.x); xs.add(b.x + b.w);
    ys.add(b.y); ys.add(b.y + b.h);
  }
  return { xs: [...xs], ys: [...ys] };
}

/** 動かした矩形をそろえる（左右・上下の辺のうち、近い目標にそろう方。無ければ左上を grid に） */
export function snapMove(r, targets, { grid = GRID, tol = SNAP_TOL, W = CANVAS.w, H = CANVAS.h } = {}) {
  const pick = (a, len, list) => {
    let best = null;
    for (const t of list) {
      for (const edge of [a, a + len]) {
        const d = t - edge;
        if (Math.abs(d) <= tol && (best == null || Math.abs(d) < Math.abs(best))) best = d;
      }
    }
    return best != null ? a + best : Math.round(a / grid) * grid;
  };
  const x = pick(r.x, r.w, targets.xs || []);
  const y = pick(r.y, r.h, targets.ys || []);
  return clampRect({ ...r, x, y }, { minW: 1, minH: 1, W, H }, r);
}

/** 大きさを変えた矩形をそろえる（動かした辺だけ） */
export function snapResize(r, handle, targets, { grid = GRID, tol = SNAP_TOL, minW = 1, minH = 1, W = CANVAS.w, H = CANVAS.h } = {}) {
  let x = r.x;
  let y = r.y;
  let x2 = r.x + r.w;
  let y2 = r.y + r.h;
  const o = { grid, tol };
  if (handle.includes('w')) x = Math.min(x2 - minW, snapValue(x, { ...o, targets: targets.xs }));
  if (handle.includes('e')) x2 = Math.max(x + minW, snapValue(x2, { ...o, targets: targets.xs }));
  if (handle.includes('n')) y = Math.min(y2 - minH, snapValue(y, { ...o, targets: targets.ys }));
  if (handle.includes('s')) y2 = Math.max(y + minH, snapValue(y2, { ...o, targets: targets.ys }));
  return clampRect({ x, y, w: x2 - x, h: y2 - y }, { minW, minH, W, H }, r);
}

/** 矢印キーで 1px（Shift で 10px）動かす量 */
export function nudgeDelta(key, shift = false) {
  const s = shift ? 10 : 1;
  return { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] }[key] || null;
}
