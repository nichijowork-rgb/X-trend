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
  dailyEmpty: 'デイリーのレポートはまだありません。初回は 10/12 23:59 の更新後に表示されます',
  risingEmpty: 'この日の「伸びている投稿」はありません',
  reviewEmpty: '答え合わせは前日に「伸びている投稿」があった日に表示されます（初回は 10/13 23:59 の更新後）',
  hitRateEmpty: '的中率はまだありません（答え合わせの開始後に表示されます）',
  weeklyEmpty: '週間のレポートはまだありません。初回は 10/17（土）12:00 の更新後に表示されます',
  weeklyHitEmpty: 'この週の的中率はありません',
  proposalEmpty: '基準の見直し案はありません',
  candidatesEmpty: '見張りアカウントの追加候補はありません',
  crossedColumn: '50万超え',
  crossedYes: '50万超え',
  crossedNo: '届かず',
  missingPost: 'この投稿は posts.json に含まれていません',
});
