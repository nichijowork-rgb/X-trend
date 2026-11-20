// 投稿を開く専用ウィンドウ（名前付きポップアップ。毎回同じウィンドウを使い回す）。
// 位置と大きさは設定（localStorage）。Chrome の Window Management API（window.getScreenDetails）が使えれば、表示する画面（モニター）を選べる。
// 計算部分は DOM 非依存（node:test から import される）。

export const VIEWER_NAME = 'xtrend-viewer';
export const VIEWER_PREF_KEY = 'xtrend-show-viewer';
export const VIEWER_PRESETS = Object.freeze([
  Object.freeze({ key: 'center', label: '中央' }),
  Object.freeze({ key: 'right', label: '右半分' }),
  Object.freeze({ key: 'left', label: '左半分' }),
  Object.freeze({ key: 'full', label: '全体' }),
  Object.freeze({ key: 'custom', label: '数値で指定' }),
]);
const PRESET_KEYS = VIEWER_PRESETS.map((x) => x.key);
/** 右半分・左半分・全体のときの大きさ（その範囲に対する %。範囲の真ん中に置く）。2026-11-21 オーナー: 70% くらいで真ん中に */
export const VIEWER_SCALES = Object.freeze([50, 60, 70, 80, 90, 100]);
export const VIEWER_SCALE_DEFAULT = 70;
/** 設定の版。2: 「進行で投稿をクリックしたら開く」を既定オンに（それより前に保存した設定もオンにする。2026-11-21 オーナー） */
export const VIEWER_PREFS_VERSION = 2;

const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : d);

/** 画面（モニター）の情報（保存できる形）。availLeft/Top/Width/Height と名前 */
export function screenSnapshot(s, i = 0) {
  if (!s) return null;
  const w = num(s.availWidth, 200, 20000, null);
  const h = num(s.availHeight, 200, 20000, null);
  if (!w || !h) return null;
  return { label: String(s.label || `画面 ${i + 1}`).slice(0, 80), left: num(s.availLeft ?? s.left, -40000, 40000, 0), top: num(s.availTop ?? s.top, -40000, 40000, 0), width: w, height: h, primary: Boolean(s.isPrimary) };
}

export function defaultViewerPrefs() {
  return { preset: 'right', left: 960, top: 0, width: 640, height: 900, scale: VIEWER_SCALE_DEFAULT, screen: null, catcher: true, openOnClick: true, v: VIEWER_PREFS_VERSION };
}

/** 保存した設定を読む（壊れていれば既定） */
export function parseViewerPrefs(raw) {
  let o = null;
  try { o = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { o = null; }
  const d = defaultViewerPrefs();
  if (!o || typeof o !== 'object') return d;
  return {
    preset: PRESET_KEYS.includes(o.preset) ? o.preset : d.preset,
    left: num(o.left, -40000, 40000, d.left),
    top: num(o.top, -40000, 40000, d.top),
    width: num(o.width, 250, 20000, d.width),
    height: num(o.height, 200, 20000, d.height),
    scale: num(o.scale, 30, 100, d.scale),
    screen: o.screen ? screenSnapshot({ ...o.screen, availLeft: o.screen.left, availTop: o.screen.top, availWidth: o.screen.width, availHeight: o.screen.height, isPrimary: o.screen.primary }) : null,
    catcher: o.catcher !== false,
    // 版 2 より前の保存（既定オフだったころ）はオンにする
    openOnClick: Number(o.v) >= VIEWER_PREFS_VERSION ? o.openOnClick === true : true,
    v: VIEWER_PREFS_VERSION,
  };
}

/**
 * ウィンドウの位置と大きさ。prefs.preset が数値指定なら prefs の値、それ以外は画面（prefs.screen か fallbackScreen）に合わせる。
 * 中央＝幅 640（画面の 9 割まで）・高さ 画面の 9 割。
 * 右半分・左半分・全体＝その範囲（画面の半分・画面全体）の scale %（既定 70%）の大きさで、範囲の真ん中に置く
 */
export function viewerRect(prefs, fallbackScreen = null) {
  const p = parseViewerPrefs(prefs);
  if (p.preset === 'custom') return { left: p.left, top: p.top, width: p.width, height: p.height };
  const s = p.screen || screenSnapshot(fallbackScreen) || { left: 0, top: 0, width: 1920, height: 1080 };
  if (p.preset === 'full' || p.preset === 'left' || p.preset === 'right') {
    const half = Math.floor(s.width / 2);
    const area = p.preset === 'full' ? { left: s.left, width: s.width }
      : { left: p.preset === 'left' ? s.left : s.left + s.width - half, width: half };
    const k = p.scale / 100;
    const w = Math.max(250, Math.floor(area.width * k));
    const h = Math.max(200, Math.floor(s.height * k));
    return { left: area.left + Math.floor((area.width - w) / 2), top: s.top + Math.floor((s.height - h) / 2), width: w, height: h };
  }
  const w = Math.min(640, Math.floor(s.width * 0.9));
  const h = Math.floor(s.height * 0.9);
  return { left: s.left + Math.floor((s.width - w) / 2), top: s.top + Math.floor((s.height - h) / 2), width: w, height: h };
}

/** window.open の 3 つ目の引数 */
export function viewerFeatures(rect) {
  return `popup,left=${rect.left},top=${rect.top},width=${rect.width},height=${rect.height}`;
}

/** X の投稿 URL か（専用ウィンドウで開く対象） */
export function isXUrl(href) {
  return typeof href === 'string' && /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\//.test(href);
}

/**
 * 専用ウィンドウで開く（ブラウザのみ）。返り値: true（開けた）/ false（ポップアップがブロックされた）
 * すでに開いているウィンドウは同じ名前で使い回し、位置・大きさも合わせ直す
 */
export function openViewer(url, prefs, win = window) {
  const rect = viewerRect(prefs, win.screen);
  let w = null;
  try { w = win.open(url, VIEWER_NAME, viewerFeatures(rect)); } catch { w = null; }
  if (!w) return false;
  try { w.moveTo(rect.left, rect.top); w.resizeTo(rect.width, rect.height); } catch { /* 動かせないブラウザもある */ }
  try { w.focus(); } catch { /* 無視 */ }
  return true;
}
