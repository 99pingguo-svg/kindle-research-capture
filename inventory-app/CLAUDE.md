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
- 検索（`public/js/search.js`）: 全角半角・カナ/ひらがな・空白・記号・長音・フォ/ホ を無視した部分一致。含まれる語＝一致（選んだ並び順）、5文字以上で1〜2文字違い・長い語の大きな一部・3語以上で1語欠け＝「近い候補」（一致の後ろ・近い順）。数字の語（ID・JAN）は打った通りだけ。📷＝写真の文字とバーコードを Mac で読む（`POST /api/ocr` → `tools/bin/ocr`＝macOS Vision・日英、写真は保存しない。ビルド `npm run build:ocr`）→ JAN 一致・商品名の重なりで候補を出す。候補をタップするとその写真を現物写真（source `search`）として追加し自動仕上げへ（文字で探した場合は詳細に「この商品の写真にする」、15分間）。
- Amazon管理番号（`fnsku`、X00…の倉庫ラベル）: 撮った現物写真が届くたびに `server/codes.js` が `tools/bin/ocr` で読み、空なら入れる（今ある写真は `POST /api/codes/backfill`）。検索欄・📷で一致。📷で未登録の番号を読んだら、選んだ商品に登録。
- メモ（`notes`）は一覧の行と詳細の 📝 からシートで編集（`public/js/quick.js`。🎤＝ブラウザの音声認識、なければキーボードの音声入力）。
- 純正カメラ連携: アプリで撮影対象を決める（`PUT /api/native-shoot`、ユーザーのみ）→ iPhone の「カメラ」で撮影 → ショートカット「台帳に送る」が撮影開始後の写真を `POST /api/native-shoot/photos`（合言葉 `x-upload-key`、この2口だけ有効）へ送り、サーバーが sips で work/thumb を作る。画面は `public/js/native.js`。ショートカットは `tools/make_shortcuts.py` が作り `shortcuts sign` で署名、`GET /api/native-shoot/shortcut/camera|send` で配る（send は合言葉入り）。撮影開始前の写真は EXIF の撮影日時で除外。
- 撮った写真の自動仕上げ（`server/studio.js`、設定 `autoStudio`）: 届いた現物写真ごとに `tools/bin/studio`（macOS Vision の切り抜き＋自動補正。ビルド `npm run build:studio`）で切り抜き→白抜き（主）とグレーのスタジオ背景（候補）の2枚・商品は正方形の約72%で少し上寄せ・接地影・色補正は控えめ・商品に落ちた影を明るく（設定 `studioStyle`）。白い商品は白く（明るい部分を白に・色かぶり除去）・陰の側を明るい側へ・周りの影は薄く下だけ。仕上げの指針は `tools/STUDIO_GUIDE.md`（変えたら VERSION を上げて redo）。四角い・細長い商品の傾き1.5〜30°を補正、余白は形で決める（細長い0.86・やや長い0.82・四角0.76）。90°/180°の向き直しは文字認識が当てにならず不採用（EXIFのまま）。ローカルAIの欠け判定は誤りが多いので「要確認」と書くだけ。旧仕上げの作り直しは `POST /api/studio/redo`（AIが作った仕上げは同じ写真のまま画像だけ差し替え `refinishPhoto`、前の画像は消さない）。
- 開封チェック済み（`openCheckedAt`、ユーザーのみ・`POST /api/products/:id/open-check`）: 一覧の行と詳細のチェック。絞り込みチップ「開封未チェック」「開封チェック済み」。
- 一覧の行の色: 出さない（薄い赤）・在庫なし（グレー）が優先、それ以外でフリマに入っていればオレンジの縁と淡い地。（`--deshadow`、設定 `studioDeshadow` 既定0.6。qwen3.5:4b は影の有無を見分けられず gemma4:26b は1枚3分・16GB で不採用→数値処理）（白っぽい商品は薄いグレー背景、はみ出し・大写しは色補正のみ）→ ローカルAI（Ollama qwen3.5:4b）が欠けを確認 → 編集写真（source=studio）として追加し出品用で元写真と入れ替え（🔒確定時は入れ替えない）。未処理分は `POST /api/studio/run`。
- 写真の種類: actual（ユーザー撮影の現物）・generated（注記入りのAI紹介画像。出品用に選べるが現物ではない）・reference（参考。出品不可）。
- 399商品の取り込み・更新同期は `node scripts/import-399.js`（元フォルダは読むだけ。変化は data/imports/update-ledger に記録）。
- 出品先は メルカリ／ジモティー／ヤフオク／ヤフーフリマ（id `paypay`）／ラクマ／フリマ（`targets`、ユーザーのみ。一覧は `server/schema.js` の `CHANNELS`）。既定ルール（`server/defaults.js`、設定 `fleaDefault`）: Amazon 1,000円以下 または 手取り 700円以下 の商品にフリマを商品ごとに1回だけ自動で入れる（actor `system`）。手取りのおすすめ（設定 `netDefault`）: `channelNets`（サイトの売り切れ中央値−手数料 `SITE_FEES`−送料）で一番よいサイトと差が100円か1割以内のサイトを入れ、相場が変われば自分が入れた分だけ入れ替える。規則が入れた出品先は緑（summary `targetAuto`）。ユーザーが手で付け外しした出品先（`targetsManual`）には触らない。飲食料品（`server/food.js`: 種類「食品・飲料」＋サプリ・ペット用飲食品の語）はフリマを既定で入れず、既存は手で入れたものも商品ごとに1回外す（`foodFleaRuleAt`）。手で入れるのは確認ダイアログ経由だけ（サーバーも `confirmFoodFlea` なしは409で拒否）。出品先ごとの原稿は `override.<出品先>.*` と出品先ごとの写真。各サイトへのアップロードは MCP `channel_package(id, channel)` を正本に読む。
- 取り込み元の正本（10/12〜）: 画像は `399商品_Claude画像制作共有/handoff_to_dot/COORDINATOR_CLAUDE/ADOPTION_LEDGER.json`（formally_adopted、役ごと）＋旧台帳で補完、原稿は販売用（products_resale）を優先、価格・分類は最新の `*/outputs/399商品_価格確認データ_*.json`。
- ユーザーが同時にアプリで作業（判断・現物/パッケージ撮影）している前提で更新する: データは API（1件ずつ・該当欄だけ）で書き、product.json や写真フォルダを直接書き換えない。サーバー再起動は必要なときだけ。
- 多数の商品をまとめて変更する前は MCP `save_state_snapshot` で状態を保存する。ロールバックはユーザーのみ（`data/snapshots/`、セーブポイント=manual／自動保存=auto・before）。
- Amazon の公式画像・価格・サイズは `node scripts/amazon-info.js`（ログアウト状態の fetch・CAPTCHA なら中止）。新しい商品リストは `--add <リスト>`（ASIN で重複除外）。送料表は `server/shipping.js`（メルカリ公式の料金表。改定時はここだけ直す）。
- 相場（メルカリ売り切れ・ヤフオク落札・ヤフーフリマ売り切れ・ラクマ売り切れ。記録は `market`／`marketYahoo`／`marketPaypay`／`marketRakuma`）は頼まれたときだけ `.claude/skills/mercari-market/SKILL.md` の手順で調べ、MCP `save_market_research`（`site`）に記録（同じ商品=same／似た商品=similar を必ず区別）。まとめて調べるときはローカルAI（無料）で: `site-scan.js` → `judge-tasks.js` → `local_judge.py`（Ollama qwen3.5:4b）→ `judge-decide.js` → `apply-market.js --site`。同じ商品は写真がほぼ一致するもの（dHash 距離10以下、AI「同じ」なら12以下）だけ。手取り（`mercariNet`）は 同じ商品の相場（メルカリ→ヤフーフリマ→ラクマ→ヤフオク）→ 似た商品の相場（同じ順・「参考手取り」と表示）→ 販売価格 の順で出す。一覧の相場ボタンは中央値に近い売れた商品へ直接、詳細は各サイトの売り切れ一覧へのリンクを別に置く。
- メルカリの状況確認は頼まれたときだけ（`channel_tracked` → 一覧を文字で読む → `channel_sync_status` を1回）。定期実行しない。
- QC（画像QC: 画質・写真間の整合性・違和感チェックを含む）は Claude Opus 5.5（`claude-opus-5-5`）で実施し、`save_qc_result` の `model` に記録する。サーバーは設定 `imageQcModels` 以外のモデルの QC を拒否する。

- 公開用アプリの素材: `node scripts/export-public.js` → `exports/public-kit/`（外に出してよい項目だけ・AI仕上げ写真。git 管理外）。引き継ぎ書は `docs/HANDOFF_PUBLIC_APP.md`、キットの項目は `docs/PUBLIC_KIT_SCHEMA.md`。

## 開発
- 軽さのための作り: 一覧は20件ずつ描画（スクロールで追加・更新時は位置を保つ）、一覧のサムネは `x.mini.jpg`（256px、初回要求時に `sips` で作成）、JSON と JS/CSS は gzip・ETag で 304。行に `content-visibility` を付けない（再描画で位置がずれる）。
- テスト: `npm test`（node:test）。UI は `npm run demo` → `INVENTORY_DATA=./demo-data npm start`。
- ユーザー確定（locks）と AI 提案（proposals）、ユーザー専用操作（`forbidAi`）の境界を崩さないこと。
- メルカリの画面構造（セレクタ等）をアプリ本体に入れないこと。
