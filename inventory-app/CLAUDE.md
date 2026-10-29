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
- 日付は 注文日・購入日（`orderDate`）／到着日（`arrivalDate`）／区別しない日付（`itemDate`）。種類は `category`（`server/category.js` の一覧。未設定は商品名から推定）。これらは整理用なので変更しても QC はやり直しにならない（FIELDS の `meta`）。
- 一覧の絞り込みは 状態チップ＋📅期間＋💴価格帯＋🔍条件（同じ見出しは OR、見出し間は AND）、並び順はキー＋向き。「保存した表示」は設定 `listViews`（ユーザーのみ・全端末共通）。
- 純正カメラ連携: アプリで撮影対象を決める（`PUT /api/native-shoot`、ユーザーのみ）→ iPhone の「カメラ」で撮影 → ショートカット「台帳に送る」が撮影開始後の写真を `POST /api/native-shoot/photos`（合言葉 `x-upload-key`、この2口だけ有効）へ送り、サーバーが sips で work/thumb を作る。画面は `public/js/native.js`。
- 写真の種類: actual（ユーザー撮影の現物）・generated（注記入りのAI紹介画像。出品用に選べるが現物ではない）・reference（参考。出品不可）。
- 399商品の取り込み・更新同期は `node scripts/import-399.js`（元フォルダは読むだけ。変化は data/imports/update-ledger に記録）。
- 出品先は メルカリ／ジモティー／フリマ（`targets`、ユーザーのみ）。出品先ごとの原稿は `override.<出品先>.*` と出品先ごとの写真。各サイトへのアップロードは MCP `channel_package(id, channel)` を正本に読む。
- 取り込み元の正本（10/12〜）: 画像は `399商品_Claude画像制作共有/handoff_to_dot/COORDINATOR_CLAUDE/ADOPTION_LEDGER.json`（formally_adopted、役ごと）＋旧台帳で補完、原稿は販売用（products_resale）を優先、価格・分類は最新の `*/outputs/399商品_価格確認データ_*.json`。
- ユーザーが同時にアプリで作業（判断・現物/パッケージ撮影）している前提で更新する: データは API（1件ずつ・該当欄だけ）で書き、product.json や写真フォルダを直接書き換えない。サーバー再起動は必要なときだけ。
- 多数の商品をまとめて変更する前は MCP `save_state_snapshot` で状態を保存する。ロールバックはユーザーのみ（`data/snapshots/`、セーブポイント=manual／自動保存=auto・before）。
- Amazon の公式画像・価格・サイズは `node scripts/amazon-info.js`（ログアウト状態の fetch・CAPTCHA なら中止）。新しい商品リストは `--add <リスト>`（ASIN で重複除外）。送料表は `server/shipping.js`（メルカリ公式の料金表。改定時はここだけ直す）。
- 相場（メルカリ売り切れ・ヤフオク落札・ラクマ売り切れ）は頼まれたときだけ `.claude/skills/mercari-market/SKILL.md` の手順で調べ、MCP `save_market_research`（`site`）に記録（同じ商品=same／似た商品=similar を必ず区別）。まとめて調べるときはローカルAI（無料）で: `site-scan.js` → `judge-tasks.js` → `local_judge.py`（Ollama qwen3.5:4b）→ `judge-decide.js` → `apply-market.js --site`。同じ商品は写真がほぼ一致するもの（dHash 距離10以下、AI「同じ」なら12以下）だけ。
- メルカリの状況確認は頼まれたときだけ（`channel_tracked` → 一覧を文字で読む → `channel_sync_status` を1回）。定期実行しない。
- QC（画像QC: 画質・写真間の整合性・違和感チェックを含む）は Claude Opus 5.5（`claude-opus-5-5`）で実施し、`save_qc_result` の `model` に記録する。サーバーは設定 `imageQcModels` 以外のモデルの QC を拒否する。

## 開発
- 軽さのための作り: 一覧は20件ずつ描画（スクロールで追加・更新時は位置を保つ）、一覧のサムネは `x.mini.jpg`（256px、初回要求時に `sips` で作成）、JSON と JS/CSS は gzip・ETag で 304。行に `content-visibility` を付けない（再描画で位置がずれる）。
- テスト: `npm test`（node:test）。UI は `npm run demo` → `INVENTORY_DATA=./demo-data npm start`。
- ユーザー確定（locks）と AI 提案（proposals）、ユーザー専用操作（`forbidAi`）の境界を崩さないこと。
- メルカリの画面構造（セレクタ等）をアプリ本体に入れないこと。
