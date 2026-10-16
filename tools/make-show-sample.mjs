#!/usr/bin/env node
// 番組サイト（/show/）用のサンプルデータ生成（決定的）: sample/show/ に posts.json・reports.json・bookmarks.json を作る。
//
//   node tools/make-show-sample.mjs              # → sample/show/
//   node tools/make-show-sample.mjs /tmp/out     # 出力先を指定（data/ には出さないこと）
//
// ダッシュボード用の sample/*.json とは別ファイル（ダッシュボードのテストに影響させないため）。
// 番組週（前週 土 1:00 〜 土 1:00）が埋まるよう generated_at を金曜 0:09 にし、
// 話題辞書でまとまる投稿（ホストコール・シャンパンタワー・生誕祭・トー横）、データ側の話題名（topic:）、
// 本文が似ている投稿、同じアカウントの投稿、@で関係者に言及した投稿、ばらばらの1件投稿、前週の投稿を含む。
// 検証用に <img onerror> を含む本文、表示数の欠損、写真（pbs.twimg.com の SAMPLE_ok_）も混ぜる。
// bookmarks.json（日時あり・null・前週・posts.json に無い id）と in_bookmarks / below_threshold 付きの投稿も作る。
// ユーザー名はすべて sample_ 始まりの架空、本文の末尾に「（サンプル）」を付ける（話題名が読みやすいよう先頭には付けない）。

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'sample', 'show'));

const GENERATED_AT = '2026-10-16T00:09:00+09:00';
const REF = Math.floor(Date.parse(GENERATED_AT) / 1000);
const WEEK_START = Math.floor(Date.parse('2026-10-10T01:00:00+09:00') / 1000);
const PREV_START = WEEK_START - 7 * 86400;

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
const rnd = mulberry32(20261016);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const JST = 9 * 3600;
function toJst(ts) {
  const d = new Date((ts + JST) * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+09:00`;
}

function metrics(scale = 1) {
  const imp = Math.round(Math.exp(9.5 + rnd() * 2.6) * scale);
  const like = Math.round(imp * (0.005 + rnd() * 0.03));
  return {
    impression_count: imp,
    like_count: like,
    retweet_count: Math.round(like * rnd() * 0.3),
    reply_count: Math.round(like * rnd() * 0.15),
    quote_count: Math.round(like * rnd() * 0.05),
    bookmark_count: Math.round(like * rnd() * 0.4),
  };
}

const posts = [];
let seq = 0;
function post({ user, text, cats, terms = [], ts, scale = 1, extra = {} }) {
  seq++;
  const t = ts ?? (WEEK_START + int(3600, REF - WEEK_START - 600));
  const id = String(2110000000000000000n + BigInt(t) * 1000n + BigInt(seq));
  const p = {
    id,
    url: `https://x.com/${user}/status/${id}`,
    user,
    created_jst: toJst(t),
    ts: t,
    metrics: metrics(scale),
    text: `${text}（サンプル）`,
    categories: cats,
    matched_terms: terms,
    is_watched: false,
    ...extra,
  };
  posts.push(p);
  return p;
}

// ---- 1. ホストコール（辞書: シャンパンコール／コール／ラスソン／マイク）
const hostcall = [
  'シャンパンコールの新しい掛け声が店ごとに違いすぎて面白い',
  '初めてラスソン聴いたけど担当の歌が本気すぎて笑った',
  'ホストコールの動画が切り抜かれてまた拡散されてる',
  'マイク持った瞬間に空気が変わるの、あれは才能だと思う',
  'コール中に新人くんが噛んで全員で拾ってたのが良かった',
  '昨日のシャンパンコール、3分超えの大作でした',
  'ラスソン争いがある店は月末がすごいことになる',
  'コールの作り方を教えてくれる先輩ホストの配信が人気らしい',
];
hostcall.forEach((t, i) => post({ user: `sample_host_${['kai', 'ren', 'shin', 'jin'][i % 4]}${10 + i}`, text: t, cats: ['ホスト'], terms: ['ホスト'], scale: i === 2 ? 6 : 1.4 }));

// ---- 2. シャンパンタワー
['誕生日のシャンパンタワー、5段で写真映えがすごい', '今月のシャンパンタワー件数ランキングが発表されてた', 'シャンパンタワーの値段を真面目に計算してみた', 'タワー前の準備動画がバズっていた'].forEach((t, i) =>
  post({ user: `sample_hostclub_${['sora', 'leo', 'ten', 'rei'][i]}${20 + i}`, text: t, cats: ['ホスト'], terms: ['シャンパンタワー'], scale: 1.2 }));

// ---- 3. データ側の話題名（topic:）
['サンプル王子さんが今月で引退すると発表、驚きの声', 'サンプル王子さんのラストイベントの日程が出た', 'サンプル王子さんの引退理由についてのインタビュー', 'サンプル王子さん、最後の営業日に行列', 'サンプル王子さんの後輩たちがメッセージ動画'].forEach((t, i) =>
  post({ user: `sample_player_${['hikaru', 'kaito', 'aoi', 'ryu', 'emi'][i]}${30 + i}`, text: t, cats: ['ホスト'], terms: ['サンプル王子', 'quote:ホスト', `topic:サンプル王子さんの引退`], scale: i === 0 ? 9 : 2 }));

// ---- 4. 生誕祭（キャバクラ）
['生誕祭のお花が通りまで並んでいて圧巻', 'バースデーのイベントで着るドレスを3着から迷っている', '生誕祭の売上目標を公開したキャスト、応援コメントが殺到', '周年イベントで店内が全部ピンクになっていた', '生誕祭の準備でネイルを新しくした', '生誕祭終わりの片付け動画が意外と人気'].forEach((t, i) =>
  post({ user: `sample_cabajo_${['mio', 'yuna', 'rina', 'nana', 'mei', 'luna'][i]}${40 + i}`, text: t, cats: ['キャバクラ'], terms: ['キャバ嬢'], scale: i === 2 ? 5 : 1.3,
    extra: i === 0 ? { media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/SAMPLE_ok_flower.jpg', width: 1200, height: 800, alt_text: 'お花のサンプル画像' }] } : {} }));

// ---- 5. トー横（歌舞伎町）
['トー横の広場に新しい案内看板ができた', 'ゴジラロードの深夜の人通りが増えている気がする', 'トー横周辺の見回りが強化されたというニュース', 'トー横の若者支援の窓口が開設されたらしい', 'トー横の話題が朝の情報番組で取り上げられていた'].forEach((t, i) =>
  post({ user: `sample_kabuki_${['ryu', 'sora', 'aoi', 'mei', 'jin'][i]}${50 + i}`, text: t, cats: ['歌舞伎町'], terms: ['歌舞伎町'], scale: i === 2 ? 4 : 1.1 }));

// ---- 6. 本文が似ている投稿（辞書に無い → 類似まとめ）
['歌舞伎町の新しいラーメン店「麺屋サンプル」に深夜でも行列ができている', '麺屋サンプルの深夜の行列がすごい、歌舞伎町の新しいラーメン店', '歌舞伎町にできたラーメン店「麺屋サンプル」深夜の行列に並んできた', '深夜の歌舞伎町、ラーメン店「麺屋サンプル」の行列が伸びていた'].forEach((t, i) =>
  post({ user: `sample_gourmet_${['kai', 'nana', 'leo', 'rei'][i]}${60 + i}`, text: t, cats: ['歌舞伎町'], terms: ['歌舞伎町'], scale: 1.6 }));
['新作ゲーム「サンプルクエスト」が発売初日に売り切れ続出', 'サンプルクエストの新作が発売初日に売り切れ、ゲーム店に行列', '発売初日に売り切れた新作ゲーム「サンプルクエスト」の転売に注意'].forEach((t, i) =>
  post({ user: `sample_misc_${10 + i}`, text: t, cats: ['その他'], scale: 3 }));

// ---- 7. 同じアカウントの投稿（夜職。辞書に無い言葉）
['今週の出勤は水木金です、よろしくお願いします', '新しい名刺のデザインが届いた、紫にしてみた', '常連さんから手作りのお菓子をもらって泣いた', '来月から系列の新店舗に異動になります'].forEach((t) =>
  post({ user: 'sample_night_sakura77', text: t, cats: ['夜職その他'], terms: ['夜職'], scale: 0.9 }));

// ---- 8. 関係者（@言及）
post({ user: 'sample_emi88', text: '新しいラウンジを開店しました、内装にこだわっています', cats: ['キャバクラ'], terms: ['ラウンジ'], scale: 1.5 });
post({ user: 'sample_sumire89', text: '@sample_emi88 さんの新店に遊びに行ってきた、照明がとても綺麗', cats: ['キャバクラ'], terms: ['ラウンジ'], scale: 1.2 });

// ---- 9. XSS・欠損・メディア
post({ user: 'sample_host_xss01', text: '<img src=x onerror="alert(1)"> 画像タグ入りの本文 ホストの話', cats: ['ホスト'], terms: ['ホスト'], scale: 0.8 });
const miss = post({ user: 'sample_night_miss02', text: '表示数が不明な投稿のサンプル、ガールズバーの体験談', cats: ['夜職その他'], terms: ['ガールズバー'] });
miss.metrics = { impression_count: null, like_count: 12, retweet_count: null, reply_count: 1, quote_count: 0, bookmark_count: null };

// ---- 10. ばらばらの1件投稿（単独の話題）
const SINGLES = [
  '同伴の待ち合わせ場所で毎回迷う', 'アフターで行く焼肉屋の新規開拓', '体入初日に覚えることリスト', '指名替えのルールって店ごとに違う',
  '源氏名を決めるときに画数を気にした', '送りの車でかかっていた曲がよかった', '名刺の紙質にこだわり始めた', '新人研修で教わった乾杯の作法',
  '寮生活は思ったより快適', '給料日前の財布事情', '終電を逃したときの過ごし方', '仕事終わりの朝ごはんは牛丼派',
  '香水を変えたら気づいてもらえた', 'ヘアメイクさんの予約が取れない', 'ヒールで靴擦れした日の対処法', '腕時計の話で太客と盛り上がった',
  '日焼け止めを塗り忘れて後悔', '店の近くの占い師がよく当たる', '筋トレを始めて体力がついた', '控室に観葉植物を置いたら好評',
  'ドレスのレンタルと購入どっちが得か', '営業LINEの返信速度について', '担当替えをお願いするか悩み中', 'まつエクの持ちが季節で違う',
  '出勤前の仮眠は20分がベスト', '確定申告の準備を今から始める', '店のBGMが急にジャズになった', '誕生日は家でゆっくりしたい派', 'ノンアルのカクテルが充実してきた', '終礼で褒められてうれしかった',
];
const NIGHT = [['ホスト', 'ホスト'], ['キャバクラ', 'キャバ嬢'], ['歌舞伎町', '歌舞伎町'], ['夜職その他', '夜職']];
SINGLES.forEach((s, i) => {
  const [cat, term] = NIGHT[i % 4];
  post({ user: `sample_${['night', 'kyaba', 'host', 'kabuki'][i % 4]}_u${100 + i}`, text: s, cats: [cat], terms: [term], scale: 0.6 + rnd() });
});
const GEN = ['今日の空がきれい', '駅のホームで傘を忘れた', 'コンビニの新作スイーツが当たり', '猫が布団から出てこない', '電車で隣の人の音漏れ', '久しぶりに映画館に行った', '自炊の味噌汁がうまくできた', '推しのライブの抽選に外れた', '雨の日の洗濯物問題', 'ランチの店が満席だった', '新しいスニーカーを買った', '週末の天気が心配'];
GEN.forEach((t, i) => post({ user: `sample_misc_${30 + i}`, text: t, cats: ['その他'], scale: 0.7 + rnd() * 2 }));

// ---- 11. 前週の投稿（週の切り替え確認用）
for (let i = 0; i < 40; i++) {
  const ts = PREV_START + int(3600, 7 * 86400 - 3600);
  const [cat, term] = pick(NIGHT);
  post({ user: `sample_prev_${i % 9}`, text: `先週の話：${SINGLES[(i * 7) % SINGLES.length]}（その${i + 1}）`, cats: [cat], terms: [term], ts, scale: 0.8 });
}
post({ user: 'sample_host_prev_call', text: '先週のシャンパンコール大会の結果まとめ', cats: ['ホスト'], terms: ['ホスト'], ts: PREV_START + 3 * 86400 });

// 新しい順
posts.sort((a, b) => b.ts - a.ts);

const inWeek = posts.filter((p) => p.ts >= WEEK_START);

// ブックマーク（データ側botの形式。並びは新しくブックマークした順。bookmarked_at は null のことがある）
// ブックマークした投稿は posts.json に in_bookmarks: true（表示数が基準未満なら below_threshold: true も）で入る
const lowPost = post({ user: 'sample_bm_low', text: '小さな店の名物ママの話がしみた', cats: ['夜職その他'], terms: ['夜職'], scale: 0.05, ts: WEEK_START + 2 * 86400 });
const prevPost = posts.find((p) => p.ts < WEEK_START);
const bmTargets = [
  { p: inWeek[5], at: '2026-10-15T23:10:00+09:00' },
  { p: inWeek[12], at: null }, // 日時なし → 投稿日時で今週
  { p: lowPost, at: '2026-10-14T08:00:00+09:00' },
  { p: prevPost, at: null }, // 日時なし・投稿は前週 → 「すべて」でだけ見える
  { p: inWeek[20], at: '2026-10-08T12:00:00+09:00' }, // 前週にブックマーク
];
for (const { p } of bmTargets) {
  p.in_bookmarks = true;
  if (p === lowPost) p.below_threshold = true;
}
posts.sort((a, b) => b.ts - a.ts);
const bookmarks = {
  generated_at: GENERATED_AT,
  bookmarks: [
    { id: '1999999999999999999', url: 'https://x.com/sample_unknown/status/1999999999999999999', bookmarked_at: '2026-10-15T08:00:00+09:00' },
    ...bmTargets.map(({ p, at }) => ({ id: p.id, url: `https://x.com/${p.user}/status/${p.id}`, bookmarked_at: at })),
  ],
};

const reports = {
  generated_at: GENERATED_AT,
  daily: [
    {
      date: '2026-10-15',
      rising: [{ id: inWeek[0].id, views: 382000, hours_since_post: 3, views_per_hour: 127333, condition_label: '投稿から6時間以内で30万表示以上' }],
      review: [{ id: inWeek[1].id, before_views: 320000, after_views: 610000, crossed_500k: true }],
      hit_rate: [{ condition_label: '投稿から6時間以内で30万表示以上', total: 4, crossed: 3 }],
    },
  ],
  weekly: [
    {
      period: { from: '2026-10-10', to: '2026-10-16' },
      generated_at: GENERATED_AT,
      hit_rate_by_condition: [
        { condition_label: '投稿から6時間以内で30万表示以上', total: 12, crossed: 8 },
        { condition_label: '投稿から3時間以内で10万表示以上', total: 20, crossed: 7 },
      ],
      hit_rate_by_pace: [{ pace_label: '1時間あたり10万以上', total: 6, crossed: 5 }],
      threshold_proposal: '（サンプル）3時間以内の基準を10万→12万に上げる案',
      watch_candidates: [{ user: 'sample_host_kai10', reason: '（サンプル）コール動画が連続で伸びている' }],
    },
  ],
};

mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, 'posts.json'), JSON.stringify({ generated_at: GENERATED_AT, categories: ['ホスト', 'キャバクラ', '歌舞伎町', '夜職その他', '監視アカウント', 'その他'], posts }, null, 1) + '\n');
writeFileSync(path.join(OUT, 'reports.json'), JSON.stringify(reports, null, 1) + '\n');
writeFileSync(path.join(OUT, 'bookmarks.json'), JSON.stringify(bookmarks, null, 1) + '\n');
const ids = posts.map((p) => p.id);
console.log(`wrote ${posts.length} posts (${inWeek.length} in week) → ${OUT} (ids unique: ${new Set(ids).size === ids.length})`);
