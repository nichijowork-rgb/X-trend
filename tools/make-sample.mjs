#!/usr/bin/env node
// サンプルデータ生成（決定的）: sample/posts.json と sample/summary.json を作る。
//
//   node tools/make-sample.mjs            # 既定 1,500 件 → sample/
//   node tools/make-sample.mjs 3000 /tmp/out   # 件数と出力先を指定（性能確認用）
//
// Node 22 標準モジュールのみ使用。乱数はシード固定（mulberry32）なので何度実行しても同じ結果になる。
// ユーザー名はすべて sample_ 始まりの架空、本文は「【サンプル】」で始まる。
// 検証用に以下を意図的に混ぜている:
//   - 未知カテゴリ「テスト新カテゴリ」（少数）
//   - 監視アカウント（is_watched=true）
//   - 本文が URL だけの投稿（→「その他」）
//   - 2016 年の古い投稿（数件）
//   - 改行・t.co 短縮 URL・matched_terms
//   - <script> / <img onerror> などを含む本文（XSS 検証）
//   - metrics の一部欠損（null・キー欠落・metrics 自体の欠落）、created_jst が null の投稿
//   - 任意フィールド media（写真 1〜4 枚・動画・GIF・mp4 無し動画・許可外ドメイン）

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COUNT = Number(process.argv[2]) || 1500;
const OUT = path.resolve(process.argv[3] || path.join(ROOT, 'sample'));

const GENERATED_AT = '2026-10-11T18:41:00+09:00';
const NEWEST_TS = Math.floor(Date.parse('2026-10-11T18:32:00+09:00') / 1000);
const CATEGORIES = ['ホスト', 'キャバクラ', '歌舞伎町', '夜職その他', '監視アカウント', 'その他', 'テスト新カテゴリ'];

// ---- 乱数（決定的）
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261011);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const tco = () => 'https://t.co/' + Array.from({ length: 10 }, () => pick(B62.split(''))).join('');

// ---- 架空アカウント
const USERS = [];
const prefixes = {
  'ホスト': ['host', 'hostclub', 'player'],
  'キャバクラ': ['cabajo', 'kyaba', 'lounge'],
  '歌舞伎町': ['kabuki', 'shinjuku', 'gourmet'],
  '夜職その他': ['night', 'girlsbar', 'concafe'],
};
const names = ['ryu', 'mio', 'kai', 'rina', 'sora', 'yuna', 'ren', 'aoi', 'hikaru', 'sakura', 'ten', 'nana', 'shin', 'mei', 'leo', 'luna', 'jin', 'emi', 'kaito', 'rei'];
let n = 0;
for (const [cat, ps] of Object.entries(prefixes)) {
  for (let i = 0; i < 26; i++) {
    n++;
    USERS.push({ user: `sample_${pick(ps)}_${pick(names)}${String(n).padStart(2, '0')}`, cat, watched: false, w: rnd() ** 2 * 10 + 0.3 });
  }
}
for (let i = 1; i <= 8; i++) {
  USERS.push({ user: `sample_watch_${String(i).padStart(2, '0')}`, cat: pick(Object.keys(prefixes)), watched: true, w: 4 + rnd() * 4 });
}
for (let i = 1; i <= 10; i++) {
  USERS.push({ user: `sample_misc_${String(i).padStart(2, '0')}`, cat: 'その他', watched: false, w: 1 });
}
const totalW = USERS.reduce((s, u) => s + u.w, 0);
function pickUser() {
  let r = rnd() * totalW;
  for (const u of USERS) { r -= u.w; if (r <= 0) return u; }
  return USERS[USERS.length - 1];
}

// ---- 本文の部品
const TERMS = {
  'ホスト': ['ホスト', 'シャンパンタワー', '指名', '売掛', '初回', 'ホストクラブ', '担当'],
  'キャバクラ': ['キャバクラ', 'キャバ嬢', '同伴', 'アフター', '体入', 'ラウンジ', '指名'],
  '歌舞伎町': ['歌舞伎町', 'トー横', '新宿', 'ゴジラロード', '一番街', '区役所通り'],
  '夜職その他': ['夜職', 'ガールズバー', 'コンカフェ', 'ナイトワーク', '源氏名', '出勤'],
};
const OPENERS = ['今日の', '週末の', '昨日の', '最近の', '今夜の', '月末の'];
const BODIES = [
  (t) => `${t}の話題をまとめてみた`,
  (t) => `${t}について気になったことメモ`,
  (t) => `${t}界隈のニュースを見かけた`,
  (t) => `${t}、混雑していたのでレポート`,
  (t) => `${t}の相場感についての雑談`,
  (t) => `${t}でイベント告知が出ていた`,
];
const TAILS = ['', '', '', ' #夜職', ' #歌舞伎町', '（続く）', ' 詳細はリンク先へ'];

function makeText(cats, terms) {
  const main = terms[0] || '雑談';
  let t = `【サンプル】${pick(OPENERS)}${pick(BODIES)(main)}${pick(TAILS)}`;
  if (terms[1]) t += `\n${terms[1]}も話題に。`;
  if (chance(0.35)) t += `\n\n${pick(['ちなみに', '補足：', 'PS.'])}${pick(['写真は後で', '感想どうぞ', 'また書きます'])}`;
  if (chance(0.4)) t += ` ${tco()}`;
  return t;
}

function lognormal(mu, sigma) {
  const u = Math.max(1e-9, rnd());
  const v = rnd();
  return Math.exp(mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
}

function makeMetrics(watched) {
  const imp = Math.round(lognormal(watched ? 9.2 : 7.6, 1.4));
  const like = Math.round(imp * (0.005 + rnd() * 0.04));
  return {
    impression_count: imp,
    like_count: like,
    retweet_count: Math.round(like * rnd() * 0.3),
    reply_count: Math.round(like * rnd() * 0.15),
    quote_count: Math.round(like * rnd() * 0.05),
    bookmark_count: Math.round(like * rnd() * 0.4),
  };
}

const JST = 9 * 3600;
function toJst(ts) {
  const d = new Date((ts + JST) * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+09:00`;
}
const dayKey = (ts) => toJst(ts).slice(0, 10);

// ---- 投稿生成
let idBase = 1844674407370955161n; // 2^53 を超える 19 桁 → 必ず文字列で扱う
const posts = [];
for (let i = 0; i < COUNT; i++) {
  const u = pickUser();
  // 直近ほど多い分布（約 75 日）
  const ageSec = Math.floor((rnd() ** 1.8) * 75 * 86400) + (i === 0 ? 0 : int(0, 600));
  const ts = NEWEST_TS - (i === 0 ? 0 : ageSec);
  let cats = [];
  let terms = [];
  if (u.cat === 'その他') {
    cats = ['その他'];
  } else {
    cats = [u.cat];
    terms = [pick(TERMS[u.cat])];
    if (chance(0.25)) {
      const other = pick(Object.keys(TERMS).filter((c) => c !== u.cat));
      cats.push(other);
      terms.push(pick(TERMS[other]));
    }
  }
  if (u.watched) cats.push('監視アカウント');
  const text = u.cat === 'その他' ? `【サンプル】${pick(['おはようございます', '今日は雨', 'ランチ何にしよう', '雑談です'])}` : makeText(cats, terms);
  posts.push({
    id: String(idBase - BigInt(i * 7919 + int(0, 7000))),
    url: '',
    user: u.user,
    created_jst: toJst(ts),
    ts,
    metrics: makeMetrics(u.watched),
    text,
    categories: [...new Set(cats)],
    matched_terms: [...new Set(terms)],
    is_watched: u.watched,
  });
}

// ---- 特殊ケースの上書き（位置は固定 → 決定的）
const special = (idx, patch) => { Object.assign(posts[idx], patch); };
// URL だけの本文 → その他（ラベル【サンプル】は付ける）
for (const idx of [3, 140, 600]) {
  special(idx, { text: `【サンプル】\n${tco()}`, categories: ['その他'], matched_terms: [] });
}
// 未知カテゴリ（少数）
for (const idx of [5, 77, 222, 480, 901]) {
  posts[idx].categories = [...new Set([...posts[idx].categories, 'テスト新カテゴリ'])];
  posts[idx].text += '\nテスト語彙を含む投稿';
  posts[idx].matched_terms = [...posts[idx].matched_terms, 'テスト語彙'];
}
// XSS 文字列
special(8, {
  text: '【サンプル】<script>alert("xss")</script> スクリプトタグ入りの本文 ホスト',
  categories: ['ホスト'], matched_terms: ['ホスト'],
});
special(9, {
  text: '【サンプル】<img src=x onerror="alert(1)"> 画像タグ入り\n"><svg onload=alert(2)> javascript:alert(3) キャバクラ',
  categories: ['キャバクラ'], matched_terms: ['キャバクラ'],
});
// metrics 欠損
special(2, { metrics: { impression_count: null, like_count: 12, retweet_count: 1, reply_count: 0, quote_count: 0, bookmark_count: null } });
special(11, { metrics: { like_count: 30, retweet_count: 2 } }); // キー欠落
special(14, { metrics: {} });
delete posts[17].metrics; // metrics 自体なし
for (let i = 30; i < COUNT; i += 97) posts[i].metrics.impression_count = null;
for (let i = 45; i < COUNT; i += 131) delete posts[i].metrics.bookmark_count;
// created_jst が null（ts から表示）
special(20, { created_jst: null });
// 数値表記確認用
posts[1].metrics.impression_count = 1155424;
posts[1].metrics.like_count = 12345;

// 2016 年などの古い投稿（数件）
const oldDates = ['2016-03-04T10:00:00+09:00', '2016-07-21T23:45:00+09:00', '2016-12-31T23:59:00+09:00', '2019-05-01T00:10:00+09:00'];
oldDates.forEach((iso, k) => {
  const idx = COUNT - 1 - k;
  const ts = Math.floor(Date.parse(iso) / 1000);
  special(idx, { ts, created_jst: toJst(ts), id: String(700000000000000000n + BigInt(k)), text: `【サンプル】昔の投稿（${iso.slice(0, 4)}年）が混ざるケース 歌舞伎町`, categories: ['歌舞伎町'], matched_terms: ['歌舞伎町'] });
});

// 添付メディア（任意フィールド media）。URL は架空（実在しない）→ 読み込み失敗時のプレースホルダ表示も確認できる
const PBS = 'https://pbs.twimg.com/media/SAMPLE_';
const photo = (name, alt = '') => ({ type: 'photo', url: `${PBS}${name}.jpg`, width: 1200, height: 800, alt_text: alt });
special(6, { media: [photo('ok_1', '【サンプル】店内の写真（架空）')] });
special(7, { media: [photo('ok_2a'), photo('ng_2b')] });
special(10, { media: [photo('ok_3a'), photo('ok_3b'), photo('ok_3c')] });
special(12, { media: [photo('ok_4a'), photo('ok_4b'), photo('ng_4c'), photo('ok_4d')] });
special(13, {
  media: [{
    type: 'video', preview_image_url: `${PBS}ok_video_thumb.jpg`, width: 1280, height: 720,
    variants: [
      { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/ext_tw_video/SAMPLE/pl/playlist.m3u8' },
      { content_type: 'video/mp4', bit_rate: 832000, url: 'https://video.twimg.com/ext_tw_video/SAMPLE/vid/640x360/low.mp4' },
      { content_type: 'video/mp4', bit_rate: 2176000, url: 'https://video.twimg.com/ext_tw_video/SAMPLE/vid/1280x720/high.mp4' },
    ],
  }],
});
special(15, {
  media: [{
    type: 'animated_gif', preview_image_url: `${PBS}ok_gif_thumb.jpg`,
    variants: [{ content_type: 'video/mp4', bit_rate: 0, url: 'https://video.twimg.com/tweet_video/SAMPLE_gif.mp4' }],
  }],
});
// mp4 が無い動画 →「Xで再生」
special(16, { media: [{ type: 'video', preview_image_url: `${PBS}ng_video2_thumb.jpg`, variants: [{ content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/SAMPLE/pl.m3u8' }] }] });
// 許可外ドメイン・http は表示しない（このメディアは全て捨てられる）
special(18, {
  media: [
    { type: 'photo', url: 'https://evil.example.com/sample.jpg' },
    { type: 'photo', url: 'http://pbs.twimg.com/media/SAMPLE_http.jpg' },
    { type: 'video', preview_image_url: 'javascript:alert(1)', variants: [{ content_type: 'video/mp4', url: 'https://video.twimg.com.evil.example/x.mp4' }] },
  ],
});

for (const p of posts) p.url = `https://x.com/${p.user}/status/${p.id}`;
posts.sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1));

// ---- summary.json
const get = (p, k) => (p.metrics && typeof p.metrics[k] === 'number' ? p.metrics[k] : 0);
const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, { posts: 0, impressions: 0, likes: 0 }]));
const byAccount = new Map();
const byDay = new Map();
for (const p of posts) {
  for (const c of p.categories) {
    byCategory[c].posts++;
    byCategory[c].impressions += get(p, 'impression_count');
    byCategory[c].likes += get(p, 'like_count');
  }
  const a = byAccount.get(p.user) || { user: p.user, is_watched: p.is_watched, posts: 0, impressions: 0, likes: 0 };
  a.posts++; a.impressions += get(p, 'impression_count'); a.likes += get(p, 'like_count');
  byAccount.set(p.user, a);
  const k = dayKey(p.ts);
  const d = byDay.get(k) || { date: k, posts: 0, impressions: 0, likes: 0, categories: {} };
  d.posts++; d.impressions += get(p, 'impression_count'); d.likes += get(p, 'like_count');
  for (const c of p.categories) d.categories[c] = (d.categories[c] || 0) + 1;
  byDay.set(k, d);
}
const slim = (p) => ({ id: p.id, url: p.url, user: p.user, created_jst: p.created_jst, ts: p.ts, metrics: p.metrics, text: p.text, categories: p.categories });
const topBy = (k) => posts.filter((p) => p.metrics && typeof p.metrics[k] === 'number').sort((a, b) => b.metrics[k] - a.metrics[k]).slice(0, 20).map(slim);
const sortedTs = posts.map((p) => p.ts).sort((a, b) => a - b);
const summary = {
  generated_at: GENERATED_AT,
  total_posts: posts.length,
  total_accounts: byAccount.size,
  period: { oldest_jst: toJst(sortedTs[0]), newest_jst: toJst(sortedTs[sortedTs.length - 1]) },
  by_category: byCategory,
  by_account: [...byAccount.values()].sort((a, b) => b.posts - a.posts || b.impressions - a.impressions),
  by_day: [...byDay.values()].sort((a, b) => (a.date < b.date ? 1 : -1)),
  top_posts: { by_impressions: topBy('impression_count'), by_likes: topBy('like_count') },
};

mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, 'posts.json'), JSON.stringify({ generated_at: GENERATED_AT, categories: CATEGORIES, posts }, null, 1) + '\n');
writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1) + '\n');
console.log(`wrote ${posts.length} posts → ${path.relative(process.cwd(), OUT) || OUT}`);
