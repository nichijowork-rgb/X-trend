// X-trend フロントエンド エントリ（ハッシュルーティング）
import { apiEvents, tokens } from './js/api.js';
import { state, refreshStatus, onStatus, isViewer, isUnauthenticated } from './js/state.js';
import { h, icon, mount, clear, button, field, loadingEl, errorEl, toast } from './js/ui.js';
import * as feed from './js/views/feed.js';
import * as topics from './js/views/topics.js';
import * as digests from './js/views/digests.js';
import * as importer from './js/views/import.js';
import * as capture from './js/views/capture.js';
import * as dismissed from './js/views/dismissed.js';
import * as settings from './js/views/settings.js';

const NAV = [
  ['feed', 'フィード', 'feed'],
  ['topics', 'トピック', 'topics'],
  ['digests', 'まとめ', 'digests'],
  ['import', '取り込み', 'import'],
  ['dismissed', '興味なし', 'dismissed'],
  ['settings', '設定', 'settings'],
];
const VIEWS = { feed, topics, digests, import: importer, capture, dismissed, settings };
const TITLES = { feed: 'フィード', topics: 'トピック', digests: 'まとめ', import: '取り込み', capture: '取り込みプレビュー', dismissed: '興味なし', settings: '設定' };

const viewEl = document.getElementById('view');
const mainEl = document.getElementById('main');
let current = { token: 0, cleanup: null };
let authBlocked = false;

/* ---------- 共有トークンを URL から取り出して保存し、URLからは消す ---------- */
function captureShareToken() {
  try {
    const url = new URL(location.href);
    let token = url.searchParams.get('share');
    if (token) url.searchParams.delete('share');
    const [hpath, hquery = ''] = url.hash.split('?');
    const hq = new URLSearchParams(hquery);
    if (hq.get('share')) {
      token = token || hq.get('share');
      hq.delete('share');
      const rest = hq.toString();
      url.hash = rest ? `${hpath}?${rest}` : hpath;
    }
    if (token) {
      tokens.share = token;
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  } catch { /* noop */ }
}

/* ---------- ルーティング ---------- */
export function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  return { name: parts[0] || 'feed', parts: parts.slice(1), query: new URLSearchParams(query) };
}

function renderNav(active) {
  const list = document.getElementById('nav-list');
  const navActive = active === 'capture' ? 'import' : active;
  mount(list, NAV.map(([name, label, ic]) => h('li', {},
    h('a', {
      class: ['nav-link', name === navActive && 'active'],
      href: `#/${name}`,
      attrs: { 'aria-current': name === navActive ? 'page' : null },
    }, icon(ic), h('span', { class: 'nav-label', text: label })))));
}

async function route({ focus = false } = {}) {
  const r = parseRoute();
  if (!VIEWS[r.name]) { location.replace('#/feed'); return; }
  renderNav(r.name);
  document.title = `${TITLES[r.name] || ''} | X-trend`;
  if (current.cleanup) { try { current.cleanup(); } catch { /* noop */ } }
  current.cleanup = null;
  const token = ++current.token;
  const ctx = { route: r, alive: () => token === current.token && !authBlocked };
  if (authBlocked) { renderAuthScreen(); return; }
  if (!state.status && !state.statusError) mount(viewEl, loadingEl('起動中…'));
  if (!state.status && state.statusError) {
    renderStartupError(state.statusError);
    return;
  }
  clear(viewEl);
  try {
    const cleanup = await VIEWS[r.name].render(viewEl, ctx);
    if (token === current.token) current.cleanup = typeof cleanup === 'function' ? cleanup : null;
  } catch (err) {
    console.error(err);
    if (token === current.token) mount(viewEl, errorEl(err, () => route()));
  }
  if (focus && token === current.token) {
    mainEl.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }
}

/* ---------- 上部帯・ステータス ---------- */
function renderBanners() {
  const host = document.getElementById('banners');
  const s = state.status;
  const items = [];
  if (s && s.sampleMode) {
    items.push(h('div', { class: 'banner banner-sample', attrs: { role: 'note' } },
      icon('alert'),
      h('strong', { text: 'サンプルデータを表示中です。実データは未接続です' }),
      h('span', { class: 'banner-sub', text: s.realPostCount ? '' : '取り込み画面から実データを追加できます' })));
  }
  if (state.statusError && state.statusError.isNetwork && s) {
    items.push(h('div', { class: 'banner banner-error', attrs: { role: 'alert' } },
      icon('alert'), h('span', { text: state.statusError.message }),
      button('再接続', { small: true, variant: 'ghost', onClick: () => refreshStatus() })));
  }
  mount(host, items);

  const st = document.getElementById('topbar-status');
  const pills = [];
  if (s && isViewer()) pills.push(h('span', { class: 'pill pill-viewer', attrs: { title: '共有リンクで閲覧中です。編集はできません' } }, icon('lock'), h('span', { text: '閲覧専用' })));
  else if (s && s.authRequired && s.role === 'admin') pills.push(h('span', { class: 'pill pill-admin', text: '管理者' }));
  if (s && s.sampleMode) pills.push(h('span', { class: 'pill pill-sample', text: 'サンプル' }));
  mount(st, pills);
  document.body.classList.toggle('is-viewer', !!(s && isViewer()));
}

function renderStartupError(err) {
  mount(viewEl, h('div', { class: 'view-narrow' },
    h('h1', { class: 'page-title', text: 'X-trend' }),
    errorEl(err, async () => { mount(viewEl, loadingEl('再接続中…')); await refreshStatus(); route(); })));
}

/* ---------- 401：共有リンク / 管理者トークンが必要 ---------- */
function renderAuthScreen() {
  renderNav('');
  const adminInput = h('input', { type: 'password', class: 'input', autocomplete: 'off', attrs: { placeholder: '管理者トークン' } });
  const shareInput = h('input', { type: 'text', class: 'input', autocomplete: 'off', attrs: { placeholder: 'https://…/?share=… または共有トークン' } });
  const retry = async () => {
    const link = shareInput.value.trim();
    if (link) {
      let t = link;
      try { const u = new URL(link); t = u.searchParams.get('share') || new URLSearchParams(u.hash.split('?')[1] || '').get('share') || ''; } catch { /* トークン直接入力 */ }
      if (!t) { toast('共有リンクに share= が含まれていません。', { type: 'error' }); return; }
      tokens.share = t;
    }
    if (adminInput.value.trim()) tokens.admin = adminInput.value.trim();
    authBlocked = false;
    await refreshStatus();
    if ((state.statusError && state.statusError.status === 401) || isUnauthenticated()) { authBlocked = true; toast('認証できませんでした。リンクまたはトークンを確認してください。', { type: 'error' }); return; }
    route();
  };
  const form = h('form', { class: 'auth-form', noValidate: true, on: { submit: (e) => { e.preventDefault(); } } },
    field('共有リンク（閲覧用）', shareInput, { hint: '管理者から受け取った共有リンクを貼り付けてください。' }),
    field('管理者トークン（編集用）', adminInput, { hint: 'このブラウザにのみ保存され、X-Admin-Token ヘッダで送信されます。' }),
    h('div', { class: 'form-actions' },
      button('この内容で開く', { variant: 'primary', type: 'submit', onClick: retry }),
      (tokens.share || tokens.admin) ? button('保存済みトークンを消去', { onClick: () => { tokens.share = ''; tokens.admin = ''; toast('消去しました', { type: 'success' }); } }) : null));
  mount(viewEl, h('div', { class: 'view-narrow auth-screen' },
    h('div', { class: 'auth-icon' }, icon('lock')),
    h('h1', { class: 'page-title', text: 'アクセスにはリンクかトークンが必要です' }),
    h('p', { class: 'page-sub', text: 'このX-trendは保護されています。閲覧には共有リンク、編集には管理者トークンが必要です。' }),
    form));
}

apiEvents.addEventListener('unauthorized', () => {
  if (authBlocked) return;
  authBlocked = true;
  current.token++;
  renderAuthScreen();
});

/* ---------- 起動 ---------- */
async function start() {
  captureShareToken();
  onStatus(renderBanners);
  // 共有リンクの再発行などで閲覧権限を失ったら（定期ステータス更新で検知）認証画面へ
  onStatus(() => {
    if (!authBlocked && isUnauthenticated()) { authBlocked = true; current.token++; renderAuthScreen(); }
  });
  window.addEventListener('hashchange', () => route({ focus: true }));
  window.addEventListener('online', () => { toast('オンラインに戻りました', { type: 'success', timeout: 2500 }); refreshStatus(); });
  window.addEventListener('offline', () => toast('オフラインです。接続が戻るまで操作できません。', { type: 'error', timeout: 8000 }));
  renderNav(parseRoute().name);
  mount(viewEl, loadingEl('起動中…'));
  await refreshStatus();
  // /api/status は未認証でも 200 { authRequired: true, role: "none" } を返すので、それも認証画面へ
  if ((state.statusError && state.statusError.status === 401) || isUnauthenticated()) { authBlocked = true; renderAuthScreen(); return; }
  route();
  // ステータスは定期的に更新（サンプル帯・最終実行などを最新に）
  setInterval(() => { if (!document.hidden && !authBlocked) refreshStatus(); }, 60000);
}

start();
