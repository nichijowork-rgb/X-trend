// OBS 用オーバーレイ（段階2・4）。overlay.html?part=topicbar|card|title|fx|comments|all（&scale=1.2&motion=off&demo=1&sound=on）
// 流れるコメント（part=comments）は type: 'chat' のメッセージ（ytchat.js）。&top= &lanes= &laneh= &size= &speed= で流れ方を上書きできる。
// &preview=1 はレイアウト調整の中の見本（OBS・BroadcastChannel は聞かず、親の画面から postMessage で設定を受け取る）
// データの受け取り: OBS のブラウザソースでは window の 'xtrend-show' イベント（obs-websocket の CallVendorRequest → obs-browser の
// emit_event。detail はオブジェクトでも JSON 文字列でも可）。同じブラウザ内のプレビューでは BroadcastChannel。
// 外部テキストはすべて textContent。画像は pbs.twimg.com のみ。
import { formatCompact } from '../assets/js/core.js';
import { OVERLAY_PARTS, LAYOUT_GUIDE } from './js/overlayinfo.js';
import { OBS_EVENT_NAME, OVERLAY_CHANNEL, shouldAccept, readDetail, titleVisible, demoPayload } from './js/payload.js';
import { createEffectGate, effectDef, thanksText, makeEffect } from './js/effects.js';
import { validImageDataUrl } from './js/imaging.js';
import { createChatReceiver, sanitizeChatCfg, applyChatOverrides, CHAT_CFG_DEFAULTS, buildChatMessage, demoChatItem, demoChatPin, inkFor, initialOf } from './js/ytchat.js';
import { createLaneScheduler, lanesOverlapping, laneTop, travelMs, laneBusyMs } from './js/lanes.js';

const PARTS = { all: { w: 1920, h: 1080 } };
for (const p of OVERLAY_PARTS) PARTS[p.key] = { w: p.w, h: p.h };
// 全部入り（確認用）での配置。参考配置図（overlayinfo.js）と同じ。タイトルは全面
const LAYOUT = {};
for (const g of LAYOUT_GUIDE) if (g.key) LAYOUT[g.key] = { x: g.x, y: g.y, w: g.w, h: g.h };
LAYOUT.comments = { x: 0, y: 0, w: 1920, h: 1080 }; // 流れるコメントは全面（いちばん下＝投稿カードの裏を通る）
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
// 自分で追加した画像（送り手は新しい画像のときと 30 秒おきにだけ本体 media を付ける）。ハッシュ → data URL
const imageCache = new Map();
st.images = imageCache;
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
  // 話題名（2 行まで）と、その下に小さく「NEXT：次の話題」だけ。ジャンル色は左端の細いライン
  const tb = el('div', 'tb');
  tb.hidden = true;
  const line = el('span', 'tb-line');
  const main = el('div', 'tb-main');
  const topic = el('div', 'tb-topic');
  const name = el('span', 'tb-name');
  topic.append(name);
  const next = el('div', 'tb-next');
  main.append(topic, next);
  tb.append(line, main);
  host.append(tb);
  view.tb = { tb, line, name, next };
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
  const photo = el('img', 'cd-photo');
  photo.alt = '';
  photo.decoding = 'async';
  photo.hidden = true;
  const wait = el('p', 'cd-wait', '画像を受け取り中…');
  wait.hidden = true;
  box.append(band, user, photo, wait, text, img, metrics);
  cd.append(box);
  host.append(cd);
  view.cd = { cd, band, bandText, bandX, user, text, img, metrics, photo, wait, box };
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
      if (k === 'comments') buildComments(inner);
    }
  } else if (part === 'comments') buildComments(stage);
  else if (part === 'topicbar') buildTopicbar(stage);
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
  v.line.className = `tb-line g-${color(t ? t.genre : p.corner.color)}`;
  v.name.textContent = t ? t.name : (p.corner.name || '');
  v.next.textContent = '';
  if (p.next && p.next.name) { v.next.append(el('b', '', 'NEXT：'), document.createTextNode(p.next.name)); }
  v.next.hidden = !v.next.textContent;
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
  const isImage = Boolean(show && post.kind === 'image' && post.image);
  v.box.classList.toggle('is-image', isImage);
  if (isImage) {
    v.band.className = `cd-band g-${color(p.topic ? p.topic.genre : 'white')}`;
    v.bandText.textContent = p.topic ? p.topic.name : '';
    v.user.textContent = '';
    v.user.hidden = true;
    v.metrics.textContent = '';
    v.img.hidden = true;
    v.img.removeAttribute('src');
    v.text.textContent = post.text || '';
    v.text.hidden = !post.text;
    v.text.classList.remove('has-img');
    const data = post.image.hash ? imageCache.get(post.image.hash) : null;
    if (data) { if (v.photo.getAttribute('src') !== data) v.photo.src = data; v.photo.hidden = false; v.wait.hidden = true; } else { v.photo.removeAttribute('src'); v.photo.hidden = true; v.wait.hidden = false; }
    v.bandX.textContent = '画像';
  } else {
    v.user.hidden = false;
    v.text.hidden = false;
    v.photo.hidden = true;
    v.photo.removeAttribute('src');
    v.wait.hidden = true;
    v.bandX.textContent = 'X の投稿';
  }
  if (show && !isImage) {
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

// ---------------------------------------------------------------- 流れるコメント（YouTube ライブ。type: 'chat'）
// 右から左へ一定の速さで流す（lanes.js が列を決める）。固定コメントは中央の箱（重なる列には新しいコメントを入れない）。
// 文字はすべて textContent。アイコンは YouTube の画像（ytchat.js の safeIcon が通したもの）か頭文字の丸。

const chatOverride = {};
for (const [q, k] of [['top', 'top'], ['lanes', 'lanes'], ['laneh', 'laneH'], ['size', 'size'], ['speed', 'speed']]) {
  if (params.has(q) && params.get(q) !== '' && Number.isFinite(Number(params.get(q)))) chatOverride[k] = Number(params.get(q));
}
const previewMode = params.get('preview') === '1';
// 番組サイト（color-scheme: dark）の中の iframe では、配色をそろえないと背景が白く塗られる
if (previewMode) document.documentElement.style.colorScheme = 'dark';
const chat = {
  base: sanitizeChatCfg(CHAT_CFG_DEFAULTS), cfg: applyChatOverrides(sanitizeChatCfg(CHAT_CFG_DEFAULTS), chatOverride), receiver: createChatReceiver(),
  sched: null, active: new Map(), pin: null, blocked: [], launched: [], received: 0, timer: null,
};
st.chat = chat; // E2E・確認用

const AV_COLORS = ['#e02a1b', '#1f5fe0', '#e0157a', '#7b2ff2', '#1e9e50', '#c77700', '#0088a8', '#6d4c41'];
function avatar(item, cls) {
  const initial = () => {
    const sp = el('span', `${cls} cm-initial`, initialOf(item.name));
    let n = 0;
    for (const ch of String(item.name || '')) n = (n * 31 + ch.codePointAt(0)) >>> 0;
    sp.style.background = AV_COLORS[n % AV_COLORS.length];
    return sp;
  };
  if (!item.icon) return initial();
  const img = el('img', cls);
  img.alt = '';
  img.referrerPolicy = 'no-referrer';
  img.decoding = 'async';
  img.addEventListener('error', () => { if (img.isConnected) img.replaceWith(initial()); });
  img.src = item.icon;
  return img;
}

function buildComments(host) {
  const layer = el('div', 'cm');
  // 流れる範囲（帯）。はみ出した部分は見せない（帯の右端から入って左端で消える）
  const flow = el('div', 'cm-flow');
  const pin = el('div', 'cm-pin');
  pin.hidden = true;
  layer.append(flow, pin);
  host.append(layer);
  view.cm = { layer, flow, pin };
  chat.sched = createLaneScheduler({ lanes: chat.cfg.lanes });
  applyChatCfg(chat.base, true);
  chat.timer = setInterval(pumpChat, 100);
}

/** 流れ方の設定（送り手の設定に URL の上書きを重ねる）: 帯の位置と大きさ・列の数・文字・速さ・固定コメントの箱 */
function applyChatCfg(cfg, force = false) {
  chat.base = cfg;
  const next = applyChatOverrides(sanitizeChatCfg(cfg), chatOverride);
  const was = chat.cfg;
  chat.cfg = next;
  const v = view.cm;
  const b = next.band;
  Object.assign(v.flow.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` });
  v.layer.style.setProperty('--cm-size', `${next.size}px`);
  v.layer.dataset.flow = String(next.flow);
  const pb = next.pin;
  Object.assign(v.pin.style, { left: `${pb.x}px`, top: `${pb.y}px`, width: `${pb.w}px` });
  v.pin.style.setProperty('--pin-size', `${pb.size}px`);
  v.pin.style.setProperty('--pin-lines', String(pb.lines));
  if (chat.sched.lanes !== next.lanes) chat.sched.resize(next.lanes);
  if (!next.flow) { chat.sched.clear(); for (const id of [...chat.active.keys()]) removeComment(id); }
  if (force || JSON.stringify(was) !== JSON.stringify(next)) {
    // 列の高さが変わったら、流れているコメントも新しい列の位置へ
    for (const a of chat.active.values()) a.node.style.top = `${laneTop(next, Math.min(a.lane, next.lanes - 1))}px`;
    updateBlocked();
  }
}

function updateBlocked() {
  const p = view.cm.pin;
  chat.blocked = chat.pin && !p.hidden ? lanesOverlapping(chat.cfg, { x: p.offsetLeft, y: p.offsetTop, w: p.offsetWidth, h: p.offsetHeight }) : [];
}

function commentEl(item) {
  const node = el('div', `cm-item is-${item.kind}`);
  node.dataset.id = item.id;
  const text = el('div', 'cm-text');
  if (item.kind !== 'text') {
    if (item.color) { text.style.background = item.color; text.style.color = inkFor(item.color); }
    if (item.amount) text.append(el('span', 'cm-amount', item.amount));
  }
  if (item.text) text.append(el('span', 'cm-body', item.text));
  const meta = el('div', 'cm-meta');
  meta.append(avatar(item, 'cm-icon'), el('span', 'cm-name', item.name));
  node.append(text, meta);
  return node;
}

function launch(item, lane, now) {
  const v = view.cm;
  const node = commentEl(item);
  const bw = chat.cfg.band.w;
  node.style.top = `${laneTop(chat.cfg, lane)}px`;
  node.style.transform = `translateX(${bw}px)`;
  node.dataset.lane = String(lane);
  v.flow.append(node);
  const w = node.offsetWidth;
  const quiet = calm();
  chat.sched.occupy(lane, now + laneBusyMs(w, chat.cfg, { calm: quiet }), item.id);
  const dur = quiet ? Math.round(chat.cfg.speed * 1000) : travelMs(w, chat.cfg);
  let anim = null;
  if (quiet) {
    // 動きを減らす: 流さずに列の左寄りでフェードイン・アウト
    node.style.transform = 'translateX(40px)';
    if (typeof node.animate === 'function') anim = node.animate([{ opacity: 0 }, { opacity: 1, offset: 0.08 }, { opacity: 1, offset: 0.9 }, { opacity: 0 }], { duration: dur, fill: 'forwards' });
  } else if (typeof node.animate === 'function') {
    anim = node.animate([{ transform: `translateX(${bw}px)` }, { transform: `translateX(${-w}px)` }], { duration: dur, easing: 'linear', fill: 'forwards' });
  }
  const t = setTimeout(() => removeComment(item.id, false), dur + 50);
  chat.active.set(item.id, { node, anim, lane, t });
  chat.launched.push({ id: item.id, lane, at: now });
  if (chat.launched.length > 300) chat.launched.splice(0, chat.launched.length - 300);
}

function removeComment(id, release = true) {
  chat.sched.remove(id);
  const a = chat.active.get(id);
  if (!a) return;
  chat.active.delete(id);
  clearTimeout(a.t);
  if (a.anim) { try { a.anim.cancel(); } catch { /* 無視 */ } }
  a.node.remove();
  if (release) chat.sched.release(id, Date.now());
}

function pumpChat() {
  if (!view.cm || !chat.cfg.flow) return;
  const now = Date.now();
  let r;
  while ((r = chat.sched.take(now, chat.blocked))) launch(r.item, r.lane, now);
}

function renderPin(pin) {
  const v = view.cm;
  if (!pin) {
    if (!chat.pin) return;
    chat.pin = null;
    chat.blocked = [];
    v.pin.classList.add('is-out');
    const hideAt = Date.now();
    chat.pinHideAt = hideAt;
    setTimeout(() => { if (!chat.pin && chat.pinHideAt === hideAt) { v.pin.hidden = true; v.pin.classList.remove('is-out'); } }, calm() ? 0 : 280);
    return;
  }
  const same = chat.pin && JSON.stringify(chat.pin) === JSON.stringify(pin);
  chat.pin = pin;
  if (same && !v.pin.hidden) return; // 再送では出し直さない
  while (v.pin.firstChild) v.pin.firstChild.remove();
  v.pin.dataset.id = pin.id;
  v.pin.className = `cm-pin is-${pin.kind}`;
  const head = el('div', 'cm-pin-head');
  head.append(el('span', 'cm-pin-name', pin.name));
  if (pin.kind !== 'text' && pin.amount) {
    const amt = el('span', 'cm-pin-amount', pin.amount);
    if (pin.color) { amt.style.background = pin.color; amt.style.color = inkFor(pin.color); }
    head.append(amt);
  }
  const body = el('div', 'cm-pin-body');
  body.append(head, el('p', 'cm-pin-text', pin.text || ''));
  v.pin.append(el('span', 'cm-pin-tag', '固定中'), avatar(pin, 'cm-pin-icon'), body);
  v.pin.hidden = false;
  v.pin.classList.remove('is-in');
  void v.pin.offsetWidth;
  v.pin.classList.add('is-in');
  updateBlocked();
}

function receiveChat(msg) {
  if (!view.cm) return;
  const r = chat.receiver.accept(msg, Date.now());
  if (!r) return;
  chat.received++;
  if (r.cfg) applyChatCfg(r.cfg);
  for (const id of r.remove) removeComment(id);
  if (r.pin !== undefined) renderPin(r.pin);
  if (chat.pin && r.remove.includes(chat.pin.id)) renderPin(null);
  if (chat.cfg.flow) for (const it of r.add) chat.sched.enqueue(it);
  pumpChat();
}

/** ?demo=1: 見本のコメントを流し続け、見本の固定コメントを出す（配置の確認用。名前は架空） */
function chatDemo() {
  let i = 0;
  let seq = 0;
  const pin = demoChatPin(0); // id を固定（レイアウト調整の画面から送る見本と同じもの＝出し直さない）
  const tick = () => {
    const now = Date.now();
    receiveChat(buildChatMessage({ sid: 'demo', seq: ++seq, at: now, add: [demoChatItem(i++, now)], pin }));
  };
  tick();
  setInterval(tick, 900);
}

// ---------------------------------------------------------------- 受信

function receive(raw) {
  const p = readDetail(raw);
  if (p && p.type === 'chat') { receiveChat(p); return; }
  // 画像の本体（再送の古い seq でも受け取ってキャッシュ。待っていた画像なら描き直す）
  if (p && p.media && typeof p.media.hash === 'string' && /^[0-9a-f]{8,64}$/.test(p.media.hash) && validImageDataUrl(p.media.dataUrl)) {
    const fresh = !imageCache.has(p.media.hash);
    imageCache.set(p.media.hash, p.media.dataUrl);
    if (imageCache.size > 30) imageCache.delete(imageCache.keys().next().value);
    const cur = st.last && st.last.card && st.last.card.post;
    if (fresh && cur && cur.kind === 'image' && cur.image && cur.image.hash === p.media.hash && view.cd) { try { renderCard(st.last); } catch { /* 無視 */ } }
  }
  if (!shouldAccept(st.last, p)) return;
  st.last = p;
  st.received++;
  try { render(p); } catch (err) { console.warn('overlay render', err); }
}

setup();
if (previewMode) {
  // レイアウト調整の見本: 親（同じサイト）の画面からだけ受け取る
  window.addEventListener('message', (e) => { if (e.origin === location.origin && e.source === window.parent) receive(e.data); });
} else {
  window.addEventListener(OBS_EVENT_NAME, (e) => receive(e.detail));
  try {
    if ('BroadcastChannel' in window) new BroadcastChannel(OVERLAY_CHANNEL).onmessage = (e) => receive(e.data);
  } catch { /* 無視 */ }
}
window.addEventListener('resize', fit);
if (params.get('demo') === '1') {
  const d = demoPayload();
  // 演出の見本（?demo=1&fx=confetti など。配置の確認用）
  const fx = params.get('fx');
  if (fx) d.effect = makeEffect(fx, { name: params.get('name') || 'サンプル', amount: params.get('amount') || '¥10,000' });
  receive(d);
  if (view.cm) chatDemo();
} else if (previewMode && view.cm) chatDemo();
