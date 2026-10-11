# Xレポート ダッシュボード 制作要件

## 1. 目的
別botが定期収集しているXの投稿（夜職・歌舞伎町まわり）を、カテゴリ別に仕分けて視覚的に見やすく閲覧できるWebページを作る。

## 2. 構成（静的サイト）
- 公開先: GitHub Pages（静的ホスティング）
- サーバー・API・DBは使わない。HTML / CSS / JavaScript のみ
- データは同じリポジトリの `data/` 配下のJSONを `fetch` で読む
  - `data/posts.json` … 投稿一覧（分類済み）
  - `data/summary.json` … 集計データ
- JSONはデータ側が自動で更新・pushする。フロント側はJSONを書き換えない
- 相対パスで読むこと（例: `fetch('data/posts.json')`）。キャッシュ回避に `?t=` + 時刻を付ける

```
repo/
├── index.html      ← フロント担当が作る（CSS/JSは分けても可）
└── data/           ← データ側が自動更新（触らない）
    ├── posts.json
    └── summary.json
```

## 3. データ仕様（要点）
### posts.json
```json
{ "generated_at": "2026-10-11T18:41:00+09:00",
  "categories": ["ホスト","キャバクラ","歌舞伎町","夜職その他","監視アカウント","その他"],
  "posts": [ Post, ... ] }   // 新しい順
```
Post:
| フィールド | 型 | 説明 |
|---|---|---|
| id | string | 投稿ID（必ず文字列で扱う） |
| url | string | X上の投稿URL |
| user | string | ユーザー名（@なし） |
| created_jst | string\|null | 投稿日時JST。表示はこれ |
| ts | number | UNIX秒（並び替え・期間絞り込み用） |
| metrics | object | impression_count, like_count, retweet_count, reply_count, quote_count, bookmark_count |
| text | string | 本文（改行・t.co短縮URLあり） |
| categories | string[] | 該当カテゴリ（複数あり、必ず1つ以上） |
| matched_terms | string[] | 分類の根拠になった語（ハイライト用） |
| is_watched | boolean | 監視アカウントの投稿か |

- カテゴリは**固定で書かない**こと。`categories` 配列から動的に生成する（今後増える）

### summary.json
- total_posts, total_accounts, period{oldest_jst, newest_jst}, generated_at
- by_category {カテゴリ: {posts, impressions, likes}}
- by_account [{user, is_watched, posts, impressions, likes}]
- by_day [{date, posts, impressions, likes, categories{カテゴリ:件数}}] … 投稿のない日は含まれないので0埋めすること
- top_posts.by_impressions / by_likes（上位20件）

## 4. 画面要件
### 必須
1. **ヘッダー**: タイトル、最終更新日時（generated_at）、データ期間
2. **サマリーカード**: 総投稿数、アカウント数、合計インプレッション、最大インプレッションの投稿
3. **カテゴリフィルタ**: タブまたはチップで切替。各カテゴリに件数表示。複数選択可（OR）。カテゴリごとに色を固定
4. **絞り込み**: 期間（24時間 / 7日 / 30日 / すべて）、アカウント、キーワード検索（スペース区切りAND）、監視アカウントのみ
5. **並び替え**: 新しい順 / インプレッション / いいね / ブックマーク
6. **投稿カード**: ユーザー名、投稿日時（JST）、本文、各数値、カテゴリバッジ、Xで開くリンク（新規タブ）
7. **グラフ**: カテゴリ別の件数とインプレッション、日別の投稿数推移（カテゴリ別の積み上げが望ましい）
8. **上位アカウント一覧**: 投稿数・インプレッション順。クリックでそのアカウントに絞り込み

### 表示ルール
- 数値は万・億表記（1155424 → 115.5万、123456789 → 1.2億）
- 日時は「10/11 13:34」形式
- 本文の改行を保持、URLはリンク化
- 期間「24時間」等は**データの最新投稿時刻**基準でもよい（現在時刻基準だと更新が止まると0件になるため）

### あると良い
- 本文中の matched_terms をハイライト
- フィルタ状態をURLに保持（共有・再読込用）
- ダークモード
- 件数が多いので無限スクロールまたはページング（目安50件ずつ）

## 5. 非機能要件
- スマホ・PC両対応（レスポンシブ）
- 日本語UI
- 1,500〜数千件で軽快に動くこと（フィルタはクライアント側で処理）
- 外部ライブラリは使用可（Chart.js等、CDN可）。ビルド不要の構成が望ましい
- XSS対策: 本文は必ずエスケープしてから表示

## 6. 注意
- 本文がURLだけの投稿は「その他」に入る
- 2016年など古い投稿も少数混ざるため、日別グラフは表示期間を絞る
- 内容に夜職関連の投稿が含まれるため、公開範囲（公開/非公開リポジトリ）は要検討
