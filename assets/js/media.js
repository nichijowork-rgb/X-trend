// 添付メディア（写真・動画・GIF）の表示。URL は core.sanitizeMedia で
// https://pbs.twimg.com / https://video.twimg.com のみに絞り込み済み。
import { isAllowedMediaUrl, isSafeHttpUrl } from './core.js';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function placeholder(text) {
  const p = el('span', 'media-ph', text);
  p.setAttribute('role', 'img');
  p.setAttribute('aria-label', text);
  return p;
}

// ---------------------------------------------------------------- ライトボックス

let lightbox = null;

function getLightbox() {
  if (lightbox) return lightbox;
  const dlg = document.getElementById('lightbox');
  const img = dlg.querySelector('img');
  const cap = dlg.querySelector('.lb-caption');
  const close = dlg.querySelector('.lb-close');
  close.addEventListener('click', () => dlg.close());
  // 背景（画像の外）クリックで閉じる。Esc は dialog 標準で閉じる
  dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target.classList.contains('lb-body')) dlg.close(); });
  dlg.addEventListener('close', () => { img.removeAttribute('src'); img.hidden = false; dlg.querySelector('.lb-error').hidden = true; });
  img.addEventListener('error', () => { if (img.getAttribute('src')) { img.hidden = true; dlg.querySelector('.lb-error').hidden = false; } });
  lightbox = { dlg, img, cap };
  return lightbox;
}

export function openLightbox(url, alt) {
  if (!isAllowedMediaUrl(url)) return;
  const lb = getLightbox();
  lb.img.hidden = false;
  lb.img.alt = alt || '添付画像';
  lb.img.src = url;
  lb.cap.textContent = alt || '';
  lb.cap.hidden = !alt;
  if (typeof lb.dlg.showModal === 'function') lb.dlg.showModal();
  else lb.dlg.setAttribute('open', '');
}

// ---------------------------------------------------------------- 描画

/** pbs.twimg.com の画像を指定サイズ（small≒680px / large≒2048px）で取得する URL に変える。それ以外はそのまま */
export function sizedImageUrl(url, size) {
  try {
    const u = new URL(url);
    if (u.hostname !== 'pbs.twimg.com') return url;
    const ext = /\.(jpe?g|png|webp)$/i.exec(u.pathname);
    if (ext) { u.pathname = u.pathname.slice(0, -ext[0].length); u.searchParams.set('format', ext[1].toLowerCase() === 'jpeg' ? 'jpg' : ext[1].toLowerCase()); }
    u.searchParams.set('name', size);
    return u.toString();
  } catch {
    return url;
  }
}

function photoThumb(m, i, total) {
  const b = el('button', 'media-thumb');
  b.type = 'button';
  const alt = m.alt || `添付画像 ${i + 1}/${total}`;
  b.setAttribute('aria-label', `画像を拡大: ${alt}`);
  const img = el('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = alt;
  img.referrerPolicy = 'no-referrer';
  if (m.width && m.height) { img.width = m.width; img.height = m.height; }
  img.addEventListener('error', () => {
    b.classList.add('is-broken');
    b.disabled = true;
    b.setAttribute('aria-label', '画像を読み込めませんでした');
    img.replaceWith(placeholder('画像を読み込めませんでした'));
  }, { once: true });
  img.src = sizedImageUrl(m.url, 'small');
  b.append(img);
  b.addEventListener('click', () => { if (!b.classList.contains('is-broken')) openLightbox(sizedImageUrl(m.url, 'large'), m.alt); });
  return b;
}

function videoBlock(m, postUrl) {
  const isGif = m.type === 'animated_gif';
  const wrap = el('div', 'media-video');
  const label = isGif ? 'GIF' : '動画';
  const poster = () => {
    if (!m.preview) return placeholder(`${label}（プレビューなし）`);
    const img = el('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = m.alt || `${label}のプレビュー`;
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => img.replaceWith(placeholder(`${label}のプレビューを読み込めませんでした`)), { once: true });
    img.src = sizedImageUrl(m.preview, 'small');
    return img;
  };
  if (!m.video) {
    // mp4 が無い → X で再生
    const a = el('a', 'media-play');
    if (isSafeHttpUrl(postUrl)) {
      a.href = postUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    a.append(poster(), el('span', 'play-badge', `Xで再生 ↗`));
    a.setAttribute('aria-label', `${label}をXで再生（新しいタブ）`);
    wrap.append(a);
    return wrap;
  }
  const btn = el('button', 'media-play');
  btn.type = 'button';
  btn.setAttribute('aria-label', `${label}を再生`);
  btn.append(poster(), el('span', 'play-badge', `▶ ${label}を再生`));
  btn.addEventListener('click', () => {
    const v = el('video', 'media-player');
    v.controls = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.preload = 'none';
    if (isGif) { v.loop = true; v.muted = true; }
    if (m.preview) v.poster = m.preview;
    v.addEventListener('error', () => {
      const box = el('div', 'media-ph media-ph-row');
      box.append(document.createTextNode(`${label}を読み込めませんでした`));
      if (isSafeHttpUrl(postUrl)) {
        const a = el('a', null, 'Xで再生 ↗');
        a.href = postUrl;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        box.append(document.createTextNode(' '), a);
      }
      v.replaceWith(box);
    }, { once: true });
    v.src = m.video;
    btn.replaceWith(v);
    const pr = v.play();
    if (pr && typeof pr.catch === 'function') pr.catch(() => {});
  });
  wrap.append(btn);
  return wrap;
}

/** media 配列 → 要素（無ければ null） */
export function renderMedia(media, postUrl) {
  if (!Array.isArray(media) || !media.length) return null;
  const box = el('div', 'media');
  const photos = media.filter((m) => m.type === 'photo');
  if (photos.length) {
    const grid = el('div', `media-grid n${photos.length}`);
    photos.forEach((m, i) => grid.append(photoThumb(m, i, photos.length)));
    box.append(grid);
  }
  for (const m of media) if (m.type !== 'photo') box.append(videoBlock(m, postUrl));
  return box;
}
