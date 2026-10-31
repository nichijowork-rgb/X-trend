// OBS 用オーバーレイ（段階2）。overlay.html?part=topicbar|card|title|all（&scale=1.2&motion=off&demo=1）
// データの受け取り: OBS のブラウザソースでは window の 'xtrend-show' イベント（obs-websocket の CallVendorRequest → obs-browser の
// emit_event。detail はオブジェクトでも JSON 文字列でも可）。同じブラウザ内のプレビューでは BroadcastChannel。
// 外部テキストはすべて textContent。画像は pbs.twimg.com のみ。
import { formatCompact } from '../assets/js/core.js';
import { OVERLAY_PARTS, LAYOUT_GUIDE } from './js/overlayinfo.js';
import { OBS_EVENT_NAME, OVERLAY_CHANNEL, shouldAccept, readDetail, titleVisible, demoPayload } from './js/payload.js';

const PARTS = { all: { w: 1920, h: 1080 } };
for (const p of OVERLAY_PARTS) PARTS[p.key] = { w: p.w, h: p.h };
// 全部入り（確認用）での配置。参考配置図（overlayinfo.js）と同じ。タイトルは全面
const LAYOUT = {};
for (const g of LAYOUT_GUIDE) if (g.key) LAYOUT[g.key] = { x: g.x, y: g.y, w: g.w, h: g.h };
LAYOUT.title = { x: 0, y: 0, w: 1920, h: 1080 }; // いちばん上に重ねる

const params = new URLSearchParams(location.search);
const part = PARTS[params.get('part')] ? params.get('part') : 'all';
const extra = Math.min(4, Math.max(0.1, Number(params.get('scale')) || 1));
const motionOff = params.get('motion') === 'off';
const stage = document.getElementById('stage');
const COLORS = ['main', 'host', 'kyaba', 'kabuki', 'night', 'general', 'review', 'white'];
const color = (k) => (COLORS.includes(k) ? k : 'white');

const st = { last: null, received: 0, topicId: undefined, cardKey: undefined, titleId: undefined, titleTimer: null };
window.__overlay = st; // E2E・確認用

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ---------------------------------------------------------------- 骨組み

const view = {};

function buildTopicbar(host) {
  const tb = el('div', 'tb');
  tb.hidden = true;
  const corner = el('div', 'tb-corner');
  const cName = el('span', 'tb-corner-name');
  const cN = el('span', 'tb-corner-n');
  corner.append(cName, cN);
  const main = el('div', 'tb-main');
  const topic = el('div', 'tb-topic');
  const dot = el('span', 'tb-dot');
  const name = el('span', 'tb-name');
  topic.append(dot, name);
  const next = el('div', 'tb-next');
  main.append(topic, next);
  tb.append(corner, main);
  host.append(tb);
  view.tb = { tb, corner, cName, cN, dot, name, next };
}

function buildCard(host) {
  const cd = el('div', 'cd is-out');
  const box = el('div', 'cd-box');
  const band = el('div', 'cd-band');
  const bandText = el('span', '', '');
  const bandX = el('span', 'cd-x', 'X の投稿');
  band.append(bandText, bandX);
  const user = el('div', 'cd-user');
  const text = el('p', 'cd-text');
  const img = el('img', 'cd-img');
  img.alt = '';
  img.referrerPolicy = 'no-referrer';
  img.decoding = 'async';
  img.hidden = true;
  img.addEventListener('error', () => { img.hidden = true; text.classList.remove('has-img'); });
  const metrics = el('div', 'cd-metrics');
  box.append(band, user, text, img, metrics);
  cd.append(box);
  host.append(cd);
  view.cd = { cd, band, bandText, user, text, img, metrics };
}

function buildTitle(host) {
  const tt = el('div', 'tt');
  tt.hidden = true;
  const card = el('div', 'tt-card');
  const kicker = el('p', 'tt-kicker', 'ここからは');
  const name = el('p', 'tt-name');
  const sub = el('p', 'tt-sub');
  card.append(kicker, name, sub);
  tt.append(card);
  host.append(tt);
  view.tt = { tt, card, name, sub };
}

function setup() {
  const size = PARTS[part];
  stage.style.width = `${size.w}px`;
  stage.style.height = `${size.h}px`;
  document.documentElement.classList.toggle('no-motion', motionOff);
  document.body.dataset.part = part;
  if (part === 'all') {
    for (const [k, r] of Object.entries(LAYOUT)) {
      const box = el('div', `al-part al-${k}`);
      Object.assign(box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      const inner = el('div', 'ov-inner');
      const pw = PARTS[k];
      Object.assign(inner.style, { position: 'absolute', left: 0, top: 0, width: `${pw.w}px`, height: `${pw.h}px`, transformOrigin: '0 0', transform: `scale(${Math.min(r.w / pw.w, r.h / pw.h)})` });
      box.append(inner);
      stage.append(box);
      if (k === 'topicbar') buildTopicbar(inner);
      if (k === 'card') buildCard(inner);
      if (k === 'title') buildTitle(inner);
    }
  } else if (part === 'topicbar') buildTopicbar(stage);
  else if (part === 'card') buildCard(stage);
  else if (part === 'title') buildTitle(stage);
  fit();
}

/** ソースの枠いっぱいに（縦横比を保って）拡大・縮小。?scale= でさらに倍率 */
function fit() {
  const size = PARTS[part];
  const s = Math.min(window.innerWidth / size.w, window.innerHeight / size.h) * extra || extra;
  stage.style.transform = `scale(${s})`;
}

// ---------------------------------------------------------------- 描画

function render(p) {
  if (view.tb) renderTopicbar(p);
  if (view.cd) renderCard(p);
  if (view.tt) renderTitle(p);
}

function renderTopicbar(p) {
  const v = view.tb;
  const t = p.topic;
  const show = Boolean(p.corner && p.live && p.live.started && !p.live.finished);
  v.tb.hidden = !show;
  if (!show) { st.topicId = undefined; return; }
  v.corner.className = `tb-corner g-${color(p.corner.color)}`;
  v.cName.textContent = p.corner.name || '';
  v.cN.textContent = p.corner.n && p.corner.of ? `${p.corner.n} / ${p.corner.of}` : '';
  v.cN.hidden = !v.cN.textContent;
  v.dot.className = `tb-dot g-${color(t ? t.genre : p.corner.color)}`;
  v.name.textContent = t ? t.name : (p.corner.sub || p.corner.name || '');
  v.next.textContent = '';
  if (p.next && p.next.name) { v.next.append(el('b', '', 'NEXT'), document.createTextNode(p.next.name)); }
  const key = `${p.corner.key}:${t ? t.id : ''}`;
  if (st.topicId !== key) {
    v.tb.classList.remove('is-enter');
    void v.tb.offsetWidth;
    v.tb.classList.add('is-enter');
    st.topicId = key;
  }
}

function renderCard(p) {
  const v = view.cd;
  const post = p.card && p.card.post;
  const show = Boolean(p.card && p.card.visible && post && p.live && p.live.started && !p.live.finished);
  if (show) {
    v.band.className = `cd-band g-${color(p.topic ? p.topic.genre : 'white')}`;
    v.bandText.textContent = p.topic ? p.topic.name : '';
    v.user.textContent = post.user ? `@${post.user}` : '';
    v.text.textContent = post.text || '（本文は X でご確認ください）';
    const thumb = typeof post.thumb === 'string' && /^https:\/\/pbs\.twimg\.com\//.test(post.thumb) ? post.thumb : null;
    if (thumb) { if (v.img.getAttribute('src') !== thumb) v.img.src = thumb; v.img.hidden = false; } else { v.img.removeAttribute('src'); v.img.hidden = true; }
    v.text.classList.toggle('has-img', Boolean(thumb));
    v.metrics.textContent = '';
    const m = post.metrics || {};
    for (const [k, label] of [['impression_count', '表示'], ['like_count', 'いいね'], ['retweet_count', 'RP']]) {
      if (m[k] == null) continue;
      const s = el('span', '', `${label} `);
      s.append(el('b', '', formatCompact(m[k])));
      v.metrics.append(s);
    }
  }
  v.cd.classList.toggle('is-out', !show);
  v.cd.dataset.visible = String(show);
  st.cardKey = show ? post.id : null;
}

function renderTitle(p) {
  const v = view.tt;
  const t = p.title;
  if (!t || !titleVisible(t)) {
    if (!t || st.titleId !== t.id) { v.tt.hidden = true; v.tt.classList.remove('is-show', 'is-leave'); }
    return;
  }
  if (st.titleId === t.id) return; // 再送では出し直さない
  st.titleId = t.id;
  v.card.className = `tt-card g-${color(t.color)}`;
  v.name.textContent = t.text || '';
  v.sub.textContent = t.sub || '';
  v.tt.hidden = false;
  v.tt.classList.remove('is-leave');
  v.tt.classList.remove('is-show');
  void v.tt.offsetWidth;
  v.tt.classList.add('is-show');
  clearTimeout(st.titleTimer);
  const left = Math.max(300, (t.duration || 4000) - (Date.now() - t.at));
  st.titleTimer = setTimeout(() => {
    v.tt.classList.add('is-leave');
    setTimeout(() => { if (st.titleId === t.id) { v.tt.hidden = true; v.tt.classList.remove('is-show', 'is-leave'); } }, motionOff ? 0 : 500);
  }, left);
}

// ---------------------------------------------------------------- 受信

function receive(raw) {
  const p = readDetail(raw);
  if (!shouldAccept(st.last, p)) return;
  st.last = p;
  st.received++;
  try { render(p); } catch (err) { console.warn('overlay render', err); }
}

setup();
window.addEventListener(OBS_EVENT_NAME, (e) => receive(e.detail));
try {
  if ('BroadcastChannel' in window) new BroadcastChannel(OVERLAY_CHANNEL).onmessage = (e) => receive(e.data);
} catch { /* 無視 */ }
window.addEventListener('resize', fit);
if (params.get('demo') === '1') receive(demoPayload());
