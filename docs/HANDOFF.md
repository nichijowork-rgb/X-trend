# X-trend 引き継ぎ書（別のAI・開発者向け）

このリポジトリで作っている「Xレポート ダッシュボード」の作り方・決まりごと・経緯をまとめた文書です。**作業を始める前に最後まで読んでください。** 詳細な画面仕様とデータ仕様は [DASHBOARD.md](DASHBOARD.md)、元の要件は [DASHBOARD_REQUIREMENTS.md](DASHBOARD_REQUIREMENTS.md) にあります。

---

## 1. 何を作っているか

- **目的**: 別の収集botが定期収集しているXの投稿（夜職＝ホスト・キャバクラ・歌舞伎町まわり／一般のバズ）を、カテゴリ別に見やすく閲覧する Web ページ。業界把握と投稿ネタ探しに使う。
- **公開URL**: https://www.x-yoru-buzz.com/ （GitHub Pages ＋独自ドメイン。旧URL `nichijowork-rgb.github.io/X-trend/` は自動転送）
- **リポジトリ**: `nichijowork-rgb/X-trend`（公開リポジトリ）
- **公開ブランチ**: `claude/x-scraper-nightlife-tool-sb26pq`（これがデフォルトブランチ兼 Pages の配信元。main は無い）
- **利用者**: 非エンジニアのオーナー1名。説明は日本語・専門用語少なめで。

## 2. 全体構成（役割分担）

```
[収集bot（別担当・別管理）]
   毎日 23:59 JST の集計 → 0時台に data/*.json を push
        │
        ▼
[このリポジトリ]  ← GitHub Pages が push のたびに自動配信
   index.html + assets/  … ダッシュボード（読むだけ）
   data/                 … botだけが書く（フロントは絶対に触らない・コミットしない）
        │
        ▼
[閲覧者のブラウザ]  JSON を1回だけ取得して、絞り込み・並べ替えはすべて画面側で処理
```

- **サーバー・API・DB・ビルドは無し**。HTML / CSS / ES modules の素の JavaScript だけ。外部ライブラリも無し（グラフは自前 SVG）。
- 収集botの担当者とはオーナー経由でメッセージをやり取りする（直接の連絡手段は無い）。botへの依頼は「依頼文」を書いてオーナーに渡す。

## 3. ファイル構成

| パス | 役割 |
|---|---|
| `index.html` | ページ本体。CSP（通信先の制限）と `noindex` を設定 |
| `assets/dashboard.js` | エントリ。読み込み・状態管理・描画・イベント |
| `assets/js/core.js` | **DOM 非依存の純粋関数**（数値/日時の書式、フィルタ、並べ替え、集計、URL 状態、伸びペース、reports 正規化など）。単体テストの対象 |
| `assets/js/config.js` | **運用で変わる値と文言の置き場所**（更新スケジュール、レポート文言、カテゴリのグループ定義、表示名） |
| `assets/js/charts.js` | グラフ（横棒・日別積み上げ）。自前 SVG |
| `assets/js/embed.js` | X公式埋め込み（widgets.js の遅延読み込み、画面に近いものだけ生成） |
| `assets/js/media.js` | 写真・動画・GIF とライトボックス。pbs.twimg.com の画像サイズ指定 |
| `assets/js/theme-init.js` | テーマ初期化（OS設定に自動追従のみ。旧保存値の掃除） |
| `assets/dashboard.css` | デザイン。色はすべて `:root` のトークン |
| `sample/*.json` | サンプルデータ（`data/` が無い・壊れているとき表示） |
| `tools/make-sample.mjs` | サンプルの決定的生成（`npm run sample`） |
| `test/dashboard.test.js` | 単体テスト（node:test） |
| `test/e2e/dashboard-e2e.mjs` | E2E（Playwright。リポジトリに依存は入れない） |
| `CNAME` | 独自ドメイン `www.x-yoru-buzz.com`。**消さない** |
| `data/` | 収集botの管轄。読むだけ |
| `show/` | **配信番組サイト**（台本・進行・映す用。下記 10 章・[SHOW_SPEC.md](SHOW_SPEC.md)） |

## 4. データ（収集botとの取り決め）

詳細は [DASHBOARD.md](DASHBOARD.md) の「データ側botとの取り決め」「レポート欄」。要点：

- `data/posts.json`（必須）: `{ generated_at, categories[], posts[] }`。Post は `id`(文字列) / `url` / `user` / `created_jst` / `ts`(UNIX秒) / `metrics`{impression_count, like_count, retweet_count, reply_count, quote_count, bookmark_count} / `text` / `categories[]` / `matched_terms[]` / `is_watched` / 任意の `media[]`。
- `data/summary.json`（任意）: 集計値。絞り込み後の件数が全件と同じときだけ使い、それ以外は画面側で集計。
- `data/reports.json`（任意）: `daily[]`（`date`, `rising`, `rising_watch`, `review`, `hit_rate`）と `weekly[]`。どの配列も空の日がある。
- カテゴリ: `ホスト / キャバクラ / 歌舞伎町 / 夜職その他 / 監視アカウント / その他`。全投稿に話題カテゴリ（夜職4種かその他）が必ず1つ以上付く（bot対応済み）。「監視アカウント」は話題ではなく「見張り対象の人」の印。
- 更新: 毎日 23:59 JST 集計 → 0時台に push。週間は土曜 12:00（初回 10/17）。

## 5. 画面仕様の要点（ユーザーが決めたこと）

変更するときは、ここに書いた決定を崩さないこと。

- **見た目**: 歌舞伎町ネオン調、アクセントは**赤**（ダーク `#ff3b4e` / ライト `#d0102a`）。基本UIはシンプル。ダーク/ライトは**OS設定に自動追従**（切替ボタンは無し）。PC・スマホ両対応（360px で横スクロールなし、タップ領域 44px 以上）。
- **ヘッダー右上**: ［夜職｜一般のバズ］切替（URL `group=`）。
- **初期状態**（URL指定なし・「条件をクリア」）: **24時間・夜職すべて・インプレッションが多い順**。
- **カテゴリチップ**: 夜職モードで［夜職すべて］［ホスト］［キャバクラ］［歌舞伎町］［夜職その他］。「すべて」「監視アカウント」「一般のバズ」チップは無い。「その他」は画面上「一般のバズ」と表示。
- **期間**: 24時間 / 3日 / 7日 / 30日（「すべて」は廃止。旧 `period=all` は 30日扱い）。**基準時刻は現在時刻ではなく `generated_at`**（更新が止まっても0件にならないため）。
- **並び替え**: 新しい順 / インプレッションが多い順 / いいねが多い順 / ブックマークが多い順 / 伸びペースが速い順。
- **投稿カード**: 本文（長文は4行で折りたたみ「続きを読む」）、カテゴリバッジ、伸びペース行、数値6種（1行）、「埋め込みで見る」「Xで開く」。**「監視」バッジは表示しない**。
- **表示切替**: カード（既定）／X埋め込み。
- **「伸びている」ボタン**（専用パネル）: reports.json の `rising` と補足 `rising_watch`。**夜職関連のみ**（一般のバズのみの投稿は除外）。条件の説明文は `condition_label` から生成し、**しきい値（15万等）を画面に決め打ちしない**。
- **「詳細」ボタン**（折りたたみ）: 検索・アカウント・監視のみ、サマリー、答え合わせ（夜職のみ）・的中率・週間、グラフ、上位アカウント。
- **空データ**: 各セクションは独立。空なら「該当なし」。どれかが空でも他を止めない。
- **不明な数値**は「不明」と表示し 0 や推測で埋めない。並べ替えでは末尾。
- **順位**は「取得した候補内」。X全体の順位とは書かない。
- **性能**: JSON は最初の1回だけ取得。投稿は最初20件、スクロールで20件ずつ追加。画像は `loading="lazy"` かつ小サイズ（`name=small`、拡大時 `large`）。動画はサムネイル→クリックで再生（`preload="none"`）。埋め込みは画面に近い分だけ。

## 6. 守るべきルール

1. **`data/` を変更・コミットしない**（`git add -A ':!data'` を使う）。botと競合する。
2. **安全**: 本文などは必ず `textContent` / DOM 生成で入れる（`innerHTML` 禁止）。リンク化は http(s) のみ、`rel="noopener noreferrer"`。メディアは `https://pbs.twimg.com` / `video.twimg.com` のみ。CSP を緩めるときは最小限に。
3. **決め打ち禁止**: botが変える可能性がある値（しきい値、条件名、カテゴリ一覧）は画面に固定しない。運用値・文言は `config.js` に集約。
4. **URL 状態**: フィルタはハッシュに保存（既定値と違うものだけ）。旧URLとの互換を壊さない。localStorage は try/catch。
5. **テスト**: 変更したら `npm test`（単体）と E2E を全件通す。見た目の変更は 1280px と 375px、ダーク/ライトでスクリーンショットを撮って目視。
6. **コミット**: 作業ブランチ `claude/x-scraper-nightlife-tool-sb26pq` に直接。push 前に `git pull --no-rebase` （botが頻繁に data/ を push するため）。
7. **ドキュメント**: 仕様を変えたら [DASHBOARD.md](DASHBOARD.md) も更新。

## 7. 開発・確認の手順

```bash
npm start      # = python3 -m http.server 8000 → http://localhost:8000（file:// では動かない）
npm test       # 単体テスト（node 22+）
npm run sample # サンプル再生成（sample/ に出力。data/ には出さない）

# E2E（Playwright は別ディレクトリに入れる）
mkdir -p /tmp/qa && cd /tmp/qa && npm init -y && npm i playwright
PW_DIR=/tmp/qa/node_modules node test/e2e/dashboard-e2e.mjs
```

- 公開への反映: push すると GitHub Actions の「pages build and deployment」が自動で走り、1〜2分で公開。ブラウザ側に最大10分程度キャッシュが残ることがある。
- 独自ドメインの DNS（ムームーDNS）: `www` CNAME → `nichijowork-rgb.github.io`、apex A × 4（185.199.108–111.153）。GitHub Pages 設定で Enforce HTTPS 有効。

## 8. これまでの経緯（主な変更順）

1. 当初は Node サーバー版アプリ（収集機能つき）を作成 → オーナーの判断で廃止し、**静的ダッシュボード＋別botのデータ**の構成に切り替え。
2. 要件書どおりのダッシュボード（カテゴリ別、絞り込み、グラフ、上位アカウント、ネオンUI）。
3. X公式埋め込み表示・写真/動画表示を追加。
4. botの更新が1日1回（23:59）に変更 → 次回更新表示、期間基準を generated_at に、伸びペース並べ替えを追加。
5. reports.json（伸びている投稿・答え合わせ・的中率・週間）を表示。
6. UIを簡潔化（詳細パネルに集約）、アクセントを赤に。
7. 「すべて」を廃止し［夜職すべて］／［一般のバズ］に分離、初期状態を 24時間・夜職すべて・インプレッション順に。botが全投稿に話題カテゴリを付けるよう対応。
8. テーマ切替を廃止し右上を［夜職｜一般のバズ］切替に。「監視」バッジ非表示。
9. 伸びている投稿を専用ボタンへ。夜職のみ、補足 `rising_watch`（10万〜20万の伸び始め）を追加。説明文を平易に。
10. 期間を 24時間/3日/7日/30日 に。
11. 表示速度改善（初回20件、画像の小サイズ化）、空データは「該当なし」。

## 9. 未解決・今後の候補

- X公式埋め込みと実画像の表示は、開発環境から X に接続できないため**実機でのみ確認可能**。
- 的中率（hit_rate）は bot の集計をそのまま表示しており、一般のバズを含む場合がある。
- 週間レポートは 10/17（土）が初回。届いたら表示確認が必要。
- ドメイン（ムームードメイン）は自動更新。2年目以降 年 約2,200円。

## 10. 配信番組サイト（/show/）

- 公開URL: https://www.x-yoru-buzz.com/show/ 。ダッシュボードとはヘッダー上部の［ダッシュボード｜番組］タブで行き来（ダッシュボード側の変更は `index.html` のタブと `dashboard.css` 末尾のスタイルだけ）。
- 週1回（土 1:00、約90分）のニュース形式トーク配信の台本・進行サイト。画面は ①編成 `#plan` ②進行 `#live` ③映す用 `#onair`（1920×1080・OBS 用）④振り返り `#review`。
- **v2 段階1（2026-10-31）**: 画面半分（960×1040）基準。編成は**フォルダ型**（左の木＝番組構成〈メイン1〜3・メイン候補・カテゴリ別・雑談〉／まとまり／受信箱／★ブクマ／NEW／片付け／ゴミ箱、右＝行リスト＋プレビュー）。pointer events のドラッグ＆ドロップ・複数選択・一括操作・右クリック・「移動先…」・常設検索・新しいまとまり・名前変更・ジャンル上書き（投稿 ID で全週）・元に戻す/やり直す（Ctrl+Z/Y）・一般のバズはおすすめ 30 件・仕分けモード（1/2/3/G/X/→/←）。進行は縦 1 列。進行状態は `show/js/events.js` から 1 か所で発行（段階2で OBS WebSocket へ）。計画は [SHOW_V2_PLAN.md](SHOW_V2_PLAN.md)。純粋ロジックは `show/js/logic.js` と `show/js/folders.js`。
- データは `data/posts.json`・`bookmarks.json` を読むだけ（`show_pick: true` が付いた投稿は雑談おすすめの最優先＝段階3の受け口）。番組の状態（編成・台本・進行・持ち越し・辞書）は**ブラウザの localStorage** に保存＋JSON の書き出し/読み込み。公開ファイルには書かない。
- 仕様・ファイル構成・保存データの形・使い方は [SHOW_SPEC.md](SHOW_SPEC.md) の「実装メモ」。テストは `npm test`（`test/show.test.js` を含む）と `PW_DIR=… node test/e2e/show-e2e.mjs`。サンプルは `sample/show/`（`node tools/make-show-sample.mjs`）。
