// 表示まわりの設定（データ側botの運用に合わせて変える値はここだけに置く）。
// 2026-10-11 のお知らせ（docs/DATA_BOT_NOTICE_2026-10-11.md）に基づく。

/** データ（posts.json / summary.json）の更新スケジュール（JST） */
export const UPDATE_SCHEDULE = Object.freeze({
  /** 毎日の更新時刻（JST） */
  daily: Object.freeze({ hour: 23, minute: 59, earlyMinutes: 30 }), // earlyMinutes: 定時のこの分数前以降の生成は「その回」の更新とみなす
  /** 画面表示用の文字列 */
  dailyLabel: '毎日23:59（JST）',
  weeklyLabel: '毎週土曜 12:00（JST）',
  /** 予定時刻をこの時間過ぎても generated_at が変わらなければ「遅れている可能性」を表示 */
  delayGraceHours: 2,
});

/** 伸びペースの注記 */
export const PACE_NOTE = 'データ更新時点の値からの計算。今後の予測ではありません';

/**
 * レポート欄（data/reports.json）の文言。データが揃うまでの案内もここで管理する。
 * しきい値や条件の文字列はデータ（condition_label など）からそのまま表示し、ここには置かない。
 * 「50万」は答え合わせの列名・バッジ文言にのみ使う（判定は crossed_500k の真偽値をそのまま使う）。
 */
export const REPORT_TEXT = Object.freeze({
  dailyEmpty: '該当なし（デイリーのデータがまだありません）',
  risingEmpty: '該当なし',
  risingAllGeneral: (n) => `該当なし（一般のバズ ${n}件は対象外）`,
  reviewEmpty: '該当なし',
  hitRateEmpty: '該当なし',
  weeklyEmpty: '該当なし（週間まとめの初回は 10/17（土）12:00 の更新後）',
  weeklyHitEmpty: '該当なし',
  proposalEmpty: '該当なし',
  candidatesEmpty: '該当なし',
  crossedColumn: '50万超え',
  crossedYes: '50万超え',
  crossedNo: '届かず',
  missingPost: 'この投稿は posts.json に含まれていません',
  risingTitle: '伸びている投稿',
  risingButton: '伸びている',
  risingWatchTitle: '補足：伸びそうな投稿',
  risingLead: '投稿から短い時間で表示回数が急に伸びている、夜職関連の投稿です。',
  risingCondLead: '次のどれかを満たす投稿を、1時間あたりの伸びが速い順に並べています。',
  risingWatchLead: '上の条件には届かないものの、伸び始めている夜職関連の投稿です。',
  risingAsOf: (t) => `数値は ${t} 時点のものです。`,
});

/**
 * カテゴリのグループ（ツールバーのグループチップ）。
 * - 夜職すべて: NIGHT_CATEGORIES のいずれかを持つ投稿
 * - 一般のバズ: GENERAL_CATEGORIES を持つ投稿（両方持つ投稿は両方に出る）
 * データ側botは全投稿に話題カテゴリ（夜職4種 or その他）を 1 つ以上付ける（2026-10-11 21:31 生成分から）。
 * 「監視アカウント」カテゴリだけではどのグループにも入らない（is_watched と「監視」バッジで表す）。
 * 話題カテゴリを持たない投稿（想定外）はどのグループにも入らず、詳細パネルに「分類なし n件」と注記する。
 * データに未知の新カテゴリが来たら個別チップとして表示し、どのグループにも含めない。
 */
export const NIGHT_CATEGORIES = Object.freeze(['ホスト', 'キャバクラ', '歌舞伎町', '夜職その他']);
export const WATCH_CATEGORY = '監視アカウント';
export const GENERAL_CATEGORIES = Object.freeze(['その他']);
export const CATEGORY_GROUPS = Object.freeze([
  Object.freeze({ key: 'night', label: '夜職すべて', categories: NIGHT_CATEGORIES }),
  Object.freeze({ key: 'general', label: '一般のバズ', categories: GENERAL_CATEGORIES }),
]);

/** 画面での表示名（データ上の値はそのまま） */
export const CATEGORY_DISPLAY_NAMES = Object.freeze({ 'その他': '一般のバズ' });
