// 自分で追加する画像の縮小（段階: 進行の改修）。サイズの決め方は DOM 非依存（node:test から import される）。
// 実際の縮小（canvas）は encode 関数を外から渡す（ブラウザでは canvasEncoder）。
//  - 保存用: 長辺 1600px・1 枚 1MB まで（IndexedDB）
//  - OBS 用: 長辺 1280px・data URL で 1.5MB 未満（obs-websocket の 1 メッセージに収める）

export const IMAGE_LIMITS = Object.freeze({
  storeSide: 1600,
  storeBytes: 1000 * 1000,
  obsSide: 1280,
  obsDataUrl: 1500 * 1000, // data URL の文字数（ほぼバイト数）
  sourceBytes: 30 * 1000 * 1000, // 元のファイルの上限
  minSide: 200,
});

const QUALITIES = [0.86, 0.76, 0.66, 0.56, 0.46];

/** 長辺を max 以下に（縦横比を保つ。小さければそのまま） */
export function fitSize(w, h, max) {
  if (!(w > 0 && h > 0)) return { w: 0, h: 0 };
  const s = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/** 画像として受け付けるファイルか。返り値: null（OK）か 日本語の理由 */
export function checkImageFile(file) {
  if (!file) return '画像が見つかりません';
  const type = String(file.type || '');
  if (!/^image\/(png|jpeg|jpg|webp|gif|bmp|avif)$/.test(type)) return `画像ファイル（PNG・JPEG・WebP など）を選んでください（${type || '種類不明'}）`;
  if (file.size > IMAGE_LIMITS.sourceBytes) return `画像が大きすぎます（${Math.round(file.size / 1e6)}MB。${IMAGE_LIMITS.sourceBytes / 1e6}MB まで）`;
  return null;
}

/**
 * 縮小して上限に収める。src: { w, h, type }、limit: { maxSide, maxBytes }、
 * encode(w, h, type, quality) → Promise<{ bytes, data }>（data は Blob か data URL）。
 * PNG は PNG のまま試し、大きければ JPEG に。JPEG は画質を下げ、それでも大きければ寸法を 0.8 倍ずつ。
 * 返り値: { w, h, type, quality, bytes, data }。どうしても収まらなければ例外（日本語）
 */
export async function shrinkImage(src, limit, encode) {
  let { w, h } = fitSize(src.w, src.h, limit.maxSide);
  if (!w || !h) throw new Error('画像の大きさが読めませんでした');
  for (let round = 0; round < 8; round++) {
    if (src.type === 'image/png') {
      const r = await encode(w, h, 'image/png', null);
      if (r && r.bytes <= limit.maxBytes) return { w, h, type: 'image/png', quality: null, bytes: r.bytes, data: r.data };
    }
    for (const q of QUALITIES) {
      const r = await encode(w, h, 'image/jpeg', q);
      if (r && r.bytes <= limit.maxBytes) return { w, h, type: 'image/jpeg', quality: q, bytes: r.bytes, data: r.data };
    }
    if (Math.max(w, h) * 0.8 < IMAGE_LIMITS.minSide) break;
    w = Math.max(1, Math.round(w * 0.8));
    h = Math.max(1, Math.round(h * 0.8));
  }
  throw new Error('画像を小さくできませんでした（別の画像を試してください）');
}

/** data URL として正しい画像か（OBS 側の確認用） */
export function validImageDataUrl(s) {
  return typeof s === 'string' && s.length <= IMAGE_LIMITS.obsDataUrl + 100 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s);
}

/** 文字列の SHA-256（16 進の先頭 16 文字）。画像の同一判定に使う */
export async function shortHash(text, subtle = globalThis.crypto && globalThis.crypto.subtle) {
  if (subtle) {
    const buf = await subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let h1 = 0x811c9dc5;
  let h2 = 0x9747b28c;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0; h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0; }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** 画像 id（英小文字と数字） */
export function newImageId(now = Date.now()) {
  return `${Math.floor(now).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------- ブラウザ用（canvas）

/** File/Blob → { bitmap, w, h }（ブラウザのみ） */
export async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try { const b = await createImageBitmap(file); return { source: b, w: b.width, h: b.height }; } catch { /* 下へ */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { source: img, w: img.naturalWidth, h: img.naturalHeight };
  } catch {
    throw new Error('画像を読めませんでした（壊れているか、対応していない形式です）');
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** canvas で縮小して Blob か data URL にする encode 関数を作る（as: 'blob' | 'dataurl'） */
export function canvasEncoder(source, as = 'blob') {
  return async (w, h, type, quality) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (type === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); }
    ctx.drawImage(source, 0, 0, w, h);
    if (as === 'dataurl') {
      const data = c.toDataURL(type, quality ?? undefined);
      return { bytes: data.length, data };
    }
    const blob = await new Promise((resolve) => c.toBlob(resolve, type, quality ?? undefined));
    if (!blob) return null;
    return { bytes: blob.size, data: blob };
  };
}
