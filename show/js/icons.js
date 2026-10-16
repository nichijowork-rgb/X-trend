// ジャンル・コーナーのマーク（シンプルな図形）。
// キャラクターに差し替えるときは ICONS の値を { img: '画像のパス' } にすると <img> で表示する
// （例: host: { img: 'img/host.png' }。画像は show/ からの相対パス・自サイト内に置く）。

const SVG_NS = 'http://www.w3.org/2000/svg';

export const ICONS = {
  // メイン: 星形のバースト
  main: { path: 'M12 1.5l2.6 5.6 6.1-.9-3.9 4.8 3.9 4.8-6.1-.9L12 20.5l-2.6-5.6-6.1.9 3.9-4.8-3.9-4.8 6.1.9z' },
  // ホスト: 王冠
  host: { path: 'M3 18h18l1-10-5.5 4L12 4 7.5 12 2 8z' },
  // キャバクラ: ハート
  kyaba: { path: 'M12 21s-8.5-5.3-8.5-11.2A4.8 4.8 0 0 1 12 6.7a4.8 4.8 0 0 1 8.5 3.1C20.5 15.7 12 21 12 21z' },
  // 歌舞伎町: ひし形
  kabuki: { path: 'M12 2l9 10-9 10-9-10z' },
  // 夜職その他: 三日月
  night: { path: 'M15.5 2.5a9.5 9.5 0 1 0 6 16.9A8 8 0 0 1 15.5 2.5z' },
  // 一般のバズ: 花
  general: { path: 'M12 2a3.2 3.2 0 0 1 3 4.3 3.2 3.2 0 1 1 3.2 5.7 3.2 3.2 0 1 1-1.9 5.4A3.2 3.2 0 1 1 12 19.5a3.2 3.2 0 1 1-4.3-2.1 3.2 3.2 0 1 1-1.9-5.4A3.2 3.2 0 1 1 9 6.3 3.2 3.2 0 0 1 12 2zm0 7.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z' },
  // 答え合わせ: チェック
  review: { path: 'M9.5 16.2L4.8 11.5 3 13.3l6.5 6.5L21 8.3l-1.8-1.8z' },
  // オープニング・中休み・エンディング: 吹き出し
  white: { path: 'M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H10l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z' },
};

/** マークの要素（装飾なので aria-hidden） */
export function genreIcon(key) {
  const def = ICONS[key] || ICONS.white;
  if (def.img) {
    const img = document.createElement('img');
    img.src = def.img;
    img.alt = '';
    img.className = 'icon';
    img.setAttribute('aria-hidden', 'true');
    return img;
  }
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', def.path);
  p.setAttribute('fill', 'currentColor');
  p.setAttribute('fill-rule', 'evenodd');
  svg.append(p);
  return svg;
}
