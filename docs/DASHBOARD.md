# Xレポート ダッシュボード（静的サイト）

`index.html`（リポジトリ直下）は、別botが push する `data/posts.json`・`data/summary.json` を読んで表示するだけの静的ページです。サーバー・API・DB・ビルドは不要です。要件は [DASHBOARD_REQUIREMENTS.md](DASHBOARD_REQUIREMENTS.md) を参照してください。

```
repo/
├── index.html               … ページ本体
├── assets/
│   ├── dashboard.css        … デザイン（歌舞伎町ネオン調ダーク＋ライト）
│   ├── dashboard.js         … エントリ（読み込み・描画・状態管理）
│   └── js/
│       ├── config.js        … 更新スケジュール・レポート欄の案内文などの設定定数（運用で変わる値はここだけ）
│       ├── core.js          … 純粋関数（数値・日時・フィルタ・集計・URL状態など。DOM 非依存）
│       ├── charts.js        … グラフ（自前 SVG。外部ライブラリ不使用）
│       ├── embed.js         … X 公式埋め込み（widgets.js の遅延読み込み）
│       ├── media.js         … 写真・動画・GIF の表示とライトボックス
│       └── theme-init.js    … テーマの初期適用（ちらつき防止）
├── sample/                  … サンプルデータ（data/ が無いときに表示）
├── tools/make-sample.mjs    … サンプル生成スクリプト
└── data/                    … データ側botが自動更新（フロントは触らない）
```


## GitHub Pages での公開手順

1. GitHub のリポジトリ画面で **Settings → Pages** を開く
2. **Build and deployment** の Source で **Deploy from a branch** を選ぶ
3. Branch に **`claude/x-scraper-nightlife-tool-sb26pq`**、フォルダに **`/ (root)`** を選んで **Save**
4. 数分後に表示される URL（`https://<ユーザー名>.github.io/<リポジトリ名>/`）を開く

- すべて相対パスで読むので、サブパス配下（`/<リポジトリ名>/`）でもそのまま動きます。
- `data/` が push されるまでは、画面上部に **「サンプルデータを表示中（data/ が見つかりません）」** の黄色い帯が出ます（下記）。
- Pages の反映・CDN キャッシュで更新が数分遅れることがあります。JSON は `?t=<時刻>` 付きで取得するのでブラウザキャッシュの影響は受けません。

## 公開範囲の注意

- **GitHub Pages のサイトは原則として誰でも閲覧できます**。Free プランでは公開リポジトリのみ Pages を使え、Pro/Team では非公開リポジトリからも公開できますがサイト自体は公開です。閲覧者を限定できる（private Pages）のは Enterprise Cloud のみです。
- 本リポジトリは公開リポジトリです。`data/` を push した時点で、収集した投稿（夜職関連の内容・ユーザー名・本文）がインターネット上に公開されます。
- 公開を避けたい場合の選択肢: リポジトリを非公開にしてローカル確認のみにする／Enterprise の private Pages を使う／アクセス制限付きの別ホスティング（Cloudflare Access 等）を使う。
- `<meta name="robots" content="noindex, nofollow">` を入れていますが、検索エンジンに対する「お願い」であって**アクセス制限ではありません**。
- ページ自体は Cookie・トラッキング・解析タグを使わず、外部へデータを送りません。例外は利用者が **「X埋め込み」表示や「埋め込みで見る」を選んだとき**の `platform.twitter.com`（X 側の Cookie 等が使われる場合があります。画面にも注記を出します）と、添付メディアの画像・動画（`pbs.twimg.com`・`video.twimg.com`）の読み込みです。

## データ側botとの取り決め

| 項目 | 内容 |
|---|---|
| パス | `data/posts.json`・`data/summary.json`（リポジトリ直下からの相対パス） |
| 形式 | 要件書「3. データ仕様」のとおり（UTF-8 の JSON） |
| 書き込み | **データ側botのみ**。フロントは読むだけで、JSON を書き換えない |
| posts.json | 必須。`posts` 配列が無い・JSON 不正の場合はサンプル表示に切り替わる |
| summary.json | 任意。無い・壊れている・`total_posts` が posts.json の件数と食い違う場合は、投稿から集計して表示する |
| カテゴリ | 固定していない。`categories` 配列と各投稿の `categories` から動的に生成（新カテゴリは自動でチップ・グラフに出る） |
| id | 文字列で出力してください（19 桁は数値だと精度が落ちる） |
| 指標の欠損 | `null` やキー欠落は「不明」と表示（0 扱いしない）。合計は既知値のみで「一部不明」と注記 |
| 更新 | 毎日 **23:59（JST）に1回**（週間まとめは毎週土曜 12:00）。表示文字列は `assets/js/config.js` の `UPDATE_SCHEDULE` で一元管理 |
| 期間の基準 | 「24時間/7日/30日」と伸びペースは **`generated_at` を優先**し、無ければ最新投稿の `ts` を基準にする（現在時刻ではない。日中に見ても前日 23:59 時点で切る／更新が止まっても 0 件にならない）。画面に「基準：10/11 23:59 時点」と表示 |
| 古い投稿 | 日別グラフは「すべて」でも直近 90 日だけ表示し、それより古い件数を注記 |
| media | **任意**（下記）。無ければ何も表示しない |
| reports.json | **任意**（`data/reports.json`。下記「レポート欄」）。無い・壊れている場合はレポート欄を出さないだけ |

### 任意フィールド `media`（写真・動画）

各 Post に次の配列を付けると、カード表示で写真・動画・GIF を表示します。

```jsonc
"media": [
  { "type": "photo", "url": "https://pbs.twimg.com/media/XXXX.jpg", "width": 1200, "height": 800, "alt_text": "説明" },
  { "type": "video", "preview_image_url": "https://pbs.twimg.com/ext_tw_video_thumb/…/XXXX.jpg",
    "variants": [
      { "content_type": "application/x-mpegURL", "url": "https://video.twimg.com/…/pl/XXXX.m3u8" },
      { "content_type": "video/mp4", "bit_rate": 2176000, "url": "https://video.twimg.com/…/1280x720/XXXX.mp4" }
    ] },
  { "type": "animated_gif", "preview_image_url": "https://pbs.twimg.com/tweet_video_thumb/XXXX.jpg",
    "variants": [{ "content_type": "video/mp4", "bit_rate": 0, "url": "https://video.twimg.com/tweet_video/XXXX.mp4" }] }
]
```

| フィールド | 型 | 説明 |
|---|---|---|
| type | `"photo"` \| `"video"` \| `"animated_gif"` | 種別（それ以外は無視） |
| url | string | 写真の URL（photo） |
| preview_image_url | string | 動画・GIF のサムネイル |
| variants | `[{content_type, url, bit_rate?}]` | 動画の配信形式。`video/mp4` のうち最大 `bit_rate` を再生。mp4 が無ければ「Xで再生」リンク |
| width / height | number | 任意。レイアウトのがたつき防止 |
| alt_text | string | 任意。代替テキスト・拡大時のキャプション |

- 表示する URL は **`https://` かつ `pbs.twimg.com` / `video.twimg.com` のみ**。それ以外（http、他ドメイン）は表示しません。
- 写真は最大 4 枚（グリッド表示・タップで拡大・Esc で閉じる）。読み込みに失敗した画像はプレースホルダを表示します。
- 動画は `<video controls playsinline preload="none">`（再生ボタンを押すまで読み込まない）。

#### データ側botへの依頼文（コピペ用）

> posts.json の各 Post に、任意フィールド `media` を追加してください（添付が無い投稿は省略で構いません）。
> X API v2 なら、ツイート取得時に `expansions=attachments.media_keys` と `media.fields=type,url,preview_image_url,variants,width,height,alt_text` を指定すると、レスポンスの `includes.media` に必要な値が入ります。各ツイートの `attachments.media_keys` で `includes.media` を引き当て、`{ type, url, preview_image_url, variants, width, height, alt_text }` をそのまま（キー名も同じで）配列にして `media` に入れてください。`variants` の `bit_rate` は数値のままで OK です。URL は `pbs.twimg.com` / `video.twimg.com` のものだけが表示対象です。

## 画面の機能

### 画面構成（簡潔表示）

アクセントカラーは赤（ダーク `#ff3b4e`／ライト `#d0102a`）。歌舞伎町ネオン調のダーク既定＋ライト。グローは見出し・選択中の要素・最大インプレッションの数値のみ。

**常に見えるもの**

1. ヘッダー: タイトル、「最終更新 10/11 23:59 ・ 次回 毎日23:59（JST）」を 1 行で（スマホではテーマ切替はアイコンのみ）
   - generated_at の次の 23:59 JST からさらに 2 時間（`delayGraceHours`）過ぎても更新されていなければ「更新が遅れている可能性があります」と控えめに表示（現在時刻を使うのはこの判定だけ。サンプル表示中は出さない）。定時の 30 分前以降に生成されたデータはその回の更新とみなす（`earlyMinutes`）
2. 最大インプレッションの投稿（1 枚。絞り込みに追従）
3. ツールバー: カテゴリチップ（複数選択で OR・件数表示。スマホは 1 行の横スクロール）／期間（24時間・7日・30日・すべて）／並び替え（新しい順・表示回数が多い順・いいねが多い順・ブックマークが多い順・伸びペースが速い順。欠損は末尾）／カード・X埋め込み切替／「詳細・レポート・グラフ」ボタン
   - キーワード・アカウント・監視のみで絞り込み中は、その条件がツールバーにチップで表示され「×」で解除できる（詳細パネルを閉じていても見える）
4. 投稿一覧

**「詳細・レポート・グラフ」パネル**（既定は閉じる。開閉は URL の `panel=1` と localStorage に保存）

- 検索・絞り込み（キーワード：スペース区切りで AND、全角スペース・半角カナも可／アカウント／監視アカウントのみ／条件をクリア）
- サマリー（総投稿数・アカウント数・合計インプレッション、データ期間、基準「10/11 23:59 時点」、集計元の注記）
- レポート（reports.json。下記）
- グラフ
- 上位アカウント
- レポートに新しいデータ（最新の daily の date または weekly の期間が前回パネルを開いたときより新しい）が来るとボタンに「NEW」バッジ（既読は localStorage。使えない環境でも動作）

**投稿カード**（スマホで 1 画面に 2〜3 件が目安）

- ユーザー名・日時・カテゴリバッジを 1 行、本文、伸びペースの一行、数値 6 種（表示・いいね・リポスト・返信・引用・ブックマークをアイコン＋値で 1 行。意味は title とスクリーンリーダー用ラベル）、「埋め込みで見る」「Xで開く」
- 長文（約 140 字超または 4 行超）は 4 行で折りたたみ、「続きを読む／閉じる」（`aria-expanded`、キーボード操作可）。ハイライトやリンクは DOM のまま CSS で隠すだけなので壊れない
- 写真・動画は折りたたみの外に控えめなサイズ（最大幅 320px）で表示

- 伸びペース: `impression_count ÷（基準時刻 − ts の時間数）`。経過 1 時間未満は 1 時間として計算し、表示回数が不明なら「不明」で末尾。各カードに「投稿から3時間で38.2万表示（1時間あたり12.7万）」と小さく表示し、伸びペース順のときは強調＋「データ更新時点の値からの計算。今後の予測ではありません」と注記。**しきい値（15万/30万/40万など）は画面に持たない**（データ側の基準は試行中で変わるため）
- 絞り込み中は、サマリー・グラフ・上位アカウントも絞り込み結果から再集計（フィルタ無しのときは summary.json の値を使用）
- グラフ（自前 SVG）: カテゴリ別の件数・インプレッション（横棒）、日別の投稿数（カテゴリ別の積み上げ、0 件の日も表示）。ホバー/キーボード（←→）でツールチップ、「表で見る」で数値表
- 上位アカウント: 投稿数順/インプレッション順。クリックでそのアカウントに絞り込み（もう一度で解除）
- 投稿: 50 件ずつ（スクロールで自動追加＋「さらに表示」ボタン）。本文の改行保持、http(s) の URL のみリンク化、matched_terms と検索語をハイライト
- 表示切替「カード / X埋め込み」:
  - X埋め込みは、選んだときだけ `https://platform.twitter.com/widgets.js` を読み込み、画面に近づいた投稿だけ数件ずつ公式埋め込みを生成（`lang: 'ja'`・現在のテーマ・`dnt: true`・`conversation: 'none'`）
  - 削除・非公開・センシティブ・ネットワーク遮断などで埋め込めないときは自前カードにフォールバックし「埋め込みを表示できませんでした」と表示
  - 埋め込みの上にカテゴリ・数値・根拠語（matched_terms）の帯を残す
  - カード表示でも各投稿の「埋め込みで見る」でその 1 件だけ展開できる（データに media が無くても写真・動画を確認可能）
- フィルタ・並び順・表示切替は URL（`#cat=…&period=7d&q=…` など）に保存。共有・再読み込み・戻る/進むで復元。表示切替とテーマは localStorage にも保存（使えない環境でも動作）
- テーマ: 既定は OS 設定に追従（指定が無ければダーク）。右上のボタンで 自動 → ダーク → ライト を切替
- セキュリティ: 本文などはすべて `textContent` / DOM 生成で挿入（`innerHTML` 不使用）。CSP で通信先を自サイト＋上記の X ドメインに限定

### カテゴリ色

色はカテゴリ名に固定し、絞り込みで色が変わらないようにしています。dataviz の検証済み 8 色パレットから、アクセントの赤と紛れる赤・マゼンタを既知カテゴリに使わない並びを選び、隣接色の色覚シミュレーション差 ΔE≥8・通常視 ΔE≥15 をライト・ダーク両方でバリデータ検証済みです。色だけに頼らず、チップ・凡例・バッジには必ずカテゴリ名を併記します。

| カテゴリ | 色 |
|---|---|
| ホスト | パープル |
| キャバクラ | イエロー |
| 歌舞伎町 | アクア |
| 夜職その他 | ブルー |
| 監視アカウント | グリーン |
| その他 | グレー（ニュートラル） |
| 未知のカテゴリ | 名前のハッシュでオレンジ／ピンクのどちらか（毎回同じ色） |

## レポート欄（実装済み）：data/reports.json

データ側のデイリー／週間まとめにある「伸びている投稿」「答え合わせ」「的中率」を表示する任意ファイルです。データ側botは下記の形式**そのまま**で出力することに合意済み（デイリーの rising は 10/12 23:59 以降、review は 10/13 以降、weekly は 10/17(土) 以降）。posts.json / summary.json は変更ありません。

- posts/summary と並列に `data/reports.json?t=…` を取得。**404・JSON 不正・オブジェクトでない場合はレポート欄自体を出さない**（エラー帯なし・他の表示に影響なし）。サンプル表示時は `sample/reports.json` を読む。
- `daily` / `weekly` が空配列・片方だけの期間は、その欄に案内文を表示（文言は `assets/js/config.js` の `REPORT_TEXT`）。
- 未知フィールドは無視し、型が違う値は「不明」と表示。文字列はすべて `textContent` で表示（タグは文字のまま）。

- 条件（「2時間以内で15万以上」など）は**データ側が文字列の `condition_label` で渡し**、フロントはしきい値を持たない（基準が変わってもフロントの改修不要）。
- 投稿本体は `id` で posts.json を引く（本文・指標を二重に持たない）。posts.json に無い id は「Xで開く」だけ表示する想定。
- ファイルが無い／壊れている場合は該当欄を出さないだけにする（他の表示に影響させない）。

```jsonc
{
  "generated_at": "2026-10-12T23:59:00+09:00",
  "daily": [
    {
      "date": "2026-10-12",
      "rising": [   // 伸びている投稿（最大10件・データ側の並び順のまま表示）
        { "id": "1844…", "views": 382000, "hours_since_post": 3.0, "views_per_hour": 127333,
          "condition_label": "投稿から6時間以内で30万表示以上" }
      ],
      "review": [   // 答え合わせ（前日に rising に載せた投稿のその後）
        { "id": "1844…", "before_views": 382000, "after_views": 625000, "crossed_500k": true }
      ],
      "hit_rate": [ // 条件ごとの的中（何件中何件が50万超え）
        { "condition_label": "投稿から6時間以内で30万表示以上", "total": 4, "crossed": 3 }
      ]
    }
  ],
  "weekly": [
    {
      "period": { "from": "2026-10-10", "to": "2026-10-17" },   // 対象の7日間
      "generated_at": "2026-10-17T12:00:00+09:00",
      "hit_rate_by_condition": [ { "condition_label": "…", "total": 20, "crossed": 11 } ],
      "hit_rate_by_pace": [ { "pace_label": "1時間あたり10万以上", "total": 8, "crossed": 6 } ],
      "threshold_proposal": "2時間以内の基準を15万→12万に下げる案 …（自由記述テキスト。そのまま textContent で表示）",
      "watch_candidates": [ { "user": "…", "reason": "…" } ]   // 見張りアカウントの追加候補
    }
  ]
}
```

### 画面（サマリーの下「レポート」）

- **デイリー**（日付セレクタ。既定は最新の `date`）
  - 伸びている投稿: データ側の並び順のまま、posts.json の投稿カードを再利用（最初の 3 件＋「残り N件を表示」）。帯に `condition_label` と「投稿から3時間で38.2万表示（1時間あたり12.7万）」（`views`・`hours_since_post` から。1時間あたりは `views_per_hour` を優先）。posts.json に無い id は「この投稿は posts.json に含まれていません」＋「Xで開く」（`https://x.com/i/web/status/<id>`）のみ
  - 答え合わせ: 表（投稿／前→後（万表記）／50万超えバッジ）。判定は `crossed_500k` の真偽値をそのまま使い、「50万」は列名・バッジの文言にだけ使う
  - 条件ごとの的中率: 「n件中m件（xx%）」＋横棒（自前 SVG、1 色のメーター型）。`total=0` は「対象なし」
- **週間**（期間セレクタ。既定は最新の `period`）: 条件別・ペース別の的中率（同じ表示）、基準の見直し案（改行保持）、見張りアカウントの追加候補（クリックでそのアカウントに絞り込み、理由を併記）
- 選択中の日付・週（`rdate`・`rweek`）と各欄の開閉（閉じた欄を `rc=report|daily|weekly`）を URL に保存
- しきい値・条件の文字列はすべてデータから表示し、画面側には持たない

## サンプル表示の仕組み

1. `data/posts.json` と `data/summary.json` を並列に取得（`?t=<時刻>` 付き）
2. `data/posts.json` が 404・JSON 不正・形式不正なら `sample/posts.json`・`sample/summary.json` を読み、上部に「サンプルデータを表示中（data/ が見つかりません）」と理由を表示
3. どちらも読めなければエラー画面（「再読み込み」ボタン）

※ data/ が無い状態では、ブラウザの開発者ツールに `data/posts.json` の 404 が 1〜2 行記録されます（ブラウザの仕様で抑止できません。動作上の問題はありません）。

サンプルは `tools/make-sample.mjs` で決定的に生成しています（約 1,500 件。ユーザー名は `sample_` 始まりの架空、本文は「【サンプル】」で始まる）。未知カテゴリ「テスト新カテゴリ」、監視アカウント、URL だけの本文、2016 年の古い投稿、改行・t.co URL、`<script>` や `<img onerror>` を含む本文、指標の欠損、`media`（写真 1〜4 枚・動画・GIF・mp4 無し・許可外ドメイン）を含みます。埋め込み用の ID は実在しないため、X埋め込み表示ではフォールバック表示になります。`sample/reports.json` には、デイリー 2 日分（posts.json に無い id・型違いの値・タグ入りの条件名を含む）と週間 2 週分を入れています。

```sh
node tools/make-sample.mjs                 # sample/ を再生成（1,500 件）
node tools/make-sample.mjs 3000 /tmp/big   # 件数・出力先を指定（性能確認用。data/ には出力しないこと）
```

## ローカルでの確認

ES modules と `fetch` を使うため、`file://` で直接開くと動きません。リポジトリ直下で簡易サーバーを起動してください（`npx serve` などのインストールは不要）。

```sh
cd X-trend
python3 -m http.server 8000 --bind 127.0.0.1
# → http://127.0.0.1:8000/ を開く（data/ が無ければサンプル表示）
```

実データで確認したいときは、`data/posts.json`・`data/summary.json` を一時的に置いて確認し、**コミットしないで削除**してください（data/ はデータ側botの管轄です）。

### テスト

```sh
npm test   # test/dashboard.test.js（core.js の純粋関数）を含む全テスト
```

E2E（Playwright。リポジトリには依存を入れない）:

```sh
mkdir -p /path/to/qa && cd /path/to/qa && npm init -y && npm i playwright
PW_DIR=/path/to/qa/node_modules node test/e2e/dashboard-e2e.mjs
```

サンプルフォールバック・3,000 件の性能・summary 無し・空データ・XSS・未知カテゴリ・複数カテゴリ OR・AND 検索・監視のみ・アカウント絞り込み・URL 状態の復元・ライト/ダーク・外部通信遮断・埋め込み切替とフォールバック・メディア表示・許可外ドメイン拒否・スマホ幅（360/375px）を確認します。外部通信はすべてモック／遮断します。
