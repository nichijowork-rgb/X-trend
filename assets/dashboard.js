// Xレポート ダッシュボード — エントリ（ES module）
// データ: data/posts.json・data/summary.json（別botが更新）。無ければ sample/ にフォールバック。
// 本文などの外部由来文字列は textContent / DOM 生成でのみ挿入する（innerHTML 不使用）。

import {
  ACCOUNT_SORTS, DEFAULT_STATE, METRIC_KEYS, METRIC_LABELS, PERIODS, SORTS,
  aggregate, chartDayRange, countByCategory, debounce, fillDays, filterPosts,
  formatCompact, formatDateTime, formatDateTimeFull, formatExact, highlightSegments, isFilterActive,
  isSafeHttpUrl, isValidSummary, jstParts, linkifySegments, mergeSummary, normalizeDataset,
  parseKeywords, parseState, parseTimestamp, serializeState, sortPosts, topAccounts,
  shortDate, VIEWS, embedTweetId, chooseRefTs, isUpdateDelayed, formatPace, viewsPerHour,
  normalizeReports, pickReport, formatRisingPace, formatBeforeAfter, REPORT_SECTIONS,
  categoryMatcher, inGroup, isUnclassified, filterNightRising, individualChipCategories, categoryLabel, normalizeCategorySelection,
} from './js/core.js';
import { UPDATE_SCHEDULE, PACE_NOTE, REPORT_TEXT, CATEGORY_GROUPS, WATCH_CATEGORY } from './js/config.js';
import {
  createTooltip, renderDayTable, renderHBars, renderLegend, renderStackedDays, setCatColor, renderRateBars,
} from './js/charts.js';
import { createEmbedder, resetWidgetsFailure } from './js/embed.js';
import { renderMedia } from './js/media.js';

const PAGE_SIZE = 50;
const RISING_INITIAL = 3;
const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ---------------------------------------------------------------- 読み込み

async function getJson(path) {
  const res = await fetch(path + '?t=' + Date.now(), { cache: 'no-store', credentials: 'omit' });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path}: JSON の形式が不正です`);
  }
}

async function loadFrom(dir) {
  const [p, s, r] = await Promise.allSettled([getJson(`${dir}/posts.json`), getJson(`${dir}/summary.json`), getJson(`${dir}/reports.json`)]);
  if (p.status === 'rejected') throw p.reason;
  // reports.json は任意。無い・壊れている場合はレポート欄を出さないだけ
  const reports = r.status === 'fulfilled' ? normalizeReports(r.value) : null;
  const dataset = normalizeDataset(p.value); // 形式不正は例外
  const summary = s.status === 'fulfilled' && isValidSummary(s.value) ? s.value : null;
  const summaryNote = s.status === 'rejected' ? s.reason.message : (summary ? '' : `${dir}/summary.json: 形式が不正です`);
  return { dataset, summary, summaryNote, dir, reports };
}

async function load() {
  try {
    return { ...(await loadFrom('data')), isSample: false };
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    try {
      return { ...(await loadFrom('sample')), isSample: true, reason };
    } catch (err2) {
      const e = new Error(`data/: ${reason} ／ sample/: ${err2 && err2.message ? err2.message : err2}`);
      throw e;
    }
  }
}

// ---------------------------------------------------------------- テーマ

// テーマは OS 設定に自動追従（手動切替なし。theme-init.js 参照）

/** 実際に表示中のテーマ（埋め込みの theme 指定用） */
function resolvedTheme() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

// ---------------------------------------------------------------- 保存値（localStorage は失敗しても動く）

const VIEW_KEY = 'xreport-view';
const PANEL_KEY = 'xreport-panel';
const SEEN_KEY = 'xreport-report-seen';
const RISING_KEY = 'xreport-rising';
const RISING_SEEN_KEY = 'xreport-rising-seen';
const NOTICE_KEY = 'xreport-embed-notice-dismissed';

function storageGet(k) {
  try { return window.localStorage.getItem(k); } catch { return null; }
}

function storageSet(k, v) {
  try { window.localStorage.setItem(k, v); } catch { /* 保存できない環境では無視 */ }
}

// ---------------------------------------------------------------- アプリ状態

const app = {
  ds: null,
  summary: null,
  postsById: new Map(),
  allAgg: null, // フィルタなしの集計（summary があれば反映）
  refYear: null,
  state: { ...DEFAULT_STATE },
  sorted: [],
  shown: 0,
  terms: [],
  lastDays: null,
  lastDayCats: null,
  tooltip: null,
  embedder: null,
  unknownCats: new Set(),
  noticeDismissed: false,
  perf: { lastRenderMs: 0, renders: 0 },
};

function sanitizeState(st) {
  return { ...st, ...normalizeCategorySelection(st, app.ds.categories) };
}

function writeUrl(push) {
  const s = serializeState(app.state);
  const target = s ? `#${s}` : location.pathname + location.search;
  const cur = location.hash.replace(/^#/, '');
  if (cur === s) return;
  if (push) history.pushState(null, '', target);
  else history.replaceState(null, '', target);
}

function update(patch, { push = true, scroll = false } = {}) {
  app.state = sanitizeState({ ...app.state, ...patch });
  writeUrl(push);
  syncControls();
  render();
  if (scroll) $('posts-heading').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function onUrlChange() {
  const st = sanitizeState(parseState(location.hash));
  if (serializeState(st) === serializeState(app.state)) return;
  app.state = st;
  syncControls();
  render();
}

// ---------------------------------------------------------------- コントロール

function buildControls() {
  const { ds } = app;
  // カテゴリチップ（データから動的生成）
  const chips = $('cat-chips');
  chips.replaceChildren();
  const groupChip = (g) => {
    const b = el('button', 'chip chip-group');
    b.type = 'button';
    b.dataset.group = g.key;
    b.append(el('span', 'chip-name', g.label), el('span', 'count', ''));
    b.title = g.key === 'night' ? `${g.label}（${g.categories.join('・')}）` : g.label;
    // グループを押すとそのグループのみ（個別選択は解除）
    b.addEventListener('click', () => update({ group: g.key, cats: [] }));
    return b;
  };
  const [night, general] = CATEGORY_GROUPS;
  app.unknownCats = new Set(individualChipCategories(ds.categories).filter((c) => !night.categories.includes(c)));
  chips.append(groupChip(night));
  for (const c of individualChipCategories(ds.categories)) {
    const b = el('button', 'chip');
    b.type = 'button';
    b.dataset.cat = c;
    setCatColor(b, c);
    b.append(el('i', 'dot'), el('span', 'chip-name', categoryLabel(c)), el('span', 'count', ''));
    b.title = categoryLabel(c);
    b.addEventListener('click', () => {
      // 個別チップを押すとグループ選択は解除。最後の 1 つを外したら「夜職すべて」に戻す
      const set = new Set(app.state.cats);
      if (set.has(c)) set.delete(c); else set.add(c);
      const cats = ds.categories.filter((x) => set.has(x));
      // 選択はモード（夜職／一般のバズ）の中で行う。全部外したらそのモードの全体に戻る
      update({ cats });
    });
    chips.append(b);
  }
  // ヘッダーの「夜職 ／ 一般のバズ」スイッチ（グループの切替。期間・並び替え・検索などは保持）
  const mg = $('mode-group');
  mg.replaceChildren();
  for (const g of [night, general]) {
    const b = el('button', null, g.key === 'night' ? '夜職' : g.label);
    b.type = 'button';
    b.dataset.group = g.key;
    b.title = g.key === 'night' ? `夜職（${g.categories.join('・')}）` : g.label;
    b.addEventListener('click', () => update({ group: g.key, cats: [] }));
    mg.append(b);
  }

  // 期間
  const pg = $('period-group');
  pg.replaceChildren();
  for (const p of PERIODS) {
    const b = el('button', null, p.label);
    b.type = 'button';
    b.dataset.period = p.key;
    b.addEventListener('click', () => update({ period: p.key }));
    pg.append(b);
  }

  // 並び替え
  const sort = $('sort');
  sort.replaceChildren(...SORTS.map((s) => {
    const o = el('option', null, s.label);
    o.value = s.key;
    return o;
  }));
  sort.addEventListener('change', () => update({ sort: sort.value }));

  // 上位アカウントの並び
  const ag = $('acct-group');
  ag.replaceChildren();
  for (const a of ACCOUNT_SORTS) {
    const b = el('button', null, a.label);
    b.type = 'button';
    b.dataset.acct = a.key;
    b.addEventListener('click', () => update({ acct: a.key }, { push: false }));
    ag.append(b);
  }

  // 表示切替（カード / X埋め込み）
  const vg = $('view-group');
  vg.replaceChildren();
  for (const v of VIEWS) {
    const b = el('button', null, v.label);
    b.type = 'button';
    b.dataset.view = v.key;
    b.addEventListener('click', () => {
      storageSet(VIEW_KEY, v.key);
      if (v.key === 'embed') resetWidgetsFailure();
      update({ view: v.key });
    });
    vg.append(b);
  }
  $('panel-toggle').addEventListener('click', () => {
    const next = !app.state.panel;
    storageSet(PANEL_KEY, next ? '1' : '0');
    update({ panel: next });
  });
  $('embed-notice-close').addEventListener('click', () => {
    app.noticeDismissed = true;
    storageSet(NOTICE_KEY, '1');
    $('embed-notice').hidden = true;
  });

  // キーワード（デバウンス）
  const q = $('q');
  const applyQ = debounce(() => update({ q: q.value }, { push: false }), 200);
  q.addEventListener('input', applyQ);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { applyQ.cancel(); update({ q: q.value }, { push: false }); }
  });

  // アカウント
  const users = [...new Set(ds.posts.map((p) => p.user))].sort();
  const userSet = new Set(users.map((u) => u.toLowerCase()));
  const dl = $('user-list');
  const frag = document.createDocumentFragment();
  for (const u of users) {
    const o = document.createElement('option');
    o.value = u;
    frag.append(o);
  }
  dl.replaceChildren(frag);
  const user = $('user');
  const applyUser = debounce(() => {
    const v = user.value.replace(/^@/, '').trim();
    if (!v || userSet.has(v.toLowerCase())) update({ user: v });
  }, 250);
  user.addEventListener('input', applyUser);
  user.addEventListener('change', () => { applyUser.cancel(); update({ user: user.value.replace(/^@/, '').trim() }); });

  $('watched').addEventListener('change', (e) => update({ watched: e.target.checked }));
  // 初期状態（夜職すべて・24時間・インプレッションが多い順）に戻す。表示切替・パネル等は維持
  $('reset').addEventListener('click', () => update({ cats: [], group: DEFAULT_STATE.group, period: DEFAULT_STATE.period, sort: DEFAULT_STATE.sort, user: '', q: '', watched: false }));

  // さらに表示 / 無限スクロール
  $('more').addEventListener('click', () => appendPosts());
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && app.shown < app.sorted.length && app.shown > 0) appendPosts();
    }, { rootMargin: '600px 0px' });
    io.observe($('sentinel'));
  }

  // 日別グラフは幅に合わせて再描画
  if ('ResizeObserver' in window) {
    let lastW = 0;
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0].contentRect.width);
      if (w && Math.abs(w - lastW) > 4 && app.lastDays) {
        lastW = w;
        drawDayChart();
      } else if (!lastW) lastW = w;
    });
    ro.observe($('chart-day'));
  }

  window.addEventListener('popstate', onUrlChange);
  window.addEventListener('hashchange', onUrlChange);
}

function syncControls() {
  const st = app.state;
  for (const b of $('cat-chips').querySelectorAll('.chip')) {
    const c = b.dataset.cat;
    b.setAttribute('aria-pressed', String(c ? st.cats.includes(c) : (!st.cats.length && st.group === b.dataset.group)));
    // 一般のバズモードでは夜職のチップを隠し、どのグループにも入らない未知カテゴリのチップだけ残す
    b.hidden = st.group === 'general' && !(c && app.unknownCats.has(c));
  }
  for (const b of $('period-group').children) b.setAttribute('aria-pressed', String(b.dataset.period === st.period));
  for (const b of $('acct-group').children) b.setAttribute('aria-pressed', String(b.dataset.acct === st.acct));
  $('cat-chips').hidden = ![...$('cat-chips').querySelectorAll('.chip')].some((b) => !b.hidden);
  for (const b of $('mode-group').children) b.setAttribute('aria-pressed', String(b.dataset.group === st.group));
  for (const b of $('view-group').children) b.setAttribute('aria-pressed', String(b.dataset.view === st.view));
  $('panel').hidden = !st.panel;
  const risingOpen = st.rising && !!app.reports;
  $('rising-panel').hidden = !risingOpen;
  $('rising-toggle').setAttribute('aria-expanded', String(risingOpen));
  $('rising-toggle').classList.toggle('is-open', risingOpen);
  if (risingOpen) markRisingSeen();
  $('panel-toggle').setAttribute('aria-expanded', String(st.panel));
  $('panel-toggle').classList.toggle('is-open', st.panel);
  if (st.panel) markReportsSeen();
  if (st.view === 'embed') showEmbedNotice();
  $('sort').value = st.sort;
  if (document.activeElement !== $('q')) $('q').value = st.q;
  if (document.activeElement !== $('user')) $('user').value = st.user;
  $('watched').checked = st.watched;
}

// ---------------------------------------------------------------- 描画

function setNum(node, n, unit = '') {
  node.textContent = formatCompact(n) + (n == null ? '' : unit);
  node.title = n == null ? '値なし' : formatExact(n) + unit;
}

function render() {
  const t0 = performance.now();
  const { ds, state } = app;
  const base = filterPosts(ds.posts, state, ds.refTs, { ignoreCategories: true });
  const match = categoryMatcher(state);
  const filtered = match ? base.filter(match) : base;
  // 全件と同じ（カテゴリも期間等も絞っていない）ときだけ summary.json の値を使う
  const active = isFilterActive(state) || filtered.length !== ds.posts.length;
  const agg = active ? aggregate(filtered, ds.categories) : app.allAgg;

  renderChipCounts(countByCategory(base), base);
  // 話題カテゴリ（夜職4種・その他）を持たない投稿はどのグループにも入らないので件数だけ注記
  let unclassified = 0;
  for (const p of base) if (isUnclassified(p)) unclassified++;
  $('unclassified-note').hidden = unclassified === 0;
  $('unclassified-note').textContent = `分類なし ${formatExact(unclassified)}件（話題カテゴリが無く「夜職すべて」「一般のバズ」のどちらにも入らない投稿。現在の期間・検索条件で集計）`;
  renderSummary(agg, active, filtered.length);
  renderCharts(agg, filtered);
  renderAccounts(agg);
  app.terms = parseKeywords(state.q);
  app.sorted = sortPosts(filtered, state.sort, ds.refTs);
  renderPostsReset(filtered.length);
  renderActiveFilters();
  renderReports();
  renderRising();

  app.perf.lastRenderMs = performance.now() - t0;
  app.perf.renders += 1;
}

function renderChipCounts(counts, base) {
  for (const b of $('cat-chips').querySelectorAll('.chip')) {
    const c = b.dataset.cat;
    const g = b.dataset.group;
    let n = 0;
    if (c) n = counts.get(c) || 0;
    else for (const p of base) if (inGroup(p, g)) n++;
    const cnt = b.querySelector('.count');
    cnt.textContent = formatCompact(n);
    b.classList.toggle('is-zero', n === 0);
    const name = c ? categoryLabel(c) : b.querySelector('.chip-name').textContent;
    b.setAttribute('aria-label', `${name}（${formatExact(n)}件）`);
  }
}

function renderSummary(agg, active, filteredCount) {
  const { ds } = app;
  setNum($('stat-posts'), agg.totalPosts, '件');
  $('stat-posts').textContent = formatCompact(agg.totalPosts);
  $('stat-posts-sub').textContent = active ? `全 ${formatExact(ds.posts.length)} 件中（絞り込み中）` : '全期間';
  setNum($('stat-accounts'), agg.totalAccounts);
  $('stat-accounts-sub').textContent = active ? '絞り込み中のアカウント数' : 'ユニークアカウント';
  setNum($('stat-imp'), agg.impressions.sum);
  $('stat-imp').title = `${formatExact(agg.impressions.sum)}（既知の値の合計）`;
  $('stat-imp-sub').textContent = agg.impressions.unknown > 0
    ? `（一部不明：${formatExact(agg.impressions.unknown)}件は値なし）`
    : '既知の値の合計';

  const box = $('stat-top');
  box.replaceChildren();
  const p = agg.maxImp;
  if (!p) {
    box.append(el('p', 'stat-value', '—'), el('p', 'stat-sub', filteredCount ? 'インプレッションが不明です' : '該当なし'));
  } else {
    const wrap = el('div', 'top-post');
    const head = el('div', 'top-post-head');
    const v = el('span', 'top-post-value', formatCompact(p.metrics.impression_count));
    v.title = `${formatExact(p.metrics.impression_count)} インプレッション`;
    const u = el('button', 'post-user', `@${p.user}`);
    u.type = 'button';
    u.addEventListener('click', () => update({ user: p.user }, { scroll: true }));
    const time = el('span', 'post-time', formatDateTime(p.created_jst, p.ts, app.refYear));
    time.title = formatDateTimeFull(p.created_jst, p.ts);
    head.append(v, u, time);
    if (isSafeHttpUrl(p.url)) {
      const a = el('a', 'open-x top-post-link', 'Xで開く ↗');
      a.href = p.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      head.append(a);
    }
    const text = el('p', 'top-post-text', p.text.replace(/\s+/g, ' ').trim() || '（本文なし）');
    wrap.append(head, text);
    box.append(wrap);
  }

  const note = $('source-note');
  if (active) note.textContent = 'サマリー・グラフ・上位アカウントは絞り込み結果から集計しています。';
  else if (agg.source === 'summary') note.textContent = '集計値は summary.json を使用しています（不明件数は投稿データから算出）。';
  else if (app.summaryNote) note.textContent = `summary.json を利用できないため、投稿データから集計しています（${app.summaryNote}）。`;
  else note.textContent = '集計値は投稿データから計算しています。';
}

function renderCharts(agg, filtered) {
  const { ds, state } = app;
  const sortDesc = (key) => (a, b) => b[key] - a[key];
  try {
    const postsItems = agg.byCategory.map((c) => ({ name: c.name, value: c.posts, unknown: 0 })).sort(sortDesc('value'));
    renderHBars($('chart-cat-posts'), postsItems, { unit: '件', tooltip: app.tooltip, valueLabel: '件数', emptyText: '該当する投稿はありません' });
    const impItems = agg.byCategory.map((c) => ({ name: c.name, value: c.impressions.sum, unknown: c.impressions.unknown })).sort(sortDesc('value'));
    renderHBars($('chart-cat-imp'), impItems, { unit: '', tooltip: app.tooltip, valueLabel: 'インプレッション', emptyText: '該当する投稿はありません' });
    $('chart-cat-imp-sub').textContent = impItems.some((i) => i.unknown > 0)
      ? '既知の値の合計。※＝一部不明（値が無い投稿を含む）'
      : '既知の値の合計';
  } catch (err) {
    console.warn(err);
    $('chart-cat-posts').textContent = 'グラフを読み込めませんでした';
    $('chart-cat-imp').textContent = 'グラフを読み込めませんでした';
  }

  const range = chartDayRange(state.period, ds.refTs);
  const sub = $('chart-day-sub');
  if (!range) {
    app.lastDays = [];
    app.lastDayCats = [];
    sub.textContent = '';
    $('chart-day-legend').replaceChildren();
    $('chart-day-table').replaceChildren();
    drawDayChart();
    return;
  }
  const days = fillDays(agg.byDay, range.startKey, range.endKey);
  const used = new Set();
  for (const d of days) for (const [c, v] of Object.entries(d.categories)) if (v > 0) used.add(c);
  const cats = [...ds.categories.filter((c) => used.has(c)), ...[...used].filter((c) => !ds.categories.includes(c))];
  app.lastDays = days;
  app.lastDayCats = cats;
  const text = `${shortDate(range.startKey)}〜${shortDate(range.endKey)}（JST・0件の日も表示）`;
  sub.textContent = text + '。複数カテゴリの投稿は各カテゴリに計上';
  renderLegend($('chart-day-legend'), cats);
  renderDayTable($('chart-day-table'), days, cats);
  drawDayChart();
  void filtered;
}

function drawDayChart() {
  const c = $('chart-day');
  try {
    renderStackedDays(c, app.lastDays || [], app.lastDayCats || [], { tooltip: app.tooltip, emptyText: 'この期間の投稿はありません' });
  } catch (err) {
    console.warn(err);
    c.classList.add('is-empty');
    c.textContent = 'グラフを読み込めませんでした';
  }
}

function renderAccounts(agg) {
  const { state } = app;
  const list = $('acc-list');
  const focusedUser = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.user : undefined;
  list.replaceChildren();
  const top = topAccounts(agg.byAccount, state.acct, 20);
  if (!top.length) {
    list.append(el('li', 'muted small', '該当するアカウントはありません'));
    return;
  }
  top.forEach((a, i) => {
    const li = el('li', 'acc-item');
    const b = el('button');
    b.type = 'button';
    b.dataset.user = a.user;
    b.title = `@${a.user}`;
    const selected = state.user && state.user.toLowerCase() === a.user.toLowerCase();
    b.setAttribute('aria-pressed', String(!!selected));
    const name = el('span', 'acc-name');
    name.append(el('span', null, `@${a.user}`));
    const stats = el('span', 'acc-stats');
    const imp = formatCompact(a.impressions.sum) + (a.impressions.unknown ? '＋不明' : '');
    if (state.acct === 'imp') {
      stats.append(el('strong', null, imp), document.createTextNode(` ・ ${formatExact(a.posts)}件`));
    } else {
      stats.append(el('strong', null, `${formatExact(a.posts)}件`), document.createTextNode(` ・ ${imp}`));
    }
    stats.title = `投稿 ${formatExact(a.posts)}件 / インプレッション ${formatExact(a.impressions.sum)}${a.impressions.unknown ? `（${a.impressions.unknown}件不明）` : ''}`;
    b.append(el('span', 'acc-rank', String(i + 1)), name, stats);
    b.setAttribute('aria-label', `@${a.user} 投稿${a.posts}件、インプレッション${formatExact(a.impressions.sum)}。${selected ? '絞り込みを解除' : 'このアカウントで絞り込む'}`);
    b.addEventListener('click', () => update({ user: selected ? '' : a.user }));
    li.append(b);
    list.append(li);
  });
  if (focusedUser) {
    const again = [...list.querySelectorAll('button')].find((x) => x.dataset.user === focusedUser);
    if (again) again.focus({ preventScroll: true });
  }
}

function renderActiveFilters() {
  const box = $('active-filters');
  box.replaceChildren();
  const st = app.state;
  const add = (label, patch) => {
    const s = el('span', 'af');
    s.append(el('span', null, label));
    const x = el('button', null, '×');
    x.type = 'button';
    x.setAttribute('aria-label', `「${label}」の条件を外す`);
    x.addEventListener('click', () => update(patch));
    s.append(x);
    box.append(s);
  };
  // カテゴリ・期間はツールバーに常に見えているので、ここでは詳細パネル側の条件だけをチップにする
  if (st.user) add(`アカウント: @${st.user}`, { user: '' });
  if (st.q.trim()) add(`キーワード: ${st.q.trim()}`, { q: '' });
  if (st.watched) add('監視アカウントのみ', { watched: false });
}

function showEmbedNotice() {
  if (!app.noticeDismissed) $('embed-notice').hidden = false;
}

function renderPostsReset(count) {
  app.embedder.reset();
  $('post-list').classList.toggle('is-embed', app.state.view === 'embed');
  const total = app.ds.posts.length;
  $('result-count').textContent = `${formatExact(count)}件 / 全${formatExact(total)}件`;
  $('posts-count').textContent = `${formatExact(count)}件・${SORTS.find((s) => s.key === app.state.sort).label}`;
  const paceNote = $('pace-note');
  paceNote.hidden = app.state.sort !== 'pace';
  paceNote.textContent = `伸びペース＝表示回数 ÷ 投稿からの経過時間（基準時刻まで・1時間未満は1時間）。${PACE_NOTE}`;
  $('post-list').replaceChildren();
  app.shown = 0;
  $('posts-empty').hidden = count > 0;
  appendPosts();
}

function appendPosts() {
  const list = $('post-list');
  const next = app.sorted.slice(app.shown, app.shown + PAGE_SIZE);
  const frag = document.createDocumentFragment();
  for (const p of next) frag.append(postCard(p));
  list.append(frag);
  app.shown += next.length;
  const rest = app.sorted.length - app.shown;
  const more = $('more');
  more.hidden = rest <= 0;
  more.textContent = `さらに表示（残り ${formatExact(rest)}件）`;
}

function appendHighlighted(parent, text, groups) {
  for (const seg of highlightSegments(text, groups)) {
    if (seg.hit) {
      const m = el('mark', seg.kind === 'q' ? 'm-q' : 'm-term', seg.text);
      parent.append(m);
    } else {
      parent.append(document.createTextNode(seg.text));
    }
  }
}

function postHead(p) {
  const head = el('div', 'post-head');
  const user = el('button', 'post-user', `@${p.user || '（不明）'}`);
  user.type = 'button';
  user.title = `@${p.user} で絞り込む`;
  user.addEventListener('click', () => update({ user: p.user }, { scroll: true }));
  head.append(user);
  // 「監視」小バッジは表示しない（データの is_watched と詳細パネルの「監視アカウントのみ」は残す）
  const time = el('time', 'post-time', formatDateTime(p.created_jst, p.ts, app.refYear));
  time.title = formatDateTimeFull(p.created_jst, p.ts);
  if (p.ts != null) time.dateTime = new Date(p.ts * 1000).toISOString();
  head.append(time);
  return head;
}

/** カード上部: ユーザー・日時・カテゴリを 1 行（収まらなければ折り返し） */
function postTop(p) {
  const head = postHead(p);
  const cats = postCats(p);
  head.append(cats);
  return head;
}

/** 伸びペース（常時小さく表示。伸びペース順のときは強調） */
function paceLine(p) {
  const v = viewsPerHour(p, app.ds.refTs);
  const line = el('p', `pace${app.state.sort === 'pace' ? ' is-active' : ''}${v ? '' : ' unk'}`, formatPace(p, app.ds.refTs));
  line.title = PACE_NOTE;
  return line;
}

function postCats(p) {
  const cats = el('div', 'post-cats');
  for (const c of p.categories) {
    if (c === WATCH_CATEGORY) continue; // 「監視アカウント」はカテゴリバッジに出さない
    const b = el('span', 'badge', categoryLabel(c));
    setCatColor(b, c);
    cats.append(b);
  }
  return cats;
}

const CLAMP_CHARS = 140;
const CLAMP_LINES = 4;
let clampSeq = 0;

/** 長文は折りたたみ（約4行または約140字超）。ハイライト・リンクは DOM のまま CSS で隠すだけ */
function postBodyWithToggle(p) {
  const body = postBody(p);
  const long = p.text.length > CLAMP_CHARS || p.text.split('\n').length > CLAMP_LINES;
  if (!long) return [body];
  body.id = `pt-${++clampSeq}`;
  body.classList.add('is-clamped');
  const b = el('button', 'more-text', '続きを読む');
  b.type = 'button';
  b.setAttribute('aria-expanded', 'false');
  b.setAttribute('aria-controls', body.id);
  b.addEventListener('click', () => {
    const open = body.classList.toggle('is-clamped') === false;
    b.textContent = open ? '閉じる' : '続きを読む';
    b.setAttribute('aria-expanded', String(open));
  });
  return [body, b];
}

function postBody(p) {
  const body = el('p', 'post-text');
  const groups = [{ kind: 'q', terms: app.terms }, { kind: 'term', terms: p.matched_terms }];
  for (const seg of linkifySegments(p.text)) {
    if (seg.type === 'url' && isSafeHttpUrl(seg.value)) {
      const a = el('a');
      a.href = seg.value;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      appendHighlighted(a, seg.value, groups);
      body.append(a);
    } else {
      appendHighlighted(body, seg.value, groups);
    }
  }
  return body;
}

// 指標アイコン（装飾。意味は sr-only のラベルと title で伝える）
const METRIC_ICONS = {
  impression_count: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  like_count: 'M8 13.5S2 10 2 6a3 3 0 0 1 6-1 3 3 0 0 1 6 1c0 4-6 7.5-6 7.5Z',
  retweet_count: 'M4 12V5h7M9 3l2 2-2 2 M12 4v7H5M7 13l-2-2 2-2',
  reply_count: 'M2.5 3.5h11v7h-6l-3.5 3v-3h-1.5Z',
  quote_count: 'M3 4.5h4v4H5c0 1.5.7 2.5 2 3 M9 4.5h4v4h-2c0 1.5.7 2.5 2 3',
  bookmark_count: 'M4 2.5h8v11l-4-3-4 3Z',
};

function metricIcon(k) {
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = document.createElementNS(NS, 'svg');
  svgEl.setAttribute('viewBox', '0 0 16 16');
  svgEl.setAttribute('aria-hidden', 'true');
  svgEl.setAttribute('focusable', 'false');
  svgEl.setAttribute('class', 'mi');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', METRIC_ICONS[k]);
  svgEl.append(path);
  return svgEl;
}

/** 数値 6 種を 1 行に（アイコン＋値。ラベルはスクリーンリーダー用と title） */
function metricsList(p) {
  const ul = el('ul', 'metrics');
  ul.setAttribute('aria-label', '指標');
  for (const k of METRIC_KEYS) {
    const v = p.metrics[k];
    const item = el('li');
    item.title = `${METRIC_LABELS[k]} ${v == null ? '不明' : formatExact(v)}`;
    item.append(metricIcon(k), el('span', 'sr-only', METRIC_LABELS[k]));
    const val = el('span', v == null ? 'v unk' : 'v', formatCompact(v));
    item.append(val);
    ul.append(item);
  }
  return ul;
}

function openXLink(p) {
  if (!isSafeHttpUrl(p.url)) return null;
  const a = el('a', 'open-x', 'Xで開く ↗');
  a.href = p.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.setAttribute('aria-label', `@${p.user} の投稿をXで開く（新しいタブ）`);
  return a;
}

function embedHost() {
  const host = el('div', 'embed-host');
  const sk = el('div', 'embed-skeleton');
  sk.setAttribute('aria-label', '埋め込みを読み込み中');
  sk.setAttribute('role', 'status');
  sk.append(el('span', 'sk-line w40'), el('span', 'sk-line w90'), el('span', 'sk-line w75'), el('span', 'sk-block'));
  host.append(sk);
  return host;
}

function embedFailNote(err) {
  const n = el('p', 'embed-fail', '埋め込みを表示できませんでした');
  if (err && err.message) n.title = err.message;
  return n;
}

function postCard(p) {
  return app.state.view === 'embed' ? postEmbedCard(p) : postPlainCard(p);
}

/** カード表示 */
function postPlainCard(p) {
  const li = el('li', 'card post');
  const parts = [postTop(p), ...postBodyWithToggle(p)];
  const media = renderMedia(p.media, p.url);
  if (media) parts.push(media);
  // 伸びペース＋数値（左）とボタン（右）を 1 つの行に。幅が足りなければボタンだけ折り返す
  const stats = el('div', 'post-stats');
  stats.append(paceLine(p), metricsList(p));
  const foot = el('div', 'post-foot');
  foot.append(stats);
  const actions = el('div', 'post-actions');
  const id = embedTweetId(p);
  let slot = null;
  if (id) {
    const b = el('button', 'btn btn-ghost btn-sm embed-toggle', '埋め込みで見る');
    b.type = 'button';
    b.setAttribute('aria-expanded', 'false');
    b.addEventListener('click', () => {
      if (slot) {
        slot.remove();
        slot = null;
        b.textContent = '埋め込みで見る';
        b.setAttribute('aria-expanded', 'false');
        return;
      }
      showEmbedNotice();
      resetWidgetsFailure();
      slot = embedHost();
      li.append(slot);
      b.textContent = '埋め込みを閉じる';
      b.setAttribute('aria-expanded', 'true');
      const host = slot;
      app.embedder.now(host, id, (err) => { host.replaceChildren(embedFailNote(err)); });
    });
    actions.append(b);
  }
  const x = openXLink(p);
  if (x) actions.append(x);
  foot.append(actions);
  parts.push(foot);
  li.append(...parts);
  return li;
}

/** X埋め込み表示: 上部にダッシュボード用の帯（カテゴリ・数値・根拠語）＋公式埋め込み */
function postEmbedCard(p) {
  const li = el('li', 'card post post-embed');
  const band = el('div', 'embed-band');
  const head = postHead(p);
  const x = openXLink(p);
  if (x) head.append(x);
  head.append(postCats(p));
  band.append(head, paceLine(p), metricsList(p));
  if (p.matched_terms.length) {
    const t = el('p', 'terms');
    t.append(el('span', 'muted', '根拠語: '));
    p.matched_terms.forEach((term, i) => {
      if (i) t.append(document.createTextNode(' '));
      t.append(el('mark', 'm-term', term));
    });
    band.append(t);
  }
  li.append(band);
  const id = embedTweetId(p);
  const fallback = (err) => {
    const box = el('div', 'embed-fallback');
    box.append(embedFailNote(err), ...postBodyWithToggle(p));
    const media = renderMedia(p.media, p.url);
    if (media) box.append(media);
    host.replaceWith(box);
  };
  const host = embedHost();
  li.append(host);
  if (id) app.embedder.observe(host, id, fallback);
  else queueMicrotask(() => fallback(new Error('投稿IDがありません')));
  return li;
}

// ---------------------------------------------------------------- レポート（reports.json）

/** レポートの最新キー（デイリーの date と週の key） */
function latestReportKeys() {
  if (!app.reports) return null;
  return { d: app.reports.daily[0] ? app.reports.daily[0].date : '', w: app.reports.weekly[0] ? app.reports.weekly[0].key : '' };
}

function readSeen() {
  try { const v = JSON.parse(storageGet(SEEN_KEY) || 'null'); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

/** 前回見たものより新しいレポートがあれば「NEW」バッジ */
function updateNewBadge() {
  const latest = latestReportKeys();
  const seen = readSeen() || { d: '', w: '' };
  const isNew = !!latest && ((latest.d && latest.d > String(seen.d || '')) || (latest.w && latest.w > String(seen.w || '')));
  $('new-badge').hidden = !isNew;
  $('panel-toggle').setAttribute('aria-label', `詳細・レポート・グラフ${isNew ? '（新しいレポートあり）' : ''}`);
}

function markReportsSeen() {
  const latest = latestReportKeys();
  if (!latest) return;
  storageSet(SEEN_KEY, JSON.stringify(latest));
  $('new-badge').hidden = true;
  $('panel-toggle').setAttribute('aria-label', '詳細・レポート・グラフ');
}

/** 伸びている投稿がある最新の日付 */
function latestRisingDate() {
  if (!app.reports) return '';
  const d = app.reports.daily.find((x) => x.rising.length || x.risingWatch.length);
  return d ? d.date : '';
}

function updateRisingBadge() {
  const latest = latestRisingDate();
  const isNew = !!latest && latest > String(storageGet(RISING_SEEN_KEY) || '');
  $('rising-new').hidden = !isNew;
  const n = app.reports && app.reports.daily[0] ? filterNightRising(app.reports.daily[0].rising, app.postsById).items.length : 0;
  $('rising-count').textContent = String(n);
  $('rising-toggle').setAttribute('aria-label', `伸びている投稿 ${n}件${isNew ? '（新しいデータあり）' : ''}`);
}

function markRisingSeen() {
  const latest = latestRisingDate();
  if (latest) storageSet(RISING_SEEN_KEY, latest);
  $('rising-new').hidden = true;
}

/** 伸びている投稿の一覧（帯＋投稿カード）。データ側の並び順のまま、最初の数件＋「残りN件」 */
function risingListEl(items, { withReason = false, initial = RISING_INITIAL, label = '' } = {}) {
  const wrap = el('div');
  const list = el('ol', 'rising-list');
  list.setAttribute('aria-label', label);
  items.forEach((r, i) => {
    const li = el('li', 'rising-item');
    const band = el('div', 'rising-band');
    band.append(el('span', 'rank', `#${i + 1}`), el('span', 'cond', r.label ?? '条件：不明'), el('span', 'rpace', formatRisingPace(r.views, r.hours, r.perHour)));
    if (withReason && r.reason) band.append(el('span', 'reason', r.reason));
    band.title = PACE_NOTE;
    const post = r.id ? app.postsById.get(r.id) : null;
    li.append(band, post ? postPlainCard(post) : missingPostCard(r.id));
    list.append(li);
  });
  wrap.append(list);
  const extra = [...list.children].slice(initial);
  if (extra.length) {
    extra.forEach((li) => { li.hidden = true; });
    const more = el('button', 'btn btn-ghost rising-more', `残り ${extra.length}件を表示`);
    more.type = 'button';
    more.addEventListener('click', () => { extra.forEach((li) => { li.hidden = false; }); more.remove(); });
    wrap.append(more);
  }
  return wrap;
}

/** 説明文：導入文＋（データ側の条件名の一覧）＋時点。条件の数値は画面に持たず condition_label から作る */
function risingNoteEls(items, lead, condLead, asOf) {
  const firstNum = (t) => { const m = /\d+(?:\.\d+)?/.exec(t); return m ? Number(m[0]) : Infinity; };
  const labels = [...new Set((items || []).map((r) => r.label).filter(Boolean))].sort((a, b) => firstNum(a) - firstNum(b));
  const out = [el('p', null, lead + (labels.length && condLead ? condLead : ''))];
  if (labels.length) {
    const ul = el('ul', 'rising-conds');
    labels.forEach((l) => ul.append(el('li', null, l)));
    out.push(ul);
  }
  if (asOf) out.push(el('p', 'muted', asOf));
  return out;
}

/** 伸びている投稿パネル（夜職関連のみ。夜職／一般の切替やカテゴリ絞り込みとは連動しない） */
function renderRising() {
  if (!app.reports) return;
  const body = $('rising-body');
  body.replaceChildren();
  const d = pickReport(app.reports.daily, app.state.rsdate, (x) => x.date);
  const watchSec = $('rising-watch');
  if (!d) {
    body.append(reportEmpty(REPORT_TEXT.dailyEmpty));
    $('rising-note').replaceChildren();
    watchSec.hidden = true;
    return;
  }
  $('rsdate').value = d.date;
  const main = filterNightRising(d.rising, app.postsById);
  const watch = filterNightRising(d.risingWatch, app.postsById);
  const excluded = main.excluded + watch.excluded;
  const asOf = app.reports.generated_at ? REPORT_TEXT.risingAsOf(formatDateTime(app.reports.generated_at, parseTimestamp(app.reports.generated_at), null)) : '';
  $('rising-note').replaceChildren(...risingNoteEls(d.rising, REPORT_TEXT.risingLead, REPORT_TEXT.risingCondLead, asOf));
  $('rising-watch-note').replaceChildren(...risingNoteEls(d.risingWatch, REPORT_TEXT.risingWatchLead, '', ''));
  $('rising-note').title = excluded ? `一般のバズ ${formatExact(excluded)}件は表示していません` : '';
  body.append(main.items.length
    ? risingListEl(main.items, { label: `伸びている投稿（${main.items.length}件・データ側の並び順）` })
    : reportEmpty(main.excluded ? REPORT_TEXT.risingAllGeneral(formatExact(main.excluded)) : REPORT_TEXT.risingEmpty));
  // 補足「伸びそうな投稿」（任意フィールド rising_watch。無い・空なら見出しごと非表示）
  watchSec.hidden = watch.items.length === 0;
  $('rising-watch-title').textContent = REPORT_TEXT.risingWatchTitle;
  $('rising-watch-body').replaceChildren(...(watch.items.length
    ? [risingListEl(watch.items, { withReason: true, label: `${REPORT_TEXT.risingWatchTitle}（${watch.items.length}件）` })]
    : []));
}

function setupRising() {
  if (!app.reports) return;
  $('rising-toggle').hidden = false;
  const daily = app.reports.daily;
  $('rsdate').replaceChildren(...daily.map((d) => { const o = el('option', null, d.date.replace(/^(\d{4})-0?(\d+)-0?(\d+)$/, '$1/$2/$3')); o.value = d.date; return o; }));
  $('rsdate-wrap').hidden = daily.length === 0;
  $('rsdate').addEventListener('change', (e) => update({ rsdate: e.target.value }));
  $('rising-toggle').addEventListener('click', () => {
    const next = !app.state.rising;
    storageSet(RISING_KEY, next ? '1' : '0');
    update({ rising: next });
  });
  updateRisingBadge();
}

function setupReports() {
  updateNewBadge();
  setupRising();
  const box = $('report');
  if (!app.reports) { box.hidden = true; return; }
  box.hidden = false;
  const { daily, weekly, generated_at: gen } = app.reports;
  if (gen) {
    const t = parseTimestamp(gen);
    $('report-meta').textContent = `更新 ${formatDateTime(gen, t, null)}`;
    $('report-meta').title = formatDateTimeFull(gen, t);
  }
  const fill = (sel, items) => {
    sel.replaceChildren(...items.map(([v, label]) => { const o = el('option', null, label); o.value = v; return o; }));
  };
  fill($('rdate'), daily.map((d) => [d.date, d.date.replace(/^(\d{4})-0?(\d+)-0?(\d+)$/, '$1/$2/$3')]));
  fill($('rweek'), weekly.map((w) => [w.key, `${shortDate(w.from)}〜${shortDate(w.to)}`]));
  $('rdate-wrap').hidden = daily.length === 0;
  $('rweek-wrap').hidden = weekly.length === 0;
  $('rdate').addEventListener('change', (e) => update({ rdate: e.target.value }));
  $('rweek').addEventListener('change', (e) => update({ rweek: e.target.value }));
  const sections = { report: $('report'), daily: $('report-daily'), weekly: $('report-weekly') };
  for (const [k, node] of Object.entries(sections)) {
    node.addEventListener('toggle', () => {
      const closed = app.state.rclosed.includes(k);
      if (node.open === !closed) return; // 状態どおり（プログラムからの変更）
      const set = new Set(app.state.rclosed);
      if (node.open) set.delete(k); else set.add(k);
      update({ rclosed: REPORT_SECTIONS.filter((x) => set.has(x)) }, { push: false });
    });
  }
}

function reportEmpty(text) {
  return el('p', 'report-empty', text);
}

function reportPart(title, ...children) {
  const sec = el('section', 'report-part');
  sec.append(el('h4', null, title), ...children);
  return sec;
}

function statusUrl(id) {
  return id && /^\d{1,25}$/.test(id) ? `https://x.com/i/web/status/${id}` : null;
}

function externalLink(href, text) {
  const a = el('a', 'open-x', text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function missingPostCard(id) {
  const box = el('div', 'card post post-missing');
  box.append(el('span', null, `${REPORT_TEXT.missingPost}（ID: ${id ?? '不明'}）`));
  const href = statusUrl(id);
  if (href) box.append(externalLink(href, 'Xで開く ↗'));
  return box;
}

function renderReports() {
  if (!app.reports) return;
  const st = app.state;
  const { daily, weekly } = app.reports;
  const open = (k) => !st.rclosed.includes(k);
  if ($('report').open !== open('report')) $('report').open = open('report');
  if ($('report-daily').open !== open('daily')) $('report-daily').open = open('daily');
  if ($('report-weekly').open !== open('weekly')) $('report-weekly').open = open('weekly');

  // デイリー
  const dBody = $('report-daily-body');
  dBody.replaceChildren();
  const d = pickReport(daily, st.rdate, (x) => x.date);
  if (!d) {
    dBody.append(reportEmpty(REPORT_TEXT.dailyEmpty));
  } else {
    $('rdate').value = d.date;
    const byId = app.postsById;
    // 「伸びている投稿」は専用パネル（renderRising）へ移動。ここは答え合わせ・的中率のみ
    // 答え合わせ
    let review;
    if (!d.review.length) {
      review = reportEmpty(REPORT_TEXT.reviewEmpty);
    } else {
      review = el('div', 'table-scroll');
      const table = el('table', 'data-table report-table');
      const hr = el('tr');
      hr.append(el('th', null, '投稿'), el('th', null, '前→後'), el('th', null, REPORT_TEXT.crossedColumn));
      const thead = el('thead');
      thead.append(hr);
      const tbody = el('tbody');
      for (const r of d.review) {
        const tr = el('tr');
        const cell = el('td', 'post-cell');
        const post = r.id ? byId.get(r.id) : null;
        if (post) {
          const u = el('button', 'rt-user', `@${post.user}`);
          u.type = 'button';
          u.addEventListener('click', () => update({ user: post.user }, { scroll: true }));
          cell.append(u, el('span', 'rt-text', post.text.replace(/\s+/g, ' ').trim()));
        } else {
          cell.append(el('span', 'muted', `ID: ${r.id ?? '不明'} `));
          const href = statusUrl(r.id);
          if (href) cell.append(externalLink(href, 'Xで開く ↗'));
        }
        const ba = el('td', null, formatBeforeAfter(r.before, r.after));
        ba.title = `${formatExact(r.before)} → ${formatExact(r.after)}`;
        const cr = el('td');
        const badge = el('span', r.crossed === true ? 'cross yes' : 'cross', r.crossed === true ? REPORT_TEXT.crossedYes : r.crossed === false ? REPORT_TEXT.crossedNo : '不明');
        cr.append(badge);
        tr.append(cell, ba, cr);
        tbody.append(tr);
      }
      table.append(thead, tbody);
      review.append(table);
    }
    dBody.append(reportPart('答え合わせ', review));
    // 的中率
    const rate = el('div', 'chart');
    renderRateBars(rate, d.hitRate, REPORT_TEXT.hitRateEmpty);
    dBody.append(reportPart('条件ごとの的中率', rate));
  }

  // 週間
  const wBody = $('report-weekly-body');
  wBody.replaceChildren();
  const w = pickReport(weekly, st.rweek, (x) => x.key);
  if (!w) {
    wBody.append(reportEmpty(REPORT_TEXT.weeklyEmpty));
  } else {
    $('rweek').value = w.key;
    const r1 = el('div', 'chart');
    renderRateBars(r1, w.byCondition, REPORT_TEXT.weeklyHitEmpty);
    const r2 = el('div', 'chart');
    renderRateBars(r2, w.byPace, REPORT_TEXT.weeklyHitEmpty);
    const prop = w.proposal && w.proposal.trim() ? el('p', 'proposal', w.proposal) : reportEmpty(REPORT_TEXT.proposalEmpty);
    let cands;
    if (!w.candidates.length) {
      cands = reportEmpty(REPORT_TEXT.candidatesEmpty);
    } else {
      cands = el('ul', 'cand-list');
      for (const c of w.candidates) {
        const li = el('li');
        const b = el('button');
        b.type = 'button';
        b.append(el('span', 'cand-user', `@${c.user}`), el('span', 'cand-reason', c.reason ?? '理由：不明'));
        b.setAttribute('aria-label', `@${c.user} で絞り込む。${c.reason ?? ''}`);
        b.addEventListener('click', () => update({ user: c.user }, { scroll: true }));
        li.append(b);
        cands.append(li);
      }
    }
    wBody.append(
      reportPart('条件ごとの的中率', r1),
      reportPart('ペース別の的中率', r2),
      reportPart('基準の見直し案', prop),
      reportPart('見張りアカウントの追加候補', cands),
    );
  }
}

// ---------------------------------------------------------------- ヘッダー

function renderHeader(loaded) {
  const { dataset: ds, summary } = loaded;
  const gen = ds.generated_at || (summary && summary.generated_at) || null;
  const genTs = parseTimestamp(gen);
  const genYear = genTs != null ? jstParts(genTs).y : null;
  $('meta-generated').textContent = gen ? formatDateTime(gen, genTs, genYear) : '不明';
  $('meta-generated').title = gen ? formatDateTimeFull(gen, genTs) : '';
  let oldest = null;
  let newest = null;
  if (summary && summary.period && typeof summary.period === 'object') {
    oldest = summary.period.oldest_jst;
    newest = summary.period.newest_jst;
  }
  const oTs = parseTimestamp(oldest) ?? ds.minTs;
  const nTs = parseTimestamp(newest) ?? ds.latestPostTs;
  if (oTs != null && nTs != null) {
    $('meta-period').textContent = `${formatDateTime(oldest, oTs, app.refYear)} 〜 ${formatDateTime(newest, nTs, app.refYear)}`;
    $('meta-period').title = `${formatDateTimeFull(oldest, oTs)} 〜 ${formatDateTimeFull(newest, nTs)}`;
  } else {
    $('meta-period').textContent = '—';
  }
  if (ds.refTs != null) {
    $('meta-ref').textContent = `${formatDateTime(null, ds.refTs, null)} 時点`;
    $('meta-ref').title = ds.refSource === 'generated_at'
      ? `期間フィルタ（24時間/7日/30日）と伸びペースは、データの更新時刻（generated_at）${formatDateTimeFull(null, ds.refTs)} を基準にしています`
      : `generated_at が無いため、最新投稿の時刻 ${formatDateTimeFull(null, ds.refTs)} を基準にしています`;
  } else {
    $('meta-ref').textContent = '—';
  }
  $('meta-next').textContent = UPDATE_SCHEDULE.dailyLabel;
  $('meta-next').title = `データは${UPDATE_SCHEDULE.dailyLabel}に1回更新されます（週間まとめは${UPDATE_SCHEDULE.weeklyLabel}）`;
  // 現在時刻を使うのはこの「遅れ」判定だけ（サンプル表示中は判定しない）
  $('meta-delay').hidden = loaded.isSample || genTs == null || !isUpdateDelayed(genTs, Math.floor(Date.now() / 1000), UPDATE_SCHEDULE);
}

// ---------------------------------------------------------------- 起動

function showError(err) {
  $('loading').hidden = true;
  $('app').hidden = true;
  $('error').hidden = false;
  $('error-detail').textContent = err && err.message ? err.message : String(err);
  $('main').setAttribute('aria-busy', 'false');
}

async function main() {
  $('reload').addEventListener('click', () => location.reload());
  app.tooltip = createTooltip($('tooltip'));
  app.embedder = createEmbedder({ getTheme: resolvedTheme });
  app.noticeDismissed = storageGet(NOTICE_KEY) === '1';
  let loaded;
  try {
    loaded = await load();
  } catch (err) {
    showError(err);
    return;
  }
  try {
    app.ds = loaded.dataset;
    // posts.json に generated_at が無ければ summary.json の generated_at を基準に使う
    if (app.ds.refSource !== 'generated_at' && loaded.summary && typeof loaded.summary.generated_at === 'string') {
      const r = chooseRefTs(loaded.summary.generated_at, app.ds.latestPostTs);
      if (r.refSource === 'generated_at') Object.assign(app.ds, r);
    }
    app.summary = loaded.summary;
    app.summaryNote = loaded.summaryNote;
    app.refYear = loaded.dataset.refTs != null ? jstParts(loaded.dataset.refTs).y : null;
    for (const p of app.ds.posts) if (!app.postsById.has(p.id)) app.postsById.set(p.id, p);
    app.allAgg = mergeSummary(aggregate(app.ds.posts, app.ds.categories), app.summary, app.postsById);

    if (loaded.isSample) {
      $('sample-banner').hidden = false;
      $('sample-reason').textContent = `理由: ${loaded.reason}`;
      document.title = '【サンプル】Xレポート ダッシュボード';
    }
    app.reports = loaded.reports;
    renderHeader(loaded);
    buildControls();
    setupReports();
    app.state = sanitizeState(parseState(location.hash, storageGet(VIEW_KEY), storageGet(PANEL_KEY) === '1', storageGet(RISING_KEY) === '1'));
    writeUrl(false); // 保存済みの表示切替を URL にも反映
    $('loading').hidden = true;
    $('app').hidden = false;
    syncControls();
    render();
    $('main').setAttribute('aria-busy', 'false');
    // E2E・性能計測用（外部送信はしない）
    window.__dashboard = { ready: true, perf: app.perf, source: loaded.isSample ? 'sample' : 'data', get state() { return { ...app.state }; } };
  } catch (err) {
    console.error(err);
    showError(err);
  }
}

main();
