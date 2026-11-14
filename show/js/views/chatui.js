// 進行画面の「コメント」パネル（YouTube ライブのコメント）と設定ダイアログ。
// 取得のたびに画面全体は描き直さない: refreshChatPanel が状態の 1 行・固定中の表示・一覧（id ごとに差分）だけ更新する。
// 文字はすべて textContent。
import { h, btn, field } from '../dom.js';
import { CHAT_INTERVALS, CHAT_CFG_DEFAULTS, CHAT_CFG_LIMITS, YT_QUOTA_DAILY, quotaPerHour, validKey, initialOf, inkFor } from '../ytchat.js';

const fmt = (n) => Number(n || 0).toLocaleString('ja-JP');

/** 状態の 1 行 */
export function chatStatusText(app) {
  const c = app.chat;
  if (!validKey(app.chatPrefs.key) && !['starting', 'running', 'retrying'].includes(c.status)) return '未設定（「⚙ 設定」で API キーを入れてください）';
  if (c.status === 'starting') return '接続中…';
  if (c.status === 'running') return `取得中・${fmt(c.count)}件`;
  if (c.status === 'retrying') return `やり直し中：${c.reason}`;
  if (c.status === 'error') return `エラー：${c.reason}`;
  if (c.status === 'stopped') return `停止（${fmt(c.count)}件）`;
  return '止まっています';
}

const running = (app) => ['starting', 'running', 'retrying'].includes(app.chat.status);

function avatar(item, cls) {
  const initial = () => h('span', { class: `${cls} yc-initial`, attrs: { 'aria-hidden': 'true' } }, initialOf(item.name));
  if (!item.icon) return initial();
  const img = h('img', { class: cls, alt: '', referrerPolicy: 'no-referrer', decoding: 'async', loading: 'lazy', src: item.icon });
  img.addEventListener('error', () => { if (img.isConnected) img.replaceWith(initial()); });
  return img;
}

function rowSig(app, e) {
  return [e.ng ? 'ng' : '', app.chat.hidden.has(e.id) ? 'h' : '', app.chat.pin && app.chat.pin.id === e.id ? 'p' : ''].join('|');
}

/** 一覧の 1 行（アイコン・名前・本文・［固定］［画面から消す］） */
function rowEl(app, e) {
  const pinned = Boolean(app.chat.pin && app.chat.pin.id === e.id);
  const hidden = app.chat.hidden.has(e.id);
  const li = h('li', { class: `yc-row is-${e.kind}${e.ng ? ' is-ng' : ''}${hidden ? ' is-hidden' : ''}${pinned ? ' is-pinned' : ''}`, dataset: { id: e.id, sig: rowSig(app, e) } });
  const badges = [];
  if (e.owner) badges.push(h('span', { class: 'yc-badge is-owner' }, '配信者'));
  if (e.mod) badges.push(h('span', { class: 'yc-badge is-mod' }, 'モデレーター'));
  if (e.sample) badges.push(h('span', { class: 'yc-badge' }, '見本'));
  if (e.backlog) badges.push(h('span', { class: 'yc-badge', attrs: { title: '開始したときに読んだ、それより前のコメント（画面には流していません）' } }, '開始前'));
  if (e.ng) badges.push(h('span', { class: 'yc-badge is-ng', attrs: { title: `NG ワード「${e.ng}」を含むので画面に出しません` } }, 'NG'));
  if (hidden) badges.push(h('span', { class: 'yc-badge is-gone' }, '画面から消した'));
  if (pinned) badges.push(h('span', { class: 'yc-badge is-pin' }, '固定中'));
  const amount = e.kind !== 'text' && e.amount ? h('span', { class: 'yc-amount' }, e.amount) : null;
  if (amount && e.color) { amount.style.background = e.color; amount.style.color = inkFor(e.color); }
  const body = h('div', { class: 'yc-body' },
    h('div', { class: 'yc-line1' }, h('span', { class: 'yc-name' }, e.name), ...badges),
    h('p', { class: 'yc-text' }, amount, e.text));
  const blocked = Boolean(e.ng || hidden);
  const acts = h('div', { class: 'yc-acts' },
    pinned
      ? btn('固定を外す', () => app.chatUnpin(), 'btn btn-small yc-btn is-on', { 'data-key': 'yc-unpin' })
      : btn('固定', () => app.chatPin(e.id), 'btn btn-small yc-btn', { 'data-key': 'yc-pin', disabled: blocked, title: blocked ? '画面に出さないコメントは固定できません' : 'OBS の中央に大きく出します' }),
    btn('画面から消す', () => app.chatHide(e.id), 'btn btn-small btn-ghost-dark yc-btn', { 'data-key': 'yc-hide', disabled: hidden || Boolean(e.ng), title: '流れていれば消し、これからも出しません' }));
  li.append(avatar(e, 'yc-icon'), body, acts);
  return li;
}

/** 一覧を状態に合わせる（新しいものが上。変わった行だけ作り直す） */
export function syncChatLog(app, ul) {
  if (!ul) return;
  const want = app.chat.log.slice().reverse();
  const old = new Map();
  for (const li of [...ul.children]) {
    if (li.dataset.id) old.set(li.dataset.id, li);
    else li.remove();
  }
  const prevH = ul.scrollHeight;
  const keepScroll = ul.scrollTop > 4;
  const nodes = want.map((e) => {
    const li = old.get(e.id);
    if (li && li.dataset.sig === rowSig(app, e)) { old.delete(e.id); return li; }
    return rowEl(app, e);
  });
  for (const li of old.values()) li.remove();
  nodes.forEach((n, i) => { if (ul.children[i] !== n) ul.insertBefore(n, ul.children[i] || null); });
  while (ul.children.length > nodes.length) ul.lastElementChild.remove();
  if (!nodes.length) ul.append(h('li', { class: 'yc-empty muted' }, running(app) ? 'まだコメントはありません（新しいコメントがここに出ます）' : '「開始」すると、ここに新しいコメントが上から並びます'));
  // 下の方を読んでいるときは、上に増えても見ている位置を保つ
  if (keepScroll) ul.scrollTop += ul.scrollHeight - prevH;
}

function pinnedEl(app) {
  const p = app.chat.pin;
  if (!p) return h('div', { class: 'yc-pinned is-empty', dataset: { key: 'yc-pinned' }, hidden: true });
  return h('div', { class: 'yc-pinned', dataset: { key: 'yc-pinned' } },
    h('span', { class: 'yc-pin-tag' }, '固定中'),
    avatar(p, 'yc-icon'),
    h('span', { class: 'yc-pinned-text' }, h('b', {}, p.name), ' ', p.amount ? `${p.amount} ` : '', p.text),
    btn('固定を外す', () => app.chatUnpin(), 'btn btn-small yc-btn', { 'data-key': 'yc-unpin-top' }));
}

/** 状態の 1 行・ボタン・固定中・一覧・使った量を、画面全体を描き直さずに更新する */
export function refreshChatPanel(app) {
  const panel = document.querySelector('[data-key="yc-panel"]');
  if (!panel) return;
  const status = panel.querySelector('[data-key="yc-status"]');
  if (status) { status.textContent = chatStatusText(app); status.dataset.state = app.chat.status; status.title = app.chat.reason || ''; }
  for (const b of panel.querySelectorAll('[data-key="yc-toggle-run"]')) { b.textContent = running(app) ? '停止' : '開始'; b.classList.toggle('is-on', running(app)); }
  const flow = panel.querySelector('[data-key="yc-flow"]');
  if (flow) flow.checked = app.chatPrefs.flow !== false;
  const pinned = panel.querySelector('[data-key="yc-pinned"]');
  if (pinned) pinned.replaceWith(pinnedEl(app));
  syncChatLog(app, panel.querySelector('[data-key="yc-log"]'));
  const q = document.querySelector('[data-key="yc-quota"]');
  if (q) q.textContent = quotaText(app);
}

function quotaText(app) {
  return `この起動で使った量：約 ${fmt(app.chatUnits())} / ${fmt(YT_QUOTA_DAILY)}（1 日の上限。取得間隔 ${app.chatPrefs.interval / 1000} 秒なら 1 時間で約 ${fmt(quotaPerHour(app.chatPrefs.interval))}）`;
}

/** 「コメント」パネル（折りたたみ。開閉は localStorage） */
export function chatPanel(app) {
  const open = Boolean(app.chatOpen);
  const u = app.ui;
  if (u.ycUrl == null) u.ycUrl = app.chatPrefs.url || '';
  const bar = h('section', { class: `yc-panel${open ? ' is-open' : ''}`, attrs: { 'aria-label': 'YouTube のコメント' }, dataset: { keep: 'yc-panel', key: 'yc-panel' } });
  const toggleRun = () => {
    const input = document.querySelector('[data-key="yc-url"]');
    app.chatToggle(input ? input.value : u.ycUrl);
  };
  bar.append(h('div', { class: 'ycp-head' },
    btn(open ? 'コメント ▾' : 'コメント ▸', () => app.setChatOpen(!open), 'btn btn-small btn-ghost-dark fxp-toggle', { 'data-key': 'yc-open', 'aria-expanded': String(open), title: 'YouTube ライブのコメント（OBS の「流れるコメント」パーツに流します）' }),
    h('span', { class: 'ycp-status', attrs: { role: 'status', 'aria-live': 'polite' }, dataset: { key: 'yc-status', state: app.chat.status } }, chatStatusText(app)),
    btn(running(app) ? '停止' : '開始', toggleRun, `btn btn-small ycp-run${running(app) ? ' is-on' : ''}`, { 'data-key': 'yc-toggle-run' })));
  if (!open) return bar;
  const url = h('input', { class: 'input input-sm ycp-url', type: 'url', value: u.ycUrl, placeholder: '配信の URL（https://www.youtube.com/live/… など）', dataset: { key: 'yc-url' }, attrs: { 'aria-label': '配信の URL', autocomplete: 'off', spellcheck: 'false' } });
  url.addEventListener('input', () => { u.ycUrl = url.value; });
  url.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (!running(app)) app.chatStart(url.value); } });
  const flow = h('input', { type: 'checkbox', checked: app.chatPrefs.flow !== false, dataset: { key: 'yc-flow' } });
  flow.addEventListener('change', () => app.chatSetFlow(flow.checked));
  bar.append(h('div', { class: 'ycp-row' },
    url,
    h('label', { class: 'check-line ycp-flow', attrs: { title: 'オフにすると取得は続けたまま、画面に流すのを止めます' } }, flow, h('span', {}, '画面に流す')),
    btn('⚙ 設定', () => { u.ycDlg = true; app.render(); }, 'btn btn-small btn-ghost-dark', { 'data-key': 'yc-settings' })));
  bar.append(pinnedEl(app));
  // 一覧は data-keep-leaf（描き直しても中身はそのまま。refreshChatPanel が差分で更新）
  bar.append(h('ul', { class: 'yc-log', dataset: { keep: 'yc-log', keepLeaf: '', key: 'yc-log' }, attrs: { 'aria-label': 'コメント一覧（新しいものが上）' } }));
  return bar;
}

/** 設定ダイアログ（API キー・取得間隔・流れ方・NG ワード・見本・使った量・キーの作り方） */
export function chatSettingsDialog(app) {
  const p = app.chatPrefs;
  const u = app.ui;
  if (!u.ycDraft) u.ycDraft = { key: p.key, interval: p.interval, top: p.top, lanes: p.lanes, laneH: p.laneH, size: p.size, speed: p.speed, ng: p.ng };
  const d = u.ycDraft;
  const close = () => { u.ycDlg = false; u.ycDraft = null; app.render(); };
  const dlg = h('dialog', { class: 'obs-dialog yc-dialog', attrs: { 'data-modal': '', 'aria-labelledby': 'yc-title' }, dataset: { keep: 'yc-dialog' } });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  const bind = (input, k, num = false) => { input.addEventListener('input', () => { d[k] = num ? Number(input.value) : input.value; }); return input; };
  const key = bind(h('input', { class: 'input', type: 'password', value: d.key, dataset: { key: 'yc-key' }, attrs: { autocomplete: 'off', spellcheck: 'false', 'aria-label': 'API キー' } }), 'key');
  const showKey = h('input', { type: 'checkbox', dataset: { key: 'yc-show-key' } });
  showKey.addEventListener('change', () => { key.type = showKey.checked ? 'text' : 'password'; });
  const interval = h('select', { class: 'input', dataset: { key: 'yc-interval' } },
    ...CHAT_INTERVALS.map((ms) => h('option', { value: String(ms), selected: ms === Number(d.interval) }, `${ms / 1000} 秒${ms === 6000 ? '（おすすめ）' : ''}`)));
  interval.addEventListener('change', () => { d.interval = Number(interval.value); });
  const num = (k, label, hint) => {
    const [min, max] = CHAT_CFG_LIMITS[k];
    return field(label, bind(h('input', { class: 'input', type: 'number', min, max, step: k === 'speed' ? 0.5 : 1, value: String(d[k]), dataset: { key: `yc-${k.toLowerCase()}` } }), k, true), hint);
  };
  const ng = bind(h('textarea', { class: 'input', rows: 3, value: d.ng, placeholder: '例：荒らし、宣伝（「、」か改行で区切る）', dataset: { key: 'yc-ng' }, attrs: { 'aria-label': 'NG ワード' } }), 'ng');
  ng.value = d.ng;
  const save = () => {
    app.chatSavePrefs({ key: String(d.key || '').trim(), interval: d.interval, top: d.top, lanes: d.lanes, laneH: d.laneH, size: d.size, speed: d.speed, ng: d.ng });
    u.ycDraft = null;
    u.ycDlg = false;
    app.toast('コメントの設定を保存しました');
    app.render();
  };
  const reset = () => { Object.assign(d, { top: CHAT_CFG_DEFAULTS.top, lanes: CHAT_CFG_DEFAULTS.lanes, laneH: CHAT_CFG_DEFAULTS.laneH, size: CHAT_CFG_DEFAULTS.size, speed: CHAT_CFG_DEFAULTS.speed }); app.render(); };
  dlg.append(
    h('header', { class: 'move-head' }, h('h2', { id: 'yc-title' }, 'コメントの設定'), btn('閉じる', close, 'btn btn-small btn-ghost', { 'data-key': 'yc-close' })),
    h('div', { class: 'obs-body' },
      h('p', { class: 'muted' }, 'YouTube ライブのコメントを読み取り、OBS の「流れるコメント」パーツに流します（読むだけ。YouTube に書き込むことはありません）。'),
      field('API キー（YouTube Data API v3）', key),
      h('label', { class: 'check-line' }, showKey, h('span', {}, 'キーを表示')),
      h('p', { class: 'obs-warn' }, '⚠ API キーはこのパソコンのこのブラウザにだけ保存します（YouTube の API 以外には送りません。書き出しにも入りません）。共用のパソコンでは使い終わったら消してください。'),
      field('取得間隔', interval, '（短いほど早く出ますが、1 日の上限を早く使います）'),
      h('p', { class: 'muted yc-quota', dataset: { key: 'yc-quota' } }, quotaText(app)),
      h('h3', { class: 'yc-h3' }, '流れ方（1920×1080 の画面で）'),
      h('div', { class: 'obs-grid yc-grid' },
        num('top', '位置（上端の y）', `（既定 ${CHAT_CFG_DEFAULTS.top}）`),
        num('lanes', '列の数', `（既定 ${CHAT_CFG_DEFAULTS.lanes}）`),
        num('laneH', '列の高さ', `（既定 ${CHAT_CFG_DEFAULTS.laneH}）`),
        num('size', '文字の大きさ', `（既定 ${CHAT_CFG_DEFAULTS.size}）`),
        num('speed', '速さ（横切る秒数）', `（既定 ${CHAT_CFG_DEFAULTS.speed}。大きいほどゆっくり）`)),
      h('div', { class: 'row' }, btn('流れ方を既定に戻す', reset, 'btn btn-small btn-ghost', { 'data-key': 'yc-reset' })),
      field('NG ワード', ng, '（含むコメントは一覧で灰色になり、画面には出しません。全角・半角や大文字・小文字は区別しません。名前も見ます）'),
      h('div', { class: 'row' },
        btn('保存', save, 'btn btn-small btn-red', { 'data-key': 'yc-save' }),
        btn('見本を流す', () => app.chatDemo(), 'btn btn-small', { 'data-key': 'yc-demo', title: 'API を使わずに見本のコメントを OBS・このブラウザで開いたパーツへ流します（配置の確認用）' }),
        btn('キーを消す', () => { d.key = ''; key.value = ''; app.chatSavePrefs({ key: '' }); }, 'btn btn-small btn-ghost', { 'data-key': 'yc-forget' })),
      h('details', { class: 'obs-help' }, h('summary', {}, 'API キーの作り方（無料・はじめの 1 回だけ）'),
        h('ol', {},
          h('li', {}, 'Google Cloud（console.cloud.google.com）に Google アカウントで入り、上の「プロジェクトの選択」→「新しいプロジェクト」（「このページを表示するには、プロジェクトを選択してください」と出たら右の「プロジェクトの作成」）で作る（名前は自由。例：yoru-comments）。'),
          h('li', {}, '作ったプロジェクトを上の「プロジェクトの選択」で選んだ状態で、「API とサービス」→「ライブラリ」で「YouTube Data API v3」を探して「有効にする」。'),
          h('li', {}, '「API とサービス」→「認証情報」→「認証情報を作成」→「API キー」。できたキーをコピーして、上の「API キー」に貼って「保存」。'),
          h('li', {}, 'キーの制限（大事）：作ったキーの「編集」で、アプリケーションの制限＝「ウェブサイト」にして https://www.x-yoru-buzz.com/* を追加。API の制限＝「キーを制限」で「YouTube Data API v3」だけを選んで保存。'),
          h('li', {}, '1 日の上限は 10,000（日本時間の 16〜17 時ごろに戻ります）。取得間隔 6 秒で 1 時間に約 3,000 使うので、3 時間くらいまでの配信向けです。長い配信は間隔を 8〜10 秒に。'))),
      h('details', { class: 'obs-help' }, h('summary', {}, '使い方'),
        h('ul', {},
          h('li', {}, 'OBS に「流れるコメント」パーツ（overlay.html?part=comments・1920×1080）を画面全体に貼り、投稿カードより下に置く。'),
          h('li', {}, '配信が始まったら、配信の URL を入れて「開始」。開始する前のコメントは一覧にだけ入り、画面には流しません。'),
          h('li', {}, '一覧の［固定］で中央に大きく出します（もう一度［固定を外す］）。［画面から消す］はそのコメントを画面から消します。「画面に流す」を外すと、取得は続けたまま流すのを止めます。'),
          h('li', {}, 'YouTube で削除されたコメント・BAN された人のコメントは、一覧・画面から自動で消えます。')))));
  return dlg;
}
