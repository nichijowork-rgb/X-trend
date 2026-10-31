// OBS 連携の画面部品（段階2）: 接続設定ダイアログ（進行画面）とセットアップガイド（#obs-setup）。
import { h, btn, field } from '../dom.js';
import { LAYOUT_GUIDE, OVERLAY_PARTS } from '../overlayinfo.js';

const STATE_LABEL = { idle: '未接続', connecting: '接続中…', connected: '接続済み', error: 'エラー' };

export function obsStatusLabel(s) {
  return `OBS：${STATE_LABEL[s.state] || '未接続'}`;
}

/** 状態の表示（ダイアログ内。状態が変わったらこの要素だけ差し替える） */
export function obsStatusEl(s) {
  return h('p', { class: `obs-state is-${s.state}`, attrs: { role: 'status' }, dataset: { key: 'obs-state' } },
    h('b', {}, obsStatusLabel(s)), s.obsVersion && s.state === 'connected' ? `（obs-websocket ${s.obsVersion}）` : '', s.reason ? h('span', { class: 'obs-reason' }, s.reason) : null);
}

/** 状態が変わったとき、開いているダイアログを入力を消さずに更新する */
export function refreshObsDialog(s) {
  const old = document.querySelector('.obs-dialog [data-key="obs-state"]');
  if (old) old.replaceWith(obsStatusEl(s));
  const c = document.querySelector('.obs-dialog [data-key="obs-connect"]');
  if (c) c.textContent = connectLabel(s);
  const d = document.querySelector('.obs-dialog [data-key="obs-disconnect"]');
  if (d) d.disabled = s.state === 'idle';
}

const connectLabel = (s) => (s.state === 'connected' || s.state === 'connecting' ? 'つなぎ直す' : '接続');

/** 接続設定ダイアログ */
export function obsDialog(app) {
  const prefs = app.obsPrefs;
  const s = app.obs ? app.obs.status() : { state: 'idle', reason: '' };
  const close = () => { app.ui.obsDlg = false; app.render(); };
  const dlg = h('dialog', { class: 'obs-dialog', attrs: { 'data-modal': '', 'aria-labelledby': 'obs-title' }, dataset: { keep: 'obs-dialog' } });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  const host = h('input', { class: 'input', type: 'text', value: prefs.host, dataset: { key: 'obs-host' }, attrs: { autocomplete: 'off', spellcheck: 'false' } });
  const port = h('input', { class: 'input', type: 'number', min: 1, max: 65535, value: String(prefs.port), dataset: { key: 'obs-port' } });
  const pass = h('input', { class: 'input', type: 'password', value: prefs.password, dataset: { key: 'obs-password' }, attrs: { autocomplete: 'off' } });
  const showPass = h('input', { type: 'checkbox', dataset: { key: 'obs-show-pass' } });
  showPass.addEventListener('change', () => { pass.type = showPass.checked ? 'text' : 'password'; });
  const auto = h('input', { type: 'checkbox', checked: prefs.auto, dataset: { key: 'obs-auto' } });
  const values = () => ({ host: host.value.trim(), port: Number(port.value), password: pass.value, auto: auto.checked });
  const stateText = obsStatusEl(s);
  dlg.append(
    h('header', { class: 'move-head' }, h('h2', { id: 'obs-title' }, 'OBS と連動'), btn('閉じる', close, 'btn btn-small btn-ghost', { 'data-key': 'obs-close' })),
    h('div', { class: 'obs-body' },
      h('p', { class: 'muted' }, 'この進行画面から OBS（WebSocket）へ、進行に合わせた表示の指示を送ります。OBS には「ブラウザソース」でオーバーレイのパーツを貼ってください（下の「セットアップガイド」）。'),
      stateText,
      h('div', { class: 'obs-grid' }, field('ホスト', host), field('ポート', port)),
      field('パスワード', pass, '（OBS の「ツール → WebSocket サーバー設定」）'),
      h('label', { class: 'check-line' }, showPass, h('span', {}, 'パスワードを表示')),
      h('label', { class: 'check-line' }, auto, h('span', {}, '切れたら自動でつなぎ直す')),
      h('p', { class: 'obs-warn' }, '⚠ パスワードはこのパソコンのこのブラウザにだけ、暗号化せずに保存します（ほかへは送りません）。共用のパソコンでは使い終わったら消してください。'),
      h('div', { class: 'row' },
        btn(connectLabel(s), () => app.obsConnect(values()), 'btn btn-small btn-red', { 'data-key': 'obs-connect' }),
        btn('切断', () => app.obsDisconnect(), 'btn btn-small', { 'data-key': 'obs-disconnect', disabled: s.state === 'idle' }),
        btn('テスト表示', () => app.obsTest(), 'btn btn-small', { 'data-key': 'obs-test', title: 'テストの話題・投稿カード・コーナータイトルをオーバーレイに出します' }),
        btn('パスワードを消す', () => { pass.value = ''; app.obsSavePrefs({ ...values(), password: '' }); app.render(); }, 'btn btn-small btn-ghost', { 'data-key': 'obs-forget' })),
      h('details', { class: 'obs-help' }, h('summary', {}, 'つながらないとき'),
        h('ul', {},
          h('li', {}, 'OBS が起動しているか、「ツール → WebSocket サーバー設定」で「WebSocket サーバーを有効にする」がオンか（ポートは既定 4455）。'),
          h('li', {}, 'パスワードが OBS の設定と同じか（「接続情報を表示」で確認できます）。'),
          h('li', {}, 'Chrome で初めてつなぐときに「このサイトがデバイス上の他のアプリにアクセスしようとしています」などの確認が出たら「許可」。出ないとき・拒否したときは、アドレスバー左のアイコン → サイトの設定 →「デバイス上のアプリ（ローカル ネットワーク）」を「許可」に。'),
          h('li', {}, 'OBS と同じパソコンで開いているか（ホストは 127.0.0.1 のまま）。'))),
      h('p', {}, h('a', { href: '#obs-setup', class: 'btn btn-small btn-ghost', dataset: { key: 'obs-guide' }, on: { click: () => { app.ui.obsDlg = false; } } }, 'セットアップガイド（パーツの URL・配置）を開く'))));
  return dlg;
}

/** セットアップガイド（#obs-setup） */
export function renderObsSetup(app) {
  const root = h('div', { class: 'obs-setup wrap', dataset: { keep: `obs-setup:${app.weekKey}` } });
  const base = new URL('overlay.html', location.href);
  const urlOf = (q) => { const u = new URL(base); u.search = q; return u.toString(); };
  const s = app.obs ? app.obs.status() : { state: 'idle' };
  root.append(h('div', { class: 'sec-head' }, h('h2', { class: 'sec-title' }, 'OBS セットアップガイド'),
    btn(`${obsStatusLabel(s)}（設定を開く）`, () => { app.ui.obsDlg = true; app.render(); }, 'btn btn-small', { 'data-key': 'setup-obs-open' })));
  root.append(h('ol', { class: 'setup-steps' },
    h('li', {}, h('b', {}, 'OBS の WebSocket を有効にする：'), 'OBS の「ツール → WebSocket サーバー設定」で「WebSocket サーバーを有効にする」をオン。ポートは 4455 のまま、「認証を有効にする」をオンにしてパスワードを決める（「接続情報を表示」でコピーできます）。'),
    h('li', {}, h('b', {}, 'この番組サイトからつなぐ：'), '［進行］か、この画面の右上の「OBS：未接続」を押し、パスワードを入れて「接続」。Chrome の許可の確認が出たら「許可」。「接続済み」になれば OK。「テスト表示」でオーバーレイに見本が出ます。'),
    h('li', {}, h('b', {}, 'パーツを貼る：'), 'OBS の「ソース → ＋ → ブラウザ」で、下の URL と幅・高さを入れる（「ページの権限」は既定のまま。「カスタム CSS」は空でもかまいません。背景は透明です）。パーツごとに 1 つずつ貼り、位置と大きさは自由に動かせます。'),
    h('li', {}, h('b', {}, '配置：'), '下の参考配置のように、コメント（CastCraft）・どね/スパチャのバー（Doneru）・LINE・イラストと重ならない場所へ。')));
  const table = h('div', { class: 'setup-parts' });
  for (const p of OVERLAY_PARTS) {
    const url = urlOf(`part=${p.key}`);
    const copy = btn('URL をコピー', async () => {
      try { await navigator.clipboard.writeText(url); copy.textContent = 'コピーしました'; } catch { copy.textContent = '選んで Ctrl+C でコピー'; }
    }, 'btn btn-small', { 'data-key': `copy-${p.key}` });
    table.append(h('section', { class: 'setup-part' },
      h('h3', {}, p.name, h('span', { class: 'setup-size' }, `推奨 ${p.w}×${p.h}`)),
      h('p', { class: 'muted' }, p.desc),
      h('div', { class: 'setup-url' }, h('input', { class: 'input input-sm', type: 'text', readOnly: true, value: url, dataset: { key: `url-${p.key}` }, attrs: { 'aria-label': `${p.name}の URL` } }), copy,
        h('a', { class: 'btn btn-small btn-ghost', href: urlOf(`part=${p.key}&demo=1`), target: '_blank', rel: 'noopener' }, '見本を開く'))));
  }
  root.append(h('h3', { class: 'sub-title' }, 'パーツ（ブラウザソースに 1 つずつ）'), table);
  root.append(h('p', { class: 'muted' }, 'オプション（URL の後ろに付ける）: ', h('code', {}, '&scale=1.2'), '（拡大）・', h('code', {}, '&motion=off'), '（動きを止める。演出はフェードだけ）・', h('code', {}, '&demo=1'), '（見本を表示。配置の確認用。演出は ', h('code', {}, '&demo=1&fx=confetti'), ' など）・', h('code', {}, '&sound=on'), '（演出の効果音を鳴らす。演出パーツだけ）。全部入りの確認用: ', h('code', {}, 'part=all')));
  root.append(h('h3', { class: 'sub-title' }, '演出（拍手・紙吹雪・神回！・えぇっ！？・炎上・感謝バナー）'));
  root.append(h('ul', { class: 'setup-steps setup-fx' },
    h('li', {}, '「演出」パーツ（', h('code', {}, 'part=fx'), '・1920×1080）をいちばん上に貼ります。出し方は［進行］の「演出 ▸」を開いてボタンを押すか、キーボードの Shift+1〜6（1 拍手・2 紙吹雪・3 神回！・4 えぇっ！？・5 炎上・6 感謝バナー）。名前・金額の欄で Enter でも感謝バナーが出ます。'),
    h('li', {}, '効果音は既定で鳴りません。鳴らすときは URL に ', h('code', {}, '&sound=on'), ' を付け、OBS のブラウザソースのプロパティで「OBS で音声を制御」をオンにすると、音声ミキサーで音量を調整できます（音声ファイルは使わず、その場で合成します）。'),
    h('li', {}, 'Stream Deck などのボタンから出すときは「ホットキー」で Shift+1〜6 を送ります。キーは進行画面のブラウザのウィンドウが前面（フォーカスがある状態）のときだけ届きます。名前・金額の入力欄にカーソルがあるときはキーは効きません。'),
    h('li', {}, '同じ演出は 1 秒以内の連打を無視、同時に出るのは 3 つまで。Doneru のアラートと重ならないよう、感謝バナーはトピック帯のすぐ上に細く出ます。スタンプは中央〜右寄り、紙吹雪は全面。')));
  // 参考配置図（1920×1080 を縮小）
  const fig = h('figure', { class: 'setup-fig' });
  const canvas = h('div', { class: 'setup-canvas', attrs: { role: 'img', 'aria-label': '参考配置図' } });
  for (const g of LAYOUT_GUIDE) {
    const b = h('div', { class: `setup-box ${g.ours ? 'is-ours' : 'is-other'}${g.key ? ` part-${g.key}` : ''}${g.fx ? ` part-fx-${g.fx}` : ''}` }, h('span', {}, g.label));
    Object.assign(b.style, { left: `${(g.x / 1920) * 100}%`, top: `${(g.y / 1080) * 100}%`, width: `${(g.w / 1920) * 100}%`, height: `${(g.h / 1080) * 100}%` });
    canvas.append(b);
  }
  fig.append(canvas, h('figcaption', { class: 'muted' }, '参考配置（1920×1080）。灰色＝ほかのツール（重ねない）、色つき＝この番組サイトのパーツ。コーナータイトルは全面に数秒だけ出ます。CastCraft のコメント吹き出しは投稿カードと重なることがあるので、吹き出しを出す間はカードを「隠し中」にするか、吹き出しを左寄せにしてください。'));
  root.append(h('h3', { class: 'sub-title' }, '参考配置'), fig);
  root.append(h('p', { class: 'muted' }, '※ 進行画面（またはこの画面）を開いている間だけ、オーバーレイへ進行状態を送ります（変化したとき＋5 秒おき）。OBS を後から開いても数秒で追いつきます。'));
  if (app.ui.obsDlg) {
    root.append(obsDialog(app));
    app.afterRender = () => { for (const d of document.querySelectorAll('#view dialog[data-modal]')) if (!d.open && typeof d.showModal === 'function') d.showModal(); };
  }
  return root;
}
