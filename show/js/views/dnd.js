// ドラッグ＆ドロップ（pointer events で自作。HTML5 DnD に頼らない。マウス・タッチ両対応）。
// - マウス: 行を押したまま少し動かすと開始。タッチ: 行の「⋮⋮」つまみを押して動かすと開始（行の上ではスクロールできる）
// - ドロップ先は [data-drop] を持つ要素（フォルダの木・まとまりの行・並べ替え位置）。置けるときだけ強調表示
// - ドラッグ中は件数バッジつきの影を指に追従。Esc でキャンセル。一覧・木の端では自動スクロール
import { PLAN_V2 } from '../config.js';

let active = null;

/**
 * 行の pointerdown から呼ぶ。
 * opts: {
 *   getRows(): ドラッグする行（選択中の行、または押した行）
 *   label(rows): 影に出す文字
 *   canDrop(key, rows): そこに置けるか
 *   onDrop(key, rows): 置いたとき
 *   onClick(e): 動かさずに離したとき（クリック扱い）
 *   handle: つまみから始めたか（タッチはつまみのみ）
 * }
 */
export function beginPointer(e, opts) {
  if (active || (e.pointerType === 'mouse' && e.button !== 0)) return;
  if (e.pointerType !== 'mouse' && !opts.handle) return; // タッチ・ペンはつまみからだけ（行の上ではスクロール）
  const start = { x: e.clientX, y: e.clientY };
  const src = e.currentTarget;
  const st = { opts, start, src, dragging: false, ghost: null, over: null, rows: null, pointerId: e.pointerId };
  active = st;
  try { src.setPointerCapture(e.pointerId); } catch { /* 無視 */ }
  const move = (ev) => {
    if (ev.pointerId !== st.pointerId) return;
    if (!st.dragging) {
      const d = Math.hypot(ev.clientX - start.x, ev.clientY - start.y);
      if (d < (opts.handle ? 2 : PLAN_V2.dragThreshold)) return;
      startDragging(st);
    }
    ev.preventDefault();
    moveGhost(st, ev.clientX, ev.clientY);
    updateOver(st, ev.clientX, ev.clientY);
    autoScroll(ev.clientX, ev.clientY);
  };
  const up = (ev) => {
    if (ev.pointerId !== st.pointerId) return;
    cleanup();
    if (st.dragging) {
      const key = st.over ? st.over.dataset.drop : null;
      finish(st);
      if (key && st.opts.canDrop(key, st.rows)) st.opts.onDrop(key, st.rows);
      // ドラッグ後のクリックは無視
      suppressClick();
    } else if (opts.onClick && ev.type === 'pointerup') {
      opts.onClick(ev);
    }
  };
  const key = (ev) => {
    if (ev.key === 'Escape' && st.dragging) { ev.preventDefault(); ev.stopPropagation(); cleanup(); finish(st); suppressClick(); }
  };
  const cleanup = () => {
    src.removeEventListener('pointermove', move);
    src.removeEventListener('pointerup', up);
    src.removeEventListener('pointercancel', up);
    window.removeEventListener('keydown', key, true);
    try { src.releasePointerCapture(st.pointerId); } catch { /* 無視 */ }
    active = null;
  };
  src.addEventListener('pointermove', move);
  src.addEventListener('pointerup', up);
  src.addEventListener('pointercancel', up);
  window.addEventListener('keydown', key, true);
}

export function isDragging() {
  return Boolean(active && active.dragging);
}

function startDragging(st) {
  st.dragging = true;
  st.rows = st.opts.getRows();
  const g = document.createElement('div');
  g.className = 'drag-ghost';
  g.setAttribute('aria-hidden', 'true');
  const badge = document.createElement('span');
  badge.className = 'drag-count';
  badge.textContent = `${st.rows.length}件`;
  const label = document.createElement('span');
  label.className = 'drag-label';
  label.textContent = st.opts.label(st.rows);
  g.append(badge, label);
  document.body.append(g);
  st.ghost = g;
  document.body.classList.add('is-dragging');
  // 置けるフォルダを薄く示す
  for (const el of document.querySelectorAll('[data-drop]')) if (st.opts.canDrop(el.dataset.drop, st.rows)) el.classList.add('is-drop-ok');
  const status = document.getElementById('drag-status');
  if (status) status.textContent = `${st.rows.length}件をドラッグ中。置きたいフォルダの上で離してください（Esc でやめる）`;
}

function moveGhost(st, x, y) {
  if (st.ghost) st.ghost.style.transform = `translate(${Math.round(x + 14)}px, ${Math.round(y + 12)}px)`;
}

function updateOver(st, x, y) {
  if (st.ghost) st.ghost.style.visibility = 'hidden';
  const el = document.elementFromPoint(x, y);
  if (st.ghost) st.ghost.style.visibility = '';
  let target = el ? el.closest('[data-drop]') : null;
  if (target && !st.opts.canDrop(target.dataset.drop, st.rows)) target = null;
  if (target === st.over) return;
  if (st.over) st.over.classList.remove('is-drop-over');
  st.over = target;
  if (target) target.classList.add('is-drop-over');
  if (st.ghost) st.ghost.classList.toggle('is-over', Boolean(target));
}

function finish(st) {
  if (st.over) st.over.classList.remove('is-drop-over');
  for (const el of document.querySelectorAll('.is-drop-ok')) el.classList.remove('is-drop-ok');
  if (st.ghost) st.ghost.remove();
  document.body.classList.remove('is-dragging');
  const status = document.getElementById('drag-status');
  if (status) status.textContent = '';
}

function suppressClick() {
  const stop = (e) => { e.stopPropagation(); e.preventDefault(); };
  window.addEventListener('click', stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 0);
}

/** 一覧・木の端に近づいたら自動でスクロール */
function autoScroll(x, y) {
  const el = document.elementFromPoint(x, y);
  const box = el ? el.closest('.vlist, .tree') : null;
  if (!box) return;
  const r = box.getBoundingClientRect();
  const edge = 36;
  if (y < r.top + edge) box.scrollTop -= 14;
  else if (y > r.bottom - edge) box.scrollTop += 14;
}
