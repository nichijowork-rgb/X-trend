// ② 進行（配信中）画面。キーボード: →/Enter 読んだ、← 戻す、S 飛ばす、L 来週へ、J/↓・K/↑ 映す投稿を次・前へ、Shift+1〜6 演出。
import { computeTimer, formatClock, cornerDef, cueStates, showablePostIds, liveShownPost, stepShownPost, repPostId, statusUrl } from '../logic.js';
import { h, btn, genreSticker, isEditable, prefersReducedMotion, postCard, linkCard, embedHost } from '../dom.js';
import { genreIcon } from '../icons.js';
import { cueColor, leadFor, leadIsBot, topicMarks, repPostCard, statsLine, refYear, bmInfo } from './common.js';
import { obsDialog } from './obsui.js';
import { EFFECTS, THANKS_LIMITS, effectDef } from '../effects.js';

const STATUS_LABEL = { done: '済', skipped: '飛ばした', carried: '来週へ', current: '進行中', todo: '' };

export function cueTitle(app, cue) {
  if (!cue) return '';
  const def = cornerDef(cue.cornerKey);
  if (cue.kind === 'topic') {
    const t = app.topicsById.get(cue.topicId);
    return t ? t.name : '（見つからない話題）';
  }
  if (cue.kind === 'empty') return `${def.name}（話題が未設定）`;
  return def.name;
}

export function renderLive(app) {
  const wk = app.weekState();
  const live = wk.live;
  const cues = app.cues;
  const cue = cues[live.index] || null;
  const color = cue ? cueColor(app, cue) : 'white';
  const def = cue ? cornerDef(cue.cornerKey) : null;
  const topic = cue && cue.kind === 'topic' ? app.topicsById.get(cue.topicId) : null;
  // 画面半分（960px）向けの縦 1 列: 細い進行バー → 現在の話題（大）＋タイマー → 代表投稿 → 下にボタン固定。全画面では右に一覧
  const root = h('div', { class: 'live live2', dataset: { keep: `live:${app.weekKey}` } });

  const startArea = live.startedAt == null
    ? btn('▶ 配信開始', () => app.liveAction('start'), 'btn btn-start', { 'data-key': 'live-start', title: '計測スタート' })
    : (app.ui.confirmReset
      ? h('span', { class: 'row' }, h('span', {}, '最初からやり直しますか？'),
        btn('やり直す', () => { app.ui.confirmReset = false; app.liveAction('reset'); }, 'btn btn-small btn-dark', { 'data-key': 'live-reset-yes' }),
        btn('やめる', () => { app.ui.confirmReset = false; app.render(); }, 'btn btn-small btn-ghost-dark', { 'data-key': 'live-reset-no' }))
      : btn('リセット', () => { app.ui.confirmReset = true; app.render(); }, 'btn btn-small btn-ghost-dark', { 'data-key': 'live-reset' }));
  const cardOn = live.cardVisible !== false;
  const cardToggle = btn(cardOn ? '投稿カード：表示中' : '投稿カード：隠し中', () => app.liveAction('toggleCard'), `btn btn-small ${cardOn ? 'btn-dark' : 'btn-ghost-dark'}`, { 'data-key': 'live-card', 'aria-pressed': String(cardOn), title: '映す用・OBS の投稿カードを出す／隠す' });

  root.append(progressBar(app, cues, live));
  root.append(h('section', { class: `live-head g-${color}`, attrs: { 'aria-label': '現在の話題' } },
    h('p', { class: 'lh-corner' }, h('span', { class: 'live-icon' }, genreIcon(color)),
      h('span', {}, def ? def.name : '配信終了', def && cue.kind === 'topic' ? h('span', { class: 'live-count' }, `${cue.n} / ${cue.of}`) : null)),
    h('h2', { class: 'live-headline lh-title', dataset: { key: 'live-title' } }, topic ? topic.name : (cue ? (cue.kind === 'empty' ? `${def.name}（話題が未設定）` : def.name) : 'おつかれさまでした')),
    h('div', { class: 'lh-row' }, h('div', { class: 'live-timer', id: 'live-timer', attrs: { 'aria-live': 'off' } }), h('div', { class: 'live-start' }, cardToggle, startArea))));

  root.append(fxPalette(app));

  const mainCard = h('section', { class: 'live-main', dataset: { keep: 'main' }, attrs: { 'aria-label': '今読むニュース' } });
  mainCard.append(cueContent(app, cue, wk));
  if (app.ui.stampAt && Date.now() - app.ui.stampAt < 1200) {
    const stamp = h('div', { class: `stamp${prefersReducedMotion() ? '' : ' is-anim'}`, attrs: { 'aria-hidden': 'true' } }, '済');
    mainCard.append(stamp);
    setTimeout(() => stamp.remove(), prefersReducedMotion() ? 500 : 900);
    app.ui.stampAt = null;
  }

  root.append(h('div', { class: 'live-grid', dataset: { keep: 'grid' } }, mainCard, progressList(app, cues, live)));
  root.append(controls(app, cue, live));
  if (app.ui.obsDlg) {
    root.append(obsDialog(app));
    app.afterRender = () => { for (const d of document.querySelectorAll('#view dialog[data-modal]')) if (!d.open && typeof d.showModal === 'function') d.showModal(); };
  }
  tickLive(app, root);
  return root;
}

/** 演出を出す（ボタン・Shift+1〜6）。押したボタンを一瞬光らせ、状態を読み上げ用に出す */
function fire(app, kind) {
  const params = kind === 'thanks' ? { name: app.ui.fxName || '', amount: app.ui.fxAmount || '' } : {};
  const e = app.fireEffect(kind, params);
  const st = document.querySelector('[data-key="fx-status"]');
  if (st) st.textContent = e ? `「${effectDef(kind).label}」を出しました` : '連打は 1 秒あけてください';
  const b = document.querySelector(`[data-key="fx-${kind}"]`);
  if (b && e) { b.classList.remove('is-fired'); void b.offsetWidth; b.classList.add('is-fired'); }
  return e;
}

/** 「演出」パレット（折りたたみ式の小さなボタン列。開閉は localStorage に保存） */
function fxPalette(app) {
  const open = Boolean(app.fxOpen);
  const bar = h('section', { class: `fx-palette${open ? ' is-open' : ''}`, attrs: { 'aria-label': '演出' }, dataset: { keep: 'fx-palette' } });
  const head = h('div', { class: 'fxp-head' },
    btn(open ? '演出 ▾' : '演出 ▸', () => app.setFxOpen(!open), 'btn btn-small btn-ghost-dark fxp-toggle', { 'data-key': 'fx-toggle', 'aria-expanded': String(open), title: '拍手・紙吹雪などの演出（OBS の「演出」パーツに出ます。キーは Shift+1〜6）' }),
    open ? h('span', { class: 'fxp-hint' }, 'Shift+1〜6 でも出せます') : null,
    h('span', { class: 'fxp-status', attrs: { role: 'status', 'aria-live': 'polite' }, dataset: { key: 'fx-status' } }));
  bar.append(head);
  if (!open) return bar;
  const row = h('div', { class: 'fxp-row' });
  for (const d of EFFECTS) {
    if (d.kind === 'thanks') continue;
    row.append(btn(h('span', {}, h('span', { class: 'fxp-icon', attrs: { 'aria-hidden': 'true' } }, d.icon), d.label, h('kbd', {}, `⇧${d.digit}`)), () => fire(app, d.kind), 'btn btn-small fxp-btn', { 'data-key': `fx-${d.kind}`, title: `${d.label}（Shift+${d.digit}）` }));
  }
  // 感謝バナー: 名前・金額（任意）→ Enter か ボタン
  const name = h('input', { class: 'input input-sm fxp-name', type: 'text', value: app.ui.fxName || '', maxLength: THANKS_LIMITS.name, placeholder: '名前', dataset: { key: 'fx-name' }, attrs: { 'aria-label': '感謝バナーの名前', autocomplete: 'off' } });
  const amount = h('input', { class: 'input input-sm fxp-amount', type: 'text', value: app.ui.fxAmount || '', maxLength: THANKS_LIMITS.amount, placeholder: '金額（任意）', dataset: { key: 'fx-amount' }, attrs: { 'aria-label': '感謝バナーの金額', autocomplete: 'off' } });
  name.addEventListener('input', () => { app.ui.fxName = name.value; });
  amount.addEventListener('input', () => { app.ui.fxAmount = amount.value; });
  for (const x of [name, amount]) x.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); fire(app, 'thanks'); } });
  const thanks = effectDef('thanks');
  row.append(h('span', { class: 'fxp-thanks' }, name, amount,
    btn(h('span', {}, h('span', { class: 'fxp-icon', attrs: { 'aria-hidden': 'true' } }, thanks.icon), '感謝', h('kbd', {}, `⇧${thanks.digit}`)), () => fire(app, 'thanks'), 'btn btn-small fxp-btn', { 'data-key': 'fx-thanks', title: '「◯◯さん ありがとう！」のバナー（Enter・Shift+6）' })));
  row.append(btn('プレビュー', () => {
    const url = new URL('overlay.html?part=all', location.href).toString();
    window.open(url, 'xtrend-fx-preview', 'popup,width=640,height=360');
  }, 'btn btn-small btn-ghost-dark', { 'data-key': 'fx-preview', title: 'このブラウザの小窓でオーバーレイ（全部入り）を確認します' }));
  bar.append(row);
  return bar;
}

/** 上の細い進行バー（コーナーごとの区切り。済・現在・残り） */
function progressBar(app, cues, live) {
  const states = cueStates(live, cues);
  const bar = h('nav', { class: 'lv-progress', attrs: { 'aria-label': '番組の進行' } });
  let last = null;
  cues.forEach((c, i) => {
    if (c.cornerKey !== last) { bar.append(h('span', { class: 'lvp-corner' }, cornerDef(c.cornerKey).name)); last = c.cornerKey; }
    const st = states[i];
    bar.append(h('button', {
      type: 'button', class: `lvp-seg is-${st} g-${cueColor(app, c)}`, dataset: { key: `seg-${c.id}` },
      attrs: { title: `${cueTitle(app, c)}（${STATUS_LABEL[st] || '残り'}）`, 'aria-label': `${cueTitle(app, c)}：${STATUS_LABEL[st] || '残り'}`, 'aria-current': st === 'current' ? 'step' : null },
      on: { click: () => app.liveAction('goto', { index: i }) },
    }));
  });
  const done = states.filter((x) => x === 'done').length;
  bar.append(h('span', { class: 'lvp-count' }, `済 ${done} / ${cues.length}`));
  return bar;
}

function cueContent(app, cue, wk) {
  const box = h('div', { class: 'live-content', dataset: { keep: cue ? `c:${cue.id}` : 'end' } });
  if (!cue) {
    box.append(h('p', { class: 'live-lead' }, 'すべてのコーナーが終わりました。'),
      h('a', { class: 'btn', href: '#review' }, '振り返りを見る'));
    return box;
  }
  const notes = wk.notes[cue.cornerKey];
  if (cue.kind === 'topic') {
    const t = app.topicsById.get(cue.topicId);
    if (!t) { box.append(h('p', {}, '話題が見つかりません')); return box; }
    box.append(h('div', { class: 'live-tags' }, genreSticker(t.genre), topicMarks(app, t), h('p', { class: 'stats' }, statsLine(t))));
    box.append(h('p', { class: 'live-lead' }, leadFor(app, t), leadIsBot(app, t) ? h('span', { class: 'lead-mark', attrs: { title: 'リード文は Grok（ボット）のまとめ。編成のプレビューで書き換えできます' } }, 'Grok のまとめ') : null));
    // 話すポイント・視聴者への質問の欄は表示しない（オーナー指定）。コーナーのメモは書いてあるときだけ
    const notesBox = notes ? h('div', { class: 'live-notes' }, h('h3', {}, 'コーナーのメモ'), h('p', { class: 'pre' }, notes)) : null;
    // 代表投稿は X 埋め込みが既定（「カード表示」のときと、埋め込めなかったときは自前のカード）
    const repId = t.stats.topPostId || t.linkId || (t.linkIds && t.linkIds[0]) || null;
    const own = repPostCard(app, t);
    const rep = app.ui.view !== 'card' && repId ? h('div', { dataset: { keep: 'rep' } }, embedHost(repId, own, 'live-embed')) : own;
    // 「これを映す」: 今映している投稿（選んでいなければ代表投稿）
    const shownId = liveShownPost(wk.live, cue, t);
    const repWrap = h('div', { class: `live-post${repId && repId === shownId ? ' is-shown' : ''}`, dataset: { keep: 'rep-wrap', post: repId || '' } },
      h('div', { class: 'lp-bar' }, h('h3', { class: 'live-h3' }, '代表投稿'), repId ? showButton(app, repId, shownId) : null),
      rep || h('p', { class: 'muted' }, '該当なし'));
    box.append(h('div', { class: notesBox ? 'live-two' : 'live-two is-single', dataset: { keep: 'two' } },
      h('div', { dataset: { keep: 'left' } }, repWrap, relatedList(app, t, repId, shownId)),
      notesBox));
    return box;
  }
  if (cue.kind === 'empty') {
    box.append(h('p', { class: 'live-lead' }, 'このコーナーにはまだ話題が入っていません（編成で追加できます）。'));
  } else {
    box.append(h('p', { class: 'live-lead' }, cornerDef(cue.cornerKey).sub));
  }
  if (notes) box.append(h('div', { class: 'live-notes' }, h('h3', {}, 'メモ'), h('p', { class: 'pre' }, notes)));
  return box;
}

const RELATED_FIRST = 5;

/** 「映す」ボタン（今映している投稿なら「映し中」） */
function showButton(app, id, shownId) {
  if (id === shownId) return h('span', { class: 'badge badge-shown', dataset: { key: `shown-${id}` } }, '映し中');
  return btn('映す', () => app.liveAction('show', { postId: id }), 'btn btn-small btn-show', { 'data-key': `show-${id}`, title: 'この投稿を OBS の投稿カードに出す（J/↓・K/↑ でも切り替え）' });
}

/** 関連投稿: 最初に 5 件、「残り n件を表示」で全部（話題ごとに開いた状態を覚える）。インプレ順／新しい順 */
function relatedList(app, t, repId, shownId) {
  const u = app.ui;
  if (!u.relOpen) u.relOpen = new Set();
  const order = u.relOrder === 'new' ? 'new' : 'imp';
  const ids = showablePostIds(t, app.postsById, order).filter((id) => id !== repId);
  if (!ids.length) return null;
  const open = u.relOpen.has(t.id);
  const shown = open ? ids : ids.slice(0, RELATED_FIRST);
  const wrap = h('div', { class: 'live-related', dataset: { keep: 'related' } });
  wrap.append(h('div', { class: 'lp-bar' },
    h('h3', { class: 'live-h3' }, `関連投稿（${ids.length}件${open || ids.length <= RELATED_FIRST ? '' : `中 ${shown.length}件`}）`),
    h('span', { class: 'rel-order', attrs: { role: 'group', 'aria-label': '並び順' } },
      btn('インプレ順', () => { u.relOrder = 'imp'; app.render(); }, `btn btn-small btn-ghost-dark${order === 'imp' ? ' is-on' : ''}`, { 'data-key': 'rel-order-imp', 'aria-pressed': String(order === 'imp') }),
      btn('新しい順', () => { u.relOrder = 'new'; app.render(); }, `btn btn-small btn-ghost-dark${order === 'new' ? ' is-on' : ''}`, { 'data-key': 'rel-order-new', 'aria-pressed': String(order === 'new') }))));
  for (const id of shown) {
    const p = app.postsById.get(id);
    const card = p ? postCard(p, { refTs: app.ds.refTs, refYear: refYear(app), embedder: app.embedder, compact: true, bm: bmInfo(app, p.id) }) : linkCard(id, statusUrl(id), null);
    wrap.append(h('div', { class: `live-post is-compact${id === shownId ? ' is-shown' : ''}`, dataset: { keep: `rp:${id}`, post: id } },
      h('div', { class: 'lp-bar' }, showButton(app, id, shownId)), card));
  }
  if (ids.length > RELATED_FIRST) {
    wrap.append(open
      ? btn('たたむ', () => { u.relOpen.delete(t.id); app.render(); }, 'btn btn-small btn-ghost-dark rel-more', { 'data-key': 'rel-less' })
      : btn(`残り ${ids.length - RELATED_FIRST}件を表示`, () => { u.relOpen.add(t.id); app.render(); }, 'btn btn-small rel-more', { 'data-key': 'rel-more' }));
  }
  return wrap;
}

/** J/↓・K/↑: 映す投稿を次・前へ（今の並び順。たたんでいる投稿も含む）。動かしたら true */
function stepShow(app, delta) {
  const wk = app.weekState();
  const cue = app.cues[wk.live.index];
  const t = cue && cue.kind === 'topic' ? app.topicsById.get(cue.topicId) : null;
  if (!t) return false;
  const order = app.ui.relOrder === 'new' ? 'new' : 'imp';
  const list = showablePostIds(t, app.postsById, order);
  const next = stepShownPost(list, liveShownPost(wk.live, cue, t), delta);
  if (!next) return false;
  // 次が 6 件目以降なら関連投稿を開いておく
  if (list.indexOf(next) > RELATED_FIRST) { if (!app.ui.relOpen) app.ui.relOpen = new Set(); app.ui.relOpen.add(t.id); }
  app.liveAction('show', { postId: next });
  requestAnimationFrame(() => { const el = document.querySelector(`.live-post[data-post="${CSS.escape(next)}"]`); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' }); });
  return true;
}

function progressList(app, cues, live) {
  const states = cueStates(live, cues);
  const aside = h('aside', { class: 'live-side', attrs: { 'aria-labelledby': 'h-prog' } }, h('h2', { id: 'h-prog', class: 'side-title' }, '番組の進行'));
  const ol = h('ol', { class: 'prog' });
  let lastCorner = null;
  cues.forEach((c, i) => {
    const st = states[i];
    const head = c.cornerKey !== lastCorner ? cornerDef(c.cornerKey).name : null;
    lastCorner = c.cornerKey;
    const color = cueColor(app, c);
    const label = c.kind === 'topic' ? cueTitle(app, c) : (c.kind === 'empty' ? '（未設定）' : '');
    const b = h('button', {
      type: 'button', class: `prog-item is-${st}`, dataset: { key: `prog-${c.id}`, cue: c.id },
      attrs: { 'aria-current': st === 'current' ? 'step' : null, title: 'ここへ移動' },
      on: { click: () => app.liveAction('goto', { index: i }) },
    },
    h('span', { class: `prog-dot g-${color}` }, st === 'done' ? '済' : st === 'skipped' ? '飛' : st === 'carried' ? '来' : st === 'current' ? '▶' : ''),
    h('span', { class: 'prog-text' }, head ? h('b', {}, head) : null, head && label ? ' ' : null, label),
    st !== 'todo' && st !== 'current' ? h('span', { class: 'sr-only' }, `（${STATUS_LABEL[st]}）`) : null);
    ol.append(h('li', {}, b));
  });
  aside.append(ol);
  const done = states.filter((s) => s === 'done').length;
  aside.append(h('p', { class: 'muted' }, `済 ${done} ・ 飛ばした ${states.filter((s) => s === 'skipped').length} ・ 来週へ ${states.filter((s) => s === 'carried').length} ・ 残り ${states.filter((s) => s === 'todo' || s === 'current').length}`));
  return aside;
}

function controls(app, cue, live) {
  const finished = !cue;
  const canBack = live.history.length > 0 || live.index > 0;
  return h('div', { class: 'live-controls', attrs: { role: 'group', 'aria-label': '進行の操作' } },
    btn(h('span', {}, '← 戻す', h('kbd', {}, '←')), () => doAction(app, 'back'), 'btn ctl ctl-back', { disabled: !canBack, 'data-key': 'ctl-back' }),
    btn(h('span', {}, '飛ばす', h('kbd', {}, 'S')), () => doAction(app, 'skip'), 'btn ctl ctl-skip', { disabled: finished, 'data-key': 'ctl-skip' }),
    btn(h('span', {}, '来週に回す', h('kbd', {}, 'L')), () => doAction(app, 'carry'), 'btn ctl ctl-carry', { disabled: finished || cue.kind !== 'topic', 'data-key': 'ctl-carry' }),
    btn(h('span', {}, '読んだ →', h('kbd', {}, 'Enter')), () => doAction(app, 'done'), 'btn ctl ctl-done', { disabled: finished, 'data-key': 'ctl-done' }));
}

function doAction(app, type) {
  const wk = app.weekState();
  const cue = app.cues[wk.live.index];
  if (type !== 'back' && !cue) return;
  if (type === 'carry' && (!cue || cue.kind !== 'topic')) return;
  if (type === 'done') app.ui.stampAt = Date.now();
  app.liveAction(type);
}

export function liveKeydown(app, e) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return;
  if (document.querySelector('dialog[open]')) return;
  // 演出: Shift+1〜6（入力欄にいるときは使わない。Stream Deck などからはこのキーを送る）
  const m = e.shiftKey ? /^(?:Digit|Numpad)([1-6])$/.exec(e.code || '') : null;
  if (m) {
    const d = EFFECTS.find((x) => x.digit === Number(m[1]));
    if (d) { e.preventDefault(); fire(app, d.kind); }
    return;
  }
  const onButton = e.target && (e.target.tagName === 'BUTTON' || e.target.tagName === 'A');
  let type = null;
  // 映す投稿: J/↓ 次、K/↑ 前
  if (!e.shiftKey && (e.key === 'j' || e.key === 'J' || e.key === 'ArrowDown')) { if (stepShow(app, 1)) e.preventDefault(); return; }
  if (!e.shiftKey && (e.key === 'k' || e.key === 'K' || e.key === 'ArrowUp')) { if (stepShow(app, -1)) e.preventDefault(); return; }
  if (e.key === 'ArrowRight') type = 'done';
  else if (e.key === 'Enter' && !onButton) type = 'done';
  else if (e.key === 'ArrowLeft') type = 'back';
  else if (e.key === 's' || e.key === 'S') type = 'skip';
  else if (e.key === 'l' || e.key === 'L') type = 'carry';
  if (!type) return;
  e.preventDefault();
  doAction(app, type);
}

/** タイマー表示の更新（1秒ごと） */
export function tickLive(app, root = document) {
  const el = root.querySelector ? root.querySelector('#live-timer') : null;
  if (!el) return;
  const wk = app.weekState();
  const t = computeTimer(wk.live, wk.rundown, app.cues, Date.now());
  const driftText = !t.started ? '開始前' : t.state === 'over' ? `押し +${formatClock(t.driftSec)}` : t.state === 'under' ? `巻き ${formatClock(t.driftSec)}` : '予定どおり';
  const parts = [
    h('div', { class: 'tm' }, h('span', { class: 'tm-k' }, '全体の経過'), h('span', { class: 'tm-v' }, formatClock(t.elapsedSec)), h('span', { class: 'tm-s' }, ` / ${formatClock(t.totalSec)}`)),
    h('div', { class: 'tm' }, h('span', { class: 'tm-k' }, 'コーナー残り'), h('span', { class: `tm-v${t.cornerRemainSec != null && t.cornerRemainSec < 0 ? ' is-over' : ''}` }, t.cornerRemainSec == null ? '--:--' : formatClock(t.cornerRemainSec))),
    h('div', { class: `drift is-${t.state}` }, driftText),
  ];
  while (el.firstChild) el.firstChild.remove();
  el.append(...parts);
  el.dataset.state = t.state;
}

