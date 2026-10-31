// ④ 振り返り: 読んだ／飛ばした／来週へ の一覧と、台本のテキスト書き出し（告知・概要欄用）。
import { reviewLists, scriptText, cornerDef } from '../logic.js';
import { h, btn, downloadText } from '../dom.js';
import { cueColor, currentTitle } from './common.js';
import { cueTitle } from './live.js';

export function renderReview(app) {
  const wk = app.weekState();
  const lists = reviewLists(wk.live, app.cues);
  const root = h('div', { class: 'review wrap' });
  root.append(h('div', { class: 'sec-head' }, h('h2', { class: 'sec-title' }, '振り返り'), h('p', { class: 'sec-note' }, currentTitle(app)),
    h('p', { class: 'sec-note', dataset: { key: 'review-range' } }, `対象期間：${app.range ? app.range.label : ''}`)));
  const cols = h('div', { class: 'review-cols' });
  for (const [key, label, color] of [['done', '読んだ', 'main'], ['skipped', '飛ばした', 'review'], ['carried', '来週へ', 'kabuki'], ['todo', 'まだ', 'white']]) {
    const items = lists[key];
    cols.append(h('section', { class: `tile g-${color} review-col`, dataset: { list: key }, attrs: { 'aria-label': label } },
      h('h3', { class: 'tile-head' }, `${label}（${items.length}）`),
      items.length
        ? h('ul', { class: 'review-list' }, items.map((c) => h('li', {}, h('span', { class: `dot g-${cueColor(app, c)}`, attrs: { 'aria-hidden': 'true' } }), c.kind === 'topic' ? h('span', { class: 'muted-inline' }, `${cornerDef(c.cornerKey).name}：`) : null, cueTitle(app, c))))
        : h('p', {}, '該当なし')));
  }
  root.append(cols);

  const args = {
    title: currentTitle(app), week: app.week, rundown: wk.rundown, topicsById: app.topicsById, script: wk.script,
    notes: wk.notes, postsById: app.postsById, refTs: app.ds.refTs, rangeLabel: app.range ? app.range.label : null,
  };
  for (const [mode, label, note] of [
    ['public', '告知・概要欄用', '見出し・リード文・チャプター・投稿URL（話すポイントやメモは入りません）'],
    ['full', '台本（全文）', '話すポイント・視聴者への質問・メモも入ります（自分用）'],
  ]) {
    const text = scriptText({ ...args, mode });
    const ta = h('textarea', { class: 'input export-text', rows: 14, readOnly: true, value: text, dataset: { key: `export-${mode}` }, attrs: { 'aria-label': label } });
    const copy = btn('コピー', async () => {
      try { await navigator.clipboard.writeText(ta.value); copy.textContent = 'コピーしました'; } catch { ta.select(); copy.textContent = '選択しました（Ctrl+C でコピー）'; }
    }, 'btn btn-small');
    root.append(h('section', { class: 'card export', dataset: { mode } },
      h('div', { class: 'sec-head' }, h('h2', { class: 'sec-title' }, label), h('p', { class: 'sec-note' }, note)),
      ta,
      h('div', { class: 'row' }, copy, btn('テキストで保存', () => downloadText(`show-${app.weekKey}-${mode}.txt`, ta.value, 'text/plain'), 'btn btn-small'))));
  }
  return root;
}
