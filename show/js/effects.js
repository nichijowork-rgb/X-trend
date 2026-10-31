// 段階4: 演出（エフェクト）の手動発火。DOM 非依存（node:test から import される）。
// 進行画面の「演出」パレット（ボタン・Shift+1〜6）→ ペイロードの effect 欄 → OBS（emit_event）／BroadcastChannel → overlay.html?part=fx。
//
// effect の形（1 回限りのイベント）: { id（一意）, kind, at（発火した時刻 ms）, params }
//  - kind: clap 拍手／confetti 紙吹雪／kami 神回！／eh えぇっ！？／fire 炎上／thanks 感謝バナー
//  - params: thanks のときだけ { name, amount }（文字数を制限した文字列。表示は textContent）
//  - 将来の自動発火（YouTube Data API のスパチャ等）は kind・params を増やすか、params.source を足す
// 送り手は同じペイロードを 5 秒おきに再送するが、受け手は id で発火済みを覚え、古い at（EFFECT_MAX_AGE_MS より前）は無視する。

export const EFFECTS = Object.freeze([
  Object.freeze({ kind: 'clap', label: '拍手', icon: '👏', digit: 1, duration: 2600 }),
  Object.freeze({ kind: 'confetti', label: '紙吹雪', icon: '🎉', digit: 2, duration: 3400 }),
  Object.freeze({ kind: 'kami', label: '神回！', icon: '✨', digit: 3, duration: 2300 }),
  Object.freeze({ kind: 'eh', label: 'えぇっ！？', icon: '❗', digit: 4, duration: 2100 }),
  Object.freeze({ kind: 'fire', label: '炎上', icon: '🔥', digit: 5, duration: 3000 }),
  Object.freeze({ kind: 'thanks', label: '感謝バナー', icon: '🙏', digit: 6, duration: 4800 }),
]);
export const EFFECT_KINDS = Object.freeze(EFFECTS.map((e) => e.kind));
export const effectDef = (kind) => EFFECTS.find((e) => e.kind === kind) || null;

/** 同じ演出は 1 秒以内の再発火を無視 */
export const EFFECT_COOLDOWN_MS = 1000;
/** 同時に出せる演出の数 */
export const EFFECT_MAX_ACTIVE = 3;
/** 受け手: これより古い effect は出さない（再送・後から開いたパーツ用） */
export const EFFECT_MAX_AGE_MS = 3000;
/** 送り手: ペイロードに effect を載せておく時間（この間の再送にも載るが、受け手は id で二重に出さない） */
export const EFFECT_TTL_MS = 4000;
/** 感謝バナーの入力の上限（文字数） */
export const THANKS_LIMITS = Object.freeze({ name: 20, amount: 12 });

// eslint-disable-next-line no-control-regex
const CTRL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069]', 'g');

/** 文字数（サロゲートペア・絵文字を 1 文字）で切る。制御文字・方向制御は除く */
export function clipText(v, max) {
  if (typeof v !== 'string') return '';
  return [...v.replace(CTRL, '').trim()].slice(0, max).join('').trim();
}

/** 感謝バナーの入力（名前・金額）を整える */
export function sanitizeThanks(p) {
  const o = p && typeof p === 'object' ? p : {};
  return { name: clipText(o.name, THANKS_LIMITS.name), amount: clipText(o.amount, THANKS_LIMITS.amount) };
}

/** 感謝バナーの文（表示用の部品。HTML ではなく文字列） */
export function thanksText(params) {
  const { name, amount } = sanitizeThanks(params);
  return { main: name ? `${name}さん ありがとう！` : 'ありがとう！', amount };
}

let counter = 0;
/** 一意な id（時刻＋起動ごとの乱数＋通し番号） */
const SESSION = Math.random().toString(36).slice(2, 8);
export function effectId(kind, now) {
  counter++;
  return `${kind}-${Math.floor(now).toString(36)}-${SESSION}-${counter.toString(36)}`;
}

/** 演出を作る。知らない kind は null */
export function makeEffect(kind, params = {}, now = Date.now(), idOf = effectId) {
  if (!EFFECT_KINDS.includes(kind) || !Number.isFinite(now)) return null;
  return { id: idOf(kind, now), kind, at: now, params: kind === 'thanks' ? sanitizeThanks(params) : {} };
}

/** 受け取った effect の形が正しいか */
export function validEffect(e) {
  return Boolean(e) && typeof e === 'object' && typeof e.id === 'string' && e.id.length > 0 && e.id.length <= 120
    && EFFECT_KINDS.includes(e.kind) && Number.isFinite(e.at);
}

/**
 * 発火の門番（受け手でも送り手でも使う）。
 * accept(effect, now) → true なら出す。発火済みの id・古い at・同じ演出の 1 秒以内・同時 3 つを超えるものは false。
 */
export function createEffectGate({ cooldownMs = EFFECT_COOLDOWN_MS, maxActive = EFFECT_MAX_ACTIVE, maxAgeMs = EFFECT_MAX_AGE_MS } = {}) {
  const seen = new Set();
  const lastByKind = new Map();
  let active = [];
  return {
    accept(e, now = Date.now()) {
      if (!validEffect(e) || seen.has(e.id)) return false;
      seen.add(e.id);
      if (seen.size > 500) seen.delete(seen.values().next().value);
      if (now - e.at > maxAgeMs || e.at - now > 5000) return false;
      const last = lastByKind.get(e.kind);
      if (last != null && now - last < cooldownMs) return false;
      active = active.filter((t) => t > now);
      if (active.length >= maxActive) return false;
      lastByKind.set(e.kind, now);
      active.push(now + effectDef(e.kind).duration);
      return true;
    },
    activeCount(now = Date.now()) { return active.filter((t) => t > now).length; },
  };
}

/** 送り手の連打対策（同じ演出は cooldown 以内なら発火しない） */
export function createCooldown(cooldownMs = EFFECT_COOLDOWN_MS) {
  const last = new Map();
  return (kind, now = Date.now()) => {
    const t = last.get(kind);
    if (t != null && now - t < cooldownMs) return false;
    last.set(kind, now);
    return true;
  };
}
