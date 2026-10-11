// グラフ描画（自前 SVG / HTML）。外部ライブラリ・CDN に依存しない。
// 方針（dataviz スキル準拠）:
//  - カテゴリ色は実体（カテゴリ名）に固定。フィルタで色が変わらない
//  - 細いマーク（棒は 24px 以下・データ端 4px 角丸）、積み上げは 2px の面色ギャップ
//  - 罫線は 1px の実線で控えめ。凡例は 2 系列以上で常に表示、色だけに頼らない
//  - ホバー/フォーカスでツールチップ、値は「表で見る」でも読める
//  - ラベルやカテゴリ名は textContent で挿入（innerHTML 不使用）

import { formatCompact, formatExact, niceTicks, shortDate, categorySlot, hitRateText, hitRatio, categoryLabel } from './core.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function svg(tag, attrs = {}) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

export function setCatColor(node, name) {
  node.style.setProperty('--c', `var(--cat-${categorySlot(name)})`);
  return node;
}

// ---------------------------------------------------------------- ツールチップ

export function createTooltip(node) {
  let visible = false;
  function place(x, y) {
    const pad = 12;
    const r = node.getBoundingClientRect();
    let left = x + 14;
    let top = y + 14;
    if (left + r.width > window.innerWidth - pad) left = Math.max(pad, x - r.width - 14);
    if (top + r.height > window.innerHeight - pad) top = Math.max(pad, y - r.height - 14);
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  }
  return {
    /** rows: [{label, value, cat?}] */
    show(title, rows, x, y) {
      node.replaceChildren();
      if (title) node.append(el('div', 'tt-title', title));
      for (const r of rows) {
        const row = el('div', 'tt-row');
        const key = el('span', r.cat ? 'tt-key' : 'tt-key no-key', r.label);
        if (r.cat) setCatColor(key, r.cat);
        row.append(key, el('span', 'tt-val', r.value));
        node.append(row);
      }
      node.hidden = false;
      visible = true;
      place(x, y);
    },
    hide() {
      if (!visible) return;
      node.hidden = true;
      visible = false;
    },
  };
}

function anchorPoint(target) {
  const r = target.getBoundingClientRect();
  return [r.left + Math.min(r.width, 160), r.top + r.height / 2];
}

// ---------------------------------------------------------------- 横棒（カテゴリ別）

/**
 * items: [{name, value, unknown}]  value は既知値の合計。unknown は欠損件数。
 * opts: { unit: '件' | '', tooltip, emptyText, valueLabel }
 */
export function renderHBars(container, items, opts) {
  container.replaceChildren();
  container.classList.remove('is-empty');
  const max = Math.max(0, ...items.map((i) => i.value));
  if (!items.length || max <= 0) {
    container.classList.add('is-empty');
    container.textContent = opts.emptyText || 'データがありません';
    return;
  }
  const list = el('div', 'hbar-list');
  list.setAttribute('role', 'list');
  for (const it of items) {
    const row = el('div', 'hbar');
    row.setAttribute('role', 'listitem');
    row.tabIndex = 0;
    setCatColor(row, it.name);
    const label = el('div', 'hbar-label');
    const name = categoryLabel(it.name);
    label.append(el('i', 'dot'), el('span', null, name));
    label.title = name;
    const track = el('div', 'hbar-track');
    const fill = el('div', 'hbar-fill');
    const pct = (it.value / max) * 100;
    // 値ラベル分の余白を残す（数値がはみ出さないよう最大 78%）
    fill.style.width = `calc(${(pct * 0.78).toFixed(2)}%)`;
    if (it.value <= 0) fill.classList.add('is-zero');
    const val = el('span', 'hbar-value', formatCompact(it.value) + (opts.unit || ''));
    val.title = formatExact(it.value) + (opts.unit || '');
    if (it.unknown > 0) {
      const u = el('span', 'unk', '※');
      u.title = `一部不明（${it.unknown}件は値なし）`;
      val.append(u);
    }
    track.append(fill, val);
    row.append(label, track);
    const aria = `${name}: ${formatExact(it.value)}${opts.unit || ''}${it.unknown > 0 ? `（${it.unknown}件は不明）` : ''}`;
    row.setAttribute('aria-label', aria);
    const rows = [{ label: opts.valueLabel || '値', value: formatExact(it.value) + (opts.unit || ''), cat: it.name }];
    if (it.unknown > 0) rows.push({ label: '値が不明な投稿', value: `${formatExact(it.unknown)}件` });
    row.addEventListener('pointermove', (e) => opts.tooltip.show(name, rows, e.clientX, e.clientY));
    row.addEventListener('pointerleave', () => opts.tooltip.hide());
    row.addEventListener('focus', () => { const [x, y] = anchorPoint(fill); opts.tooltip.show(name, rows, x, y); });
    row.addEventListener('blur', () => opts.tooltip.hide());
    list.append(row);
  }
  container.append(list);
}

// ---------------------------------------------------------------- 凡例

export function renderLegend(container, categories) {
  container.replaceChildren();
  for (const c of categories) {
    const item = el('span', 'legend-item');
    setCatColor(item, c);
    item.append(el('i', 'sw'), el('span', null, categoryLabel(c)));
    container.append(item);
  }
}

// ---------------------------------------------------------------- 日別積み上げ

function roundedTopPath(x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/**
 * days: fillDays の結果。categories: 積み上げ順（凡例と同じ）。
 * 返り値: 破棄用の関数（イベント解除）
 */
export function renderStackedDays(container, days, categories, opts) {
  container.replaceChildren();
  container.classList.remove('is-empty');
  const totalAll = days.reduce((s, d) => s + d.posts, 0);
  if (!days.length || totalAll === 0) {
    container.classList.add('is-empty');
    container.textContent = opts.emptyText || 'この期間の投稿はありません';
    return;
  }
  const W = Math.max(260, Math.floor(container.clientWidth || 600));
  const H = 220;
  const m = { top: 10, right: 6, bottom: 24, left: 40 };
  const pw = W - m.left - m.right;
  const ph = H - m.top - m.bottom;
  const n = days.length;
  const band = pw / n;
  const barW = Math.max(1, Math.min(24, band * (band > 6 ? 0.68 : 0.8)));
  const gap = band > 4 ? 2 : 1; // 積み上げセグメント間の面色ギャップ
  const stackMax = Math.max(...days.map((d) => categories.reduce((s, c) => s + (d.categories[c] || 0), 0)));
  const ticks = niceTicks(stackMax, 4);
  const yMax = ticks[ticks.length - 1] || 1;
  const y = (v) => m.top + ph - (v / yMax) * ph;

  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'group', tabindex: 0 });
  root.setAttribute('aria-label', `日別の投稿数。${shortDate(days[0].date)}〜${shortDate(days[n - 1].date)}。左右キーで日付を移動`);

  const gGrid = svg('g');
  for (const t of ticks) {
    const yy = Math.round(y(t)) + 0.5;
    gGrid.append(svg('line', { class: t === 0 ? 'baseline' : 'grid', x1: m.left, x2: W - m.right, y1: yy, y2: yy }));
    const lab = svg('text', { class: 'tick', x: m.left - 6, y: yy + 4, 'text-anchor': 'end' });
    lab.textContent = formatCompact(t);
    gGrid.append(lab);
  }
  root.append(gGrid);

  // X 軸ラベル（重ならない間隔で、右端の日付を基準に間引く）
  const step = Math.max(1, Math.ceil(44 / band));
  const gX = svg('g');
  for (let i = n - 1; i >= 0; i -= step) {
    const cx = m.left + band * i + band / 2;
    let anchor = 'middle';
    if (cx - 18 < m.left - 10) anchor = 'start';
    if (cx + 18 > W) anchor = 'end';
    const t = svg('text', { class: 'tick', x: anchor === 'start' ? cx - barW / 2 : anchor === 'end' ? cx + barW / 2 : cx, y: H - 6, 'text-anchor': anchor });
    t.textContent = shortDate(days[i].date);
    gX.append(t);
  }
  root.append(gX);

  const cols = [];
  const gBars = svg('g');
  days.forEach((d, i) => {
    const g = svg('g', { class: 'col' });
    const x0 = m.left + band * i;
    g.append(svg('rect', { class: 'hit', x: x0, y: m.top, width: band, height: ph }));
    const bx = x0 + (band - barW) / 2;
    let acc = 0;
    const present = categories.filter((c) => (d.categories[c] || 0) > 0);
    present.forEach((c, k) => {
      const v = d.categories[c];
      const yTop = y(acc + v);
      const yBot = y(acc);
      acc += v;
      let h = yBot - yTop;
      const isTop = k === present.length - 1;
      if (h > gap + 0.5 && k > 0) h -= gap; // 下のセグメントとの間に面色のすき間
      const node = isTop
        ? svg('path', { class: 'seg', d: roundedTopPath(bx, yTop, barW, Math.max(h, 0.5), 4) })
        : svg('rect', { class: 'seg', x: bx, y: yTop, width: barW, height: Math.max(h, 0.5) });
      setCatColor(node, c);
      g.append(node);
    });
    gBars.append(g);
    cols.push(g);
  });
  root.append(gBars);
  container.append(root);

  let active = -1;
  function rowsFor(d) {
    const rows = [{ label: '投稿数', value: `${formatExact(d.posts)}件` }];
    for (const c of categories) {
      const v = d.categories[c] || 0;
      if (v > 0) rows.push({ label: categoryLabel(c), value: `${formatExact(v)}件`, cat: c });
    }
    return rows;
  }
  function title(d) {
    const [yy, mm, dd] = d.date.split('-').map(Number);
    return `${yy}/${mm}/${dd}`;
  }
  function setActive(i, x, yy) {
    if (active >= 0 && cols[active]) cols[active].classList.remove('is-active');
    active = i;
    if (i < 0) { opts.tooltip.hide(); return; }
    cols[i].classList.add('is-active');
    opts.tooltip.show(title(days[i]), rowsFor(days[i]), x, yy);
  }
  function indexFromEvent(e) {
    const r = root.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * W;
    const i = Math.floor((sx - m.left) / band);
    return i >= 0 && i < n ? i : -1;
  }
  root.addEventListener('pointermove', (e) => {
    const i = indexFromEvent(e);
    if (i < 0) setActive(-1);
    else setActive(i, e.clientX, e.clientY);
  });
  root.addEventListener('pointerleave', () => setActive(-1));
  root.addEventListener('blur', () => setActive(-1));
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    let i = active < 0 ? n - 1 : active;
    if (e.key === 'ArrowLeft') i = Math.max(0, i - 1);
    if (e.key === 'ArrowRight') i = Math.min(n - 1, i + 1);
    if (e.key === 'Home') i = 0;
    if (e.key === 'End') i = n - 1;
    const r = cols[i].getBoundingClientRect();
    setActive(i, r.left + r.width / 2, r.top + 20);
  });
}

// ---------------------------------------------------------------- 表ビュー

export function renderDayTable(container, days, categories) {
  container.replaceChildren();
  const table = el('table', 'data-table');
  const thead = el('thead');
  const hr = el('tr');
  hr.append(el('th', null, '日付'), el('th', null, '投稿数'));
  for (const c of categories) hr.append(el('th', null, categoryLabel(c)));
  hr.append(el('th', null, 'インプレッション'));
  thead.append(hr);
  const tbody = el('tbody');
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i];
    const tr = el('tr');
    tr.append(el('td', null, d.date), el('td', null, formatExact(d.posts)));
    for (const c of categories) tr.append(el('td', null, formatExact(d.categories[c] || 0)));
    const imp = el('td', null, formatCompact(d.impressions));
    imp.title = formatExact(d.impressions);
    tr.append(imp);
    tbody.append(tr);
  }
  table.append(thead, tbody);
  container.append(table);
}

// ---------------------------------------------------------------- 的中率（メーター型の横棒）

/**
 * items: [{label, total, crossed}]。1 系列なので色は 1 色（凡例なし）。
 * 値は「n件中m件（xx%）」を常に直接表示（ツールチップに頼らない）。total=0 は「対象なし」。
 */
export function renderRateBars(container, items, emptyText) {
  container.replaceChildren();
  container.classList.remove('is-empty');
  if (!items.length) {
    container.classList.add('is-empty');
    container.textContent = emptyText;
    return;
  }
  const list = el('div', 'rate-list');
  list.setAttribute('role', 'list');
  for (const it of items) {
    const row = el('div', 'rate-row');
    row.setAttribute('role', 'listitem');
    const label = el('div', 'rate-label', it.label ?? '（条件名なし）');
    const text = hitRateText(it.total, it.crossed);
    const ratio = hitRatio(it.total, it.crossed);
    const meter = svg('svg', { class: 'rate-meter', viewBox: '0 0 100 8', preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' });
    meter.append(svg('rect', { class: 'rate-track', x: 0, y: 0, width: 100, height: 8, rx: 0 }));
    if (ratio != null && ratio > 0) meter.append(svg('rect', { class: 'rate-fill', x: 0, y: 0, width: Math.max(0.8, ratio * 100), height: 8 }));
    const value = el('div', ratio == null ? 'rate-value muted' : 'rate-value', text);
    row.setAttribute('aria-label', `${it.label ?? '条件名なし'}: ${text}`);
    row.title = `${it.label ?? ''} ${text}`.trim();
    row.append(label, meter, value);
    list.append(row);
  }
  container.append(list);
}
