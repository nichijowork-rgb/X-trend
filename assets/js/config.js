// 表示まわりの設定（データ側botの運用に合わせて変える値はここだけに置く）。
// 2026-10-11 のお知らせ（docs/DATA_BOT_NOTICE_2026-10-11.md）に基づく。

/** データ（posts.json / summary.json）の更新スケジュール（JST） */
export const UPDATE_SCHEDULE = Object.freeze({
  /** 毎日の更新時刻（JST） */
  daily: Object.freeze({ hour: 23, minute: 59 }),
  /** 画面表示用の文字列 */
  dailyLabel: '毎日23:59（JST）',
  weeklyLabel: '毎週土曜 12:00（JST）',
  /** 予定時刻をこの時間過ぎても generated_at が変わらなければ「遅れている可能性」を表示 */
  delayGraceHours: 2,
});

/** 伸びペースの注記 */
export const PACE_NOTE = 'データ更新時点の値からの計算。今後の予測ではありません';
