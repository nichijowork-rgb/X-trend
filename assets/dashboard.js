// Xレポート ダッシュボード — エントリ（ES module）
// データ: data/posts.json・data/summary.json（別botが更新）。無ければ sample/ にフォールバック。
// 本文などの外部由来文字列は textContent / DOM 生成でのみ挿入する（innerHTML 不使用）。

import {
  ACCOUNT_SORTS, DEFAULT_STATE, METRIC_KEYS, METRIC_LABELS, PERIODS, SORTS,
  aggregate, chartDayRange, countBefore, countByCategory, debounce, fillDays, filterPosts,
  formatCompact, formatDateTime, formatDateTimeFull, formatExact, highlightSegments, isFilterActive,
  isSafeHttpUrl, isValidSummary, jstParts, linkifySegments, mergeSummary, normalizeDataset,
  parseKeywords, parseState, parseTimestamp, serializeState, sortPosts, topAccounts, CHART_MAX_DAYS,
  shortDate, VIEWS, embedTweetId,
} from './js/core.js';
import {
  createTooltip, renderDayTable, renderHBars, renderLegend, renderStackedDays, setCatColor,
} from './js/charts.js';
import { createEmbedder, resetWidgetsFailure } from './js/embed.js';
import { renderMedia } from './js/media.js';

const PAGE_SIZE = 50;
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
  const [p, s] = await Promise.allSettled([getJson(`${dir}/posts.json`), getJson(`${dir}/summary.json`)]);
  if (p.status === 'rejected') throw p.reason;
  const dataset = normalizeDataset(p.value); // 形式不正は例外
  const summary = s.status === 'fulfilled' && isValidSummary(s.value) ? s.value : null;
  const summaryNote = s.status === 'rejected' ? s.reason.message : (summary ? '' : `${dir}/summary.json: 形式が不正です`);
  return { dataset, summary, summaryNote, dir };
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

const THEME_KEY = 'xreport-theme';
const THEME_ORDER = ['auto', 'dark', 'light'];
const THEME_LABEL = { auto: '自動', dark: 'ダーク', light: 'ライト' };

function currentTheme() {
  const t = document.documentElement.getAttribute('data-theme');
  return t === 'light' || t === 'dark' ? t : 'auto';
}

/** 実際に表示中のテーマ（埋め込みの theme 指定用） */
function resolvedTheme() {
  const t = currentTheme();
  if (t !== 'auto') return t;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

// ---------------------------------------------------------------- 保存値（localStorage は失敗しても動く）

const VIEW_KEY = 'xreport-view';
const NOTICE_KEY = 'xreport-embed-notice-dismissed';

function storageGet(k) {
  try { return window.localStorage.getItem(k); } catch { return null; }
}

function storageSet(k, v) {
  try { window.localStorage.setItem(k, v); } catch { /* 保存できない環境では無視 */ }
}

function setupTheme() {
  const btn = $('theme-toggle');
  const label = $('theme-label');
  const sync = () => {
    const t = currentTheme();
    label.textContent = THEME_LABEL[t];
    btn.setAttribute('aria-label', `表示テーマ: ${THEME_LABEL[t]}（クリックで切り替え）`);
  };
  btn.addEventListener('click', () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(currentTheme()) + 1) % THEME_ORDER.length];
    if (next === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', next);
    try {
      if (next === 'auto') window.localStorage.removeItem(THEME_KEY);
      else window.localStorage.setItem(THEME_KEY, next);
    } catch {
      /* 保存できなくても表示は切り替わる */
    }
    sync();
  });
  sync();
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
  noticeDismissed: false,
  perf: { lastRenderMs: 0, renders: 0 },
};

function sanitizeState(st) {
  const known = new Set(app.ds.categories);
  return { ...st, cats: st.cats.filter((c) => known.has(c)) };
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
  const all = el('button', 'chip chip-all');
  all.type = 'button';
  all.dataset.cat = '';
  all.append(el('span', 'chip-name', 'すべて'), el('span', 'count', ''));
  all.addEventListener('click', () => update({ cats: [] }));
  chips.append(all);
  for (const c of ds.categories) {
    const b = el('button', 'chip');
    b.type = 'button';
    b.dataset.cat = c;
    setCatColor(b, c);
    b.append(el('i', 'dot'), el('span', 'chip-name', c), el('span', 'count', ''));
    b.title = c;
    b.addEventListener('click', () => {
      const set = new Set(app.state.cats);
      if (set.has(c)) set.delete(c); else set.add(c);
      update({ cats: ds.categories.filter((x) => set.has(x)) });
    });
    chips.append(b);
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
  $('reset').addEventListener('click', () => update({ cats: [], period: 'all', user: '', q: '', watched: false }));

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
  for (const b of $('cat-chips').children) {
    const c = b.dataset.cat;
    b.setAttribute('aria-pressed', String(c ? st.cats.includes(c) : st.cats.length === 0));
  }
  for (const b of $('period-group').children) b.setAttribute('aria-pressed', String(b.dataset.period === st.period));
  for (const b of $('acct-group').children) b.setAttribute('aria-pressed', String(b.dataset.acct === st.acct));
  for (const b of $('view-group').children) b.setAttribute('aria-pressed', String(b.dataset.view === st.view));
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
  let filtered = base;
  if (state.cats.length) {
    const set = new Set(state.cats);
    filtered = base.filter((p) => p.categories.some((c) => set.has(c)));
  }
  const active = isFilterActive(state);
  const agg = active ? aggregate(filtered, ds.categories) : app.allAgg;

  renderChipCounts(countByCategory(base), base.length);
  renderSummary(agg, active, filtered.length);
  renderCharts(agg, filtered);
  renderAccounts(agg);
  app.terms = parseKeywords(state.q);
  app.sorted = sortPosts(filtered, state.sort);
  renderPostsReset(filtered.length);
  renderActiveFilters();

  app.perf.lastRenderMs = performance.now() - t0;
  app.perf.renders += 1;
}

function renderChipCounts(counts, baseTotal) {
  for (const b of $('cat-chips').children) {
    const c = b.dataset.cat;
    const n = c ? counts.get(c) || 0 : baseTotal;
    const cnt = b.querySelector('.count');
    cnt.textContent = formatCompact(n);
    b.classList.toggle('is-zero', n === 0);
    b.setAttribute('aria-label', `${c || 'すべてのカテゴリ'}（${formatExact(n)}件）`);
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
    const text = el('p', 'top-post-text', p.text.replace(/\s+/g, ' ').trim() || '（本文なし）');
    wrap.append(head, text);
    if (isSafeHttpUrl(p.url)) {
      const a = el('a', 'top-post-link', 'Xで開く ↗');
      a.href = p.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      wrap.append(a);
    }
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
  let text = `${shortDate(range.startKey)}〜${shortDate(range.endKey)}（JST・0件の日も表示）`;
  if (state.period === 'all') {
    const excluded = countBefore(agg.byDay, range.startKey);
    text = `直近${CHART_MAX_DAYS}日 ${text}`;
    if (excluded > 0) text += `。それ以前の古い投稿 ${formatExact(excluded)}件は外れ値としてグラフから除外`;
  }
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
    if (a.is_watched) name.append(el('span', 'badge-watch', '監視'));
    const stats = el('span', 'acc-stats');
    const imp = formatCompact(a.impressions.sum) + (a.impressions.unknown ? '＋不明' : '');
    if (state.acct === 'imp') {
      stats.append(el('strong', null, imp), document.createTextNode(` ・ ${formatExact(a.posts)}件`));
    } else {
      stats.append(el('strong', null, `${formatExact(a.posts)}件`), document.createTextNode(` ・ ${imp}`));
    }
    stats.title = `投稿 ${formatExact(a.posts)}件 / インプレッション ${formatExact(a.impressions.sum)}${a.impressions.unknown ? `（${a.impressions.unknown}件不明）` : ''}`;
    b.append(el('span', 'acc-rank', String(i + 1)), name, stats);
    b.setAttribute('aria-label', `@${a.user}${a.is_watched ? '（監視）' : ''} 投稿${a.posts}件、インプレッション${formatExact(a.impressions.sum)}。${selected ? '絞り込みを解除' : 'このアカウントで絞り込む'}`);
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
  for (const c of st.cats) add(`カテゴリ: ${c}`, { cats: st.cats.filter((x) => x !== c) });
  if (st.period !== 'all') add(`期間: ${PERIODS.find((p) => p.key === st.period).label}`, { period: 'all' });
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
  if (p.is_watched) head.append(el('span', 'badge-watch', '監視'));
  const time = el('time', 'post-time', formatDateTime(p.created_jst, p.ts, app.refYear));
  time.title = formatDateTimeFull(p.created_jst, p.ts);
  if (p.ts != null) time.dateTime = new Date(p.ts * 1000).toISOString();
  head.append(time);
  return head;
}

function postCats(p) {
  const cats = el('div', 'post-cats');
  for (const c of p.categories) {
    const b = el('span', 'badge', c);
    setCatColor(b, c);
    cats.append(b);
  }
  return cats;
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

function metricsList(p) {
  const ul = el('ul', 'metrics');
  ul.setAttribute('aria-label', '指標');
  for (const k of METRIC_KEYS) {
    const v = p.metrics[k];
    const item = el('li');
    item.append(el('span', null, METRIC_LABELS[k]));
    const val = el('span', v == null ? 'v unk' : 'v', formatCompact(v));
    val.title = v == null ? '値なし（不明）' : formatExact(v);
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
  const parts = [postHead(p), postCats(p), postBody(p)];
  const media = renderMedia(p.media, p.url);
  if (media) parts.push(media);
  const foot = el('div', 'post-foot');
  foot.append(metricsList(p));
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
  band.append(head, postCats(p), metricsList(p));
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
    box.append(embedFailNote(err), postBody(p));
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
  const nTs = parseTimestamp(newest) ?? ds.refTs;
  if (oTs != null && nTs != null) {
    $('meta-period').textContent = `${formatDateTime(oldest, oTs, app.refYear)} 〜 ${formatDateTime(newest, nTs, app.refYear)}`;
    $('meta-period').title = `${formatDateTimeFull(oldest, oTs)} 〜 ${formatDateTimeFull(newest, nTs)}`;
  } else {
    $('meta-period').textContent = '—';
  }
  if (ds.refTs != null) {
    $('meta-ref').textContent = `${formatDateTime(null, ds.refTs, null)}（データ内の最新投稿）`;
    $('meta-ref').title = `期間フィルタ（24時間/7日/30日）は ${formatDateTimeFull(null, ds.refTs)} を基準にしています`;
  } else {
    $('meta-ref').textContent = '—';
  }
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
  setupTheme();
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
    renderHeader(loaded);
    buildControls();
    app.state = sanitizeState(parseState(location.hash, storageGet(VIEW_KEY)));
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
