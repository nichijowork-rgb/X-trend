// ① 編成（準備）画面。
import { formatDateTime, formatCompact, hitRateText } from '../../../assets/js/core.js';
import { CHECKPOINTS, GENRES, SCORE_NOTE, DEFAULT_DICT, SHOW_DEFAULTS } from '../config.js';
import {
  assignTopic, removeTopic, moveInCorner, replaceTopicId, usedTopicIds, suggestMain, cornerDef, totalMinutes,
  leadText, extractStatusIds, recordCheckpoint, togglePlanCarry, isCarriedOut, parseSaved, serializeSaved,
  autoTitle, weekLabel, genreLabel, statusUrl, pickWeeklyReport, bookmarkList, pastUsedIds,
} from '../logic.js';
import { h, btn, badge, field, postCard, linkCard, downloadText, genreSticker } from '../dom.js';
import { genreIcon } from '../icons.js';
import { statsLine, leadFor, scriptFor, topicPosts, topicMarks, repPostCard, refYear, mainTopics, currentTitle, bmInfo } from './common.js';

const FILTERS = [
  { key: 'all', label: 'すべて' },
  ...GENRES.map((g) => ({ key: g.key, label: g.label, genre: g.key })),
  { key: 'new', label: 'NEW' },
  { key: 'me', label: '自分で追加・ブクマ' },
  { key: 'suggest', label: '同じ話題かも？' },
];
const PAGE = 30;

export function renderPlan(app) {
  const wk = app.weekState();
  const root = h('div', { class: 'plan wrap' });
  root.append(headBento(app, wk));
  root.append(mainSlots(app, wk));
  root.append(h('div', { class: 'plan-cols' }, rundownSection(app, wk), candidatesSection(app, wk)));
  root.append(h('div', { class: 'plan-extra' }, app.bookmarks ? bookmarkSection(app, wk) : null, personalSection(app, wk), carriedSection(app, wk), dictSection(app)));
  if (app.ui.dialogTopic) {
    const t = app.topicsById.get(app.ui.dialogTopic);
    if (t) root.append(topicDialog(app, t));
    else app.ui.dialogTopic = null;
  }
  return root;
}

// ================================================================ 上段（タイトル・チェック・保存）

function headBento(app, wk) {
  const auto = autoTitle(app.saved.showName, mainTopics(app).map((t) => t.name));
  const isAuto = !(typeof wk.title === 'string' && wk.title.trim());
  const nameInput = h('input', { class: 'input', type: 'text', value: app.saved.showName, maxLength: 60, dataset: { key: 'show-name' }, attrs: { autocomplete: 'off' } });
  nameInput.addEventListener('change', () => app.update((w, s) => { s.showName = nameInput.value.trim() || SHOW_DEFAULTS.showName; }));
  const titleInput = h('input', { class: 'input input-title', type: 'text', value: currentTitle(app), maxLength: 200, dataset: { key: 'title' }, attrs: { autocomplete: 'off' } });
  titleInput.addEventListener('input', () => app.update((w) => { w.title = titleInput.value === auto ? null : titleInput.value; }, { render: false, debounce: true }));
  titleInput.addEventListener('change', () => app.render());
  const copyBtn = btn('コピー', async () => {
    try { await navigator.clipboard.writeText(titleInput.value); copyBtn.textContent = 'コピーしました'; } catch { titleInput.select(); copyBtn.textContent = '選択しました（Ctrl+C でコピー）'; }
  }, 'btn btn-small btn-dark', { 'data-key': 'title-copy' });
  const weekPosts = app.weekPostIds.length;
  const titleCard = h('section', { class: 'tile g-white tile-title', attrs: { 'aria-labelledby': 'h-title' } },
    h('h2', { id: 'h-title', class: 'tile-kicker' }, `${app.weekKey.slice(5).replace('-', '/')}(土) 1:00 配信の編成`),
    h('p', { class: 'tile-sub' }, `対象：${weekLabel(app.week)} ・ 投稿 ${weekPosts}件 ・ 話題 ${app.topics.length}件`),
    h('div', { class: 'title-grid' },
      field('番組名', nameInput),
      field('配信タイトル', titleInput, isAuto ? '（自動：メイン3本の話題名から）' : '（手で編集中）')),
    h('div', { class: 'row' }, copyBtn, isAuto ? null : btn('自動タイトルに戻す', () => app.update((w) => { w.title = null; }), 'btn btn-small btn-ghost', { 'data-key': 'title-auto' })));

  return h('div', { class: 'bento-head' }, titleCard, checkpointTile(app, wk), saveTile(app));
}

function checkpointTile(app, wk) {
  const tile = h('section', { class: 'tile g-general tile-check', attrs: { 'aria-labelledby': 'h-check' } },
    h('h2', { id: 'h-check', class: 'tile-head' }, 'チェックポイント'),
    h('p', { class: 'tile-sub' }, '押すと今のデータ時刻を記録し、それ以降に増えた投稿・話題に NEW が付きます。'));
  const row = h('div', { class: 'row' });
  for (const cp of CHECKPOINTS) {
    row.append(btn(`${cp.label}（${cp.when}）を記録`, () => {
      app.update((w) => {
        Object.assign(w, recordCheckpoint(w, cp.kind, app.ds.generated_at, app.weekPostIds, app.topics.map((t) => t.id), Date.now()));
      }, { topics: true });
    }, 'btn btn-dark', { 'data-key': `cp-${cp.kind}` }));
  }
  tile.append(row);
  const last = wk.checkpoints[wk.checkpoints.length - 1];
  if (last) {
    const label = CHECKPOINTS.find((c) => c.kind === last.kind)?.label || '';
    const n = app.newInfo;
    const newTopics = n ? [...n.topics.keys()].length : 0;
    const sameData = last.dataAt && last.dataAt === app.ds.generated_at;
    tile.append(h('p', { class: 'cp-status', attrs: { role: 'status' } },
      `前回：${label}（${last.recordedAt ? formatDateTime(null, Math.floor(last.recordedAt / 1000)) : '不明'} に記録・データ ${last.dataAt ? formatDateTime(last.dataAt, null) : '不明'} 時点）`,
      h('br'),
      sameData ? 'その後のデータ更新はまだありません。' : `その後 新しい投稿 ${n ? n.posts.size : 0}件・話題 ${newTopics}件`));
  } else {
    tile.append(h('p', { class: 'cp-status' }, 'まだ記録していません。'));
  }
  return tile;
}

function saveTile(app) {
  const tile = h('section', { class: 'tile g-review tile-save', attrs: { 'aria-labelledby': 'h-save' } },
    h('h2', { id: 'h-save', class: 'tile-head' }, '保存'),
    h('p', { class: 'tile-sub' }, '編成・メモ・進行はこのブラウザに自動保存されます。別のパソコンへ移すときやバックアップは書き出してください。'));
  const file = h('input', { type: 'file', accept: 'application/json,.json', class: 'sr-only', id: 'import-file', dataset: { key: 'import-file' } });
  file.addEventListener('change', async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    let text = '';
    try { text = await f.text(); } catch { app.ui.importMsg = { kind: 'error', text: 'ファイルを読めませんでした' }; app.render(); return; }
    const r = parseSaved(text);
    if (!r.ok) { app.ui.importMsg = { kind: 'error', text: `読み込めませんでした（${r.reason}）` }; app.ui.pendingImport = null; } else {
      app.ui.pendingImport = r.state;
      app.ui.importMsg = { kind: 'ok', text: `「${f.name}」：番組週 ${Object.keys(r.state.weeks).length}件・辞書 ${r.state.dict.length}件${r.reason ? `（${r.reason}）` : ''}。今の内容をこのファイルで置き換えますか？` };
    }
    app.render();
  });
  const row = h('div', { class: 'row' },
    btn('書き出し（JSON）', () => downloadText(`show-${app.weekKey}.json`, serializeSaved(app.saved, Date.now())), 'btn btn-dark', { 'data-key': 'export' }),
    h('label', { class: 'btn btn-dark', attrs: { for: 'import-file' } }, '読み込み'), file);
  tile.append(row);
  const msg = app.ui.importMsg;
  if (msg) {
    const p = h('p', { class: `import-msg is-${msg.kind}`, attrs: { role: 'status' } }, msg.text);
    tile.append(p);
    if (app.ui.pendingImport) {
      tile.append(h('div', { class: 'row' },
        btn('置き換える', () => { const s = app.ui.pendingImport; app.ui.pendingImport = null; app.ui.importMsg = { kind: 'ok', text: '読み込みました' }; app.replaceSaved(s); }, 'btn btn-dark', { 'data-key': 'import-yes' }),
        btn('やめる', () => { app.ui.pendingImport = null; app.ui.importMsg = null; app.render(); }, 'btn btn-ghost', { 'data-key': 'import-no' })));
    }
  }
  return tile;
}

// ================================================================ メイン3枠

function mainSlots(app, wk) {
  const main = wk.rundown.corners.find((c) => c.key === 'main');
  const def = cornerDef('main');
  const used = usedTopicIds(wk.rundown);
  const sugg = suggestMain(app.topics, used, def.maxItems);
  const sec = h('section', { class: 'main-slots', attrs: { 'aria-labelledby': 'h-main' } });
  const head = h('div', { class: 'sec-head' },
    h('h2', { id: 'h-main', class: 'sec-title' }, 'メイン3トピック'),
    h('p', { class: 'sec-note' }, 'スコア上位（全ジャンル）からおすすめを出しています。'),
    main.items.length < def.maxItems && sugg.length
      ? btn('おすすめで埋める', () => app.update((w) => {
        let r = w.rundown;
        for (const t of suggestMain(app.topics, usedTopicIds(r), def.maxItems - r.corners.find((c) => c.key === 'main').items.length)) {
          r = assignTopic(r, t.id, 'main') || r;
        }
        w.rundown = r;
      }), 'btn btn-red', { 'data-key': 'fill-main' })
      : null);
  sec.append(head);
  const grid = h('div', { class: 'slot-grid' });
  let s = 0;
  for (let i = 0; i < def.maxItems; i++) {
    const tid = main.items[i];
    const t = tid ? app.topicsById.get(tid) : null;
    if (t) {
      grid.append(h('article', { class: 'slot g-main', dataset: { topic: t.id } },
        h('span', { class: 'slot-no', attrs: { 'aria-hidden': 'true' } }, String(i + 1)),
        h('div', { class: 'slot-top' }, genreSticker(t.genre, { small: true }), topicMarks(app, t)),
        h('h3', { class: 'slot-name' }, h('span', { class: 'sr-only' }, `メイン${i + 1}：`), t.name),
        h('p', { class: 'stats' }, statsLine(t)),
        h('p', { class: 'slot-lead' }, leadFor(app, t)),
        h('div', { class: 'row' },
          btn('↑', () => app.update((w) => { w.rundown = moveInCorner(w.rundown, 'main', t.id, -1); }), 'btn btn-small btn-onred', { 'aria-label': `${t.name} を上へ`, 'data-key': `main-up-${t.id}`, disabled: i === 0 }),
          btn('↓', () => app.update((w) => { w.rundown = moveInCorner(w.rundown, 'main', t.id, 1); }), 'btn btn-small btn-onred', { 'aria-label': `${t.name} を下へ`, 'data-key': `main-down-${t.id}`, disabled: i === main.items.length - 1 }),
          btn('編集・台本', () => openDialog(app, t.id), 'btn btn-small btn-onred', { 'data-key': `main-edit-${t.id}` }),
          btn('外す', () => app.update((w) => { w.rundown = removeTopic(w.rundown, t.id); }), 'btn btn-small btn-onred', { 'data-key': `main-rm-${t.id}` }))));
    } else {
      const sg = sugg[s++];
      grid.append(h('article', { class: 'slot is-empty' },
        h('span', { class: 'slot-no', attrs: { 'aria-hidden': 'true' } }, String(i + 1)),
        h('h3', { class: 'slot-name' }, `メイン${i + 1}：空き`),
        sg ? h('p', { class: 'slot-lead' }, 'おすすめ：', h('b', {}, sg.name), `（話題性 ${formatCompact(sg.score)}）`) : h('p', { class: 'slot-lead' }, '下の候補から「メインへ」で入れてください'),
        sg ? btn('おすすめを入れる', () => app.update((w) => { w.rundown = assignTopic(w.rundown, sg.id, 'main') || w.rundown; }), 'btn btn-small', { 'data-key': `sugg-${i}` }) : null));
    }
  }
  sec.append(grid);
  return sec;
}

// ================================================================ 構成と台本

function rundownSection(app, wk) {
  const sec = h('section', { class: 'card rundown', attrs: { 'aria-labelledby': 'h-rundown' } });
  const total = totalMinutes(wk.rundown);
  const diff = total - SHOW_DEFAULTS.totalMinutes;
  sec.append(h('div', { class: 'sec-head' },
    h('h2', { id: 'h-rundown', class: 'sec-title' }, '構成と台本'),
    h('p', { class: `sec-note${diff ? ' is-warn' : ''}` }, `合計 ${total}分${diff ? `（予定の${SHOW_DEFAULTS.totalMinutes}分より${Math.abs(diff)}分${diff > 0 ? '長い' : '短い'}）` : `（予定どおり）`}`)));
  const list = h('ol', { class: 'corner-list' });
  for (const c of wk.rundown.corners) list.append(cornerBlock(app, wk, c));
  sec.append(list);
  return sec;
}

function cornerBlock(app, wk, c) {
  const def = cornerDef(c.key);
  const li = h('li', { class: `corner g-${def.color}-edge`, dataset: { corner: c.key } });
  const min = h('input', { class: 'input input-min', type: 'number', min: 0, max: 240, step: 1, value: String(c.min), dataset: { key: `min-${c.key}` }, attrs: { 'aria-label': `${def.name}の時間（分）` } });
  min.addEventListener('change', () => {
    const v = Math.round(Number(min.value));
    if (!Number.isFinite(v) || v < 0 || v > 240) { min.value = String(c.min); return; }
    app.update((w) => { w.rundown.corners.find((x) => x.key === c.key).min = v; });
  });
  li.append(h('div', { class: 'corner-head' },
    h('span', { class: `corner-chip g-${def.color}` }, genreIcon(def.color)),
    h('div', { class: 'corner-title' }, h('h3', {}, def.name), h('p', { class: 'corner-sub' }, def.sub)),
    h('label', { class: 'min-box' }, min, h('span', {}, '分'))));
  if (def.kind === 'main' || def.kind === 'news') {
    if (!c.items.length) li.append(h('p', { class: 'muted corner-empty' }, def.kind === 'main' ? '上の「メイン3トピック」に入れてください' : '右の候補から入れてください'));
    const ol = h('ol', { class: 'item-list' });
    c.items.forEach((tid, i) => {
      const t = app.topicsById.get(tid);
      if (!t) {
        ol.append(h('li', { class: 'item is-missing' }, h('span', {}, '見つからない話題（データ更新で消えた可能性）'),
          btn('外す', () => app.update((w) => { w.rundown = removeTopic(w.rundown, tid); }), 'btn btn-small btn-ghost')));
        return;
      }
      ol.append(itemBlock(app, wk, c, t, i));
    });
    li.append(ol);
  } else if (def.kind === 'review') {
    li.append(reviewSummary(app));
    li.append(noteBox(app, wk, c.key, '話すポイント（自分用メモ）'));
  } else {
    if (c.key === 'opening') {
      const mains = mainTopics(app);
      li.append(h('p', { class: 'corner-auto' }, 'タイトルコール：', h('b', {}, currentTitle(app))));
      li.append(h('p', { class: 'corner-auto' }, '3大ニュース予告：', mains.length ? mains.map((t) => t.name).join(' ／ ') : '（メイン未設定）'));
    }
    if (c.key === 'ending') {
      const carried = wk.carriedOut.length;
      li.append(h('p', { class: 'corner-auto' }, `来週へ持ち越し：${carried ? wk.carriedOut.map((x) => x.name).join(' ／ ') : 'なし'}`));
    }
    li.append(noteBox(app, wk, c.key, c.key === 'break' ? 'コメント紹介・告知メモ' : 'メモ'));
  }
  return li;
}

function noteBox(app, wk, key, label) {
  const ta = h('textarea', { class: 'input', rows: 2, value: wk.notes[key] || '', dataset: { key: `note-${key}` } });
  ta.addEventListener('input', () => app.update((w) => { w.notes[key] = ta.value; }, { render: false, debounce: true }));
  return field(label, ta);
}

export function reviewSummary(app) {
  const wr = app.reports ? pickWeeklyReport(app.reports.weekly, app.week) : null;
  if (!wr) return h('p', { class: 'muted' }, '答え合わせのデータはまだありません（reports.json の週間まとめが届くと表示されます）');
  const rows = [...wr.byCondition, ...wr.byPace];
  return h('div', { class: 'review-sum' },
    h('p', { class: 'muted' }, `週間まとめ ${wr.from || '?'}〜${wr.to || '?'}`),
    rows.length ? h('ul', { class: 'hit-list' }, rows.map((r) => h('li', {}, h('span', {}, r.label ?? '不明'), ' ', h('b', {}, hitRateText(r.total, r.crossed))))) : h('p', { class: 'muted' }, '該当なし'));
}

function itemBlock(app, wk, c, t, i) {
  const sc = scriptFor(app, t.id);
  const auto = leadText(t, app.postsById, app.ds.refTs);
  const open = app.ui.openScript.has(t.id);
  const li = h('li', { class: `item g-${c.key === 'main' ? 'main' : t.genre}-edge`, dataset: { topic: t.id } });
  li.append(h('div', { class: 'item-head' },
    h('span', { class: 'item-no' }, String(i + 1)),
    genreSticker(t.genre, { label: false, small: true }),
    h('span', { class: 'item-name' }, t.name),
    h('span', { class: 'item-btns' },
      btn('↑', () => app.update((w) => { w.rundown = moveInCorner(w.rundown, c.key, t.id, -1); }), 'btn btn-icon', { 'aria-label': `${t.name} を上へ`, disabled: i === 0, 'data-key': `up-${c.key}-${t.id}` }),
      btn('↓', () => app.update((w) => { w.rundown = moveInCorner(w.rundown, c.key, t.id, 1); }), 'btn btn-icon', { 'aria-label': `${t.name} を下へ`, disabled: i === c.items.length - 1, 'data-key': `down-${c.key}-${t.id}` }),
      btn('外す', () => app.update((w) => { w.rundown = removeTopic(w.rundown, t.id); }), 'btn btn-small btn-ghost', { 'data-key': `rm-${c.key}-${t.id}` }))));
  const det = h('details', { class: 'script', open });
  det.addEventListener('toggle', () => { if (det.open) app.ui.openScript.add(t.id); else app.ui.openScript.delete(t.id); });
  det.append(h('summary', {}, '台本（リード・話すポイント・質問）'));
  const lead = h('textarea', { class: 'input', rows: 3, value: typeof sc.lead === 'string' && sc.lead.trim() ? sc.lead : auto, dataset: { key: `lead-${t.id}` } });
  lead.addEventListener('input', () => app.update((w) => {
    w.script[t.id] = { ...scriptFor(app, t.id), lead: lead.value === auto ? null : lead.value };
  }, { render: false, debounce: true }));
  const points = h('textarea', { class: 'input', rows: 3, value: sc.points, dataset: { key: `points-${t.id}` }, placeholder: '例：店側の言い分／お客さんの反応／自分の体験' });
  points.addEventListener('input', () => app.update((w) => { w.script[t.id] = { ...scriptFor(app, t.id), points: points.value }; }, { render: false, debounce: true }));
  const q = h('input', { class: 'input', type: 'text', value: sc.question, dataset: { key: `q-${t.id}` }, placeholder: '例：みんなの店ではどう？' });
  q.addEventListener('input', () => app.update((w) => { w.script[t.id] = { ...scriptFor(app, t.id), question: q.value }; }, { render: false, debounce: true }));
  det.append(field('リード文', lead, typeof sc.lead === 'string' && sc.lead.trim() ? '（手で編集中）' : '（自動の下書き）'),
    typeof sc.lead === 'string' && sc.lead.trim() ? btn('自動の下書きに戻す', () => app.update((w) => { w.script[t.id] = { ...scriptFor(app, t.id), lead: null }; }), 'btn btn-small btn-ghost') : null,
    field('話すポイント', points), field('視聴者への質問', q));
  li.append(det);
  return li;
}

// ================================================================ 候補（話題カード）

function filterTopics(app, wk) {
  const f = app.ui.filter;
  const q = app.ui.query.trim().normalize('NFKC').toLowerCase();
  return app.topics.filter((t) => {
    if (f === 'new' && !(app.newInfo && app.newInfo.topics.has(t.id))) return false;
    if (f === 'me' && !(t.personal || t.bookmark)) return false;
    if (f === 'suggest' && !t.suggested) return false;
    if (GENRES.some((g) => g.key === f) && t.genre !== f) return false;
    if (q && !t.name.normalize('NFKC').toLowerCase().includes(q)) return false;
    return true;
  });
}

function candidatesSection(app, wk) {
  const sec = h('section', { class: 'candidates', attrs: { 'aria-labelledby': 'h-cand' } });
  sec.append(h('div', { class: 'sec-head' },
    h('h2', { id: 'h-cand', class: 'sec-title' }, '話題の候補'),
    h('p', { class: 'sec-note', attrs: { title: SCORE_NOTE } }, '話題性の高い順（似た投稿はまとめています）')));
  const chips = h('div', { class: 'chips', attrs: { role: 'group', 'aria-label': '候補の絞り込み' } });
  for (const f of FILTERS) {
    const pressed = app.ui.filter === f.key;
    chips.append(h('button', {
      type: 'button', class: `chip${f.genre ? ` chip-${f.genre}` : ''}`, attrs: { 'aria-pressed': String(pressed) }, dataset: { key: `filter-${f.key}`, filter: f.key },
      on: { click: () => { app.ui.filter = f.key; app.ui.shown = PAGE; app.render(); } },
    }, f.label));
  }
  const search = h('input', { class: 'input input-sm', type: 'search', value: app.ui.query, placeholder: '話題名で探す', dataset: { key: 'topic-search' }, attrs: { 'aria-label': '話題名で探す' } });
  search.addEventListener('input', () => { app.ui.query = search.value; app.ui.shown = PAGE; clearTimeout(search._t); search._t = setTimeout(() => app.render(), 200); });
  sec.append(h('div', { class: 'cand-tools' }, chips, search));
  const list = filterTopics(app, wk);
  sec.append(h('p', { class: 'muted cand-count', attrs: { role: 'status' } }, `${list.length}件${list.length > app.ui.shown ? `（上位 ${app.ui.shown}件を表示）` : ''}`));
  if (!list.length) {
    sec.append(h('p', { class: 'empty' }, '該当なし'));
    return sec;
  }
  const grid = h('div', { class: 'cand-grid' });
  for (const t of list.slice(0, app.ui.shown)) grid.append(topicCard(app, wk, t));
  sec.append(grid);
  if (list.length > app.ui.shown) sec.append(h('div', { class: 'more-row' }, btn(`さらに表示（残り ${list.length - app.ui.shown}件）`, () => { app.ui.shown += PAGE; app.render(); }, 'btn', { 'data-key': 'cand-more' })));
  return sec;
}

function whereIs(wk, tid) {
  for (const c of wk.rundown.corners) if (c.items.includes(tid)) return c.key;
  return null;
}

function topicCard(app, wk, t) {
  const at = whereIs(wk, t.id);
  const carried = isCarriedOut(wk.carriedOut, t.id);
  const card = h('article', { class: `tcard g-${t.genre}`, dataset: { topic: t.id } });
  card.append(h('div', { class: 'tcard-top' }, genreSticker(t.genre, { small: true }), h('span', { class: 'tcard-marks' }, topicMarks(app, t))));
  card.append(h('h3', { class: 'tcard-name' }, t.name));
  card.append(h('p', { class: 'stats' }, statsLine(t)));
  const rep = t.stats.topPostId ? app.postsById.get(t.stats.topPostId) : null;
  if (rep) card.append(h('p', { class: 'tcard-text' }, rep.text));
  else if (t.kind === 'link') card.append(h('p', { class: 'tcard-text' }, '中身は「編集・台本」→「埋め込みで見る」か X で確認'));
  if (t.suggested) {
    const why = t.reasons.map((r) => ({ similar: '本文が似ている', same_user: '同じアカウント', related: '関係者への言及' }[r] || r)).join('・');
    card.append(h('div', { class: 'suggest-row' },
      h('span', {}, `同じ話題かも？（${why}・${t.stats.count}件）`),
      btn('まとめる', () => app.update((w) => { w.overrides.accepted = [...new Set([...w.overrides.accepted, t.id])]; }, { topics: true }), 'btn btn-small btn-dark', { 'data-key': `accept-${t.id}` }),
      btn('バラす', () => app.update((w) => { w.overrides.split = [...new Set([...w.overrides.split, t.id])]; w.rundown = removeTopic(w.rundown, t.id); }, { topics: true }), 'btn btn-small btn-dark', { 'data-key': `split-${t.id}` })));
  }
  const acts = h('div', { class: 'tcard-actions' });
  if (at) {
    acts.append(h('span', { class: 'in-corner' }, `「${cornerDef(at).name}」に入っています`),
      btn('外す', () => app.update((w) => { w.rundown = removeTopic(w.rundown, t.id); }), 'btn btn-small btn-dark', { 'data-key': `card-rm-${t.id}` }));
  } else if (carried) {
    acts.append(h('span', { class: 'in-corner' }, '来週に回しました'),
      btn('取り消す', () => app.update((w) => { w.carriedOut = togglePlanCarry(w.carriedOut, t, app.weekKey, w.script[t.id]); }), 'btn btn-small btn-dark', { 'data-key': `card-uncarry-${t.id}` }));
  } else {
    const mainFull = wk.rundown.corners.find((c) => c.key === 'main').items.length >= cornerDef('main').maxItems;
    acts.append(
      btn('メインへ', () => app.update((w) => { w.rundown = assignTopic(w.rundown, t.id, 'main') || w.rundown; }), 'btn btn-small btn-dark', { disabled: mainFull, title: mainFull ? 'メインは3本までです' : null, 'data-key': `to-main-${t.id}` }),
      btn('カテゴリ別へ', () => app.update((w) => { w.rundown = assignTopic(w.rundown, t.id, 'category') || w.rundown; }), 'btn btn-small btn-dark', { 'data-key': `to-category-${t.id}` }),
      btn('雑談へ', () => app.update((w) => { w.rundown = assignTopic(w.rundown, t.id, 'chat') || w.rundown; }), 'btn btn-small btn-dark', { 'data-key': `to-chat-${t.id}` }),
      btn('来週へ', () => app.update((w) => { w.carriedOut = togglePlanCarry(w.carriedOut, t, app.weekKey, w.script[t.id]); }), 'btn btn-small btn-ghost-dark', { 'data-key': `card-carry-${t.id}` }));
  }
  acts.append(btn('編集・台本', () => openDialog(app, t.id), 'btn btn-small btn-ghost-dark', { 'data-key': `edit-${t.id}` }));
  card.append(acts);
  return card;
}

// ================================================================ 話題の編集（ダイアログ）

function openDialog(app, tid) {
  app.ui.dialogTopic = tid;
  app.render();
}

function topicDialog(app, t) {
  const wk = app.weekState();
  const dlg = h('dialog', { class: `topic-dialog`, attrs: { 'aria-labelledby': 'dlg-title' } });
  const close = () => { app.ui.dialogTopic = null; if (dlg.open) dlg.close(); app.render(); };
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  const name = h('input', { class: 'input', type: 'text', value: t.name, maxLength: 80, dataset: { key: 'dlg-name' } });
  name.addEventListener('change', () => app.update((w) => {
    const v = name.value.trim();
    if (!v || v === t.autoName) delete w.overrides.renames[t.id]; else w.overrides.renames[t.id] = v;
  }, { topics: true }));
  const genre = h('select', { class: 'input', dataset: { key: 'dlg-genre' } }, GENRES.map((g) => h('option', { value: g.key, selected: g.key === t.genre }, g.label)));
  genre.addEventListener('change', () => app.update((w) => { w.overrides.genres[t.id] = genre.value; }, { topics: true }));

  const body = h('div', { class: 'dlg-body' });
  body.append(h('div', { class: `dlg-head g-${t.genre}` },
    genreSticker(t.genre, { small: true }),
    h('h2', { id: 'dlg-title' }, t.name),
    btn('閉じる', close, 'btn btn-small btn-dark dlg-close', { 'data-key': 'dlg-close' })));
  body.append(h('p', { class: 'stats' }, statsLine(t)));
  body.append(h('div', { class: 'dlg-grid' }, field('話題名', name, t.name !== t.autoName ? `（自動：${t.autoName}）` : null), field('ジャンル', genre)));

  // 結合
  const others = topicChoices(app, t.id);
  const mergeSel = h('select', { class: 'input', dataset: { key: 'dlg-merge' } }, h('option', { value: '' }, '— まとめ先を選ぶ —'), others.map((o) => h('option', { value: o.id }, o.label)));
  body.append(h('div', { class: 'dlg-row' }, field('この話題を別の話題にまとめる', mergeSel),
    btn('まとめる', () => {
      const dst = mergeSel.value;
      if (!dst) return;
      app.ui.dialogTopic = dst;
      app.update((w) => {
        w.overrides.merges[t.id] = dst;
        w.rundown = replaceTopicId(w.rundown, t.id, dst);
        if (w.script[t.id] && !w.script[dst]) w.script[dst] = w.script[t.id];
      }, { topics: true });
    }, 'btn', { 'data-key': 'dlg-merge-go' })));
  if (t.suggested) {
    body.append(h('div', { class: 'row' },
      h('span', { class: 'badge badge-suggest' }, '同じ話題かも？'),
      btn('まとめる（採用）', () => app.update((w) => { w.overrides.accepted = [...new Set([...w.overrides.accepted, t.id])]; }, { topics: true }), 'btn btn-small'),
      btn('バラす（分割）', () => { app.ui.dialogTopic = null; app.update((w) => { w.overrides.split = [...new Set([...w.overrides.split, t.id])]; w.rundown = removeTopic(w.rundown, t.id); }, { topics: true }); }, 'btn btn-small')));
  }

  // 台本
  const sc = scriptFor(app, t.id);
  const auto = leadText(t, app.postsById, app.ds.refTs);
  const lead = h('textarea', { class: 'input', rows: 3, value: typeof sc.lead === 'string' && sc.lead.trim() ? sc.lead : auto, dataset: { key: 'dlg-lead' } });
  lead.addEventListener('input', () => app.update((w) => { w.script[t.id] = { ...scriptFor(app, t.id), lead: lead.value === auto ? null : lead.value }; }, { render: false, debounce: true }));
  const points = h('textarea', { class: 'input', rows: 3, value: sc.points, dataset: { key: 'dlg-points' } });
  points.addEventListener('input', () => app.update((w) => { w.script[t.id] = { ...scriptFor(app, t.id), points: points.value }; }, { render: false, debounce: true }));
  const q = h('input', { class: 'input', type: 'text', value: sc.question, dataset: { key: 'dlg-q' } });
  q.addEventListener('input', () => app.update((w) => { w.script[t.id] = { ...scriptFor(app, t.id), question: q.value }; }, { render: false, debounce: true }));
  body.append(h('h3', { class: 'dlg-sub' }, '台本'), field('リード文', lead, '（数字からの自動下書き。書き換えできます）'), field('話すポイント', points), field('視聴者への質問', q));

  // 投稿
  body.append(h('h3', { class: 'dlg-sub' }, `投稿（${t.postIds.length}件）`));
  const posts = topicPosts(app, t);
  if (!posts.length) {
    const id = t.linkId || (t.linkIds && t.linkIds[0]);
    body.append(id ? linkCard(id, null, app.embedder) : h('p', { class: 'muted' }, '投稿はまだありません（ほかの話題から移せます）'));
  }
  const moveTargets = [{ id: '__new', label: '新しい話題として分ける' }, ...others];
  for (const p of posts.slice(0, 40)) {
    const sel = h('select', { class: 'input input-sm', dataset: { key: `dlg-move-${p.id}` }, attrs: { 'aria-label': 'この投稿の移動先' } }, h('option', { value: '' }, '別の話題へ移す…'), moveTargets.map((o) => h('option', { value: o.id }, o.label)));
    sel.addEventListener('change', () => {
      if (!sel.value) return;
      const target = sel.value === '__new' ? `p:${p.id}` : sel.value;
      app.update((w) => { w.overrides.moves[p.id] = target; }, { topics: true });
    });
    const mark = h('span', { class: 'post-move' }, sel);
    body.append(postCard(p, { refTs: app.ds.refTs, refYear: refYear(app), embedder: app.embedder, mark, bm: bmInfo(app, p.id) }));
  }
  if (posts.length > 40) body.append(h('p', { class: 'muted' }, `ほか ${posts.length - 40}件`));
  dlg.append(body);
  app.afterRender = () => { if (!dlg.open && typeof dlg.showModal === 'function') dlg.showModal(); };
  return dlg;
}

/** まとめ先・移動先の候補（構成に入っている話題＋スコア上位＋手動の話題） */
function topicChoices(app, exceptId) {
  const used = new Set(usedTopicIds(app.weekState().rundown));
  const list = [];
  const seen = new Set([exceptId]);
  const push = (t) => { if (!t || seen.has(t.id)) return; seen.add(t.id); list.push({ id: t.id, label: `${t.name}（${genreLabel(t.genre)}・${t.stats.count}件）` }); };
  for (const id of used) push(app.topicsById.get(id));
  for (const t of app.topics) if (t.kind === 'manual') push(t);
  for (const t of app.topics.slice(0, 60)) push(t);
  return list;
}

// ================================================================ 個人投稿・ブックマーク

function personalSection(app, wk) {
  const sec = h('section', { class: 'card personal', attrs: { 'aria-labelledby': 'h-personal' } });
  sec.append(h('h2', { id: 'h-personal', class: 'sec-title' }, '自分で集めた投稿'));
  const ta = h('textarea', { class: 'input', rows: 3, placeholder: 'https://x.com/…/status/… を1行に1つずつ貼り付け', dataset: { key: 'personal-input' }, value: app.ui.personalDraft || '' });
  ta.addEventListener('input', () => { app.ui.personalDraft = ta.value; });
  const add = btn('候補に追加', () => {
    const r = extractStatusIds(ta.value);
    const before = new Set(wk.personal.map((p) => p.id));
    const added = r.ids.filter((x) => !before.has(x.id));
    app.ui.personalDraft = '';
    const found = added.filter((x) => app.postsById.has(x.id)).length;
    app.ui.personalMsg = r.ids.length || r.invalid.length
      ? `${added.length}件追加しました（データにあり ${found}件・リンクのみ ${added.length - found}件）${r.ids.length - added.length ? `・追加済み ${r.ids.length - added.length}件` : ''}${r.invalid.length ? `・読み取れなかったもの ${r.invalid.length}件：${r.invalid.slice(0, 3).join(' ')}` : ''}`
      : 'URL が見つかりませんでした';
    app.update((w) => { w.personal = [...w.personal, ...added.map((x) => ({ id: x.id, url: x.url, addedAt: Date.now() }))]; }, { topics: true });
  }, 'btn', { 'data-key': 'personal-add' });
  sec.append(field('X の投稿URL（複数行OK）', ta), h('div', { class: 'row' }, add));
  if (app.ui.personalMsg) sec.append(h('p', { class: 'muted', attrs: { role: 'status' } }, app.ui.personalMsg));
  if (wk.personal.length) {
    const ul = h('ul', { class: 'mini-list' });
    for (const p of wk.personal) {
      const post = app.postsById.get(p.id);
      ul.append(h('li', { dataset: { id: p.id } },
        h('span', { class: 'mini-text' }, post ? `@${post.user}：${post.text.slice(0, 40)}` : `リンクのみ（ID ${p.id}）`),
        h('a', { href: post ? statusUrl(p.id) : p.url, target: '_blank', rel: 'noopener noreferrer', class: 'btn btn-small btn-ghost' }, 'Xで開く'),
        btn('削除', () => app.update((w) => { w.personal = w.personal.filter((x) => x.id !== p.id); }, { topics: true }), 'btn btn-small btn-ghost', { 'aria-label': `ID ${p.id} を削除` })));
    }
    sec.append(ul);
  }
  return sec;
}

// ================================================================ ブックマーク（data/bookmarks.json があるときだけ）

function bookmarkSection(app, wk) {
  const used = pastUsedIds(app.saved, app.weekKey);
  const weekList = bookmarkList(app.bookmarks, app.week, app.postsById, used, 'week');
  const mode = app.ui.bmMode === 'all' ? 'all' : 'week';
  const list = mode === 'all' ? bookmarkList(app.bookmarks, app.week, app.postsById, used, 'all') : weekList;
  const sec = h('section', { class: 'card bookmarks-sec', attrs: { 'aria-labelledby': 'h-bm' } });
  sec.append(h('div', { class: 'sec-head' },
    h('h2', { id: 'h-bm', class: 'sec-title' }, '★ブックマーク'),
    h('p', { class: 'sec-note' }, '今週の分（ブックマークした日時が今週。日時が無いものは投稿日時で判定）は自動で話題の候補に入っています。数値はブックマーク時点のものです。')));
  const chips = h('div', { class: 'chips', attrs: { role: 'group', 'aria-label': 'ブックマークの表示' } });
  for (const [key, label] of [['week', `今週（${weekList.length}）`], ['all', `すべて（${app.bookmarks.length}）`]]) {
    chips.append(h('button', { type: 'button', class: 'chip', attrs: { 'aria-pressed': String(mode === key) }, dataset: { key: `bm-${key}`, bm: key }, on: { click: () => { app.ui.bmMode = key; app.ui.bmShown = 20; app.render(); } } }, label));
  }
  sec.append(chips);
  if (!list.length) { sec.append(h('p', { class: 'empty' }, '該当なし')); return sec; }
  const shown = app.ui.bmShown || 20;
  const personal = new Set(wk.personal.map((p) => p.id));
  const ul = h('ul', { class: 'mini-list bm-list' });
  for (const b of list.slice(0, shown)) {
    const p = b.post;
    const flags = bmInfo(app, b.id);
    const inCand = b.inWeek || personal.has(b.id);
    ul.append(h('li', { dataset: { id: b.id }, class: b.used ? 'is-used' : '' },
      h('span', { class: 'mini-text' }, p ? h('b', {}, `@${p.user}`) : null, p ? `：${p.text.replace(/\s+/g, ' ').slice(0, 60)}` : `中身はデータに無い投稿（ID ${b.id}）`),
      b.used ? badge('使用済み', 'badge-used') : null,
      flags && flags.below ? badge('ブクマで取り込み', 'badge-me') : null,
      inCand ? h('span', { class: 'bm-in' }, '候補に入っています') : btn('候補に入れる', () => app.update((w) => {
        if (!w.personal.some((x) => x.id === b.id)) w.personal = [...w.personal, { id: b.id, url: statusUrl(b.id), addedAt: Date.now() }];
      }, { topics: true }), 'btn btn-small', { 'data-key': `bm-add-${b.id}` }),
      h('a', { href: statusUrl(b.id), target: '_blank', rel: 'noopener noreferrer', class: 'btn btn-small btn-ghost' }, 'Xで開く')));
  }
  sec.append(ul);
  if (list.length > shown) sec.append(h('div', { class: 'more-row' }, btn(`さらに表示（残り ${list.length - shown}件）`, () => { app.ui.bmShown = shown + 20; app.render(); }, 'btn btn-small', { 'data-key': 'bm-more' })));
  return sec;
}

// ================================================================ 持ち越し

function carriedSection(app, wk) {
  const sec = h('section', { class: 'card carried', attrs: { 'aria-labelledby': 'h-carried' } });
  sec.append(h('h2', { id: 'h-carried', class: 'sec-title' }, '持ち越し'));
  const fromPrev = app.topics.filter((t) => t.kind === 'carried');
  sec.append(h('h3', { class: 'sub-title' }, `先週から（${fromPrev.length}件・候補に入っています）`));
  sec.append(fromPrev.length ? h('ul', { class: 'mini-list' }, fromPrev.map((t) => h('li', {}, genreSticker(t.genre, { label: false, small: true }), h('span', { class: 'mini-text' }, t.name)))) : h('p', { class: 'muted' }, '該当なし'));
  sec.append(h('h3', { class: 'sub-title' }, `来週へ回したもの（${wk.carriedOut.length}件）`));
  if (!wk.carriedOut.length) sec.append(h('p', { class: 'muted' }, '該当なし'));
  else {
    sec.append(h('ul', { class: 'mini-list' }, wk.carriedOut.map((c) => h('li', {},
      genreSticker(c.genre, { label: false, small: true }), h('span', { class: 'mini-text' }, c.name),
      h('span', { class: 'muted' }, c.via === 'plan' ? '（編成で）' : '（進行で）'),
      c.via === 'plan' ? btn('取り消す', () => app.update((w) => { w.carriedOut = w.carriedOut.filter((x) => x.topicId !== c.topicId); }), 'btn btn-small btn-ghost') : null))));
  }
  return sec;
}

// ================================================================ 話題辞書

const splitList = (s) => s.split(/[,、，\n]/).map((x) => x.trim()).filter(Boolean);

function dictSection(app) {
  const sec = h('section', { class: 'card dict', attrs: { 'aria-labelledby': 'h-dict' } });
  sec.append(h('h2', { id: 'h-dict', class: 'sec-title' }, '話題辞書'),
    h('p', { class: 'muted' }, '言葉（本文・根拠語）か関係者（店名・源氏名・@アカウント）が一致した投稿を、同じ話題にまとめます。「、」区切りで入力。'));
  const list = h('div', { class: 'dict-list' });
  app.saved.dict.forEach((e, i) => {
    const upd = (fn) => app.update((w, s) => { const x = s.dict.find((d) => d.id === e.id); if (x) fn(x); }, { topics: true });
    const nm = h('input', { class: 'input input-sm', type: 'text', value: e.name, maxLength: 60, dataset: { key: `dict-name-${e.id}` }, attrs: { 'aria-label': '話題名' } });
    nm.addEventListener('change', () => upd((x) => { x.name = nm.value.trim() || x.name; }));
    const gs = h('select', { class: 'input input-sm', dataset: { key: `dict-genre-${e.id}` }, attrs: { 'aria-label': 'ジャンル' } }, GENRES.map((g) => h('option', { value: g.key, selected: g.key === e.genre }, g.label)));
    gs.addEventListener('change', () => upd((x) => { x.genre = gs.value; }));
    const ws = h('input', { class: 'input input-sm', type: 'text', value: e.words.join('、'), dataset: { key: `dict-words-${e.id}` }, attrs: { 'aria-label': '言葉' } });
    ws.addEventListener('change', () => upd((x) => { x.words = splitList(ws.value).slice(0, 50); }));
    const ps = h('input', { class: 'input input-sm', type: 'text', value: e.people.join('、'), placeholder: '店名・源氏名・@アカウント', dataset: { key: `dict-people-${e.id}` }, attrs: { 'aria-label': '関係者' } });
    ps.addEventListener('change', () => upd((x) => { x.people = splitList(ps.value).slice(0, 50); }));
    list.append(h('div', { class: 'dict-row', dataset: { dict: e.id } },
      h('span', { class: 'dict-no' }, String(i + 1)), nm, gs, ws, ps,
      btn('削除', () => app.update((w, s) => { s.dict = s.dict.filter((d) => d.id !== e.id); }, { topics: true }), 'btn btn-small btn-ghost', { 'aria-label': `${e.name} を削除` })));
  });
  sec.append(h('div', { class: 'dict-head', attrs: { 'aria-hidden': 'true' } }, h('span', {}), h('span', {}, '話題名'), h('span', {}, 'ジャンル'), h('span', {}, '言葉'), h('span', {}, '関係者'), h('span', {})));
  sec.append(list);
  sec.append(h('div', { class: 'row' },
    btn('話題を追加', () => app.update((w, s) => { s.dict = [...s.dict, { id: `u-${Date.now().toString(36)}`, name: '新しい話題', genre: 'night', words: [], people: [] }]; }, { topics: true }), 'btn', { 'data-key': 'dict-add' }),
    btn('最初の辞書に戻す', () => app.update((w, s) => { s.dict = DEFAULT_DICT.map((e) => ({ ...e, words: [...e.words], people: [...e.people] })); }, { topics: true }), 'btn btn-ghost', { 'data-key': 'dict-reset' })));
  return sec;
}

