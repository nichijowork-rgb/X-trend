// ② 進行（配信中）画面。キーボード: →/Enter 読んだ、← 戻す、S 飛ばす、L 来週へ。
import { computeTimer, formatClock, cornerDef, cueStates } from '../logic.js';
import { h, btn, genreSticker, isEditable, prefersReducedMotion, postCard, embedHost } from '../dom.js';
import { genreIcon } from '../icons.js';
import { cueColor, leadFor, topicPosts, topicMarks, repPostCard, statsLine, refYear, bmInfo } from './common.js';

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
  const root = h('div', { class: 'live', dataset: { keep: `live:${app.weekKey}` } });

  const startArea = live.startedAt == null
    ? btn('▶ 配信開始（計測スタート）', () => app.liveAction('start'), 'btn btn-start', { 'data-key': 'live-start' })
    : (app.ui.confirmReset
      ? h('span', { class: 'row' }, h('span', {}, '進行を最初からやり直しますか？'),
        btn('やり直す', () => { app.ui.confirmReset = false; app.liveAction('reset'); }, 'btn btn-small btn-dark', { 'data-key': 'live-reset-yes' }),
        btn('やめる', () => { app.ui.confirmReset = false; app.render(); }, 'btn btn-small btn-ghost-dark', { 'data-key': 'live-reset-no' }))
      : btn('進行をリセット', () => { app.ui.confirmReset = true; app.render(); }, 'btn btn-small btn-ghost-dark', { 'data-key': 'live-reset' }));

  root.append(h('section', { class: `live-bar g-${color}`, attrs: { 'aria-label': '現在のコーナー' } },
    h('div', { class: 'live-corner' },
      h('span', { class: 'live-icon' }, genreIcon(color)),
      h('div', {},
        h('p', { class: 'live-kicker' }, def ? def.name : '配信終了', def && cue.kind === 'topic' ? h('span', { class: 'live-count' }, `${cue.n} / ${cue.of}`) : null),
        h('p', { class: 'live-sub' }, def ? def.sub : 'おつかれさまでした'))),
    h('div', { class: 'live-timer', id: 'live-timer', attrs: { 'aria-live': 'off' } }),
    h('div', { class: 'live-start' }, startArea)));

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
  tickLive(app, root);
  return root;
}

function cueContent(app, cue, wk) {
  const box = h('div', { class: 'live-content', dataset: { keep: cue ? `c:${cue.id}` : 'end' } });
  if (!cue) {
    box.append(h('h2', { class: 'live-headline' }, 'おつかれさまでした！'),
      h('p', { class: 'live-lead' }, 'すべてのコーナーが終わりました。'),
      h('a', { class: 'btn', href: '#review' }, '振り返りを見る'));
    return box;
  }
  const notes = wk.notes[cue.cornerKey];
  if (cue.kind === 'topic') {
    const t = app.topicsById.get(cue.topicId);
    if (!t) { box.append(h('p', {}, '話題が見つかりません')); return box; }
    box.append(h('div', { class: 'live-tags' }, genreSticker(t.genre), topicMarks(app, t)));
    box.append(h('h2', { class: 'live-headline' }, t.name));
    box.append(h('p', { class: 'stats stats-lg' }, statsLine(t)));
    box.append(h('p', { class: 'live-lead' }, leadFor(app, t)));
    // 話すポイント・視聴者への質問の欄は表示しない（オーナー指定）。コーナーのメモは書いてあるときだけ
    const notesBox = notes ? h('div', { class: 'live-notes' }, h('h3', {}, 'コーナーのメモ'), h('p', { class: 'pre' }, notes)) : null;
    // 代表投稿は X 埋め込みが既定（「カード表示」のときと、埋め込めなかったときは自前のカード）
    const repId = t.stats.topPostId || t.linkId || (t.linkIds && t.linkIds[0]) || null;
    const own = repPostCard(app, t);
    const rep = app.ui.view !== 'card' && repId ? h('div', { dataset: { keep: 'rep' } }, embedHost(repId, own, 'live-embed')) : own;
    const related = topicPosts(app, t).filter((p) => p.id !== t.stats.topPostId).slice(0, 3);
    box.append(h('div', { class: notesBox ? 'live-two' : 'live-two is-single', dataset: { keep: 'two' } },
      h('div', { dataset: { keep: 'left' } }, h('h3', { class: 'live-h3' }, '代表投稿'), rep || h('p', { class: 'muted' }, '該当なし'),
        related.length ? h('div', {}, h('h3', { class: 'live-h3' }, `関連投稿（${topicPosts(app, t).length - 1}件中 ${related.length}件）`),
          related.map((p) => postCard(p, { refTs: app.ds.refTs, refYear: refYear(app), embedder: app.embedder, compact: true, bm: bmInfo(app, p.id) }))) : null),
      notesBox));
    return box;
  }
  if (cue.kind === 'empty') {
    box.append(h('h2', { class: 'live-headline' }, cornerDef(cue.cornerKey).name),
      h('p', { class: 'live-lead' }, 'このコーナーにはまだ話題が入っていません（編成で追加できます）。'));
  } else {
    box.append(h('h2', { class: 'live-headline' }, cornerDef(cue.cornerKey).name), h('p', { class: 'live-lead' }, cornerDef(cue.cornerKey).sub));
  }
  if (notes) box.append(h('div', { class: 'live-notes' }, h('h3', {}, 'メモ'), h('p', { class: 'pre' }, notes)));
  return box;
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
  const onButton = e.target && (e.target.tagName === 'BUTTON' || e.target.tagName === 'A');
  let type = null;
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

