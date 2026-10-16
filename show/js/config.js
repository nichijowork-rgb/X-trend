// 配信番組サイト（/show/）の設定。運用で変わる値・文言はここに集める。
// DOM 非依存（node:test からも import される）。

/** 番組の既定値 */
export const SHOW_DEFAULTS = Object.freeze({
  showName: '週刊ヨルニュース',
  /** 配信: 毎週 土曜 1:00（JST） */
  broadcast: Object.freeze({ weekday: 6, hour: 1, minute: 0 }), // weekday: 0=日 … 6=土
  totalMinutes: 90,
  /** 進行の押し・巻きを「予定どおり」とみなす幅（秒） */
  driftToleranceSec: 60,
});

/** 事前確認（チェックポイント）。ラベルは画面表示用 */
export const CHECKPOINTS = Object.freeze([
  Object.freeze({ kind: 'preview', label: '下見', when: '金 1:00' }),
  Object.freeze({ kind: 'final', label: '最終確認', when: '金 22:00' }),
]);

/**
 * ジャンル（話題の色分け）。cats はデータのカテゴリ名。
 * 色は show.css の --g-<key> と --g-<key>-ink に対応（コントラスト AA 確認済み）。
 */
export const GENRES = Object.freeze([
  Object.freeze({ key: 'host', label: 'ホスト', cats: Object.freeze(['ホスト']) }),
  Object.freeze({ key: 'kyaba', label: 'キャバクラ', cats: Object.freeze(['キャバクラ']) }),
  Object.freeze({ key: 'kabuki', label: '歌舞伎町', cats: Object.freeze(['歌舞伎町']) }),
  Object.freeze({ key: 'night', label: '夜職その他', cats: Object.freeze(['夜職その他']) }),
  Object.freeze({ key: 'general', label: '一般のバズ', cats: Object.freeze(['その他']) }),
]);
export const GENRE_KEYS = Object.freeze(GENRES.map((g) => g.key));
export const NIGHT_GENRES = Object.freeze(['host', 'kyaba', 'kabuki', 'night']);

/**
 * 番組構成（既定）。kind:
 *  talk   … 話題を入れないコーナー（オープニング・中休み・エンディング）
 *  main   … メイン（最大 maxItems 本）
 *  news   … 話題を入れるコーナー
 *  review … 今週の答え合わせ（reports.json weekly）
 * color はコーナー自体の色（news で話題が入っているときは話題のジャンル色）。
 */
export const CORNERS = Object.freeze([
  Object.freeze({ key: 'opening', name: 'オープニング', sub: 'タイトルコール・3大ニュース予告', min: 5, color: 'white', kind: 'talk' }),
  Object.freeze({ key: 'main', name: 'メイン3トピック', sub: '各約11分', min: 35, color: 'main', kind: 'main', maxItems: 3 }),
  Object.freeze({ key: 'break', name: '中休み', sub: 'コメント・告知', min: 5, color: 'white', kind: 'talk' }),
  Object.freeze({ key: 'category', name: 'カテゴリ別ニュース', sub: 'ホスト／キャバクラ／歌舞伎町／夜職その他', min: 25, color: 'night', kind: 'news' }),
  Object.freeze({ key: 'chat', name: '雑談', sub: '一般のバズ', min: 10, color: 'general', kind: 'news' }),
  Object.freeze({ key: 'review', name: '今週の答え合わせ', sub: '伸びる予想は当たった？', min: 5, color: 'review', kind: 'review' }),
  Object.freeze({ key: 'ending', name: 'エンディング', sub: 'まとめ・来週へ持ち越し', min: 5, color: 'white', kind: 'talk' }),
]);

/**
 * 話題辞書の初期値。words: 本文・根拠語に含まれる言葉、people: 店名・源氏名・@アカウント。
 * nightOnly: true なら夜職4カテゴリの投稿にだけ当てる（「卒業」「引退」など一般の話題にも出る言葉のため）。
 * カタカナで始まる（終わる）言葉は、前（後ろ）がカタカナのときは一致とみなさない
 * （例:「コール」は「アルコール」に一致しない）。
 */
export const DEFAULT_DICT = Object.freeze([
  { id: 'd-hostcall', name: 'ホストコール', genre: 'host', words: ['ホストコール', 'シャンパンコール', 'コール', 'ラスソン', 'マイク'], people: [], nightOnly: true },
  { id: 'd-tower', name: 'シャンパンタワー', genre: 'host', words: ['シャンパンタワー', 'タワー'], people: [], nightOnly: true },
  { id: 'd-urikake', name: '売掛・ツケ', genre: 'host', words: ['売掛', '売り掛け', 'ツケ'], people: [], nightOnly: true },
  { id: 'd-birthday', name: '生誕祭・周年', genre: 'kyaba', words: ['生誕祭', 'バースデー', '周年'], people: [], nightOnly: true },
  { id: 'd-retire', name: '卒業・引退', genre: 'night', words: ['卒業', '引退', '退店'], people: [], nightOnly: true },
  { id: 'd-toyoko', name: 'トー横', genre: 'kabuki', words: ['トー横', 'ゴジラロード', 'ゴジラ'], people: [], nightOnly: true },
  { id: 'd-papakatsu', name: 'パパ活・頂き', genre: 'night', words: ['パパ活', '頂き女子'], people: [], nightOnly: true },
]);

/**
 * 話題性スコアの重み（しきい値ではなく並べ順のための重み）。単発の巨大インプレが勝ちすぎないよう対数で扱う。
 * スコア = log10(1 + 合計表示 + 最大の伸びペース × paceHours)
 *        + perDoublePosts × log2(投稿数)            … 投稿が 2 倍になるごとに加点（maxPostsLog2 まで）
 *        + perBookmark × ブックマーク件数（maxBookmarks 件まで）
 * 例: 単発 6,000万表示 ≒ 7.8 ／ 20件・合計 3,500万 ≒ 7.5 + 4.3×0.6 ≒ 10.1
 */
export const SCORE_WEIGHTS = Object.freeze({
  paceHours: 12,
  perDoublePosts: 0.6,
  maxPostsLog2: 5,
  perBookmark: 0.15,
  maxBookmarks: 3,
});
export const SCORE_NOTE = '話題性 = 合計表示数（＋いちばん伸びた投稿の勢い）を桁数で比べ、投稿が多い話題・自分がブックマークした投稿を含む話題を上乗せした点数です。表示数が不明な投稿は計算に入れません。';

/**
 * メイン3のおすすめの優先順（上から）。同じ段の中は話題性スコア順。
 * night: 夜職4カテゴリの話題か、minPosts: 投稿数の下限
 */
export const MAIN_SUGGEST_TIERS = Object.freeze([
  Object.freeze({ night: true, minPosts: 2 }),
  Object.freeze({ night: true, minPosts: 1 }),
  Object.freeze({ night: false, minPosts: 2 }),
  Object.freeze({ night: false, minPosts: 1 }),
]);

/** 候補一覧で「まとまった話題」とみなす投稿数（これ未満は「その他の単発投稿」に折りたたむ） */
export const GROUPED_MIN_POSTS = 2;

/** 類似まとめの設定 */
export const SIMILARITY = Object.freeze({
  /** 本文の文字 bigram の重なり（Jaccard）がこの値以上なら「同じ話題かも？」 */
  minJaccard: 0.34,
  /** 短すぎる本文は比べない（bigram 数） */
  minBigrams: 6,
  /** 多くの投稿に出てくる bigram は無視する（全体に対する割合） */
  maxDfRatio: 0.06,
  maxDfMin: 6,
});

/** matched_terms の接頭辞の扱い（データ側botの付け方に合わせる） */
export const TERM_PREFIXES = Object.freeze({
  /** 話題名として使う（同じ値の投稿を1つの話題に） */
  topic: 'topic:',
  /** 接頭辞を外して普通の言葉として使う */
  strip: Object.freeze(['quote:']),
  /** 話題まとめには使わない */
  ignore: Object.freeze(['report:', 'manual', 'inherit:']),
});

/** 保存データ */
export const STORAGE_KEY = 'xtrend-show';
export const SCHEMA_VERSION = 1;
/** localStorage が一杯のとき残す番組週の数（新しい順） */
export const KEEP_WEEKS_ON_QUOTA = 6;
export const CHANNEL_NAME = 'xtrend-show';

/** 画面の文言 */
export const TEXT = Object.freeze({
  sampleBanner: 'サンプル表示中（data/ が見つからないため、架空のデータを表示しています）',
  empty: '該当なし',
  unknown: '不明',
  suggestion: '同じ話題かも？',
  noReports: '答え合わせのデータはまだありません（reports.json の週間まとめが届くと表示されます）',
  onairWaiting: 'まもなく配信開始',
});
