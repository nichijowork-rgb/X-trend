# 収集bot（Grok bot）への依頼：「整理開始」ボタンでの連携（第2版 2026-11-28）

番組サイト（https://www.x-yoru-buzz.com/show/）の制作担当から、収集bot担当へ。
第1版（パソコンの中で直接つなぐ方式）へのお返事、ありがとうございました。いただいた指摘をすべて受けて、**GitHub のファイルでやりとりする方式**に作り直しました。

## 0. いただいた指摘への回答

| 指摘 | 回答 |
|---|---|
| 1. `ws://127.0.0.1` は届かない（ボットはクラウドの別マシン） | 直接つなぐ方式はやめます。**ボタン → サイトが GitHub に依頼ファイルを書く → その push でボットが起きる** 方式にします（§2）。ブラウザに新しい合言葉は持たせません（サイトは今の `show-feedback.json` と同じトークンで書きます） |
| 2. 進み具合は大まかでよいか | はい。**段階が変わるたびに `data/show/status.json` を更新**してもらえれば十分です（§3） |
| 3. 5分以内は無理（数十分・Xの上限あり） | 了解です。番組オーナーには「配信の数時間前に押す」と案内します。待っている間もサイトで作業でき、終わったら自動で反映します。`status.json` に目安の残り時間（`eta_min`）があると助かります |
| 4. 毎時の自動実行は多い | **土曜 18:00 と 22:00 の 2 回＋ボタン** でお願いします |
| 5. 配信日の書き方 | 番組オーナーに確認しました。**配信は土曜の深夜＝日曜 1:00** です。サイト側を直しました：`week.key` は**土曜の日付**、`from` は前の日曜 1:00、`to` は日曜 1:00 です（第1版の例が 24 時間早かったのはサイト側の誤りでした）。依頼ファイルの `week` をそのまま使ってください |
| 6. 依頼の受け方（`feedback/prepare-request.json` の push をきっかけに） | そのとおりにします（§2） |
| `data/` への書き込みはハンエイさん 1 か所 | 了解です。サイトは `data/` には書きません（書くのは `feedback/` だけ）。結果のファイルは、ハンエイさんがまとめて保存してください |
| 30万未満の投稿 | お願いします。**まとまり・下書きに使った投稿は、30万未満でも `data/posts.json` に必ず入れてください**。`below_threshold: true` を付けてもらえれば、ダッシュボードには出さず、番組サイトでは使います（今もそう動きます） |
| `data/show/topics.json` がまだ無い | 失礼しました。「サイトはこの形のファイルが来たら読める」という意味です。ファイルはまだありません |
| 週をまたぐ同じ id のため `data/show/archive/` に前週分 | 賛成です。サイトは archive を読みません（自由に使ってください） |

## 1. やりたいこと（変わらず）
配信の数時間前に、番組サイトの編成で **「整理開始」を 1 回押す** と、①その時点の最新の投稿（今週分の表示数も更新）②Grok のまとまり ③番組の流れの下書き、がそろい、サイトに自動で反映される。

## 2. 依頼：`feedback/prepare-request.json`（サイトが書く → push でボットが起きる）

サイトは「整理開始」を押されると、まず `feedback/show-feedback.json`（いつもの修正）を最新にしてから、このファイルを書きます（同じブランチ `claude/x-scraper-nightlife-tool-sb26pq`）。

```jsonc
{ "app": "xtrend-prepare", "v": 1,
  "id": "p-20261128-1910-ab12",                     // 依頼ごとに新しい id
  "requested_at": "2026-11-28T19:10:00+09:00",
  "force": false,                                   // true なら 10 分以内の再依頼でも実行
  "cancel": false,                                  // true なら同じ id の依頼をやめる（できる範囲で）
  "week": { "key": "2026-11-28",                    // 番組週のキー（土曜の日付）
            "from": "2026-11-22T01:00:00+09:00", "to": "2026-11-29T01:00:00+09:00" },
  "range": { "from": "2026-11-22T01:00:00+09:00", "to": "2026-11-28T19:10:00+09:00" },   // 対象期間（まとまり・下書きに使う投稿の期間）
  "rules": {
    "main_slots": 3,                                // メインは 3 本
    "main_night_only": true,                        // メインは夜職（ホスト・キャバクラ・歌舞伎町・夜職その他）だけ
    "genre_priority": ["ホスト", "キャバクラ", "歌舞伎町", "夜職その他"],
    "category_count": 6,                            // カテゴリ別ニュース
    "chat_count": 3,                                // 雑談（一般のバズ）
    "min_posts_for_main": 2
  },
  "keep": {                                         // 番組オーナーがすでに決めたもの（触らない・下書きに使わない）
    "placed_topic_ids": ["host-call-2026w48", "m:abc"],
    "manual_topics": [ { "id": "m:abc", "name": "担当との別れ話", "post_ids": ["…"] } ]   // 手で作ったまとまり（中の投稿はほかのまとまりに入れない）
  },
  "feedback_generated_at": "2026-11-28T19:09:58+09:00" }   // 直前に書いた show-feedback.json の generated_at（それを読んでください）
```

- サイトは、前回の依頼から 10 分以内は確認なしに書きません。ボット側でも、重なったときは `status.json` で知らせてください（§3 の `busy`）。
- `feedback/show-feedback.json` の中身（削除・ジャンル・まとまりの編集・保留する言葉・URL で追加した投稿の取得依頼）は第1版の説明どおりです。

## 3. 進み具合と結果：`data/show/status.json`（ボット側が書く）

段階が変わるたびに更新してください。サイトは依頼中だけ、GitHub API で 30 秒おき（10 分たったら 60 秒おき、最長 3 時間）に読みます。

```jsonc
{ "app": "xtrend-prepare-status", "v": 1,
  "request_id": "p-20261128-1910-ab12",             // 自動実行なら "auto-20261128-1800"
  "state": "running",                               // queued / running / done / error / cancelled / busy
  "stage": "group",                                 // collect / metrics / feedback / group / draft / push
  "message": "Grok がまとまりを作っています（412 件）",   // 番組オーナーがそのまま読む日本語
  "started_at": "2026-11-28T19:11:30+09:00", "updated_at": "2026-11-28T19:38:02+09:00", "finished_at": null,
  "eta_min": 15,                                    // だいたいの残り分（わからなければ null）
  "result": null,                                   // done のとき下
  "error": null }                                   // error / busy のとき下
```

- `done` のとき：`"result": { "commit": "<data を保存したコミット>", "data_generated_at": "…", "new_posts": 86, "topics": 74 }`。サイトはこのコミットの `data/posts.json`・`data/show/topics.json`・`data/show/draft.json` を読み、空いている所だけ下書きを入れます。
- `error` のとき：`"error": { "code": "x_rate_limited", "message": "X の上限に達しました（15 分後にもう一度）", "retry_after_min": 15 }`（例：`x_rate_limited`・`x_auth`・`grok_error`・`github_push`・`cancelled`・`internal`）。
- `busy`（ほかの実行中・前回から 10 分以内）：`"error": { "code": "running" | "too_soon", "message": "…", "retry_after_min": n }`。

## 4. 作業の中身（依頼を受けたら）
1. **collect**：`range` の最新の投稿を集める（いつもの検索・見張りアカウント・おすすめ＋ `show-feedback.json` の `requested_posts`）。
2. **metrics**：今週分（`week.from`〜今）の表示・いいね・RP などを更新。
3. **feedback**：`show-feedback.json` を反映（`removed_posts` は使わない／`genre_overrides`／`hold_terms` を含むものは外す（`hold_exceptions` は除く）／`topic_edits` の名前・ジャンル・中身を引き継ぐ）。
4. **group（Grok）**：まとまり。名前は番組でそのまま使える短い日本語（20 字前後）、ジャンル、`summary`（リード文 2〜3 文）、`confidence`（0〜1）。**週をまたいでも同じ話題なら同じ id**（`archive/` を使って）。`keep.manual_topics` の投稿はほかに入れない。
5. **draft（Grok）**：`rules` に従う下書き（メイン 3＝夜職だけ・優先ジャンル順・話題性・投稿 2 件以上を優先／カテゴリ別 6＝ジャンルを順に回す／雑談 3＝一般のバズで話しやすいもの）。理由を一言。`keep.placed_topic_ids` は入れない。
6. **push**：ハンエイさんが `data/posts.json`（使った投稿は 30万未満も）・`data/show/topics.json`・`data/show/draft.json`・`data/show/status.json`（done）を 1 回で保存。

## 5. ファイルの形（第1版と同じ）

### `data/show/topics.json`
```jsonc
{ "generated_at": "…", "week": { "from": "2026-11-22T01:00:00+09:00", "to": "2026-11-29T01:00:00+09:00" },
  "topics": [ { "id": "host-call-2026w48", "name": "ホストコール規制", "genre": "ホスト",
                "post_ids": ["2109…"], "summary": "今週◯◯が話題に…", "confidence": 0.8 } ] }
```
ジャンルは ホスト／キャバクラ／歌舞伎町／夜職その他／その他（＝一般のバズ）。上限 500 まとまり・1 まとまり 300 件。`post_ids` は `posts.json` にある id だけ。

### `data/show/draft.json`
```jsonc
{ "generated_at": "…", "week": "2026-11-28", "request_id": "p-20261128-1910-ab12",
  "main":     [ { "topic_id": "host-call-2026w48", "reason": "今週最大の話題。合計 3,200 万表示" } ],   // 最大 3。順にメイン 1〜3
  "category": [ { "topic_id": "…", "reason": "…" } ],                                              // 最大 6
  "chat":     [ { "topic_id": "…", "reason": "…" } ] }                                              // 最大 3
```
サイトは空いている所だけに入れ、番組オーナーが入れたもの・手で作ったまとまりは動かしません（「元に戻す」1 回で取り消せます）。

## 6. 自動実行
**土曜 18:00 と 22:00** に §4 を実行してください（`request_id` は `auto-…`、`keep` は無しでよい）。サイトは「整理開始」でボットの結果が来なかったとき、同じ番組週で 12 時間以内の `draft.json` があればそれを使います。

## 7. 確かめ方
1. サイトで「整理開始」→ GitHub に `feedback/prepare-request.json` が push される。
2. ボットが起きて、`data/show/status.json` が queued → running（collect … push）→ done と変わる。サイトにも同じ段階が出る。
3. done で、サイトの編成にまとまり（Grok の印）と番組の流れの下書きが入る（番組オーナーが入れたものはそのまま）。
4. ボットを止めた状態で押す → サイトは待ち続けず、一定時間で「ボットから返事がありません」と出して、今あるデータで下書きを作れる。
5. 10 分以内にもう一度押す → サイトが確認を出す／ボットは `busy`（too_soon）。

形を変えたほうが作りやすい点があれば、また教えてください。
