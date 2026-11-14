// レイアウト調整の幾何計算（show/js/layoutgeo.js）の単体テスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampRect, moveRect, resizeRect, snapValue, snapTargets, snapMove, snapResize, nudgeDelta, HANDLES, CANVAS } from '../show/js/layoutgeo.js';

test('画面の中に収める・最小の大きさ・整数・壊れた値は既定', () => {
  assert.deepEqual(clampRect({ x: -20, y: 1070, w: 300.4, h: 50.6 }), { x: 0, y: 1029, w: 300, h: 51 });
  assert.deepEqual(clampRect({ x: 10, y: 10, w: 5000, h: 5000 }), { x: 0, y: 0, w: 1920, h: 1080 });
  assert.deepEqual(clampRect({ x: 10, y: 10, w: 5, h: 5 }, { minW: 200, minH: 30 }), { x: 10, y: 10, w: 200, h: 30 });
  assert.deepEqual(clampRect({ x: 'a', y: null, w: undefined, h: '' }, { minW: 10, minH: 10 }, { x: 1, y: 2, w: 300, h: 40 }), { x: 1, y: 2, w: 300, h: 40 });
  assert.deepEqual(clampRect(null, { minW: 10, minH: 10 }, { x: 5, y: 5, w: 20, h: 20 }), { x: 5, y: 5, w: 20, h: 20 });
});

test('動かす: 大きさはそのまま・端で止まる', () => {
  const r = { x: 100, y: 600, w: 1000, h: 200 };
  assert.deepEqual(moveRect(r, 50, -20), { x: 150, y: 580, w: 1000, h: 200 });
  assert.deepEqual(moveRect(r, 5000, 5000), { x: 920, y: 880, w: 1000, h: 200 });
  assert.deepEqual(moveRect(r, -5000, -5000), { x: 0, y: 0, w: 1000, h: 200 });
  assert.deepEqual(moveRect({ x: 0, y: 0, w: 1920, h: 248 }, 30, 0), { x: 0, y: 0, w: 1920, h: 248 }, '全幅は横に動かない');
});

test('つまみで大きさ: 反対側の辺は動かない・最小で止まる・端で止まる（8 つのつまみ）', () => {
  const r = { x: 100, y: 600, w: 1000, h: 200 };
  const o = { minW: 200, minH: 30 };
  assert.deepEqual(resizeRect(r, 'e', 50, 0, o), { x: 100, y: 600, w: 1050, h: 200 });
  assert.deepEqual(resizeRect(r, 'w', 50, 0, o), { x: 150, y: 600, w: 950, h: 200 });
  assert.deepEqual(resizeRect(r, 's', 0, 40, o), { x: 100, y: 600, w: 1000, h: 240 });
  assert.deepEqual(resizeRect(r, 'n', 0, -40, o), { x: 100, y: 560, w: 1000, h: 240 });
  assert.deepEqual(resizeRect(r, 'se', 10, 10, o), { x: 100, y: 600, w: 1010, h: 210 });
  assert.deepEqual(resizeRect(r, 'nw', -10, -10, o), { x: 90, y: 590, w: 1010, h: 210 });
  assert.deepEqual(resizeRect(r, 'ne', 10, -10, o), { x: 100, y: 590, w: 1010, h: 210 });
  assert.deepEqual(resizeRect(r, 'sw', -10, 10, o), { x: 90, y: 600, w: 1010, h: 210 });
  // 最小
  assert.deepEqual(resizeRect(r, 'w', 2000, 0, o), { x: 900, y: 600, w: 200, h: 200 });
  assert.deepEqual(resizeRect(r, 'n', 0, 2000, o), { x: 100, y: 770, w: 1000, h: 30 });
  // 端
  assert.deepEqual(resizeRect(r, 'e', 5000, 0, o), { x: 100, y: 600, w: 1820, h: 200 });
  assert.deepEqual(resizeRect(r, 'nw', -5000, -5000, o), { x: 0, y: 0, w: 1100, h: 800 });
  assert.deepEqual(resizeRect(r, 's', 0, 5000, o), { x: 100, y: 600, w: 1000, h: 480 });
  assert.equal(HANDLES.length, 8);
});

test('そろえる: 近くの目標（端・枠の辺）→ 無ければ 10px ごと', () => {
  assert.equal(snapValue(123), 120);
  assert.equal(snapValue(126), 130);
  assert.equal(snapValue(912, { targets: [915] }), 915, '8px 以内の目標');
  assert.equal(snapValue(905, { targets: [915] }), 910, '遠ければ grid');
  assert.equal(snapValue(5, { grid: 1 }), 5);
  const t = snapTargets([{ x: 670, y: 915, w: 1230, h: 142 }]);
  assert.ok(t.xs.includes(0) && t.xs.includes(1920) && t.xs.includes(670) && t.xs.includes(1900));
  assert.ok(t.ys.includes(0) && t.ys.includes(1080) && t.ys.includes(915) && t.ys.includes(1057));
  // 下の辺がトピック帯の上の辺（915）にそろう
  assert.deepEqual(snapMove({ x: 3, y: 660, w: 1920, h: 250 }, t), { x: 0, y: 665, w: 1920, h: 250 });
  // 左の辺が 670 にそろう（右の辺は遠い）
  assert.deepEqual(snapMove({ x: 664, y: 603, w: 500, h: 160 }, t), { x: 670, y: 600, w: 500, h: 160 });
  // 大きさ: 動かした辺だけ
  assert.deepEqual(snapResize({ x: 13, y: 660, w: 1000, h: 252 }, 's', t), { x: 13, y: 660, w: 1000, h: 255 });
  assert.deepEqual(snapResize({ x: 13, y: 660, w: 1000, h: 252 }, 'w', t, { minW: 200 }), { x: 10, y: 660, w: 1003, h: 252 });
  assert.deepEqual(snapResize({ x: 100, y: 100, w: 205, h: 50 }, 'e', { xs: [], ys: [] }, { minW: 200 }), { x: 100, y: 100, w: 210, h: 50 });
});

test('矢印キー: 1px・Shift で 10px', () => {
  assert.deepEqual(nudgeDelta('ArrowLeft'), [-1, 0]);
  assert.deepEqual(nudgeDelta('ArrowDown', true), [0, 10]);
  assert.equal(nudgeDelta('a'), null);
  assert.deepEqual(CANVAS, { w: 1920, h: 1080 });
});
