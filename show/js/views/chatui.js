// コメント（YouTube ライブ）の画面部品: 進行の 1 行の状態バー、［コメント］ページの上のバー・一覧、設定ダイアログ。
// 取得のたびに画面全体は描き直さない: refreshChatPanel が状態・固定中・一覧（id ごとに差分）だけ更新する。
// ほかのウィンドウが取りまとめ役のときも同じ（app.chat はその状態を映したもの。操作は取りまとめ役へ送られる）。
// 文字はすべて textContent。
import { h, btn, field } from '../dom.js';
import { CHAT_INTERVALS, YT_QUOTA_DAILY, quotaPerHour, validKey, looksLikeGoogleKey, initialOf, inkFor, parseChannelInput } from '../ytchat.js';

const fmt = (n) => Number(n || 0).toLocaleString('ja-JP');
const running = (app) => ['starting', 'running', 'retrying', 'searching'].includes(app.chat.status);

/** 状態の 1 行 */
export function chatStatusText(app) {
  const c = app.chat;
  if (!validKey(app.chatPrefs.key) && !running(app)) return '未設定（「⚙ 設定」で API キーを入れてください）';
  if (c.status === 'starting') return '接続中…';
  if (c.status === 'searching') return c.reason || '配信を探しています…';
  if (c.status === 'running') {
    const sec = `${app.chatPrefs.interval / 1000}秒ごと`;
    if (c.via === 'stream') return `取得中（プッシュ）・${fmt(c.count)}件`;
    return `取得中（${sec}）${c.fallback ? `※${c.fallback}` : ''}・${fmt(c.count)}件`;
  }
  if (c.status === 'retrying') return `やり直し中：${c.reason}`;
  if (c.status === 'error') return `エラー：${c.reason}`;
  if (c.status === 'stopped') return `停止（${fmt(c.count)}件）`;
  return '止まっています';
}

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
      : btn('固定', () => app.chatPin(e.id), 'btn btn-small yc-btn', { 'data-key': 'yc-pin', disabled: blocked, title: blocked ? '画面に出さないコメントは固定できません' : 'OBS の固定コメントの箱に大きく出します' }),
    btn('画面から消す', () => app.chatHide(e.id), 'btn btn-small btn-ghost-dark yc-btn', { 'data-key': 'yc-hide', disabled: hidden || Boolean(e.ng), title: '流れていれば消し、これからも出しません' }));
  li.append(avatar(e, 'yc-icon'), body, acts);
  return li;
}

/** 一覧の絞り込み: all すべて／super スパチャ・ステッカー／gone 画面から消した・NG */
export const LOG_FILTERS = Object.freeze([['all', 'すべて'], ['super', 'スパチャ'], ['gone', '画面から消した・NG']]);
function filtered(app, list) {
  const f = app.ui.ycFilter || 'all';
  if (f === 'super') return list.filter((e) => e.kind === 'super' || e.kind === 'sticker');
  if (f === 'gone') return list.filter((e) => e.ng || app.chat.hidden.has(e.id));
  return list;
}

/** 一覧を状態に合わせる（新しいものが上。変わった行だけ作り直す） */
export function syncChatLog(app, ul) {
  if (!ul) return;
  const want = filtered(app, app.chat.log.slice().reverse());
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
  if (!nodes.length) {
    const f = app.ui.ycFilter || 'all';
    ul.append(h('li', { class: 'yc-empty muted' }, f !== 'all' ? '当てはまるコメントはありません' : running(app) ? 'まだコメントはありません（新しいコメントがここに出ます）' : '「開始」すると、ここに新しいコメントが上から並びます'));
  }
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

/** 自動で見つけた配信の題名 */
function foundEl(app) {
  const f = app.chat.found;
  if (!f) return h('p', { class: 'ycp-found', dataset: { key: 'yc-found' }, hidden: true });
  return h('p', { class: 'ycp-found', dataset: { key: 'yc-found' } }, h('b', {}, '見つけた配信：'), f.title || f.videoId);
}

function chipsEl(app) {
  const f = app.ui.ycFilter || 'all';
  const n = { all: app.chat.log.length, super: app.chat.log.filter((e) => e.kind !== 'text').length, gone: app.chat.log.filter((e) => e.ng || app.chat.hidden.has(e.id)).length };
  return h('div', { class: 'cmp-chips', attrs: { role: 'group', 'aria-label': '一覧の絞り込み' }, dataset: { key: 'yc-chips' } },
    ...LOG_FILTERS.map(([k, label]) => btn(`${label}（${fmt(n[k])}）`, () => { app.ui.ycFilter = k; refreshChatPanel(app); }, `chip yc-chip${f === k ? ' is-on' : ''}`, { 'data-key': `yc-filter-${k}`, 'aria-pressed': String(f === k) })));
}

/** 状態・ボタン・固定中・一覧・使った量を、画面全体を描き直さずに更新する（進行のバー・コメントのページ・設定ダイアログ） */
export function refreshChatPanel(app) {
  for (const status of document.querySelectorAll('[data-key="yc-status"]')) { status.textContent = chatStatusText(app); status.dataset.state = app.chat.status; status.title = app.chat.reason || ''; }
  for (const b of document.querySelectorAll('[data-key="yc-toggle-run"]')) { b.textContent = running(app) ? '停止' : '開始'; b.classList.toggle('is-on', running(app)); }
  for (const flow of document.querySelectorAll('[data-key="yc-flow"]')) flow.checked = app.chatPrefs.flow !== false;
  // ほかのウィンドウで開始した URL（入力中でなければ合わせる）
  if (app.ui.ycUrlSeen !== app.chatPrefs.url) {
    app.ui.ycUrlSeen = app.chatPrefs.url;
    for (const u of document.querySelectorAll('[data-key="yc-url"]')) if (document.activeElement !== u) { u.value = app.chatPrefs.url || ''; app.ui.ycUrl = u.value; }
  }
  for (const role of document.querySelectorAll('[data-key="yc-role"]')) { const lead = app.chatIsLeader(); role.textContent = lead ? '' : 'ほかのウィンドウで取得中の内容を表示しています'; role.hidden = lead; }
  const pinned = document.querySelector('[data-key="yc-pinned"]');
  if (pinned) pinned.replaceWith(pinnedEl(app));
  const found = document.querySelector('[data-key="yc-found"]');
  if (found) found.replaceWith(foundEl(app));
  const chips = document.querySelector('[data-key="yc-chips"]');
  if (chips) chips.replaceWith(chipsEl(app));
  syncChatLog(app, document.querySelector('[data-key="yc-log"]'));
  const q = document.querySelector('[data-key="yc-quota"]');
  if (q) q.textContent = quotaText(app);
  const pv = document.querySelector('[data-key="le-obs"]');
  if (pv && document.activeElement !== pv) pv.checked = Boolean(app.chatPreviewState().obs);
}

function quotaText(app) {
  return `この起動で使った量：約 ${fmt(app.chatUnits())} / ${fmt(YT_QUOTA_DAILY)}（1 日の上限。プッシュは 1 接続 5、${app.chatPrefs.interval / 1000} 秒ごとの取得なら 1 時間で約 ${fmt(quotaPerHour(app.chatPrefs.interval))}。チャンネルから探すときは 1 回 2〜3、見つからず検索すると 100）`;
}

const runBtn = (app, onClick) => btn(running(app) ? '停止' : '開始', onClick, `btn btn-small ycp-run${running(app) ? ' is-on' : ''}`, { 'data-key': 'yc-toggle-run' });

/** 進行の 1 行のバー: 状態・開始/停止・コメントのページへ・別ウィンドウで開く */
export function chatBar(app) {
  return h('section', { class: 'yc-bar', attrs: { 'aria-label': 'YouTube のコメント' }, dataset: { keep: 'yc-bar' } },
    h('span', { class: 'ycb-label' }, 'コメント'),
    h('span', { class: 'ycp-status', attrs: { role: 'status', 'aria-live': 'polite' }, dataset: { key: 'yc-status', state: app.chat.status } }, chatStatusText(app)),
    runBtn(app, () => app.chatToggle(app.chatPrefs.url || '')),
    h('a', { class: 'btn btn-small btn-ghost-dark', href: '#comments', dataset: { key: 'yc-goto' }, attrs: { title: 'コメントの一覧・固定・レイアウトのページへ' } }, 'コメントページへ'),
    btn('別ウィンドウで開く', () => app.openCommentsWindow(), 'btn btn-small btn-ghost-dark', { 'data-key': 'yc-popout', title: 'コメントのページを別のウィンドウで開きます（進行と並べて使えます）' }));
}

/** ［コメント］ページの上のバー（固定）: 状態・URL・開始/停止・画面に流す・OBS・設定・別ウィンドウ */
export function commentsTopBar(app) {
  const u = app.ui;
  if (u.ycUrl == null) u.ycUrl = app.chatPrefs.url || '';
  const ch = parseChannelInput(app.chatPrefs.channel);
  const ph = ch ? `配信の URL（空にすると、登録したチャンネル ${app.chatPrefs.channel} の配信を自動で探します）` : '配信の URL（https://www.youtube.com/live/… など）';
  const url = h('input', { class: 'input input-sm ycp-url', type: 'url', value: u.ycUrl, placeholder: ph, dataset: { key: 'yc-url' }, attrs: { 'aria-label': '配信の URL', autocomplete: 'off', spellcheck: 'false', title: 'URL を空にすると、登録したチャンネルの配信を自動で探します（チャンネルは「⚙ 設定」で登録）' } });
  url.addEventListener('input', () => { u.ycUrl = url.value; });
  url.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (!running(app)) app.chatStart(url.value); } });
  const flow = h('input', { type: 'checkbox', checked: app.chatPrefs.flow !== false, dataset: { key: 'yc-flow' } });
  flow.addEventListener('change', () => app.chatSetFlow(flow.checked));
  const toggleRun = () => { const input = document.querySelector('[data-key="yc-url"]'); app.chatToggle(input ? input.value : u.ycUrl); };
  return h('header', { class: 'cmp-bar', dataset: { keep: 'cmp-bar' } },
    h('div', { class: 'cmp-row' },
      h('h2', { class: 'cmp-title' }, 'コメント'),
      h('span', { class: 'ycp-status', attrs: { role: 'status', 'aria-live': 'polite' }, dataset: { key: 'yc-status', state: app.chat.status } }, chatStatusText(app)),
      h('button', { type: 'button', class: 'obs-pill', dataset: { key: 'cmp-obs-pill', obsPill: '' }, on: { click: () => { app.ui.obsDlg = true; app.render(); } } }, 'OBS')),
    h('div', { class: 'cmp-row' },
      url,
      runBtn(app, toggleRun),
      h('label', { class: 'check-line ycp-flow', attrs: { title: 'オフにすると取得は続けたまま、画面に流すのを止めます' } }, flow, h('span', {}, '画面に流す')),
      btn('⚙ 設定', () => { u.ycDlg = true; app.render(); }, 'btn btn-small btn-ghost-dark', { 'data-key': 'yc-settings' }),
      btn('別ウィンドウで開く', () => app.openCommentsWindow(), 'btn btn-small btn-ghost-dark', { 'data-key': 'yc-popout', title: 'このページを別のウィンドウで開きます（約 1280×900）' })),
    h('p', { class: 'ycp-hint muted' }, ch ? 'URL を空にすると、登録したチャンネルの配信を自動で探します。' : '「⚙ 設定」でチャンネルを登録すると、URL を空にして「開始」したときに配信を自動で探します。',
      h('span', { class: 'cmp-role', dataset: { key: 'yc-role' }, hidden: app.chatIsLeader() }, app.chatIsLeader() ? '' : 'ほかのウィンドウで取得中の内容を表示しています')),
    foundEl(app));
}

/** ［コメント］ページの一覧の列: 固定中・絞り込み・一覧（新しいものが上） */
export function commentsLogColumn(app) {
  return h('section', { class: 'cmp-log-col', attrs: { 'aria-label': 'コメント一覧' }, dataset: { keep: 'cmp-log-col' } },
    pinnedEl(app),
    chipsEl(app),
    // 一覧は data-keep-leaf（描き直しても中身はそのまま。refreshChatPanel が差分で更新）
    h('ul', { class: 'yc-log cmp-log', dataset: { keep: 'yc-log', keepLeaf: '', key: 'yc-log' }, attrs: { 'aria-label': 'コメント一覧（新しいものが上）' } }));
}

export function chatSettingsDialog(app) {
  const p = app.chatPrefs;
  const u = app.ui;
  if (!u.ycDraft) u.ycDraft = { key: p.key, interval: p.interval, mode: p.mode, channel: p.channel, ng: p.ng };
  const d = u.ycDraft;
  const close = () => { u.ycDlg = false; u.ycDraft = null; u.ycKeyMsg = ''; app.render(); };
  const dlg = h('dialog', { class: 'obs-dialog yc-dialog', attrs: { 'data-modal': '', 'aria-labelledby': 'yc-title' }, dataset: { keep: 'yc-dialog' } });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  const bind = (input, k, num = false) => { input.addEventListener('input', () => { d[k] = num ? Number(input.value) : input.value; }); return input; };
  // ブラウザが保存したパスワードを自動で入れないように（new-password。パスワード管理ソフトも無視させる）
  const key = bind(h('input', { class: 'input', type: 'password', value: d.key, dataset: { key: 'yc-key' }, attrs: { autocomplete: 'new-password', spellcheck: 'false', 'aria-label': 'API キー', 'data-1p-ignore': '', 'data-lpignore': 'true' } }), 'key');
  const keyMsg = h('p', { class: 'obs-warn', attrs: { role: 'alert' }, dataset: { key: 'yc-key-msg' } }, u.ycKeyMsg || '');
  keyMsg.hidden = !u.ycKeyMsg;
  const showKey = h('input', { type: 'checkbox', dataset: { key: 'yc-show-key' } });
  showKey.addEventListener('change', () => { key.type = showKey.checked ? 'text' : 'password'; });
  const interval = h('select', { class: 'input', dataset: { key: 'yc-interval' } },
    ...CHAT_INTERVALS.map((ms) => h('option', { value: String(ms), selected: ms === Number(d.interval) }, `${ms / 1000} 秒${ms === 6000 ? '（おすすめ）' : ''}`)));
  interval.addEventListener('change', () => { d.interval = Number(interval.value); });
  const mode = h('select', { class: 'input', dataset: { key: 'yc-mode' } },
    h('option', { value: 'auto', selected: d.mode !== 'poll' }, '自動（プッシュ→だめなら数秒ごと）'),
    h('option', { value: 'poll', selected: d.mode === 'poll' }, '数秒ごとのみ（取得間隔）'));
  mode.addEventListener('change', () => { d.mode = mode.value; });
  const channel = bind(h('input', { class: 'input', type: 'text', value: d.channel || '', placeholder: '@ハンドル か https://www.youtube.com/@… か UC…', dataset: { key: 'yc-channel' }, attrs: { autocomplete: 'off', spellcheck: 'false', 'aria-label': 'チャンネル' } }), 'channel');
  const chMsg = h('p', { class: 'obs-warn', attrs: { role: 'alert' }, dataset: { key: 'yc-channel-msg' }, hidden: true });
  const ng = bind(h('textarea', { class: 'input', rows: 3, value: d.ng, placeholder: '例：荒らし、宣伝（「、」か改行で区切る）', dataset: { key: 'yc-ng' }, attrs: { 'aria-label': 'NG ワード' } }), 'ng');
  ng.value = d.ng;
  const save = () => {
    const k = String(d.key || '').trim();
    // Google の API キーは「AIza」で始まる。違うものは保存しない（自動で入ったパスワードなどを Google に送らない）
    if (k && !looksLikeGoogleKey(k)) {
      u.ycKeyMsg = '⚠ これは Google の API キーではないようです（API キーは「AIza」で始まる 39 文字です）。ブラウザが保存したパスワードが自動で入っていないか確かめ、いったん消してから貼り直してください。';
      keyMsg.textContent = u.ycKeyMsg;
      keyMsg.hidden = false;
      key.focus();
      return;
    }
    u.ycKeyMsg = '';
    const chIn = String(d.channel || '').trim();
    if (chIn && !parseChannelInput(chIn)) {
      chMsg.textContent = '⚠ チャンネルを読み取れません（@ハンドル、https://www.youtube.com/@… 、/channel/UC… のどれか）';
      chMsg.hidden = false;
      channel.focus();
      return;
    }
    app.chatSavePrefs({ key: k, interval: d.interval, mode: d.mode, channel: chIn, ng: d.ng });
    u.ycDraft = null;
    u.ycDlg = false;
    app.toast('コメントの設定を保存しました');
    app.render();
  };
  dlg.append(
    h('header', { class: 'move-head' }, h('h2', { id: 'yc-title' }, 'コメントの設定'), btn('閉じる', close, 'btn btn-small btn-ghost', { 'data-key': 'yc-close' })),
    h('div', { class: 'obs-body' },
      h('p', { class: 'muted' }, 'YouTube ライブのコメントを読み取り、OBS の「流れるコメント」パーツに流します（読むだけ。YouTube に書き込むことはありません）。'),
      field('API キー（YouTube Data API v3）', key),
      keyMsg,
      h('label', { class: 'check-line' }, showKey, h('span', {}, 'キーを表示')),
      h('p', { class: 'obs-warn' }, '⚠ API キーはこのパソコンのこのブラウザにだけ保存します（YouTube の API 以外には送りません。書き出しにも入りません）。共用のパソコンでは使い終わったら消してください。'),
      field('チャンネル', channel, '（登録すると、配信の URL を空にして「開始」したとき、このチャンネルの今の配信を自動で探します）'),
      chMsg,
      field('取得方式', mode, '（プッシュはコメントがすぐ届きます。使えないときは自動で数秒ごとに切り替わります）'),
      field('取得間隔（数秒ごとのとき）', interval, '（短いほど早く出ますが、1 日の上限を早く使います）'),
      h('p', { class: 'muted yc-quota', dataset: { key: 'yc-quota' } }, quotaText(app)),
      h('p', { class: 'muted' }, '流れる範囲・固定コメントの位置と大きさ・列の数・文字・速さは、このページの「レイアウト」で見ながら変えます（変えるとすぐ OBS に出て、自動で保存されます）。'),
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
          h('li', {}, '配信中は［コメント］のページを「別ウィンドウで開く」と、進行と並べて使えます（取得はどちらか 1 つのウィンドウがまとめてします）。'),
          h('li', {}, '配信が始まったら、配信の URL を入れて「開始」（チャンネルを登録していれば URL は空のままで、今の配信を自動で探します）。開始する前のコメントは一覧にだけ入り、画面には流しません。'),
          h('li', {}, '一覧の［固定］で中央に大きく出します（もう一度［固定を外す］）。［画面から消す］はそのコメントを画面から消します。「画面に流す」を外すと、取得は続けたまま流すのを止めます。'),
          h('li', {}, 'YouTube で削除されたコメント・BAN された人のコメントは、一覧・画面から自動で消えます。')))));
  return dlg;
}
