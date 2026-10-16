// DOM ヘルパー（番組サイト）。外部テキストは必ず textContent で入れる（innerHTML は使わない）。
import { formatCompact, formatDateTime, formatPace, isSafeHttpUrl, UNKNOWN } from '../../assets/js/core.js';
import { sizedImageUrl } from '../../assets/js/media.js';
import { statusUrl, genreLabel } from './logic.js';
import { genreIcon } from './icons.js';

/**
 * 要素を作る。props: { class, text, attrs, dataset, on, hidden, ...プロパティ }
 * children: 文字列（textContent として入る）・要素・配列・null
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'attrs') for (const [a, x] of Object.entries(v)) { if (x != null && x !== false) el.setAttribute(a, x === true ? '' : String(x)); }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else el[k] = v;
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.append(c);
    else el.append(document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

/** ボタン（type=button） */
export function btn(label, onClick, cls = 'btn', attrs = {}) {
  return h('button', { type: 'button', class: cls, on: { click: onClick }, attrs }, label);
}

/** ジャンルの丸いシール風バッジ */
export function genreSticker(genre, { label = true, small = false } = {}) {
  return h('span', { class: `sticker g-${genre}${small ? ' is-small' : ''}` },
    genreIcon(genre),
    label ? h('span', { class: 'sticker-label' }, genreLabel(genre)) : null);
}

export function badge(text, cls = '') {
  return h('span', { class: `badge ${cls}`.trim() }, text);
}

/** 投稿の X の URL（http(s) で x.com/twitter.com のものだけ。無ければ id から） */
export function postUrl(post) {
  const ok = post && isSafeHttpUrl(post.url) && /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\//.test(post.url);
  return ok ? post.url : statusUrl(post.id);
}

export function openXLink(url, label = 'Xで開く') {
  return h('a', { class: 'btn btn-small btn-ghost', href: url, target: '_blank', rel: 'noopener noreferrer' }, label);
}

const METRICS = [
  ['impression_count', '表示'],
  ['like_count', 'いいね'],
  ['retweet_count', 'RP'],
  ['bookmark_count', 'ブクマ'],
];

/** 数値の行（不明は「不明」） */
export function metricRow(post) {
  return h('p', { class: 'metrics' }, METRICS.map(([k, label]) => {
    const v = post.metrics ? post.metrics[k] : null;
    return h('span', { class: 'metric', attrs: { title: `${label}: ${v == null ? UNKNOWN : v}` } }, h('span', { class: 'metric-k' }, label), h('span', { class: 'metric-v' }, formatCompact(v)));
  }));
}

/**
 * 投稿カード。opts: { refTs, refYear, embedder, compact, noActions, mark }
 * 本文は textContent。画像は最初の写真（またはサムネイル）を小サイズ・lazy で1枚だけ。
 */
export function postCard(post, opts = {}) {
  const { refTs, refYear = null, embedder = null, compact = false, noActions = false, mark = null, bm = null } = opts;
  const card = h('article', { class: `post${compact ? ' is-compact' : ''}`, dataset: { id: post.id } });
  card.append(h('header', { class: 'post-head' },
    h('span', { class: 'post-user' }, post.user ? `@${post.user}` : UNKNOWN),
    h('time', { class: 'post-time' }, formatDateTime(post.created_jst, post.ts, refYear)),
    mark));
  card.append(h('p', { class: 'post-text' }, post.text || '（本文なし）'));
  const m = (post.media || []).find((x) => x.type === 'photo' ? x.url : x.preview);
  if (m && !compact) {
    const src = sizedImageUrl(m.type === 'photo' ? m.url : m.preview, 'small');
    const img = h('img', { class: 'post-img', loading: 'lazy', decoding: 'async', alt: m.alt || '添付画像', referrerPolicy: 'no-referrer' });
    if (m.width && m.height) { img.width = m.width; img.height = m.height; }
    img.addEventListener('error', () => img.replaceWith(h('span', { class: 'post-img-ph' }, '画像を読み込めませんでした')));
    img.src = src;
    card.append(img);
  }
  card.append(metricRow(post));
  if (bm) card.append(h('p', { class: 'post-bm' }, '★ブックマーク：数値はブックマーク時点（以後は更新されません）'));
  if (!compact && refTs != null) card.append(h('p', { class: 'post-pace' }, formatPace(post, refTs)));
  if (!noActions) card.append(postActions(post.id, postUrl(post), embedder));
  return card;
}

/** posts.json に無い投稿（リンクだけ） */
export function linkCard(id, url, embedder, note = 'この投稿の中身と数値は posts.json にありません') {
  return h('article', { class: 'post is-link', dataset: { id } },
    h('p', { class: 'post-text muted' }, note),
    h('p', { class: 'post-id' }, `投稿 ID ${id}`),
    postActions(id, url || statusUrl(id), embedder));
}

function postActions(id, url, embedder) {
  const row = h('div', { class: 'post-actions' });
  if (embedder && /^\d{5,25}$/.test(String(id))) {
    const b = btn('埋め込みで見る', () => {
      b.disabled = true;
      const host = h('div', { class: 'embed-host' }, h('div', { class: 'embed-skeleton' }, '埋め込みを読み込み中…'));
      row.after(host);
      embedder.now(host, String(id), () => {
        const sk = host.querySelector('.embed-skeleton');
        if (sk) sk.textContent = '埋め込みを表示できませんでした（削除・非公開・通信の遮断など）';
        const t = host.querySelector('.embed-target');
        if (t) t.remove();
      });
    }, 'btn btn-small btn-ghost');
    row.append(b);
  }
  row.append(openXLink(url));
  return row;
}

/** <label>＋入力欄 */
export function field(labelText, input, hint = null) {
  const id = input.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;
  return h('div', { class: 'field' }, h('label', { class: 'field-label', attrs: { for: id } }, labelText, hint ? h('span', { class: 'hint' }, hint) : null), input);
}

/** 入力中の要素がフォーム部品か（キーボード操作・再描画の判定用） */
export function isEditable(el) {
  if (!el || el === document.body) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/** ファイルとして保存させる */
export function downloadText(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, class: 'sr-only' });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

export function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/**
 * X 公式埋め込みの入れ物。中身（fallback）は読み込み中の表示を兼ね、埋め込めなかったときはそのまま残る。
 * 実際の読み込みは startEmbeds() が「画面に入ったものだけ」始める（再描画で入れ物を作り直さないよう data-keep-leaf）。
 */
export function embedHost(id, fallback, cls = '', opts = {}) {
  const host = h('div', { class: `embed-host ${cls}${opts.clamp ? ' is-clamp' : ''}`.trim(), dataset: { keep: `e:${id}`, embedId: String(id) }, attrs: { 'data-keep-leaf': '' } });
  host.append(h('div', { class: 'embed-skeleton embed-fallback' }, fallback || h('p', { class: 'muted' }, '埋め込みを読み込み中…')));
  if (opts.clamp) {
    // 長い投稿は一定の高さで切り、「全体を見る」で展開（入れ物ごと残るので再描画でも状態を保つ）
    const more = h('button', { type: 'button', class: 'embed-expand', hidden: true, dataset: { key: `expand-${id}` } }, '全体を見る ▾');
    more.addEventListener('click', () => {
      const open = host.classList.toggle('is-open');
      more.textContent = open ? 'たたむ ▴' : '全体を見る ▾';
    });
    host.append(more);
    const check = () => {
      if (host.classList.contains('is-open')) return;
      more.hidden = !(host.scrollHeight > host.clientHeight + 8);
    };
    let t = null;
    const later = () => { clearTimeout(t); t = setTimeout(check, 250); };
    try { new MutationObserver(later).observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'height'] }); } catch { /* 無視 */ }
    host.__checkTall = () => { requestAnimationFrame(check); setTimeout(check, 1500); };
  }
  return host;
}

/** root 内の未開始の埋め込みを embedder に登録する（画面に近づいたものだけ数件ずつ生成される） */
export function startEmbeds(root, embedder) {
  if (!embedder) return;
  for (const host of root.querySelectorAll('.embed-host[data-embed-id]:not([data-embed-started])')) {
    if (!host.isConnected) continue;
    host.dataset.embedStarted = '1';
    if (host.__checkTall) host.__checkTall();
    embedder.observe(host, host.dataset.embedId, () => {
      host.classList.add('is-failed');
      const sk = host.querySelector('.embed-skeleton');
      if (sk && !sk.querySelector('.embed-failed-note')) sk.prepend(h('p', { class: 'embed-failed-note' }, '埋め込みを表示できなかったため、データの内容を表示しています'));
      const t = host.querySelector('.embed-target');
      if (t) t.remove();
    });
  }
}
