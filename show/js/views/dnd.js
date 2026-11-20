// ドラッグ＆ドロップ（pointer events で自作。HTML5 DnD に頼らない。マウス・タッチ両対応）。
// - マウス: 行を押したまま少し動かすと開始。タッチ: 行の「⋮⋮」つまみを押して動かすと開始（行の上ではスクロールできる）
// - ドロップ先は [data-drop] を持つ要素（フォルダの木・まとまりの行・並べ替え位置）。置けるときだけ強調表示
// - ドラッグ中は件数バッジつきの影を指に追従。Esc でキャンセル。一覧・木の端では自動スクロール
// かんたん編成（#plan）向けの追加（opts.ghost を渡したとき）:
// - つかんだカードの写し（opts.ghost）が指についてくる・元のカード（opts.source）は薄くなる
// - 並びの中（[data-drop-item="<キー>"][data-drop-index="<位置>"]）ではカードの上半分／下半分で「その前／後ろ」になり、入る位置に線を出す
// - 置けないときは理由、置けるときは opts.hint の文を指のそばに出す
// - 端に近づけたままでも自動スクロールが続く（[data-dnd-scroll] の箱）
// - 同じ要素に data-drop-alt があれば、そのキーも順に試す（投稿を話題のカードへ移す、など）
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
 *   whyNot(key, rows): 置けないときの理由（あれば、その上で灰色＋理由を出し、離したら onDenied）
 *   onDenied(message): 置けない所で離したとき
 *   handle: つまみから始めたか（タッチはつまみのみ）
 *   ghost(rows): つかんだカードの写し（要素）。渡すと「かんたん編成」の動き（入る位置の線・指のそばの文・続く自動スクロール）になる
 *   source: ドラッグ中に薄くする元の要素
 *   hint(key, rows): 置けるときに指のそばへ出す文
 *   kind: body の data-drag-kind に入れる（CSS で置き場所の見せ方を変える）
 * }
 */
export function beginPointer(e, opts) {
  if (active || (e.pointerType === 'mouse' && e.button !== 0)) return;
  if (e.pointerType !== 'mouse' && !opts.handle) return; // タッチ・ペンはつまみからだけ（行の上ではスクロール）
  const start = { x: e.clientX, y: e.clientY };
  const src = e.currentTarget;
  const st = { opts, start, src, dragging: false, ghost: null, over: null, rows: null, pointerId: e.pointerId, modern: typeof opts.ghost === 'function', key: null, last: start };
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
    st.last = { x: ev.clientX, y: ev.clientY };
    moveGhost(st, ev.clientX, ev.clientY);
    updateOver(st, ev.clientX, ev.clientY);
    if (!st.modern) autoScroll(ev.clientX, ev.clientY);
  };
  const up = (ev) => {
    if (ev.pointerId !== st.pointerId) return;
    cleanup();
    if (st.dragging) {
      const key = st.modern ? st.key : (st.over ? st.over.dataset.drop : null);
      const denied = st.denied;
      finish(st);
      if (key && st.opts.canDrop(key, st.rows)) st.opts.onDrop(key, st.rows);
      else if (denied && st.opts.onDenied) st.opts.onDenied(denied);
      // ドラッグ後のクリックは無視
      suppressClick();
      announceEnd();
    } else if (opts.onClick && ev.type === 'pointerup') {
      opts.onClick(ev);
    }
  };
  const key = (ev) => {
    if (ev.key === 'Escape' && st.dragging) { ev.preventDefault(); ev.stopPropagation(); cleanup(); finish(st); suppressClick(); announceEnd(); }
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
  if (st.modern) { startModern(st); return; }
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

/** かんたん編成: カードの写しを浮かせ、置ける場所を光らせる */
function startModern(st) {
  const { opts, src, start } = st;
  const srcEl = opts.source || src;
  const r = srcEl.getBoundingClientRect();
  const g = document.createElement('div');
  g.className = 'drag-lift';
  g.setAttribute('aria-hidden', 'true');
  g.style.width = `${Math.round(Math.min(r.width, 460))}px`;
  let copy = null;
  try { copy = opts.ghost(st.rows); } catch { copy = null; }
  if (copy) g.append(copy);
  // つかんだ所が指の下に来るように（写しが細くなったときは幅の中に収める）
  st.grab = { x: Math.max(12, Math.min(start.x - r.left, Math.min(r.width, 460) - 24)), y: Math.max(8, Math.min(start.y - r.top, r.height - 4)) };
  st.liftH = Math.min(r.height, 120);
  const tip = document.createElement('div');
  tip.className = 'drag-tip';
  tip.hidden = true;
  const line = document.createElement('div');
  line.className = 'drop-line';
  line.hidden = true;
  document.body.append(g, tip, line);
  st.ghost = g;
  st.tip = tip;
  st.line = line;
  st.srcEl = srcEl;
  srcEl.classList.add('is-drag-src');
  document.body.classList.add('is-dragging');
  if (opts.kind) document.body.dataset.dragKind = opts.kind;
  for (const el of document.querySelectorAll('[data-drop]')) if (opts.canDrop(el.dataset.drop, st.rows)) el.classList.add('is-drop-ok');
  const status = document.getElementById('drag-status');
  if (status) status.textContent = 'ドラッグ中。光っている所の上で離してください（Esc でやめる）';
  // 端に近づけたままでも送り続ける
  const loop = () => {
    if (active !== st || !st.dragging) return;
    if (autoScroll(st.last.x, st.last.y, true)) updateOver(st, st.last.x, st.last.y);
    st.raf = requestAnimationFrame(loop);
  };
  st.raf = requestAnimationFrame(loop);
}

function moveGhost(st, x, y) {
  if (!st.ghost) return;
  if (st.modern) {
    st.ghost.style.transform = `translate(${Math.round(x - st.grab.x)}px, ${Math.round(y - st.grab.y)}px) rotate(-2deg)`;
    // 文は写しのすぐ下（カードの字に重ならないように）
    if (st.tip) st.tip.style.transform = `translate(${Math.round(Math.max(4, Math.min(x - st.grab.x + 8, window.innerWidth - 300)))}px, ${Math.round(Math.min(y - st.grab.y + st.liftH + 10, window.innerHeight - 40))}px)`;
    return;
  }
  st.ghost.style.transform = `translate(${Math.round(x + 14)}px, ${Math.round(y + 12)}px)`;
}

/** かんたん編成: 指の下から外へたどり、最初に「置ける」場所を選ぶ（並びの中は前／後ろ） */
function updateModern(st, x, y) {
  const { opts } = st;
  const hide = [st.ghost, st.tip, st.line];
  for (const n of hide) if (n) n.style.visibility = 'hidden';
  const el = document.elementFromPoint(x, y);
  for (const n of hide) if (n) n.style.visibility = '';
  let found = null; // { el, key, item, after }
  let firstWhy = null; // { el, why }
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    if (!n.dataset) continue;
    const cands = [];
    if (n.dataset.dropItem != null) {
      const r = n.getBoundingClientRect();
      const after = y > r.top + r.height / 2;
      cands.push({ key: `${n.dataset.dropItem}#${Number(n.dataset.dropIndex) + (after ? 1 : 0)}`, item: true, after });
    }
    if (n.dataset.drop != null) cands.push({ key: n.dataset.drop });
    if (n.dataset.dropAlt != null) cands.push({ key: n.dataset.dropAlt });
    for (const c of cands) {
      if (opts.canDrop(c.key, st.rows)) { found = { el: n, ...c }; break; }
      if (!firstWhy && opts.whyNot) { const why = opts.whyNot(c.key, st.rows); if (why) firstWhy = { el: n, why }; }
    }
    if (found) break;
  }
  const why = !found && firstWhy ? firstWhy.why : null;
  if (st.noEl && st.noEl !== (why ? firstWhy.el : null)) { st.noEl.classList.remove('is-drop-no'); st.noEl = null; }
  if (why) { firstWhy.el.classList.add('is-drop-no'); st.noEl = firstWhy.el; }
  st.denied = why;
  st.key = found ? found.key : null;
  const over = found ? found.el : null;
  if (over !== st.over) {
    if (st.over) st.over.classList.remove('is-drop-over');
    st.over = over;
  }
  if (over) over.classList.toggle('is-drop-over', !found.item);
  // 入る位置の線（カードとカードの間）
  if (found && found.item) {
    const r = found.el.getBoundingClientRect();
    const gap = 4;
    st.line.hidden = false;
    st.line.style.width = `${Math.round(r.width)}px`;
    st.line.style.transform = `translate(${Math.round(r.left)}px, ${Math.round((found.after ? r.bottom + gap : r.top - gap) - 2)}px)`;
  } else st.line.hidden = true;
  const text = why ? `入れられません：${why}` : (found && opts.hint ? opts.hint(found.key, st.rows) : '');
  st.tip.hidden = !text;
  st.tip.textContent = text || '';
  st.tip.classList.toggle('is-no', Boolean(why));
  st.ghost.classList.toggle('is-no', Boolean(why));
  st.ghost.classList.toggle('is-over', Boolean(found));
}

function updateOver(st, x, y) {
  if (st.modern) { updateModern(st, x, y); return; }
  if (st.ghost) st.ghost.style.visibility = 'hidden';
  const el = document.elementFromPoint(x, y);
  if (st.ghost) st.ghost.style.visibility = '';
  let target = el ? el.closest('[data-drop]') : null;
  // 置けない所: 灰色にして理由を出す（離したら onDenied）
  const raw = target;
  if (target && !st.opts.canDrop(target.dataset.drop, st.rows)) target = null;
  const why = !target && raw && st.opts.whyNot ? st.opts.whyNot(raw.dataset.drop, st.rows) : null;
  if (st.noEl && st.noEl !== raw) { st.noEl.classList.remove('is-drop-no'); st.noEl = null; }
  st.denied = why || null;
  if (why && raw) { raw.classList.add('is-drop-no'); st.noEl = raw; }
  if (st.ghost) {
    const lab = st.ghost.querySelector('.drag-label');
    if (lab) lab.textContent = why ? `入れられません：${why}` : st.opts.label(st.rows);
    st.ghost.classList.toggle('is-no', Boolean(why));
  }
  if (target === st.over) return;
  if (st.over) st.over.classList.remove('is-drop-over');
  st.over = target;
  if (target) target.classList.add('is-drop-over');
  if (st.ghost) st.ghost.classList.toggle('is-over', Boolean(target));
}

function finish(st) {
  if (st.over) st.over.classList.remove('is-drop-over');
  if (st.noEl) st.noEl.classList.remove('is-drop-no');
  for (const el of document.querySelectorAll('.is-drop-ok')) el.classList.remove('is-drop-ok');
  if (st.ghost) st.ghost.remove();
  if (st.tip) st.tip.remove();
  if (st.line) st.line.remove();
  if (st.srcEl) st.srcEl.classList.remove('is-drag-src');
  if (st.raf) cancelAnimationFrame(st.raf);
  st.dragging = false;
  document.body.classList.remove('is-dragging');
  delete document.body.dataset.dragKind;
  const status = document.getElementById('drag-status');
  if (status) status.textContent = '';
}

/** ドラッグ中に止めていた描き直しを再開する合図（show.js が聞く） */
function announceEnd() {
  try { document.dispatchEvent(new CustomEvent('xt-drag-end')); } catch { /* 無視 */ }
}

function suppressClick() {
  const stop = (e) => { e.stopPropagation(); e.preventDefault(); };
  window.addEventListener('click', stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 0);
}

/** 一覧・木の端に近づいたら自動でスクロール。動かしたら true。boxOnly: 箱（[data-dnd-scroll] など）の中だけ */
function autoScroll(x, y, boxOnly = false) {
  const el = document.elementFromPoint(x, y);
  let box = el ? el.closest('.vlist, .tree, [data-dnd-scroll]') : null;
  // 箱が中でスクロールしない（狭い画面でページごとスクロールする）ときは画面ごと
  if (box && boxOnly && box.scrollHeight <= box.clientHeight + 1) box = null;
  if (!box) {
    const before = window.scrollY;
    // 一覧の箱が無い画面（進行など）は画面ごと
    if (y < 70) window.scrollBy(0, boxOnly ? -10 : -14);
    else if (y > window.innerHeight - (boxOnly ? 90 : 130)) window.scrollBy(0, boxOnly ? 10 : 14);
    return boxOnly && window.scrollY !== before;
  }
  const r = box.getBoundingClientRect();
  const edge = boxOnly ? 56 : 36;
  const before = box.scrollTop;
  if (y < r.top + edge) box.scrollTop -= boxOnly ? 10 : 14;
  else if (y > r.bottom - edge) box.scrollTop += boxOnly ? 10 : 14;
  return box.scrollTop !== before;
}
