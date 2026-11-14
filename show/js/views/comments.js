// ［コメント］ページ: YouTube ライブのコメントをリアルタイムに操作する（配信中は別ウィンドウで開くことが多い）。
// 上のバー（状態・URL・開始/停止・画面に流す・OBS・設定・別ウィンドウ）／一覧（固定中・絞り込み・固定・画面から消す）／レイアウト（その場で調整）。
// 1200px 以上は 2 列（一覧 4：レイアウト 6）、それより狭いと縦に並べる（一覧は高さ約 45vh）。
import { h } from '../dom.js';
import { commentsTopBar, commentsLogColumn, chatSettingsDialog } from './chatui.js';
import { layoutHolder } from './layouteditor.js';
import { obsDialog } from './obsui.js';

export function renderComments(app) {
  const root = h('div', { class: 'cmp', dataset: { keep: `comments:${app.weekKey}` } });
  root.append(commentsTopBar(app));
  root.append(h('div', { class: 'cmp-grid', dataset: { keep: 'cmp-grid' } }, commentsLogColumn(app), layoutHolder()));
  const showModal = () => { for (const d of document.querySelectorAll('#view dialog[data-modal]')) if (!d.open && typeof d.showModal === 'function') d.showModal(); };
  if (app.ui.ycDlg) { root.append(chatSettingsDialog(app)); app.afterRender = showModal; }
  if (app.ui.obsDlg) { root.append(obsDialog(app)); app.afterRender = showModal; }
  return root;
}

/** このページのキー操作（レイアウトの矢印キー・Ctrl+Z はパネルの中で受ける） */
export function commentsKeydown() {}
