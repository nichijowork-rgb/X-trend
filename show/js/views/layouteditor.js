// レイアウト（「触りながら調整」）: ［コメント］ページの中で、流れるコメントの帯と固定コメントの箱を 1920×1080 の縮図の上でドラッグして決める。
// 動かすとすぐ OBS に反映（100ms ごとまで）・自動で保存（400ms あと）。元に戻す／やり直す（Ctrl+Z／Ctrl+Shift+Z）・既定に戻す（確かめてから）。
// 見本は本物のオーバーレイ（overlay.html?part=comments&preview=1）を iframe で重ね、今の設定を postMessage で送る。
// 「OBS にも見本を出す」（既定オフ。配信中にも使うため）がオンなら、見本のコメント・固定を OBS にも出す（取りまとめ役のウィンドウが送る）。
// このパネルはページを開いたときに 1 回だけ作り（data-keep-leaf の入れ物に入れる）、ドラッグ中も画面全体は描き直さない。文字はすべて textContent。
import { h, btn } from '../dom.js';
import { LAYOUT_GUIDE } from '../overlayinfo.js';
import { CHAT_CFG_DEFAULTS, CHAT_CFG_LIMITS, sanitizeChatCfg, clampPinBox, buildChatMessage, demoChatPin, pinBoxHeight, laneHeightOf } from '../ytchat.js';
import { CANVAS, HANDLES, moveRect, resizeRect, snapMove, snapResize, snapTargets, nudgeDelta, clampRect } from '../layoutgeo.js';
import { checkImageFile, decodeImage, shrinkImage, canvasEncoder } from '../imaging.js';

const BG_KEY = 'xtrend-show-layout-bg';
const UI_KEY = 'xtrend-show-layout-ui';
/** 参考の枠（ほかのツールと、この番組サイトの投稿カード・トピック帯） */
const REFS = LAYOUT_GUIDE.filter((g) => !g.ours || g.key === 'card' || g.key === 'topicbar');

function loadUi() {
  try { const o = JSON.parse(localStorage.getItem(UI_KEY) || '{}'); return { snap: o.snap !== false, refs: o.refs !== false }; } catch { return { snap: true, refs: true }; }
}
function saveUi(ui) {
  try { localStorage.setItem(UI_KEY, JSON.stringify({ snap: ui.snap, refs: ui.refs })); } catch { /* 保存できなくても動く */ }
}
function loadBg() {
  try { const s = localStorage.getItem(BG_KEY); return s && /^data:image\/(jpeg|png|webp);base64,/.test(s) ? s : null; } catch { return null; }
}

/** ページの入れ物（data-keep-leaf）。中身は mountLayoutEditor が 1 回だけ作る */
export function layoutHolder() {
  return h('section', { class: 'cmp-layout-col', attrs: { 'aria-label': 'レイアウト（流れる範囲・固定コメント）' }, dataset: { keep: 'cmp-layout', keepLeaf: '', key: 'cmp-layout' } });
}
/** 描いたあとに呼ぶ: 入れ物が空なら作る */
export function mountLayoutEditor(app) {
  const holder = document.querySelector('[data-key="cmp-layout"]');
  if (!holder || holder.firstElementChild) return;
  holder.append(layoutEditor(app));
}

const layoutOf = (app) => ({ ...sanitizeChatCfg({ ...app.chatPrefs.layout, flow: true }) });

/** レイアウトのパネル（ページの中に置く） */
export function layoutEditor(app) {
  if (!app.ui.le) app.ui.le = { sel: 'pin', past: [], future: [] };
  const le = app.ui.le;
  const ui = { ...loadUi(), bg: loadBg(), scale: 0.5, pinH: pinBoxHeight(layoutOf(app).pin), seq: 0, dragging: false, lastRec: 0, confirm: false };
  const d = () => layoutOf(app);
  const dlg = h('div', { class: 'le-root', attrs: { role: 'region', 'aria-labelledby': 'le-title' }, dataset: { key: 'le-root' } });

  // ---- 縮図（1920×1080 の舞台を枠いっぱいに縮小）
  const wrap = h('div', { class: 'le-wrap', dataset: { key: 'le-wrap' } });
  const stage = h('div', { class: 'le-stage', dataset: { key: 'le-stage' } });
  const bgImg = h('img', { class: 'le-bg', alt: '', hidden: !ui.bg, dataset: { key: 'le-bg' } });
  if (ui.bg) bgImg.src = ui.bg;
  const refs = h('div', { class: 'le-refs', hidden: !ui.refs });
  for (const g of REFS) {
    const b = h('div', { class: `le-ref${g.ours ? ' is-ours' : ''}` }, h('span', {}, g.label));
    Object.assign(b.style, { left: `${g.x}px`, top: `${g.y}px`, width: `${g.w}px`, height: `${g.h}px` });
    refs.append(b);
  }
  const frame = h('iframe', { class: 'le-frame', src: new URL('overlay.html?part=comments&preview=1', location.href).toString(), title: '流れるコメントの見本', dataset: { key: 'le-frame' }, attrs: { tabindex: '-1', 'aria-hidden': 'true' } });
  const band = h('div', { class: 'le-obj le-band', dataset: { key: 'le-band', obj: 'band' }, attrs: { tabindex: '0', role: 'group', 'aria-label': '流れる範囲（ドラッグで移動、つまみで大きさ、矢印キーで 1px・Shift で 10px）' } });
  const lanesBox = h('div', { class: 'le-lanes' });
  const bandLabel = h('span', { class: 'le-label' });
  band.append(lanesBox, bandLabel);
  for (const k of HANDLES) band.append(h('span', { class: `le-h le-h-${k}`, dataset: { handle: k, key: `le-handle-band-${k}` } }));
  const pin = h('div', { class: 'le-obj le-pin', dataset: { key: 'le-pin', obj: 'pin' }, attrs: { tabindex: '0', role: 'group', 'aria-label': '固定コメント（ドラッグで移動、左右のつまみで幅、矢印キーで 1px・Shift で 10px）' } });
  const pinLabel = h('span', { class: 'le-label' });
  pin.append(pinLabel);
  for (const k of ['w', 'e']) pin.append(h('span', { class: `le-h le-h-${k}`, dataset: { handle: k, key: `le-handle-pin-${k}` } }));
  stage.append(bgImg, refs, frame, band, pin);
  wrap.append(stage);

  // ---- 数値（読み取り・入力）
  const numIn = (key, label, min, max, step = 1) => {
    const input = h('input', { class: 'input input-sm le-num', type: 'number', min, max, step, dataset: { key } , attrs: { 'aria-label': label } });
    return [h('label', { class: 'le-field' }, h('span', {}, label), input), input];
  };
  const [bxF, bx] = numIn('le-band-x', 'x', 0, 1920);
  const [byF, by] = numIn('le-band-y', 'y', 0, 1080);
  const [bwF, bw] = numIn('le-band-w', '幅', CHAT_CFG_LIMITS.bandMinW, 1920);
  const [bhF, bh] = numIn('le-band-h', '高さ', CHAT_CFG_LIMITS.bandMinH, 1080);
  const lanesOut = h('output', { class: 'le-out', dataset: { key: 'le-lanes' } });
  const size = h('input', { type: 'range', min: CHAT_CFG_LIMITS.size[0], max: CHAT_CFG_LIMITS.size[1], step: 1, dataset: { key: 'le-size' }, attrs: { 'aria-label': '流れる文字の大きさ' } });
  const sizeOut = h('output', { class: 'le-out' });
  const speed = h('input', { type: 'range', min: CHAT_CFG_LIMITS.speed[0], max: CHAT_CFG_LIMITS.speed[1], step: 0.5, dataset: { key: 'le-speed' }, attrs: { 'aria-label': '速さ（帯を横切る秒数）' } });
  const speedOut = h('output', { class: 'le-out' });
  const [pxF, px] = numIn('le-pin-x', 'x', 0, 1920);
  const [pyF, py] = numIn('le-pin-y', 'y', 0, 1080);
  const [pwF, pw] = numIn('le-pin-w', '幅', CHAT_CFG_LIMITS.pinMinW, 1920);
  const psize = h('input', { type: 'range', min: CHAT_CFG_LIMITS.pinSize[0], max: CHAT_CFG_LIMITS.pinSize[1], step: 1, dataset: { key: 'le-pin-size' }, attrs: { 'aria-label': '固定コメントの文字の大きさ' } });
  const psizeOut = h('output', { class: 'le-out' });
  const plines = h('select', { class: 'input input-sm', dataset: { key: 'le-pin-lines' }, attrs: { 'aria-label': '固定コメントの行数' } },
    ...[1, 2, 3].map((n) => h('option', { value: String(n) }, `${n} 行まで`)));

  const targets = (except) => {
    const boxes = REFS.slice();
    if (except !== 'band') boxes.push(d().band);
    if (except !== 'pin') boxes.push({ x: d().pin.x, y: d().pin.y, w: d().pin.w, h: ui.pinH });
    return snapTargets(boxes);
  };

  // ---- 反映（DOM を直接更新・見本と OBS へ送る）
  let postRaf = 0;
  function postFrame() {
    if (postRaf) return;
    postRaf = requestAnimationFrame(() => {
      postRaf = 0;
      try {
        const msg = buildChatMessage({ sid: 'editor', seq: ++ui.seq, at: Date.now(), pin: demoChatPin(0), cfg: { ...d(), flow: true } });
        frame.contentWindow.postMessage(msg, location.origin);
      } catch { /* 読み込み前 */ }
      // 固定コメントの実際の高さ（見本の中で測る）
      requestAnimationFrame(() => {
        try {
          const el = frame.contentDocument && frame.contentDocument.querySelector('.cm-pin');
          if (el && !el.hidden && el.offsetHeight > 0 && Math.abs(el.offsetHeight - ui.pinH) > 0.5) { ui.pinH = el.offsetHeight; paint(false); }
        } catch { /* 無視 */ }
      });
    });
  }
  function setVal(input, v) { if (document.activeElement !== input) input.value = String(v); }
  function paint(send = true) {
    const c = d();
    const b = c.band;
    Object.assign(band.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` });
    while (lanesBox.firstChild) lanesBox.firstChild.remove();
    const lh = laneHeightOf(c);
    for (let i = 1; i < c.lanes; i++) { const line = h('span', { class: 'le-lane' }); line.style.top = `${Math.round(i * lh)}px`; lanesBox.append(line); }
    bandLabel.textContent = `流れる範囲　${b.x}, ${b.y}　${b.w}×${b.h}・${c.lanes} 列（1 列 ${Math.round(lh)}px）`;
    const p = c.pin;
    Object.assign(pin.style, { left: `${p.x}px`, top: `${p.y}px`, width: `${p.w}px`, height: `${ui.pinH}px` });
    pinLabel.textContent = `固定コメント　${p.x}, ${p.y}　幅 ${p.w}`;
    band.classList.toggle('is-sel', le.sel === 'band');
    pin.classList.toggle('is-sel', le.sel === 'pin');
    setVal(bx, b.x); setVal(by, b.y); setVal(bw, b.w); setVal(bh, b.h);
    lanesOut.textContent = `${c.lanes} 列（1 列 ${Math.round(lh)}px）`;
    setVal(size, c.size); sizeOut.textContent = `${c.size}px`;
    setVal(speed, c.speed); speedOut.textContent = `${c.speed} 秒`;
    setVal(px, p.x); setVal(py, p.y); setVal(pw, p.w);
    setVal(psize, p.size); psizeOut.textContent = `${p.size}px`;
    setVal(plines, p.lines);
    for (const [k, b2] of Object.entries(selBtns)) b2.setAttribute('aria-pressed', String(le.sel === k));
    if (send) postFrame();
  }
  /** 設定を差し替え（範囲に丸める）→ すぐ OBS へ・自動で保存 */
  function commit(next) {
    const c = sanitizeChatCfg({ ...d(), ...next, flow: true });
    // 固定コメントは実際の高さで画面の中に
    const r = clampRect({ x: c.pin.x, y: c.pin.y, w: c.pin.w, h: ui.pinH }, { minW: CHAT_CFG_LIMITS.pinMinW, minH: 1 });
    c.pin = clampPinBox({ ...c.pin, x: r.x, y: r.y, w: r.w });
    app.chatLayoutSet(c);
    setSaved('保存中…');
    paint();
  }
  // ---- 元に戻す／やり直す（ドラッグ 1 回・数値 1 回・続けて動かしたスライダーや矢印キーは 0.6 秒の間をまとめて 1 回）
  const snap = () => JSON.stringify(d());
  function record(force = false) {
    const now = Date.now();
    if (!force && now - ui.lastRec < 600) { ui.lastRec = now; return; }
    ui.lastRec = now;
    const cur = snap();
    if (le.past[le.past.length - 1] !== cur) le.past.push(cur);
    if (le.past.length > 100) le.past.shift();
    le.future = [];
    updHist();
  }
  function restore(json) {
    try { const c = JSON.parse(json); app.chatLayoutSet(c); ui.pinH = pinBoxHeight(sanitizeChatCfg(c).pin); setSaved('保存中…'); paint(); } catch { /* 無視 */ }
  }
  function undo() { if (!le.past.length) return; le.future.push(snap()); restore(le.past.pop()); updHist(); }
  function redo() { if (!le.future.length) return; le.past.push(snap()); restore(le.future.pop()); updHist(); }
  function updHist() { undoBtn.disabled = !le.past.length; redoBtn.disabled = !le.future.length; }
  function setSaved(t) { savedOut.textContent = t; }

  // ---- ドラッグ（pointer events。マウス・タッチ・ペン）
  function startDrag(e, obj, handle) {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    le.sel = obj;
    const el = obj === 'band' ? band : pin;
    el.focus({ preventScroll: true });
    const start = obj === 'band' ? { ...d().band } : { x: d().pin.x, y: d().pin.y, w: d().pin.w, h: ui.pinH };
    const sx = e.clientX;
    const sy = e.clientY;
    const tg = targets(obj);
    const minW = obj === 'band' ? CHAT_CFG_LIMITS.bandMinW : CHAT_CFG_LIMITS.pinMinW;
    const minH = obj === 'band' ? Math.max(CHAT_CFG_LIMITS.bandMinH, d().lanes * CHAT_CFG_LIMITS.laneMinH) : ui.pinH;
    try { e.target.setPointerCapture(e.pointerId); } catch { /* 無視 */ }
    stage.classList.add('is-dragging');
    ui.dragging = true;
    record(true);
    const move = (ev) => {
      const dx = (ev.clientX - sx) / ui.scale;
      const dy = (ev.clientY - sy) / ui.scale;
      let r = handle ? resizeRect(start, handle, dx, dy, { minW, minH }) : moveRect(start, dx, dy);
      if (ui.snap) r = handle ? snapResize(r, handle, tg, { minW, minH }) : snapMove(r, tg);
      if (obj === 'band') commit({ band: r });
      else commit({ pin: { ...d().pin, x: r.x, y: r.y, w: r.w } });
    };
    const up = () => {
      ui.dragging = false;
      e.target.removeEventListener('pointermove', move);
      e.target.removeEventListener('pointerup', up);
      e.target.removeEventListener('pointercancel', up);
      stage.classList.remove('is-dragging');
    };
    e.target.addEventListener('pointermove', move);
    e.target.addEventListener('pointerup', up);
    e.target.addEventListener('pointercancel', up);
  }
  for (const [el, obj] of [[band, 'band'], [pin, 'pin']]) {
    el.addEventListener('pointerdown', (e) => startDrag(e, obj, e.target.dataset && e.target.dataset.handle ? e.target.dataset.handle : null));
    el.addEventListener('focus', () => { if (le.sel !== obj) { le.sel = obj; paint(false); } });
    el.style.touchAction = 'none';
  }
  // 矢印キーで 1px（Shift で 10px）
  dlg.addEventListener('keydown', (e) => {
    const t = e.target;
    // Ctrl+Z 元に戻す／Ctrl+Shift+Z・Ctrl+Y やり直す（入力欄の中では文字の取り消しを優先）
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !(t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && t.type !== 'range' && t.type !== 'checkbox')) {
      if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); redo(); return; }
    }
    if (!t || !t.dataset || !t.dataset.obj) return;
    const dv = nudgeDelta(e.key, e.shiftKey);
    if (!dv) return;
    e.preventDefault();
    record();
    if (t.dataset.obj === 'band') commit({ band: moveRect(d().band, dv[0], dv[1]) });
    else commit({ pin: { ...d().pin, x: d().pin.x + dv[0], y: d().pin.y + dv[1] } });
  });

  // ---- 数値の入力
  const onNum = (input, fn) => input.addEventListener('change', () => { const v = Number(input.value); if (Number.isFinite(v)) { record(true); fn(v); } else paint(false); });
  onNum(bx, (v) => commit({ band: { ...d().band, x: v } }));
  onNum(by, (v) => commit({ band: { ...d().band, y: v } }));
  onNum(bw, (v) => commit({ band: { ...d().band, w: v } }));
  onNum(bh, (v) => commit({ band: { ...d().band, h: v } }));
  onNum(px, (v) => commit({ pin: { ...d().pin, x: v } }));
  onNum(py, (v) => commit({ pin: { ...d().pin, y: v } }));
  onNum(pw, (v) => commit({ pin: { ...d().pin, w: v } }));
  size.addEventListener('input', () => { record(); commit({ size: Number(size.value) }); });
  speed.addEventListener('input', () => { record(); commit({ speed: Number(speed.value) }); });
  psize.addEventListener('input', () => { record(); commit({ pin: { ...d().pin, size: Number(psize.value) } }); });
  plines.addEventListener('change', () => { record(true); commit({ pin: { ...d().pin, lines: Number(plines.value) } }); });
  const lanesBtn = (delta, label, key) => btn(label, () => {
    const n = Math.max(CHAT_CFG_LIMITS.lanes[0], Math.min(CHAT_CFG_LIMITS.lanes[1], d().lanes + delta));
    // 列を増やして 1 列が細くなりすぎるときは帯を高くする
    const b = { ...d().band, h: Math.max(d().band.h, n * CHAT_CFG_LIMITS.laneMinH) };
    record(true);
    commit({ lanes: n, band: b });
  }, 'btn btn-small le-step', { 'data-key': key, 'aria-label': label === '−' ? '列を減らす' : '列を増やす' });

  // ---- 上の操作
  const selBtns = {
    band: btn('流れる範囲', () => { le.sel = 'band'; band.focus({ preventScroll: true }); paint(false); }, 'btn btn-small le-sel', { 'data-key': 'le-sel-band' }),
    pin: btn('固定コメント', () => { le.sel = 'pin'; pin.focus({ preventScroll: true }); paint(false); }, 'btn btn-small le-sel', { 'data-key': 'le-sel-pin' }),
  };
  const check = (key, label, on, fn, title) => {
    const c = h('input', { type: 'checkbox', checked: on, dataset: { key } });
    c.addEventListener('change', () => fn(c.checked));
    return h('label', { class: 'check-line le-check', attrs: { title } }, c, h('span', {}, label));
  };
  const pv = app.chatPreviewState();
  const file = h('input', { type: 'file', accept: 'image/*', class: 'sr-only', id: 'le-bg-file', dataset: { key: 'le-bg-file' } });
  const bgMsg = h('span', { class: 'le-msg', attrs: { role: 'status' }, dataset: { key: 'le-bg-msg' } });
  async function setBg(f) {
    const why = checkImageFile(f);
    if (why) { bgMsg.textContent = why; return; }
    try {
      const img = await decodeImage(f);
      const out = await shrinkImage({ w: img.w, h: img.h, type: 'image/jpeg' }, { maxSide: 1280, maxBytes: 450 * 1000 }, canvasEncoder(img.source, 'dataurl'));
      ui.bg = out.data;
      bgImg.src = ui.bg;
      bgImg.hidden = false;
      try { localStorage.setItem(BG_KEY, ui.bg); bgMsg.textContent = '背景を置きました（このブラウザにだけ保存。どこにも送りません）'; } catch { bgMsg.textContent = '背景を置きました（大きいので保存はしません。閉じると消えます）'; }
    } catch (err) { bgMsg.textContent = (err && err.message) || '画像を読めませんでした'; }
  }
  file.addEventListener('change', () => { const f = file.files && file.files[0]; file.value = ''; if (f) setBg(f); });
  dlg.addEventListener('paste', (e) => {
    const f = [...((e.clipboardData && e.clipboardData.files) || [])].find((x) => /^image\//.test(x.type));
    if (!f) return;
    e.preventDefault();
    setBg(f);
  });
  const clearBg = btn('背景を消す', () => { ui.bg = null; bgImg.hidden = true; bgImg.removeAttribute('src'); try { localStorage.removeItem(BG_KEY); } catch { /* 無視 */ } bgMsg.textContent = ''; }, 'btn btn-small btn-ghost-dark', { 'data-key': 'le-bg-clear' });

  const undoBtn = btn('↶ 元に戻す', () => undo(), 'btn btn-small btn-ghost-dark', { 'data-key': 'le-undo', title: '元に戻す（Ctrl+Z）', disabled: !le.past.length });
  const redoBtn = btn('↷ やり直す', () => redo(), 'btn btn-small btn-ghost-dark', { 'data-key': 'le-redo', title: 'やり直す（Ctrl+Shift+Z）', disabled: !le.future.length });
  const savedOut = h('span', { class: 'le-saved', attrs: { role: 'status' }, dataset: { key: 'le-saved' } }, '変えるとすぐ OBS に出て、自動で保存されます');
  app.onLayoutSaved = () => setSaved('自動で保存しました');
  const confirmBox = h('span', { class: 'le-confirm', hidden: true, dataset: { key: 'le-confirm' } },
    h('span', {}, '既定（帯 0,660 1920×248・4 列／固定 655,600 幅 1170）に戻しますか？'),
    btn('戻す', () => { confirmBox.hidden = true; defBtn.hidden = false; record(true); const c = sanitizeChatCfg(CHAT_CFG_DEFAULTS); ui.pinH = pinBoxHeight(c.pin); commit(c); }, 'btn btn-small btn-red', { 'data-key': 'le-default-yes' }),
    btn('やめる', () => { confirmBox.hidden = true; defBtn.hidden = false; }, 'btn btn-small btn-ghost-dark', { 'data-key': 'le-default-no' }));
  const defBtn = btn('既定に戻す', () => { confirmBox.hidden = false; defBtn.hidden = true; }, 'btn btn-small btn-ghost-dark', { 'data-key': 'le-default' });
  dlg.append(
    h('header', { class: 'le-head' },
      h('h2', { id: 'le-title' }, 'レイアウト', h('span', { class: 'le-sub' }, '（1920×1080。ドラッグで移動、つまみで大きさ、矢印キーで 1px・Shift で 10px）')),
      h('div', { class: 'le-acts' }, undoBtn, redoBtn, defBtn, confirmBox),
      savedOut),
    h('div', { class: 'le-tools' },
      h('span', { class: 'le-seg', attrs: { role: 'group', 'aria-label': '選ぶもの' } }, selBtns.band, selBtns.pin),
      check('le-snap', 'ぴったり合わせる（10px・端・枠）', ui.snap, (v) => { ui.snap = v; saveUi(ui); }, 'ドラッグしたとき 10px ごと・画面の端・参考の枠の辺にそろえます'),
      check('le-refs', '参考の枠', ui.refs, (v) => { ui.refs = v; refs.hidden = !v; saveUi(ui); }, 'どね貯金・LINE・イラスト・トピック帯・投稿カードの場所を薄く表示'),
      check('le-obs', 'OBS にも見本を出す', Boolean(pv && pv.obs), (v) => app.chatPreviewObs(v), '見本のコメントと見本の固定を OBS（とこのブラウザで開いたパーツ）にも出します。配信中は本物のコメントがあるので、ふだんはオフ。オフにすると本物の固定・流れ方にすぐ戻ります'),
      h('label', { class: 'btn btn-small btn-ghost-dark', attrs: { for: 'le-bg-file', title: '配信画面のスクショを背景に置きます（貼り付け Ctrl+V でも。このブラウザにだけ保存）' } }, '背景にスクショ…'), file, clearBg, bgMsg),
    wrap,
    h('div', { class: 'le-panels' },
      h('fieldset', { class: 'le-box' }, h('legend', {}, '流れる範囲'),
        h('div', { class: 'le-row' }, bxF, byF, bwF, bhF),
        h('div', { class: 'le-row' }, h('span', { class: 'le-field' }, h('span', {}, '列'), lanesBtn(-1, '−', 'le-lanes-minus'), lanesOut, lanesBtn(1, '＋', 'le-lanes-plus'))),
        h('div', { class: 'le-row' }, h('label', { class: 'le-field le-slider' }, h('span', {}, '文字'), size, sizeOut), h('label', { class: 'le-field le-slider' }, h('span', {}, '速さ'), speed, speedOut))),
      h('fieldset', { class: 'le-box' }, h('legend', {}, '固定コメント'),
        h('div', { class: 'le-row' }, pxF, pyF, pwF),
        h('div', { class: 'le-row' }, h('label', { class: 'le-field le-slider' }, h('span', {}, '文字'), psize, psizeOut), h('label', { class: 'le-field' }, h('span', {}, '行数'), plines)),
        h('p', { class: 'muted le-note' }, '高さは中身（名前と本文の行数）で決まります。固定中は、箱と重なる列に新しいコメントを流しません。'))));

  // 縮尺（枠の幅 ÷ 1920）。画面の大きさが変わったら付け直す
  const fit = () => {
    const w = wrap.clientWidth;
    if (!w) return;
    ui.scale = w / CANVAS.w;
    stage.style.transform = `scale(${ui.scale})`;
    stage.style.setProperty('--le-inv', String(1 / ui.scale));
    wrap.style.height = `${Math.round(CANVAS.h * ui.scale)}px`;
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(fit).observe(wrap);
  requestAnimationFrame(fit);
  frame.addEventListener('load', () => postFrame());
  app.layoutEditorState = () => ({ scale: ui.scale, pinH: ui.pinH, draft: d(), past: le.past.length, future: le.future.length });
  // ほかのウィンドウが変えたとき（ドラッグ中は描き直さない）
  app.refreshLayoutEditor = () => { if (!ui.dragging && dlg.isConnected) paint(false); postFrame(); };
  paint(false);
  requestAnimationFrame(() => { fit(); paint(false); });
  return dlg;
}
