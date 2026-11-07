// ② 進行（配信中）画面。キーボード: →/Enter 読んだ、← 戻す、S 飛ばす、L 来週へ、J/↓・K/↑ 映す投稿を次・前へ、Shift+1〜6 演出。
import { computeTimer, formatClock, cornerDef, cueStates, liveShownPost, stepShownPost, statusUrl, isImageItem, moveItemTo } from '../logic.js';
import { h, btn, genreSticker, isEditable, prefersReducedMotion, postCard, linkCard, embedHost } from '../dom.js';
import { genreIcon } from '../icons.js';
import { cueColor, leadFor, leadIsBot, topicMarks, statsLine, refYear, bmInfo } from './common.js';
import { beginPointer } from './dnd.js';
import { obsDialog } from './obsui.js';
import { viewerDialog } from './viewerui.js';
import { urlAddDialog } from './urladd.js';
import { FEATURES, TEXT } from '../config.js';
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
  // 投稿カードは常に表示（表示中/隠し中の切り替えは廃止。2026-11-08 オーナー確定）

  // 上部に固定（スクロールしても見える）: 細い進行バー＋コーナー名・話題名（1 行）・タイマー・押し巻き・OBS・投稿カード・配信開始
  const title = topic ? topic.name : (cue ? (cue.kind === 'empty' ? `${def.name}（話題が未設定）` : def.name) : 'おつかれさまでした');
  const obsPill = h('button', { type: 'button', class: 'obs-pill lh-obs', dataset: { key: 'live-obs-pill', obsPill: '' }, on: { click: () => { app.ui.obsDlg = true; app.render(); } } }, 'OBS');
  root.append(h('div', { class: 'live-sticky', dataset: { keep: 'sticky' } },
    progressBar(app, cues, live),
    h('section', { class: `live-head is-compact g-${color}`, attrs: { 'aria-label': '現在の話題' } },
      h('div', { class: 'lh-top' },
        h('span', { class: 'live-icon' }, genreIcon(color)),
        h('span', { class: 'lh-corner-name' }, def ? def.name : '配信終了', def && cue.kind === 'topic' ? h('span', { class: 'live-count' }, `${cue.n} / ${cue.of}`) : null),
        h('h2', { class: 'live-headline lh-title', dataset: { key: 'live-title' }, attrs: { title } }, title)),
      h('div', { class: 'lh-row' }, h('div', { class: 'live-timer', id: 'live-timer', attrs: { 'aria-live': 'off' } }),
        h('div', { class: 'live-start' }, obsPill,
          btn('開く窓', () => { app.ui.viewerDlg = true; app.render(); }, 'btn btn-small btn-ghost-dark', { 'data-key': 'viewer-open', title: '投稿を開く専用ウィンドウの位置・大きさ' }),
          startArea)))));

  if (FEATURES.effects) root.append(fxPalette(app));

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
  if (app.ui.urlDlg) {
    root.append(urlAddDialog(app));
    app.afterRender = () => { for (const d of document.querySelectorAll('#view dialog[data-modal]')) if (!d.open && typeof d.showModal === 'function') d.showModal(); };
  }
  if (app.ui.viewerDlg) {
    root.append(viewerDialog(app));
    app.afterRender = () => { for (const d of document.querySelectorAll('#view dialog[data-modal]')) if (!d.open && typeof d.showModal === 'function') d.showModal(); };
  }
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
    // リード文は既定で閉じる（開閉は localStorage に保存）
    const leadBox = h('details', { class: 'live-lead-box', open: Boolean(app.leadOpen), dataset: { keep: 'lead' } },
      h('summary', { class: 'live-lead-sum', dataset: { key: 'lead-toggle' } }, 'リード文', leadIsBot(app, t) ? h('span', { class: 'lead-mark', attrs: { title: 'リード文は Grok（ボット）のまとめ。編成のプレビューで書き換えできます' } }, 'Grok のまとめ') : null),
      h('p', { class: 'live-lead' }, leadFor(app, t)));
    leadBox.addEventListener('toggle', () => app.setLeadOpen(leadBox.open));
    box.append(leadBox);
    // 話すポイント・視聴者への質問の欄は表示しない（オーナー指定）。コーナーのメモは書いてあるときだけ
    const notesBox = notes ? h('div', { class: 'live-notes' }, h('h3', {}, 'コーナーのメモ'), h('p', { class: 'pre' }, notes)) : null;
    // 話題の投稿（代表投稿を含む全件・画像も）。クリックで「今の投稿」＝ OBS の投稿カード。つまみ・帯のドラッグで並べ替え
    box.append(h('div', { class: notesBox ? 'live-two' : 'live-two is-single', dataset: { keep: 'two' } },
      h('div', { dataset: { keep: 'left' } }, itemsList(app, t, cue, wk)),
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

const ITEMS_FIRST = 5;

/** 話題の投稿の一覧（最初に 5 件、「残り n件を表示」で全部）。DOM の順は固定（id 順）にして CSS の order で並べる＝並べ替えで埋め込みを作り直さない */
function itemsList(app, t, cue, wk) {
  const u = app.ui;
  if (!u.relOpen) u.relOpen = new Set();
  const items = app.itemsFor(t);
  const manual = Boolean(wk.postOrder[t.id]);
  const order = wk.live.order === 'old' ? 'old' : 'imp';
  const shownId = liveShownPost(wk.live, cue, t, items);
  // 「埋め込みを操作」は別の投稿に移ったら戻す
  if (u.interactId && u.interactId !== shownId) u.interactId = null;
  const open = u.relOpen.has(t.id);
  const visible = open ? items : items.slice(0, ITEMS_FIRST);
  const pos = new Map(items.map((id, i) => [id, i]));
  const wrap = h('section', { class: 'live-items', dataset: { keep: `items:${t.id}` }, attrs: { 'aria-label': '話題の投稿' } });
  const file = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'sr-only', id: `img-file-${t.id}`, dataset: { key: 'img-file' } });
  file.addEventListener('change', () => { const fs = [...(file.files || [])]; file.value = ''; app.addImages(fs, t.id); });
  const ob = (key, label, on, title) => btn(label, () => app.setLiveOrder(t.id, key), `btn btn-small btn-ghost-dark${on ? ' is-on' : ''}`, { 'data-key': `rel-order-${key}`, 'aria-pressed': String(on), title });
  wrap.append(h('div', { class: 'lp-bar li-head' },
    h('h3', { class: 'live-h3' }, `投稿（${items.length}件${open || items.length <= ITEMS_FIRST ? '' : `中 ${visible.length}件`}）`),
    h('span', { class: 'rel-order', attrs: { role: 'group', 'aria-label': '並び順' } },
      ob('imp', 'インプレ順', !manual && order === 'imp', '表示が多い順'),
      ob('old', '古い順', !manual && order === 'old', '投稿日時の古い順（時系列で読む）'),
      manual ? h('span', { class: 'btn btn-small is-on rel-manual', dataset: { key: 'rel-order-manual' }, attrs: { title: '手で並べ替えた順（インプレ順・古い順を押すと解除）' } }, '手動順') : null),
    btn('＋URL', () => { u.urlDlg = { topicId: t.id, text: '' }; app.render(); }, 'btn btn-small btn-ghost-dark li-add', { 'data-key': 'url-add', title: 'X の投稿の URL を貼って、この話題に追加' }),
    h('label', { class: 'btn btn-small btn-ghost-dark li-add', attrs: { for: `img-file-${t.id}`, title: '画像を追加（ファイルを選ぶ・ここへドラッグ・Ctrl+V で貼り付け）' } }, '＋画像'), file));
  const list = h('div', { class: 'li-list', dataset: { keep: 'li-list' } });
  for (const id of [...visible].sort()) list.append(itemEl(app, t, id, pos.get(id), shownId, items));
  const end = h('div', { class: 'li-end', dataset: { keep: 'li-end', drop: `li:${items.length}` } }, 'ここに置くと末尾へ');
  end.style.order = String(items.length + 1);
  list.append(end);
  wrap.append(list);
  if (items.length > ITEMS_FIRST) {
    wrap.append(open
      ? btn('たたむ', () => { u.relOpen.delete(t.id); app.render(); }, 'btn btn-small btn-ghost-dark rel-more', { 'data-key': 'rel-less' })
      : btn(`残り ${items.length - ITEMS_FIRST}件を表示`, () => { u.relOpen.add(t.id); app.render(); }, 'btn btn-small rel-more', { 'data-key': 'rel-more' }));
  }
  // 画像ファイルをここへドラッグ
  wrap.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); wrap.classList.add('is-file-over'); } });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('is-file-over'));
  wrap.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    wrap.classList.remove('is-file-over');
    app.addImages([...e.dataTransfer.files], t.id);
  });
  return wrap;
}

/** 1 件（投稿・データに無い投稿・画像）。帯（⋮⋮・番号・映し中・×・…）＋ 中身（投稿は常に X 埋め込み） */
function itemEl(app, t, id, index, shownId, items) {
  const isImg = isImageItem(id);
  // 埋め込みの上の透明なクリック受け（既定オン）。「埋め込みを操作」中のカードだけ外す
  const catcherOn = app.viewerPrefs.catcher !== false;
  const interact = app.ui.interactId === id;
  const el = h('div', { class: `live-post li-item${id === shownId ? ' is-shown' : ''}`, dataset: { keep: `li:${id}`, post: id, drop: `li:${index}` }, attrs: { 'aria-label': `${index + 1}件目` } });
  el.style.order = String(index);
  const handle = h('span', { class: 'li-handle', attrs: { 'aria-hidden': 'true', title: 'ドラッグで並べ替え' } }, '⋮⋮');
  const menu = h('details', { class: 'menu li-menu' },
    h('summary', { class: 'btn btn-small btn-ghost-dark li-more', dataset: { key: `li-menu-${id}` }, attrs: { 'aria-label': '操作' } }, '…'),
    h('div', { class: 'menu-list' },
      h('button', { type: 'button', class: 'menu-item', dataset: { key: `li-remove2-${id}` }, on: { click: () => app.removeItem(t, id) } }, '話題から外す'),
      h('button', { type: 'button', class: 'menu-item', dataset: { key: `li-hide-${id}` }, on: { click: () => app.hideItem(t, id) } }, isImg ? '画像を削除' : 'この投稿を削除（非表示）'),
      h('button', { type: 'button', class: 'menu-item', dataset: { key: `li-top-${id}` }, disabled: index === 0, on: { click: () => app.setItemOrder(t.id, moveItemTo(items, id, 0), '先頭へ') } }, '先頭へ（代表にする）'),
      h('button', { type: 'button', class: 'menu-item', dataset: { key: `li-bottom-${id}` }, disabled: index === items.length - 1, on: { click: () => app.setItemOrder(t.id, moveItemTo(items, id, items.length), '末尾へ') } }, '末尾へ')));
  const bar = h('div', { class: 'lp-bar li-bar', dataset: { key: `li-bar-${id}` } },
    handle,
    h('span', { class: 'li-no' }, index === 0 ? '先頭（代表）' : `${index + 1}`),
    isImg ? h('span', { class: 'badge li-kind' }, '画像') : null,
    id === shownId ? h('span', { class: 'badge badge-shown', dataset: { key: `shown-${id}` } }, '映し中') : null,
    h('span', { class: 'li-sp' }),
    catcherOn && !isImg && app.postsById.has(id)
      ? btn(interact ? '操作をやめる' : '埋め込みを操作', () => { if (interact) app.ui.interactId = null; else { app.ui.interactId = id; if (id !== shownId) { app.liveAction('show', { postId: id }); return; } } app.render(); }, `btn btn-small btn-ghost-dark li-interact${interact ? ' is-on' : ''}`, { 'data-key': `li-interact-${id}`, 'aria-pressed': String(interact), title: 'このカードだけ、埋め込みの中を直接操作（動画の再生など）' })
      : null,
    btn('×', () => app.removeItem(t, id), 'btn btn-small btn-ghost-dark li-x', { 'data-key': `li-remove-${id}`, title: '話題から外す（Ctrl+Z で戻せます）', 'aria-label': '話題から外す', disabled: items.length <= 1 && !isImg }),
    menu);
  // 帯をドラッグで並べ替え（マウス・タッチ）。動かさずに離したら「今の投稿」
  bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, summary, details, input, a')) return;
    beginPointer(e, {
      handle: true,
      getRows: () => [{ key: id, id }],
      label: () => (isImg ? '画像' : (app.postsById.get(id) || {}).text || id).slice(0, 30),
      canDrop: (key) => key.startsWith('li:'),
      onDrop: (key) => {
        const to = Number(key.slice(3));
        // 置いた先の投稿の位置へ（下へ動かすとその投稿の後ろ、上へ動かすと前）
        const next = moveItemTo(items, id, to);
        if (next.join() !== items.join()) app.setItemOrder(t.id, next);
      },
      onClick: () => app.liveAction('show', { postId: id }),
    });
  });
  bar.style.touchAction = 'none';
  // カード（余白）をクリック → 今の投稿
  el.addEventListener('click', (e) => {
    if (e.target.closest('button, summary, details, input, textarea, a, .li-bar')) return;
    if (id !== shownId) app.liveAction('show', { postId: id });
  });
  if (isImg) el.append(bar, imageBody(app, id));
  else {
    const p = app.postsById.get(id);
    if (!p) { el.title = TEXT.missingPost; bar.insertBefore(h('span', { class: 'badge li-kind', attrs: { title: TEXT.missingPost } }, 'データに無い'), bar.querySelector('.li-sp')); }
    const own = p ? postCard(p, { refTs: app.ds.refTs, refYear: refYear(app), compact: true, noActions: true, bm: bmInfo(app, p.id) }) : linkCard(id, statusUrl(id), null);
    // 進行は常に X の埋め込み（画面に近いものから作る。失敗・データに無い投稿は自前のカード）
    const body = h('div', { class: 'li-body', dataset: { keep: 'body' } }, p ? embedHost(id, own, 'live-embed') : own);
    if (p && catcherOn && !interact) {
      const catcher = h('div', { class: 'li-catch', dataset: { key: `li-catch-${id}` }, attrs: { title: 'クリックで今の投稿にする（埋め込みの中を操作するときは「埋め込みを操作」）' } });
      catcher.addEventListener('click', (e) => {
        e.stopPropagation();
        if (id !== shownId) app.liveAction('show', { postId: id });
        if (app.viewerPrefs.openOnClick) app.openViewer(statusUrl(id));
      });
      body.append(catcher);
    }
    el.append(bar, body);
  }
  return el;
}

/** 画像の中身（IndexedDB から読む）とキャプション */
function imageBody(app, id) {
  const imgId = id.slice(4);
  const meta = (app.weekState().images || []).find((x) => x.id === imgId) || {};
  const data = app.imageData(imgId);
  if (!data) app.loadImage(imgId).catch(() => {});
  const img = data ? h('img', { class: 'li-img', src: data.url, alt: meta.caption || '追加した画像', decoding: 'async' }) : h('p', { class: 'muted li-img-wait' }, '画像を読み込み中…');
  if (data && meta.w && meta.h) { img.width = meta.w; img.height = meta.h; }
  const cap = h('input', { class: 'input input-sm li-cap', type: 'text', value: meta.caption || '', maxLength: 200, placeholder: 'キャプション（任意。OBS の投稿カードにも出ます）', dataset: { key: `cap-${imgId}` }, attrs: { 'aria-label': '画像のキャプション' } });
  cap.addEventListener('input', () => app.setImageCaption(imgId, cap.value));
  return h('figure', { class: 'li-figure', dataset: { keep: `fig:${imgId}` } }, h('div', { dataset: { keep: `imgbox:${imgId}${data ? ':ok' : ''}` } }, img), cap);
}

/** J/↓・K/↑: 今の投稿を次・前へ（今の並び。たたんでいる投稿も含む）。動かしたら true */
function stepShow(app, delta) {
  const wk = app.weekState();
  const cue = app.cues[wk.live.index];
  const t = cue && cue.kind === 'topic' ? app.topicsById.get(cue.topicId) : null;
  if (!t) return false;
  const list = app.itemsFor(t);
  const next = stepShownPost(list, liveShownPost(wk.live, cue, t, list), delta);
  if (!next) return false;
  // 6 件目より先なら一覧を開いておく
  if (list.indexOf(next) >= ITEMS_FIRST) { if (!app.ui.relOpen) app.ui.relOpen = new Set(); app.ui.relOpen.add(t.id); }
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
  // 元に戻す・やり直す（編成と共通の履歴）
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !isEditable(e.target)) {
    if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); if (e.shiftKey) app.redo(); else app.undo(); return; }
    if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); app.redo(); return; }
  }
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return;
  if (document.querySelector('dialog[open]')) return;
  // 演出: Shift+1〜6（入力欄にいるときは使わない。Stream Deck などからはこのキーを送る）
  const m = FEATURES.effects && e.shiftKey ? /^(?:Digit|Numpad)([1-6])$/.exec(e.code || '') : null;
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

