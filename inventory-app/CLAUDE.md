# 商品台帳 (shohin-daicho)

個人の商品在庫・撮影・メルカリ出品準備を、ユーザーと AI が共同で行うアプリ。

## 構成
- `server/` — Node 20+、依存ゼロ。`index.js`（HTTP / REST / `/mcp` / SSE / 静的配信）、`store.js`（ファイルベースの正本・履歴・ロック/提案）、`rules.js`（準備状況・機械チェック）、`mcp.js`（AI 用ツール）、`adapters/mercari.js`（メルカリ依存部分はここだけ）。
- `public/` — PWA（ビルドなし ES modules）。`camera.js` が撮影モード。
- `data/` — 正本（git 管理外）。`products/<id>/product.json` などそのまま読める形式。
- `.claude/skills/` — AI 作業手順（`inventory-ai`、`mercari-adapter`）。

## AI として作業するとき
- 商品データの読み書きは MCP `shohin-daicho` 経由（`.mcp.json`）。サーバー起動: `npm start`。
- 手順は `.claude/skills/inventory-ai/SKILL.md`。メルカリ転記は `.claude/skills/mercari-adapter/SKILL.md`。
- 出品判断は 出品／下書き／保留／出さない／在庫なし（ユーザーのみ）。「下書き」はメルカリへ下書き保存までで公開しない。
- 写真の種類: actual（ユーザー撮影の現物）・generated（注記入りのAI紹介画像。出品用に選べるが現物ではない）・reference（参考。出品不可）。
- 399商品の取り込み・更新同期は `node scripts/import-399.js`（元フォルダは読むだけ。変化は data/imports/update-ledger に記録）。
- 出品先は メルカリ／ジモティー／フリマ（`targets`、ユーザーのみ）。出品先ごとの原稿は `override.<出品先>.*` と出品先ごとの写真。各サイトへのアップロードは MCP `channel_package(id, channel)` を正本に読む。
- 取り込み元の正本（10/12〜）: 画像は `399商品_Claude画像制作共有/handoff_to_dot/COORDINATOR_CLAUDE/ADOPTION_LEDGER.json`（formally_adopted、役ごと）＋旧台帳で補完、原稿は販売用（products_resale）を優先、価格・分類は最新の `*/outputs/399商品_価格確認データ_*.json`。
- 多数の商品をまとめて変更する前は MCP `save_state_snapshot` で状態を保存する。ロールバックはユーザーのみ（`data/snapshots/`、セーブポイント=manual／自動保存=auto・before）。
- メルカリの状況確認は頼まれたときだけ（`channel_tracked` → 一覧を文字で読む → `channel_sync_status` を1回）。定期実行しない。
- QC（画像QC: 画質・写真間の整合性・違和感チェックを含む）は Claude Opus 5.5（`claude-opus-5-5`）で実施し、`save_qc_result` の `model` に記録する。サーバーは設定 `imageQcModels` 以外のモデルの QC を拒否する。

## 開発
- テスト: `npm test`（node:test）。UI は `npm run demo` → `INVENTORY_DATA=./demo-data npm start`。
- ユーザー確定（locks）と AI 提案（proposals）、ユーザー専用操作（`forbidAi`）の境界を崩さないこと。
- メルカリの画面構造（セレクタ等）をアプリ本体に入れないこと。
