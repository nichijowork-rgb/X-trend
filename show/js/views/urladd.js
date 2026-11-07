// 「＋URLで追加」: まとまりに X の投稿 URL（複数行・スペース区切り可）から投稿を足す（編成・進行で共通）。
import { h, btn } from '../dom.js';

/** ダイアログ。app.ui.urlDlg = { topicId, text, msg, conflicts } */
export function urlAddDialog(app) {
  const u = app.ui;
  const d = u.urlDlg;
  const t = app.topicsById.get(d.topicId);
  const close = () => { u.urlDlg = null; app.render(); };
  const dlg = h('dialog', { class: 'name-dialog url-dialog', attrs: { 'data-modal': '', 'aria-labelledby': 'url-title' }, dataset: { keep: 'url-dialog' } });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  const ta = h('textarea', { class: 'input', rows: 4, value: d.text || '', placeholder: 'https://x.com/…/status/… を貼り付け（複数行・スペース区切りで何件でも。fxtwitter・vxtwitter も可）', dataset: { key: 'url-input' }, attrs: { 'aria-label': '投稿の URL' } });
  ta.addEventListener('input', () => { d.text = ta.value; });
  const run = (move) => {
    const r = app.addUrlsToTopic(d.topicId, ta.value, move);
    const res = r.result || { added: [], missing: [], moved: [], dup: [], conflicts: [] };
    const parts = [];
    if (res.added.length) parts.push(`${res.added.length}件追加`);
    if (res.missing.length) parts.push(`データに無い投稿 ${res.missing.length}件を追加（埋め込みで表示）`);
    if (res.moved.length) parts.push(`${res.moved.length}件を別のまとまりから移動`);
    if (res.dup.length) parts.push(`すでにある ${res.dup.length}件は飛ばしました`);
    if (r.invalid.length) parts.push(`読み取れなかったもの ${r.invalid.length}件：${r.invalid.slice(0, 5).join(' ')}${r.invalid.length > 5 ? ' …' : ''}`);
    if (!move && res.conflicts.length) {
      d.conflicts = res.conflicts;
      d.msg = { kind: 'warn', text: parts.join('・') };
      app.render();
      return;
    }
    if (!parts.length) parts.push('URL が見つかりませんでした（x.com／twitter.com の投稿の URL を貼ってください）');
    const ok = res.added.length + res.missing.length + res.moved.length > 0;
    if (ok && !r.invalid.length) { u.urlDlg = null; app.render(); return; }
    d.conflicts = null;
    d.msg = { kind: ok ? 'ok' : 'error', text: parts.join('・') };
    if (ok) d.text = r.invalid.join('\n');
    app.render();
  };
  dlg.append(h('h2', { id: 'url-title' }, `URL で追加：${t ? t.name : ''}`),
    h('p', { class: 'muted' }, 'posts.json にある投稿はその投稿として、無い投稿は「データに無い投稿」（X の埋め込みで表示）として、このまとまりに入れます。Ctrl+Z で戻せます。'),
    ta);
  if (d.msg) dlg.append(h('p', { class: `import-msg is-${d.msg.kind}`, attrs: { role: 'status' }, dataset: { key: 'url-msg' } }, d.msg.text));
  if (d.conflicts && d.conflicts.length) {
    dlg.append(h('div', { class: 'url-conflict', dataset: { key: 'url-conflict' } },
      h('p', {}, `次の ${d.conflicts.length}件は別のまとまりに入っています。このまとまりへ移動しますか？`),
      h('ul', {}, d.conflicts.slice(0, 10).map((c) => h('li', {}, `ID ${c.id}（今は「${(app.topicsById.get(c.from) || {}).name || c.from}」）`))),
      h('div', { class: 'row' },
        btn('移動する', () => run(true), 'btn btn-small btn-red', { 'data-key': 'url-move-yes' }),
        btn('移動しない', () => { d.conflicts = null; d.msg = null; app.render(); }, 'btn btn-small btn-ghost', { 'data-key': 'url-move-no' }))));
  }
  dlg.append(h('div', { class: 'row' },
    btn('追加', () => run(false), 'btn btn-red', { 'data-key': 'url-ok' }),
    btn('閉じる', close, 'btn btn-ghost', { 'data-key': 'url-cancel' })));
  requestAnimationFrame(() => { if (ta.isConnected && !d.focused) { d.focused = true; ta.focus(); } });
  return dlg;
}
