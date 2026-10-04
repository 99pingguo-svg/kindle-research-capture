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
- QC（画像QC: 画質・写真間の整合性・違和感チェックを含む）は Claude Opus 5.5（`claude-opus-5-5`）で実施し、`save_qc_result` の `model` に記録する。サーバーは設定 `imageQcModels` 以外のモデルの QC を拒否する。

## 開発
- テスト: `npm test`（node:test）。UI は `npm run demo` → `INVENTORY_DATA=./demo-data npm start`。
- ユーザー確定（locks）と AI 提案（proposals）、ユーザー専用操作（`forbidAi`）の境界を崩さないこと。
- メルカリの画面構造（セレクタ等）をアプリ本体に入れないこと。
