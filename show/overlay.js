// OBS 用オーバーレイ（段階2・4）。overlay.html?part=topicbar|card|title|fx|all（&scale=1.2&motion=off&demo=1&sound=on）
// データの受け取り: OBS のブラウザソースでは window の 'xtrend-show' イベント（obs-websocket の CallVendorRequest → obs-browser の
// emit_event。detail はオブジェクトでも JSON 文字列でも可）。同じブラウザ内のプレビューでは BroadcastChannel。
// 外部テキストはすべて textContent。画像は pbs.twimg.com のみ。
import { formatCompact } from '../assets/js/core.js';
import { OVERLAY_PARTS, LAYOUT_GUIDE } from './js/overlayinfo.js';
import { OBS_EVENT_NAME, OVERLAY_CHANNEL, shouldAccept, readDetail, titleVisible, demoPayload } from './js/payload.js';
import { createEffectGate, effectDef, thanksText, makeEffect } from './js/effects.js';

const PARTS = { all: { w: 1920, h: 1080 } };
for (const p of OVERLAY_PARTS) PARTS[p.key] = { w: p.w, h: p.h };
// 全部入り（確認用）での配置。参考配置図（overlayinfo.js）と同じ。タイトルは全面
const LAYOUT = {};
for (const g of LAYOUT_GUIDE) if (g.key) LAYOUT[g.key] = { x: g.x, y: g.y, w: g.w, h: g.h };
LAYOUT.title = { x: 0, y: 0, w: 1920, h: 1080 };
LAYOUT.fx = { x: 0, y: 0, w: 1920, h: 1080 }; // 演出はいちばん上
const FX_BOX = Object.fromEntries(LAYOUT_GUIDE.filter((g) => g.fx).map((g) => [g.fx, g]));

const params = new URLSearchParams(location.search);
const part = PARTS[params.get('part')] ? params.get('part') : 'all';
const extra = Math.min(4, Math.max(0.1, Number(params.get('scale')) || 1));
const motionOff = params.get('motion') === 'off';
const soundOn = params.get('sound') === 'on'; // 効果音は既定オフ（WebAudio で合成。ファイルは使わない）
const calm = () => motionOff || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
const stage = document.getElementById('stage');
const COLORS = ['main', 'host', 'kyaba', 'kabuki', 'night', 'general', 'review', 'white'];
const color = (k) => (COLORS.includes(k) ? k : 'white');

const st = { last: null, received: 0, topicId: undefined, cardKey: undefined, titleId: undefined, titleTimer: null, fired: [], audio: false };
const gate = createEffectGate();
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
      if (k === 'fx') buildFx(inner);
    }
  } else if (part === 'topicbar') buildTopicbar(stage);
  else if (part === 'card') buildCard(stage);
  else if (part === 'title') buildTitle(stage);
  else if (part === 'fx') buildFx(stage);
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
  if (view.fx) renderFx(p);
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

// ---------------------------------------------------------------- 演出（段階4）
// effect は 1 回限り。gate が id（発火済み）・古い at・同じ演出の 1 秒以内・同時 3 つを見て、出すかを決める。
// 動きを減らす設定（?motion=off・OS の設定）では粒を減らし、フェードだけ（Web Animations。CSS の animation:none の影響を受けない）。

function buildFx(host) {
  const fx = el('div', 'fx');
  host.append(fx);
  view.fx = { fx };
}

const rand = (a, b) => a + Math.random() * (b - a);
const FX_COLORS = ['#e02a1b', '#1f5fe0', '#e0157a', '#7b2ff2', '#23c25b', '#ffd60a', '#ffffff'];

function place(node, box) {
  Object.assign(node.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
}

function renderFx(p) {
  const e = p.effect;
  if (!e || !gate.accept(e)) return;
  const def = effectDef(e.kind);
  const quiet = calm();
  const box = el('div', `fx-item fx-k-${e.kind}${quiet ? ' is-calm' : ''}`);
  box.dataset.kind = e.kind;
  box.dataset.id = e.id;
  box.style.setProperty('--dur', `${def.duration}ms`);
  const n = (full, few) => (quiet ? few : full);
  if (e.kind === 'clap') {
    for (let i = 0; i < n(18, 5); i++) {
      const c = el('span', 'fx-clap', '👏');
      Object.assign(c.style, { left: `${quiet ? 1180 + i * 130 : rand(560, 1820)}px`, animationDelay: `${rand(0, 0.9).toFixed(2)}s`, fontSize: `${Math.round(rand(70, 120))}px` });
      c.style.setProperty('--dx', `${Math.round(rand(-80, 80))}px`);
      box.append(c);
    }
  } else if (e.kind === 'confetti') {
    for (let i = 0; i < n(110, 24); i++) {
      const c = el('span', 'fx-conf');
      Object.assign(c.style, { left: `${rand(0, 1900)}px`, background: FX_COLORS[i % FX_COLORS.length], animationDelay: `${rand(0, 0.9).toFixed(2)}s`, animationDuration: `${rand(2.2, 3).toFixed(2)}s` });
      if (quiet) c.style.top = `${rand(40, 1000)}px`;
      c.style.setProperty('--dx', `${Math.round(rand(-160, 160))}px`);
      c.style.setProperty('--rot', `${Math.round(rand(360, 1080))}deg`);
      box.append(c);
    }
  } else if (e.kind === 'kami' || e.kind === 'eh') {
    const s = el('div', 'fx-stamp-wrap');
    place(s, FX_BOX.stamp);
    s.append(el('div', `fx-stamp fx-stamp-${e.kind}`, e.kind === 'kami' ? '神回！' : 'えぇっ！？'));
    box.append(s);
  } else if (e.kind === 'fire') {
    const f = el('div', 'fx-fire-wrap');
    f.append(el('div', 'fx-glow'));
    for (let i = 0; i < n(13, 6); i++) {
      const c = el('span', 'fx-flame', '🔥');
      Object.assign(c.style, { left: `${(quiet ? 560 + i * 220 : 520 + i * 108 + rand(-20, 20))}px`, animationDelay: `${rand(0, 0.5).toFixed(2)}s`, fontSize: `${Math.round(rand(100, 150))}px` });
      f.append(c);
    }
    box.append(f);
  } else if (e.kind === 'thanks') {
    const t = thanksText(e.params);
    const b = el('div', 'fx-banner');
    place(b, FX_BOX.thanks);
    b.append(el('span', 'fx-thanks-icon', '🙏'), el('span', 'fx-thanks-main', t.main));
    if (t.amount) b.append(el('span', 'fx-thanks-amount', t.amount));
    box.append(b);
  }
  view.fx.fx.append(box);
  if (quiet && typeof box.animate === 'function') {
    box.animate([{ opacity: 0 }, { opacity: 1, offset: 0.12 }, { opacity: 1, offset: 0.82 }, { opacity: 0 }], { duration: def.duration, fill: 'forwards' });
  }
  st.fired.push(e.id);
  setTimeout(() => box.remove(), def.duration);
  if (soundOn) playSound(e.kind);
}

// ---------------------------------------------------------------- 効果音（WebAudio で合成。?sound=on のときだけ AudioContext を作る）

let ac = null;
function audio() {
  if (!ac) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ac = new AC(); } catch { return null; }
    st.audio = true;
  }
  if (ac.state === 'suspended') ac.resume().catch(() => {});
  return ac;
}

function tone(c, out, { f, f2 = null, t = 0, dur = 0.3, type = 'sine', vol = 0.25 }) {
  const o = c.createOscillator();
  const g = c.createGain();
  const t0 = c.currentTime + t;
  o.type = type;
  o.frequency.setValueAtTime(f, t0);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(out);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

function noise(c, out, { t = 0, dur = 0.08, vol = 0.3, freq = 1500, q = 1, type = 'bandpass', sweep = null }) {
  const len = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource();
  src.buffer = buf;
  const fl = c.createBiquadFilter();
  fl.type = type;
  fl.Q.value = q;
  const t0 = c.currentTime + t;
  fl.frequency.setValueAtTime(freq, t0);
  if (sweep) fl.frequency.exponentialRampToValueAtTime(sweep, t0 + dur);
  const g = c.createGain();
  g.gain.value = vol;
  src.connect(fl).connect(g).connect(out);
  src.start(t0);
}

function playSound(kind) {
  const c = audio();
  if (!c) return;
  const out = c.createGain();
  out.gain.value = 0.6;
  out.connect(c.destination);
  if (kind === 'clap') for (let i = 0; i < 14; i++) noise(c, out, { t: i * 0.09 + Math.random() * 0.05, dur: 0.07, freq: 1400 + Math.random() * 600, q: 0.8 });
  else if (kind === 'confetti') [1047, 1319, 1568, 2093, 1568, 2093].forEach((f, i) => tone(c, out, { f, t: i * 0.07, dur: 0.25, type: 'triangle', vol: 0.18 }));
  else if (kind === 'kami') { [523, 659, 784].forEach((f) => tone(c, out, { f, dur: 0.18, type: 'square', vol: 0.08 })); [523, 659, 784, 1047].forEach((f) => tone(c, out, { f, t: 0.2, dur: 0.9, type: 'sawtooth', vol: 0.07 })); }
  else if (kind === 'eh') { tone(c, out, { f: 900, f2: 300, dur: 0.45, type: 'sine', vol: 0.3 }); tone(c, out, { f: 500, f2: 1100, t: 0.5, dur: 0.35, type: 'sine', vol: 0.25 }); }
  else if (kind === 'fire') noise(c, out, { dur: 1.4, vol: 0.5, freq: 300, sweep: 2400, type: 'lowpass', q: 0.7 });
  else if (kind === 'thanks') [880, 1320, 1760].forEach((f, i) => tone(c, out, { f, t: i * 0.14, dur: 1.1, type: 'sine', vol: 0.18 }));
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
if (params.get('demo') === '1') {
  const d = demoPayload();
  // 演出の見本（?demo=1&fx=confetti など。配置の確認用）
  const fx = params.get('fx');
  if (fx) d.effect = makeEffect(fx, { name: params.get('name') || 'サンプル', amount: params.get('amount') || '¥10,000' });
  receive(d);
}
