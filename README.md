# X-trend：Xレポート ダッシュボード

別botが定期収集しているXの投稿（夜職・歌舞伎町まわり）を、カテゴリ別に見やすく閲覧する静的Webページです。GitHub Pages で公開します（**https://www.x-yoru-buzz.com/**）。

- サーバー・API・DB は使いません（HTML / CSS / JavaScript のみ、ビルド不要）
- データは収集botが `data/posts.json`・`data/summary.json` に push。ページは読むだけ
- `data/` が無い間は `sample/` のサンプルを「サンプル表示中」と明示して表示
- 歌舞伎町ネオン調（アクセント赤、ダーク/ライトはOS設定に自動追従）、PC・スマホ対応
- カード表示 / ブログやnoteと同じ **X公式埋め込み表示** の切替、写真・動画表示

**別のAI・開発者への引き継ぎは [docs/HANDOFF.md](docs/HANDOFF.md) から。**

詳しくは [docs/DASHBOARD.md](docs/DASHBOARD.md)（公開手順・データ仕様・収集botへの依頼文）。

## ローカル確認
```bash
npm start          # = python3 -m http.server 8000 → http://localhost:8000
npm test           # 純粋関数の単体テスト
npm run sample     # サンプルデータ再生成
```

## 関連文書
- [docs/DASHBOARD_REQUIREMENTS.md](docs/DASHBOARD_REQUIREMENTS.md)：制作要件
- [docs/DATA_BOT_NOTICE_2026-10-11.md](docs/DATA_BOT_NOTICE_2026-10-11.md)：収集botの更新スケジュール変更（毎日23:59、週間は土曜12:00）
