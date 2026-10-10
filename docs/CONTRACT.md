# 共通契約（全モジュール共通の仕様）

このファイルはモジュール間の境界を定めます。変更する場合は監督者（オーケストレーター）が行います。

## 基本方針
- ランタイム依存ゼロ：Node.js 22.13+ 標準のみ（`node:http`, `node:sqlite`, `fetch`）。ESM（`"type":"module"`）。
- フロントはビルド不要の素の HTML/CSS/JS（ES modules）を `public/` から配信。
- **禁止事項**：Xへの投稿・いいね・フォロー・DM、Cookie や認証情報の抽出・転送。ブックマークレットは画面に表示されている DOM のテキストだけを読む（`document.cookie`・localStorage・トークン類には触れない）。
- **不明な指標は `null`**。0 や推測値で埋めない。UIでは「不明」と表示。
- ランキングは「取得した候補内の順位」。X全体の順位とは表現しない。
- 公式APIのホームタイムライン（reverse_chronological）は「おすすめ欄」ではない。ソース種別を分けて表示する。
- 実データが0件のときはサンプルを明示（`isSample`）。
- 秘密情報は環境変数のみ。APIレスポンス・ログ・UIに値を出さない（`configured: true/false` のみ）。

## 環境変数
| 変数 | 用途 |
|---|---|
| `PORT` | 既定 8787 |
| `DATA_DIR` | 既定 `./data`（SQLite: `x-trend.db`, 自動バックアップ: `backups/`） |
| `ADMIN_TOKEN` | 設定時：書き込みは管理者トークン必須、閲覧は共有トークン必須。未設定時：ローカルモード（全操作可） |
| `X_BEARER_TOKEN` | X API v2（App-only）：最近の検索・投稿ID参照 |
| `X_USER_ACCESS_TOKEN` / `X_USER_ID` | X API v2（OAuth2 ユーザー文脈）：ホームタイムライン（逆時系列。おすすめ欄ではない） |
| `XAI_API_KEY` | Grok（xAI API）：X検索・要約 |
| `TZ_NAME` | 既定 `Asia/Tokyo` |

## NormalizedPost（取り込みモジュール → ストア の受け渡し形）
```js
{
  postId: "1234567890",          // 必須。数字文字列
  url: "https://x.com/user/status/1234567890" | null,
  authorHandle: "user" | null,   // @なし
  authorName: "表示名" | null,
  text: "本文" | null,
  postedAt: "2026-10-10T12:00:00.000Z" | null,   // ISO8601 UTC
  metrics: { views: n|null, likes: n|null, reposts: n|null, replies: n|null, bookmarks: n|null },
  metricsFetchedAt: ISO | null,   // 指標を取得した時刻。指標が1つも無いなら null
  source: { type: SourceType, detail: string|null },  // detail 例: 検索キーワード、ファイル名
  genreHint: "nightlife"|"general"|null,
  matchedKeywords: [string],
  lang: string|null,
  raw: object|null                // 元データ（任意、サイズ注意）
}
```
`SourceType`:
`x_api_search`（公式API検索）, `x_api_home`（公式APIホームTL＝逆時系列、おすすめではない）, `foryou_capture`（ユーザー自身のブラウザ画面からのブックマークレット取り込み）, `grok_x_search`（Grok経由のX検索）, `url`（URL手動保存）, `import_json`, `import_csv`, `sample`。

## 統合（integrations）モジュールの公開インターフェース
すべて `fetchImpl` を注入可能（テスト用）。ネットワークエラーは例外ではなく `{ posts: [], error: "日本語メッセージ" }` で返すこと。

- `src/integrations/url.js`
  - `parsePostUrl(input) -> { postId, authorHandle, url } | null`（x.com / twitter.com / mobile. / fxtwitter / vxtwitter / `/i/web/status/` / 数字IDのみ も可。正規化URLは `https://x.com/{handle|i/web}/status/{id}`）
  - `fetchOEmbed(url, { fetchImpl }) -> { authorName, authorHandle, text, postedAt } | null`（publish.twitter.com/oembed。失敗時 null）
- `src/integrations/importers.js`
  - `parseJSON(text, { sourceDetail }) -> { posts: NormalizedPost[], errors: [{ index, message }] }`
  - `parseCSV(text, { sourceDetail }) -> 同上`（errors の index は行番号）
  - `normalizeCapture(payload) -> 同上`（ブックマークレット payload、source.type = `foryou_capture` 等）
  - `normalizeRecord(obj, sourceType, sourceDetail) -> NormalizedPost | null` 柔軟なフィールド名対応（id/id_str/tweet_id/url/text/full_text/created_at/like_count/favorite_count/retweet_count/view_count/impression_count/public_metrics 等）
- `src/integrations/xapi.js`
  - `createXApi({ bearerToken, userAccessToken, userId, fetchImpl }) -> { isConfigured(): {search:boolean, home:boolean}, searchRecent({ query, maxResults }), homeTimeline({ maxResults }), lookup(ids) }`
  - 各メソッドの戻り値: `{ posts: NormalizedPost[], error?: string, rateLimit?: { remaining, resetAt } }`
- `src/integrations/grok.js`
  - `createGrok({ apiKey, model, fetchImpl }) -> { isConfigured(): boolean, searchX({ query, maxResults, fromDate, toDate }) -> { posts, error?, note? }, summarize(input) -> { text, error? }, suggestTopics({ genre, count }) -> { topics: [{ label, query }], error? } }`
  - `summarize(input)`: `{ kind: "daily"|"weekly", periodLabel, sections: [{ genre, genreLabel, topics: [{ label, posts: [{ text, url, metrics }] }] }] }`
- `src/integrations/bookmarklet.js`
  - `buildBookmarklet(appUrl) -> "javascript:..."`
  - ブックマークレットは x.com の表示中DOMから投稿を集め（任意で自動スクロールして最大N件）、`{appUrl}/#/capture?d=<base64url(UTF-8 JSON)>` を新しいタブで開く。長すぎる場合はクリップボードにJSONをコピーし、取り込み画面へ貼り付けるよう案内。
  - payload: `{ v: 1, capturedAt, page: "foryou"|"following"|"search"|"other", pageUrl, posts: [{ postId, url, authorHandle, authorName, text, postedAt, metrics }] }`

## HTTP API（JSON、`/api/*`）
共通：エラーは `{ error: "日本語メッセージ" }` + 適切なステータス。
認証ヘッダ：`X-Admin-Token`（書き込み）、`X-Share-Token`（閲覧）。`ADMIN_TOKEN` 未設定ならどちらも不要。

### 投稿 Post（APIレスポンス形）
```js
{
  postId, url, authorHandle, authorName, text, postedAt,
  genre: "nightlife"|"general"|"unknown",
  topicId: string|null, topicLabel: string|null,
  metrics: { views, likes, reposts, replies, bookmarks },   // null = 不明
  metricsFetchedAt: ISO|null,
  firstSeenAt, lastSeenAt,
  sources: [{ type, detail, at }],        // 重複統合された取得元すべて
  mergedCount: number,                    // 統合された取り込み回数
  matchedKeywords: [string],
  isSample: boolean,
  hidden: boolean, demoted: boolean,
  matchedDismissals: [{ id, scope, value, reasonCode, reasonNote }],
  rank: number|null                       // 現在の並び順での候補内順位（1始まり）
}
```

### エンドポイント
- `GET /api/status` → `{ sampleMode, realPostCount, samplePostCount, role: "admin"|"viewer", authRequired, integrations: { xSearch, xHome, grok }, lastRuns: [Run], nextRuns: [{ job, at }], version }`
- `GET /api/posts?genre=nightlife|general|all&sort=views|likes|newest|score&period=day|week|month|all&topicId=&q=&includeHidden=0|1&limit=50&offset=0`
  → `{ items: [Post], total, hiddenCount, rankingNote: "取得した候補内の順位です（X全体の順位ではありません）" }`
  - 並べ替えで指標が `null` の投稿は末尾（不明は最下位扱い、0扱いしない）。`newest` は `postedAt`（null なら firstSeenAt）。
- `GET /api/topics?genre=&period=` → `{ items: [{ id, label, genre, keywords, postCount, latestAt, totalLikes|null, postIds }] }`
- `POST /api/posts/url` `{ url, genre? }` → `{ post, created }`（URLだけでも保存可。oEmbed は取れたら補完）
- `POST /api/import` `{ format: "json"|"csv", content, filename?, genre? }` → `{ added, merged, skipped, errors }`
- `POST /api/capture` `{ payload }` → `{ added, merged, skipped, errors }`
- `GET /api/bookmarklet` → `{ code, appUrl }`
- `POST /api/jobs/run` `{ job: "collect"|"daily_digest"|"weekly_digest"|"backup" }` → `{ run }`
- `GET /api/runs?limit=20` → `{ items: [Run] }`  Run: `{ id, job, startedAt, finishedAt, status: "ok"|"skipped"|"error", message, counts }`
- `GET /api/digests?kind=daily|weekly` → `{ items: [{ id, kind, periodStart, periodEnd, createdAt, summaryBy, isSample, title }] }`
- `GET /api/digests/:id` → `{ digest: { ...上記, summaryText, sections: [{ genre, genreLabel, topics: [{ label, posts: [Post] }] }] } }`
- `GET /api/dismissals?includeRevoked=1` → `{ items: [Dismissal] }`
  Dismissal: `{ id, scope: "post"|"author"|"keyword"|"topic", value, reasonCode: "other_meaning"|"vtuber"|"off_topic"|"low_quality"|"staged"|"other", reasonNote, effect: "hide"|"demote", createdAt, revokedAt|null, matchCount }`
- `POST /api/dismissals` `{ scope, value, reasonCode, reasonNote?, effect? }` → `{ dismissal }`
- `POST /api/dismissals/:id/revoke` → `{ dismissal }`（取り消し）／ `POST /api/dismissals/:id/restore` → `{ dismissal }`（再有効化）
- `GET /api/settings` → `{ settings }` ／ `PUT /api/settings` `{ settings }` → `{ settings }`（検証して保存。部分更新可）
- `GET /api/backup` → バックアップJSON（`Content-Disposition: attachment`）
- `POST /api/restore` `{ backup, mode: "replace"|"merge" }` → `{ restored: { posts, dismissals, digests, settings } }`
- `GET /api/backups` → `{ items: [{ name, size, createdAt }] }`（自動バックアップ一覧）／ `POST /api/backups/:name/restore`
- `POST /api/sample/load` / `DELETE /api/sample`
- `GET /api/share` → `{ shareUrl|null, authRequired }`（管理者のみ） ／ `POST /api/share/rotate`

### Settings 形
```js
{
  keywords: { nightlife: ["ホスト","キャバクラ","歌舞伎町","ホストクラブ","キャバ嬢","ラウンジ","夜職"], general: [] },
  excludeTerms: ["ロイヤルホスト"],     // 収集・分類時に除外（興味なしとは別の初期フィルタ）
  targets: { nightlifePerDay: { min: 30, max: 50 }, generalTopicsPerDay: 3, generalPostsPerTopic: 5 },
  schedule: {
    timezone: "Asia/Tokyo",
    collectTimes: ["09:00", "21:00"],
    dailyDigest: { enabled: true, time: "23:30" },
    weeklyDigest: { enabled: true, weekday: 1, time: "10:00", postCount: 30 },  // weekday 0=日..6=土
    autoBackup: { enabled: true, time: "04:00", keep: 14 }
  },
  sources: { xSearch: { enabled: true, maxPerQuery: 20 }, xHome: { enabled: false, maxResults: 50 }, grok: { enabled: true, model: "grok-4", useForSearch: true, useForSummary: true } },
  budget: { note: "未決定", xApiMonthlyReadCap: null },
  delivery: { method: "none", webhookUrl: null }      // 未決定。none = アプリ内のみ
}
```
