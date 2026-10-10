// 共通UIヘルパー。外部由来のテキストは必ず textContent で描画する（innerHTML は自前の定数SVGのみ）。

export const TZ = 'Asia/Tokyo';

/* ---------- ラベル ---------- */
export const SOURCE_LABELS = {
  x_api_search: '公式API検索',
  x_api_home: '公式ホームTL(逆時系列・おすすめではない)',
  foryou_capture: 'おすすめ画面取り込み',
  grok_x_search: 'Grok検索',
  url: 'URL保存',
  import_json: 'JSON',
  import_csv: 'CSV',
  sample: 'サンプル',
};
export const SOURCE_CLASS = {
  x_api_search: 'src-api', x_api_home: 'src-home', foryou_capture: 'src-foryou',
  grok_x_search: 'src-grok', url: 'src-url', import_json: 'src-file', import_csv: 'src-file', sample: 'src-sample',
};
export const GENRE_LABELS = { nightlife: '夜職', general: '一般', unknown: '未分類', all: 'すべて' };
export const REASONS = [
  ['other_meaning', '別の意味（ロイヤルホスト等）'],
  ['vtuber', 'VTuber'],
  ['off_topic', '不要な話題'],
  ['low_quality', '質の悪い投稿者'],
  ['staged', 'やらせ・ステマ'],
  ['other', 'その他'],
];
export const REASON_LABELS = Object.fromEntries(REASONS);
export const SCOPE_LABELS = { post: 'この投稿', author: '投稿者', keyword: 'キーワード', topic: 'トピック' };
export const EFFECT_LABELS = { hide: '非表示', demote: '順位を下げる' };
export const JOB_LABELS = { collect: '収集', daily_digest: '日次まとめ', weekly_digest: '週次まとめ', backup: 'バックアップ' };
export const RUN_STATUS_LABELS = { ok: '成功', skipped: 'スキップ', error: 'エラー' };
export const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/* ---------- DOM ---------- */
/**
 * h('div', { class: 'x', text: '...', on: { click }, attrs: { 'aria-label': '...' } }, child...)
 * 文字列の子は Text ノードとして追加される（HTMLとして解釈しない）。
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === 'attrs') for (const [ak, av] of Object.entries(v)) { if (av !== undefined && av !== null && av !== false) el.setAttribute(ak, av === true ? '' : String(av)); }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style') el.setAttribute('style', v);
      else if (k in el) el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export function mount(el, ...children) { clear(el); append(el, children); return el; }

/* ---------- アイコン（自前の定数SVGのみ） ---------- */
const ICONS = {
  feed: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  topics: '<circle cx="7" cy="7" r="3"/><circle cx="17" cy="7" r="3"/><circle cx="12" cy="17" r="3"/><path d="M9.5 8.5l1.5 6M14.5 8.5l-1.5 6"/>',
  digests: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  import: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v3h16v-3"/>',
  dismissed: '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  views: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>',
  likes: '<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"/>',
  reposts: '<path d="M7 7h10l-2.5-2.5M17 17H7l2.5 2.5"/><path d="M4 12V9.5A2.5 2.5 0 0 1 6.5 7M20 12v2.5a2.5 2.5 0 0 1-2.5 2.5"/>',
  replies: '<path d="M4 5.5h16v10H9l-5 4z"/>',
  bookmarks: '<path d="M6.5 3.5h11v17L12 16.5l-5.5 4z"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/>',
  play: '<path d="M7 4.5l12 7.5-12 7.5z"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  alert: '<path d="M12 3.5L2.5 20h19z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3.6-3.6a4 4 0 0 0-5.7-5.7L12.5 5.8"/><path d="M14 10a4 4 0 0 0-5.7 0l-3.6 3.6a4 4 0 0 0 5.7 5.7l1.1-1.1"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M4 20h16"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5M4 4h16"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 5.6A9.8 9.8 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.1 3.8M6.6 6.6A16.5 16.5 0 0 0 2 12s3.6 6.5 10 6.5a9.5 9.5 0 0 0 4.4-1.1"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
};
export function icon(name, cls = '') {
  const span = document.createElement('span');
  span.className = 'icon ' + cls;
  span.setAttribute('aria-hidden', 'true');
  // ICONS は本ファイル内の定数のみ（外部データは入らない）
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return span;
}

/* ---------- 書式 ---------- */
const nf = new Intl.NumberFormat('ja-JP');
export function exactNum(n) { return n === null || n === undefined ? '不明' : nf.format(n); }
/** 1.2万 / 34万 / 1.5億 の略記 */
export function shortNum(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return null;
  n = Number(n);
  const abs = Math.abs(n);
  const fmt = (v) => {
    const s = v < 100 ? (Math.floor(v * 10) / 10).toFixed(1) : String(Math.floor(v));
    return s.endsWith('.0') ? s.slice(0, -2) : s;
  };
  if (abs >= 1e8) return (n < 0 ? '-' : '') + fmt(abs / 1e8) + '億';
  if (abs >= 1e4) return (n < 0 ? '-' : '') + fmt(abs / 1e4) + '万';
  return nf.format(n);
}
const dtf = new Intl.DateTimeFormat('ja-JP', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const df = new Intl.DateTimeFormat('ja-JP', { timeZone: TZ, month: 'numeric', day: 'numeric', weekday: 'short' });
export function fmtDateTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return dtf.format(d);
}
export function fmtDay(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : df.format(d);
}
export function fmtRelative(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const diff = (Date.now() - t) / 1000;
  if (diff < -60) return fmtDateTime(iso);
  if (diff < 60) return 'たった今';
  if (diff < 3600) return `${Math.floor(diff / 60)}分前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}時間前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}日前`;
  return fmtDateTime(iso);
}
export function fmtBytes(n) {
  if (n === null || n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
/** 日時要素（title に正確な時刻） */
export function timeEl(iso, { relative = false, fallback = '不明' } = {}) {
  const abs = fmtDateTime(iso);
  if (!abs) return h('span', { class: 'unknown', text: fallback });
  return h('time', { attrs: { datetime: iso, title: abs }, text: relative ? fmtRelative(iso) : abs });
}

/* ---------- 状態表示 ---------- */
export function loadingEl(text = '読み込み中…') {
  return h('div', { class: 'state state-loading', attrs: { role: 'status' } },
    h('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }), h('span', { text }));
}
export function skeletonList(n = 3) {
  return h('div', { class: 'skeletons', attrs: { 'aria-hidden': 'true' } },
    Array.from({ length: n }, () => h('div', { class: 'skeleton card' },
      h('div', { class: 'sk-line w40' }), h('div', { class: 'sk-line w90' }), h('div', { class: 'sk-line w70' }))));
}
/** 空状態：次に何をすればよいかを案内 */
export function emptyEl({ title, body, actions = [], iconName = 'sparkle' }) {
  return h('div', { class: 'state state-empty' },
    icon(iconName, 'state-icon'),
    h('p', { class: 'state-title', text: title }),
    body ? h('p', { class: 'state-body', text: body }) : null,
    actions.length ? h('div', { class: 'state-actions' }, actions) : null);
}
export function errorEl(err, retry) {
  const msg = (err && err.message) || '読み込みに失敗しました。';
  return h('div', { class: 'state state-error', attrs: { role: 'alert' } },
    icon('alert', 'state-icon'),
    h('p', { class: 'state-title', text: err && err.isNetwork ? '接続できません' : '読み込みに失敗しました' }),
    h('p', { class: 'state-body', text: msg }),
    retry ? h('div', { class: 'state-actions' }, button('再読み込み', { onClick: retry, iconName: 'refresh' })) : null);
}

/* ---------- ボタン ---------- */
/**
 * 送信中は disabled にして連打を防ぐ。onClick が Promise を返すと完了まで busy。
 */
export function button(label, { onClick, variant = 'secondary', iconName, ariaLabel, type = 'button', small = false, title, cls = '' } = {}) {
  const b = h('button', {
    type,
    class: ['btn', `btn-${variant}`, small && 'btn-sm', cls],
    attrs: { 'aria-label': ariaLabel, title },
  }, iconName ? icon(iconName) : null, label ? h('span', { class: 'btn-label', text: label }) : null);
  if (onClick) b.addEventListener('click', (e) => runBusy(b, () => onClick(e)));
  return b;
}
export async function runBusy(btn, fn) {
  if (btn.disabled || btn.dataset.busy === '1') return;
  btn.dataset.busy = '1';
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  try { return await fn(); }
  finally {
    delete btn.dataset.busy;
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
  }
}

/* ---------- トースト ---------- */
export function toast(message, { type = 'info', action, timeout = 6000 } = {}) {
  const host = document.getElementById('toasts');
  const el = h('div', { class: ['toast', `toast-${type}`], attrs: { role: type === 'error' ? 'alert' : null } },
    h('span', { class: 'toast-msg', text: message }));
  const close = () => { el.classList.add('leaving'); setTimeout(() => el.remove(), 200); };
  if (action) {
    el.append(button(action.label, {
      variant: 'ghost', small: true, iconName: action.iconName,
      onClick: async () => { await action.onClick(); close(); },
    }));
  }
  el.append(h('button', { type: 'button', class: 'toast-close', attrs: { 'aria-label': '通知を閉じる' }, on: { click: close } }, icon('close')));
  host.append(el);
  if (timeout) setTimeout(close, action ? Math.max(timeout, 8000) : timeout);
  return close;
}
export function toastError(err) {
  return toast((err && err.message) || '操作に失敗しました。', { type: 'error', timeout: 9000 });
}

/* ---------- ダイアログ（<dialog>：フォーカス管理・Escで閉じる） ---------- */
export function openDialog({ title, body, footer, onClose, sheet = true, labelId }) {
  const id = labelId || 'dlg-' + Math.random().toString(36).slice(2, 8);
  const dlg = h('dialog', { class: ['dialog', sheet && 'dialog-sheet'], attrs: { 'aria-labelledby': id } });
  const closeBtn = h('button', { type: 'button', class: 'icon-btn', attrs: { 'aria-label': '閉じる' }, on: { click: () => dlg.close() } }, icon('close'));
  dlg.append(
    h('div', { class: 'dialog-head' }, h('h2', { id, class: 'dialog-title', text: title }), closeBtn),
    h('div', { class: 'dialog-body' }, body),
    footer ? h('div', { class: 'dialog-foot' }, footer) : null,
  );
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', () => { onClose && onClose(); dlg.remove(); });
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}
export function confirmDialog(message, { okLabel = 'OK', danger = false, title = '確認' } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const ok = button(okLabel, { variant: danger ? 'danger' : 'primary', onClick: () => { result = true; dlg.close(); } });
    const cancel = button('キャンセル', { onClick: () => dlg.close() });
    const dlg = openDialog({ title, body: h('p', { class: 'confirm-msg', text: message }), footer: [cancel, ok], sheet: false, onClose: () => resolve(result) });
    ok.focus();
  });
}

/* ---------- クリップボード ---------- */
export async function copyText(text, label = 'コピーしました') {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = h('textarea', { value: text, attrs: { readonly: true, 'aria-hidden': 'true' }, style: 'position:fixed;left:-9999px;top:0' });
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (!ok) throw new Error('copy failed');
    }
    toast(label, { type: 'success', timeout: 2500 });
    return true;
  } catch {
    toast('コピーできませんでした。手動で選択してコピーしてください。', { type: 'error' });
    return false;
  }
}

/* ---------- フォーム部品 ---------- */
let uid = 0;
export function nextId(prefix = 'f') { uid += 1; return `${prefix}-${uid}`; }
export function field(labelText, control, { hint, inline = false } = {}) {
  if (!control.id) control.id = nextId();
  const hintEl = hint ? h('p', { class: 'hint', id: control.id + '-hint', text: hint }) : null;
  if (hintEl) control.setAttribute('aria-describedby', hintEl.id);
  return h('div', { class: ['field', inline && 'field-inline'] },
    h('label', { attrs: { for: control.id }, text: labelText }), control, hintEl);
}
export function selectEl(options, value, { onChange, ariaLabel, id } = {}) {
  const s = h('select', { class: 'select', attrs: { 'aria-label': ariaLabel }, id });
  for (const [v, label] of options) s.append(h('option', { value: v, text: label, selected: String(v) === String(value) }));
  if (onChange) s.addEventListener('change', () => onChange(s.value));
  return s;
}
/** セグメント（タブ風ラジオ）。role=tablist ではなくラジオグループとして実装 */
export function segmented(name, options, value, onChange, { ariaLabel, cls = '' } = {}) {
  const wrap = h('div', { class: ['segmented', cls], attrs: { role: 'radiogroup', 'aria-label': ariaLabel } });
  const group = nextId(name);
  for (const [v, label] of options) {
    const id = nextId(name);
    const input = h('input', { type: 'radio', name: group, id, value: v, checked: v === value, class: 'sr-only' });
    input.addEventListener('change', () => { if (input.checked) onChange(v); });
    wrap.append(input, h('label', { attrs: { for: id }, text: label }));
  }
  return wrap;
}
export function toggle(labelText, checked, onChange, { hint, disabled } = {}) {
  const id = nextId('t');
  const input = h('input', { type: 'checkbox', id, checked: !!checked, class: 'switch-input', disabled });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'switch', attrs: { for: id } },
    input, h('span', { class: 'switch-track', attrs: { 'aria-hidden': 'true' } }),
    h('span', { class: 'switch-text' }, h('span', { text: labelText }), hint ? h('small', { class: 'hint', text: hint }) : null));
}
export function badge(text, cls = '', title) {
  return h('span', { class: ['badge', cls], text, attrs: { title } });
}
export function sectionCard(title, ...children) {
  const id = nextId('sec');
  return h('section', { class: 'panel', attrs: { 'aria-labelledby': id } }, h('h2', { class: 'panel-title', id, text: title }), children);
}
export function pageHead(title, sub, ...actions) {
  return h('div', { class: 'page-head' },
    h('div', {}, h('h1', { class: 'page-title', text: title }), sub ? h('p', { class: 'page-sub', text: sub }) : null),
    actions.length ? h('div', { class: 'page-actions' }, actions) : null);
}

/* ---------- その他 ---------- */
export function debounce(fn, ms = 300) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
/** base64url(UTF-8 JSON) をデコード */
export function decodeBase64UrlJson(s) {
  let b64 = String(s).replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
export function plural(n, unit = '件') { return `${exactNum(n)}${unit}`; }
