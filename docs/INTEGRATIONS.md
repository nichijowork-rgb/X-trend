# 外部連携ガイド

X の投稿を取り込む 5 つの経路と、その使い方・必要な権限・制約・既知の限界。共通の返却形は `docs/CONTRACT.md` を参照。

## 共通ルール
- 不明な指標は `null`（0 で埋めない）。`metricsFetchedAt` は指標が 1 つでもあれば取得時刻、無ければ `null`。
- ネットワーク失敗・4xx/5xx・レート制限は例外にせず `{ posts: [], error: "日本語メッセージ", rateLimit? }`。エラー文・ログにトークン等の秘密値は含めない。
- 順位は「取得した候補内」のもの。X 全体の順位ではない。

## 1. 公式 X API v2（`src/integrations/xapi.js`）
| 機能 | エンドポイント | 必要な環境変数 |
|---|---|---|
| `searchRecent` | `GET /2/tweets/search/recent` | `X_BEARER_TOKEN`（App-only） |
| `homeTimeline` | `GET /2/users/:id/timelines/reverse_chronological` | `X_USER_ACCESS_TOKEN` + `X_USER_ID`（OAuth2 ユーザー文脈） |
| `lookup(ids)` | `GET /2/tweets?ids=`（100 件ずつ） | `X_BEARER_TOKEN`（無ければユーザートークン） |

- 検索の `query` は呼び出し側の文字列をそのまま送る（`-is:retweet` 等は呼び出し側で付ける）。`max_results` は 10〜100 に丸める。
- 指標の対応: `impression_count→views` / `like_count→likes` / `retweet_count→reposts`（`quote_count` は含めない）/ `reply_count→replies` / `bookmark_count→bookmarks`。応答に無い項目は `null`。
- `homeTimeline` は **時系列順のタイムライン**で、X の「おすすめ」欄ではない。`source.type = x_api_home`、`detail = 逆時系列（おすすめ欄ではありません）`。
- `rateLimit = { remaining, resetAt(ISO) }` は `x-rate-limit-remaining` / `x-rate-limit-reset` から。
- 制約・限界: 最近の検索は直近約 7 日。利用可否・読み取り上限・料金は X のプランに依存（権限不足は 403、枠不足は 402/429 としてエラー文になる）。`impression_count` は返らない場合があり、その場合 `views = null`。ユーザーアクセストークンは期限切れになるため更新は別途必要（本モジュールは更新しない）。`lookup` の投稿は `source.type = x_api_search`、`detail = 投稿ID参照（lookup）`。

## 2. Grok / xAI API（`src/integrations/grok.js`）
- エンドポイント: `POST https://api.x.ai/v1/responses`（Responses API）。X 検索は**サーバーサイドツール `x_search`**（`tools: [{ type: "x_search", from_date, to_date }]`、日付は `YYYY-MM-DD`）。旧 Live Search（`search_parameters`）は使わない。
- 環境変数 `XAI_API_KEY`。モデルは `createGrok({ model })` で指定（アプリ設定 `sources.grok.model`、既定 `grok-4`）。
- **モデル名の注意**: 開発環境から docs.x.ai に直接アクセスできず、検索結果の断片でしか確認できていない。そこでは `grok-4.x` 系の新しいモデル名が使われていた。`grok-4` で 400/404 が出る、または「x_search が有効でない」場合は、xAI コンソールの Models ページで現行の X 検索対応モデルを確認し、設定のモデル名を差し替えること。
- `searchX`: Grok に投稿 URL・本文・投稿日時だけを JSON で返させ、応答の引用（`annotations` の URL / トップレベル `citations`）にある `x.com`・`twitter.com` の status URL と突き合わせて `postId` を確定する。引用で裏付けられない投稿は除外し、引用にだけ現れた投稿は本文 `null` で追加する。**指標は常に `null`、`metricsFetchedAt` も `null`**（Grok の数値は推測の可能性があるため。公式 API の `lookup` で後から補完する）。本文は怪しければ `null`。`note` に注意書きを返す。
- `summarize`: 日本語で「夜職の業界動向 / 投稿ネタ候補 / 一般の雑談ネタ」を作る。システムプロンプトで「収集した候補内」と明記させ、X 全体の順位を示す表現を禁止している。
- `suggestTopics`: 直近 2 日の `x_search` を元に `{ label, query }` を `count` 個返す。
- 制約・限界: Grok は LLM のため、検索漏れ・本文の誤写・日時の誤りがあり得る。利用料金は xAI の課金（ツール呼び出し回数）に依存。要約は入力した候補の範囲のみを対象にする。

## 3. 投稿 URL（`src/integrations/url.js`）
- `parsePostUrl`: `x.com` / `twitter.com` / `mobile.twitter.com` / `fxtwitter.com` / `vxtwitter.com` / `fixupx.com` / `/i/web/status/` / `/statuses/` / クエリ・フラグメント付き / 前後空白 / 数字 ID のみ。不正は `null`。
- `fetchOEmbed`: `publish.twitter.com/oembed` から本文・表示名・投稿日（日付のみ。時刻は取れず 00:00 UTC）を取得。失敗時 `null`。
- 限界: oEmbed では指標は取れない。非公開・削除済みの投稿は取得できない。

## 4. JSON / CSV インポート（`src/integrations/importers.js`）
- JSON: 配列 / `{data:[...]}` / `{posts:[...]}` / X 公式アーカイブ（`window.YTD.tweets.part0 = [...]`、`{tweet:{...}}`）/ X API v2 レスポンス（`data` + `includes.users`）/ NDJSON。
- CSV: RFC4180（引用符、セル内改行、BOM、CRLF）、カンマ/タブ自動判定、日本語ヘッダ（投稿ID, URL, 本文, 投稿日時, いいね, 表示回数, リポスト, 返信, ブックマーク など）、URL 列のみ（ヘッダ無しも可）。`errors[].index` は行番号（ヘッダ行が 1）。
- 数値の略記: `1.2万` `3.4K` `2M` `1,234` `全角数字`。数値化できなければ `null`。
- 日時: タイムゾーンの無い表記（`2026/10/10 21:30` 等）は **日本時間** として UTC に変換。Twitter 形式（`Wed Oct 07 12:00:00 +0000 2026`）や ISO8601 も可。
- `metrics_fetched_at` / `fetched_at` / `scraped_at` / `captured_at` / `取得日時` 列があればそれを `metricsFetchedAt` に使い、無ければ取り込み時刻。指標が全て不明なら `null`。
- 限界: 投稿 ID も URL も無い行はスキップして `errors` に載せる。数値 ID が JSON の数値型で 2^53 を超える場合は精度が落ちるため、ID は文字列で書き出すこと。

## 5. ブックマークレット（`src/integrations/bookmarklet.js`）
自分のブラウザで開いている X の画面（おすすめ / フォロー中 / 検索）を、その場で読んでアプリに渡す。

使い方:
1. アプリの設定画面で表示される `javascript:` コードをブックマークの URL 欄に登録する。
2. x.com の `/home`（「おすすめ」タブ）などを開いた状態でブックマークを実行。
3. 件数（既定 50）を入力し、自動スクロールするかを選ぶ。画面上部に進捗が出る（Esc で中断）。
4. 完了すると `{appUrl}/#/capture?d=...` が新しいタブで開く。ポップアップがブロックされた場合は画面上部のリンクを押す。URL が 60000 文字を超える場合は JSON をクリップボードにコピーし、`{appUrl}/#/import` を開くので貼り付ける。

読み取る内容: `article[data-testid="tweet"]` ごとの投稿 URL・ID・投稿日時（`time[datetime]`）・表示名/ハンドル（`User-Name`）・本文（`tweetText`）・返信/リポスト/いいね/ブックマーク/表示の数（`aria-label`、日本語・英語両対応）。広告（「プロモーション」「Promoted」「Ad」「広告」）は除外。

安全上の保証（テストで検証）: Cookie・ローカル保存領域・認証ヘッダ・通信 API（fetch / XMLHttpRequest 等）を一切使わず、いいね・フォロー等の操作もしない。データは `window.open` の URL（またはクリップボード）経由でアプリにだけ渡る。

限界:
- X の DOM / aria-label の仕様変更で取れなくなる可能性がある（DOM 抽出ロジックは `extractPosts` に分離しテスト済みだが、実サイトの変更には追従が必要）。
- カウントが 0 のとき X は数字を表示しないため、その指標は `null`（不明）になる。
- 仮想化リストの都合で、自動スクロール中に画面外へ出た投稿は再度読めない（読めた分は保持する）。
- ページ種別は選択中のタブ名から推定する（判別できなければ `other`）。表示順は X のアルゴリズム次第で再現性はない。取り込みデータは「あなたの画面に出たもの」であり、X 全体の傾向ではない。
- 取り込み時の `source.type` は `foryou_capture`。`detail` にページ種別（おすすめ / フォロー中 / 検索 / その他）を記載。
- X の利用規約上、自動スクロールによる大量取得は自己責任で控えめに使うこと。
