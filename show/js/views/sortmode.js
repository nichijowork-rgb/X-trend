// 仕分けモード: 受信箱・検索結果・任意のフォルダの投稿を 1 件ずつ大きく見て、キーで振り分ける。
// キー: 1 メイン候補 / 2 カテゴリ別 / 3 雑談 / G ジャンル（夜職⇄一般）/ X いらない（片付け）/ → 保留して次 / ← 前 / Esc 終了。
// 各操作は「元に戻す」（Ctrl+Z）で戻せる。
import { GENRES } from '../config.js';
import { applyDrop, sortProgress, toggledGenre, isNightGenre } from '../folders.js';
import { setPostGenre, postGenre, genreLabel, statusUrl } from '../logic.js';
import { h, btn, genreSticker, postCard, embedHost, linkCard } from '../dom.js';
import { refYear, bmInfo } from './common.js';

/** 仕分けを始める（rows: 一覧の行。投稿とまとまり） */
export function startSort(app, rows, sourceLabel) {
  const items = rows.filter((r) => r.type === 'post' || r.type === 'topic');
  if (!items.length) { app.toast('仕分けする投稿がありません'); return; }
  app.ui.sort = { items, index: 0, decisions: new Map(), source: sourceLabel };
  app.render();
}

function current(app) {
  const s = app.ui.sort;
  return s ? s.items[s.index] || null : null;
}

function next(app) {
  const s = app.ui.sort;
  s.index = Math.min(s.index + 1, s.items.length);
}

function decide(app, label, target) {
  const s = app.ui.sort;
  const it = current(app);
  if (!it) return;
  if (target) {
    let res = null;
    app.edit(`仕分け：${label}`, (w, sv) => {
      res = applyDrop(w, sv, [it], target, { topicsById: app.topicsById, postTopic: app.postTopic, postsById: app.postsById, weekKey: app.weekKey, now: Date.now() });
    }, { render: false });
    if (res && !res.ok) { app.toast(res.message); app.render(); return; }
  }
  s.decisions.set(it.key, label);
  next(app);
  app.render();
}

function changeGenre(app, genre = null) {
  const it = current(app);
  if (!it) return;
  if (it.type === 'post') {
    const p = app.postsById.get(it.id);
    const cur = postGenre(p);
    const orig = app.origGenreOf(it.id);
    const g = genre || toggledGenre(cur, orig);
    app.edit(`ジャンル変更：${genreLabel(g)}`, (w, sv) => { setPostGenre(sv, [it.id], g, Date.now(), app.origGenreOf); });
  } else {
    const t = app.topicsById.get(it.id);
    if (!t) return;
    const g = genre || toggledGenre(t.genre, null);
    app.edit(`ジャンル変更：${genreLabel(g)}`, (w) => { w.overrides.genres[t.id] = g; });
  }
  app.ui.sort.decisions.set(it.key, app.ui.sort.decisions.get(it.key) || 'ジャンル変更');
}

/** 仕分けモードのキー操作。処理したら true */
export function sortKeydown(app, e) {
  if (!app.ui.sort) return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  const k = e.key;
  const done = () => { e.preventDefault(); e.stopPropagation(); return true; };
  if (k === 'Escape') { app.ui.sort = null; app.render(); return done(); }
  if (k === '1') { decide(app, 'メイン候補', 'cand'); return done(); }
  if (k === '2') { decide(app, 'カテゴリ別', 'corner:category'); return done(); }
  if (k === '3') { decide(app, '雑談', 'corner:chat'); return done(); }
  if (k === 'x' || k === 'X') { decide(app, 'いらない（片付け）', 'shelf'); return done(); }
  if (k === 'g' || k === 'G') { changeGenre(app); return done(); }
  if (k === 'ArrowRight') { decide(app, '保留', null); return done(); }
  if (k === 'ArrowLeft') { app.ui.sort.index = Math.max(0, app.ui.sort.index - 1); app.render(); return done(); }
  return false;
}

export function sortDialog(app) {
  const s = app.ui.sort;
  const it = current(app);
  const prog = sortProgress(s.items, s.decisions, s.index);
  const close = () => { app.ui.sort = null; app.render(); };
  const dlg = h('dialog', { class: 'sort-dialog', attrs: { 'data-modal': '', 'aria-labelledby': 'sort-title' }, dataset: { keep: 'sort' } });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.append(h('header', { class: 'sort-head' },
    h('h2', { id: 'sort-title' }, '仕分けモード', h('span', { class: 'sort-src' }, `（${s.source}）`)),
    h('p', { class: 'sort-prog', attrs: { role: 'status' }, dataset: { key: 'sort-progress' } }, it ? `${prog.pos} / ${prog.total}件` : `${prog.total} / ${prog.total}件`, `　残り ${prog.remaining}件`),
    h('div', { class: 'sort-bar', attrs: { 'aria-hidden': 'true' } }, h('span', { style: `width:${prog.total ? Math.round((prog.done / prog.total) * 100) : 0}%` })),
    btn('終了（Esc）', close, 'btn btn-small btn-ghost', { 'data-key': 'sort-close' })));
  const body = h('div', { class: 'sort-body', dataset: { keep: 'sort-body' } });
  if (!it) {
    const counts = new Map();
    for (const v of s.decisions.values()) counts.set(v, (counts.get(v) || 0) + 1);
    body.append(h('div', { class: 'sort-end' }, h('h3', {}, 'おわり！'),
      h('p', {}, `${s.decisions.size}件を仕分けました。`),
      h('ul', {}, [...counts].map(([k, n]) => h('li', {}, `${k}：${n}件`))),
      h('div', { class: 'row' }, btn('最初から見直す', () => { s.index = 0; app.render(); }, 'btn btn-small'), btn('閉じる', close, 'btn btn-small btn-red', { 'data-key': 'sort-done' }))));
    dlg.append(body);
    return dlg;
  }
  const decided = s.decisions.get(it.key);
  let genre;
  let title;
  let postId;
  let meta = '';
  if (it.type === 'post') {
    const p = app.postsById.get(it.id);
    genre = p ? postGenre(p) : 'general';
    title = p ? `@${p.user}` : `ID ${it.id}`;
    postId = it.id;
    const t = app.topicsById.get(app.postTopic.get(it.id));
    meta = t && t.postIds.length > 1 ? `まとまり「${t.name}」の投稿` : '';
  } else {
    const t = app.topicsById.get(it.id);
    genre = t ? t.genre : 'night';
    title = t ? t.name : '（見つからない話題）';
    postId = t ? (t.stats.topPostId || t.linkId) : null;
    meta = t ? `まとまり・${t.stats.count}件` : '';
  }
  const p = postId ? app.postsById.get(postId) : null;
  const own = p ? postCard(p, { refTs: app.ds.refTs, refYear: refYear(app), noActions: true, bm: bmInfo(app, p.id) }) : (postId ? linkCard(postId, statusUrl(postId), null) : h('p', { class: 'muted' }, '投稿がありません'));
  body.append(h('div', { class: `sort-item-head g-${genre}` }, genreSticker(genre, { small: true }), h('b', { class: 'sort-item-title' }, title), meta ? h('span', { class: 'sort-meta' }, meta) : null,
    decided ? h('span', { class: 'badge badge-me' }, `済：${decided}`) : null));
  body.append(h('div', { class: 'sort-post', dataset: { keep: `sp:${it.key}` } }, postId && app.ui.view !== 'card' ? embedHost(postId, own, 'sort-embed') : own));
  dlg.append(body);
  const k = (label, key, cls, run, dk) => btn(h('span', {}, h('kbd', {}, key), ' ', label), run, `btn sort-key ${cls}`, { 'data-key': dk });
  dlg.append(h('footer', { class: 'sort-keys', attrs: { role: 'group', 'aria-label': '仕分けの操作' } },
    k('メイン候補', '1', 'k-main', () => decide(app, 'メイン候補', 'cand'), 'sort-1'),
    k('カテゴリ別', '2', 'k-cat', () => decide(app, 'カテゴリ別', 'corner:category'), 'sort-2'),
    k('雑談', '3', 'k-chat', () => decide(app, '雑談', 'corner:chat'), 'sort-3'),
    k(isNightGenre(genre) ? '一般のバズへ' : '夜職へ', 'G', 'k-genre', () => changeGenre(app), 'sort-g'),
    k('いらない', 'X', 'k-x', () => decide(app, 'いらない（片付け）', 'shelf'), 'sort-x'),
    k('前', '←', 'k-prev', () => { s.index = Math.max(0, s.index - 1); app.render(); }, 'sort-prev'),
    k('保留して次', '→', 'k-next', () => decide(app, '保留', null), 'sort-next')),
  h('div', { class: 'sort-genres', attrs: { role: 'group', 'aria-label': 'ジャンルを選ぶ' } }, h('span', { class: 'muted' }, 'ジャンル：'),
    GENRES.map((g) => btn(g.label, () => changeGenre(app, g.key), `btn btn-small chip${g.key === genre ? ' is-on' : ''}`, { 'data-key': `sort-genre-${g.key}`, 'aria-pressed': String(g.key === genre) }))));
  return dlg;
}
