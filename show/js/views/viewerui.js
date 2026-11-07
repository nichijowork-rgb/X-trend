// 「投稿を開くウィンドウ」の設定（進行の［開く窓］ダイアログと、編成の［ツール…］の中）。
import { h, btn, field } from '../dom.js';
import { VIEWER_PRESETS, viewerRect } from '../viewer.js';

/** 設定の中身（ダイアログとツールで共通） */
export function viewerSettings(app) {
  const p = app.viewerPrefs;
  const box = h('div', { class: 'viewer-set', dataset: { key: 'viewer-set' } });
  const save = (v) => { app.saveViewerPrefs(v); app.render(); };
  // 画面（モニター）: Window Management API が使えるときだけ
  const canScreens = typeof window.getScreenDetails === 'function';
  const screens = app.screens || [];
  if (canScreens) {
    const sel = h('select', { class: 'input input-sm', dataset: { key: 'viewer-screen' }, attrs: { 'aria-label': '表示する画面' } },
      h('option', { value: '', selected: !p.screen }, 'このウィンドウの画面'),
      screens.map((x, i) => h('option', { value: String(i), selected: Boolean(p.screen && p.screen.left === x.left && p.screen.top === x.top && p.screen.width === x.width) }, `${x.label}（${x.width}×${x.height}${x.primary ? '・メイン' : ''}）`)));
    sel.addEventListener('change', () => save({ screen: sel.value === '' ? null : screens[Number(sel.value)] }));
    box.append(h('div', { class: 'row' }, field('表示する画面（モニター）', sel),
      btn(screens.length ? '画面を読み直す' : '画面の一覧を読み込む', async () => { const r = await app.loadScreens(); if (!r) app.toast('画面の一覧を読めませんでした（ブラウザの「ウィンドウの管理」を許可してください）'); app.render(); }, 'btn btn-small', { 'data-key': 'viewer-screens', title: '初めて押すとブラウザが「ウィンドウの管理」の許可を求めます' })));
  } else {
    box.append(h('p', { class: 'muted' }, 'このブラウザでは画面（モニター）を選べません。位置と大きさを数値で指定してください（Chrome なら画面を選べます）。'));
  }
  const preset = h('div', { class: 'row viewer-presets', attrs: { role: 'group', 'aria-label': '位置' } },
    VIEWER_PRESETS.map((x) => btn(x.label, () => save({ preset: x.key }), `btn btn-small${p.preset === x.key ? ' btn-dark is-on' : ' btn-ghost'}`, { 'data-key': `viewer-preset-${x.key}`, 'aria-pressed': String(p.preset === x.key) })));
  box.append(preset);
  const numIn = (k, label) => {
    const i = h('input', { class: 'input input-sm', type: 'number', value: String(p[k]), dataset: { key: `viewer-${k}` }, attrs: { 'aria-label': label } });
    i.addEventListener('change', () => save({ [k]: Number(i.value), preset: 'custom' }));
    return field(label, i);
  };
  box.append(h('div', { class: 'viewer-grid' }, numIn('left', '左'), numIn('top', '上'), numIn('width', '幅'), numIn('height', '高さ')));
  const r = viewerRect(p, window.screen);
  box.append(h('p', { class: 'muted', dataset: { key: 'viewer-rect' } }, `開く位置：左 ${r.left}・上 ${r.top}・幅 ${r.width}・高さ ${r.height}（毎回同じウィンドウを使い回します）`));
  const catcher = h('input', { type: 'checkbox', checked: p.catcher, dataset: { key: 'viewer-catcher' } });
  catcher.addEventListener('change', () => save({ catcher: catcher.checked }));
  const onClick = h('input', { type: 'checkbox', checked: p.openOnClick, dataset: { key: 'viewer-onclick' } });
  onClick.addEventListener('change', () => save({ openOnClick: onClick.checked }));
  box.append(
    h('label', { class: 'check-line' }, catcher, h('span', {}, '進行の埋め込みの上にクリック受けを重ねる（クリックで今の投稿にする。動画の再生などは各カードの「埋め込みを操作」）')),
    h('label', { class: 'check-line' }, onClick, h('span', {}, '進行で投稿をクリックしたら、このウィンドウでも開く')),
    h('div', { class: 'row' }, btn('試しに開く', () => app.openViewer('https://x.com/'), 'btn btn-small', { 'data-key': 'viewer-test' })),
    h('p', { class: 'muted' }, '「ポップアップがブロックされました」と出たら、アドレスバー右のアイコンから、このサイトのポップアップを「常に許可」にしてください。'));
  return box;
}

/** 進行の［開く窓］ダイアログ */
export function viewerDialog(app) {
  const close = () => { app.ui.viewerDlg = false; app.render(); };
  const dlg = h('dialog', { class: 'obs-dialog viewer-dialog', attrs: { 'data-modal': '', 'aria-labelledby': 'viewer-title' }, dataset: { keep: 'viewer-dialog' } });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.append(h('header', { class: 'move-head' }, h('h2', { id: 'viewer-title' }, '投稿を開くウィンドウ'), btn('閉じる', close, 'btn btn-small btn-ghost', { 'data-key': 'viewer-close' })),
    h('div', { class: 'obs-body' }, h('p', { class: 'muted' }, '「X で開く」や投稿のリンクは、新しいタブではなく、ここで決めた位置・大きさの専用ウィンドウで開きます（編成画面も同じ）。'), viewerSettings(app)));
  return dlg;
}
