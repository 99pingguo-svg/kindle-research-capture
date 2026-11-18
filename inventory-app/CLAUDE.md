# 商品台帳 (shohin-daicho)

手元の物が「あるかないか」を気軽に確かめ、レビュー・発信（Vineレビュー・ブログ・動画）と出品をどうするかを決める、ユーザーと AI エージェントの共同作業のハブ。

- 一覧の基本は「あるかないか表示」（設定 `view`: check。≡で従来の詳しい表示）: 行ごとに ある／ない／？（`POST /api/products/:id/presence`、ユーザーのみ。ない＝出品判断「在庫なし」、ある＝最新在庫チェック、？＝在庫不明）・種類と置き場（設定 `categoryPlaces`、商品の「保管場所」が優先）・レビューの予定（`reviewPlan`: 未定／しない／する／下書きあり／投稿OK／投稿済み＋形式 vine/blog/video/sns・メモ・下書き・URL。`PUT /api/products/:id/review-plan`、AI は下書きと投稿OK後の投稿済み報告だけ）。チップ「未チェック・ある・ない・わからない・レビュー予定」。
- ほかのエージェント（Muse など）に渡す共有入口は `docs/SHARED_ENTRY.md`（つなぎ方・できること・メールからの台帳更新・場所・触らないもの）。画面を操作するエージェントは `?as=<名前>` で開く（そのタブは AI の名前で記録・ユーザー専用の操作は断られる、`public/js/api.js` の `actor`）。連絡帳は `agent-notes/NOTES.md`（git 管理外）。
- AI エージェントの入口は `docs/AGENT_HUB.md`（MCP `agent_queue`・`get_materials`・`save_review_draft`・`mark_review_posted`、`GET /api/agent/queue`）。素材Zip は `GET /api/materials.zip?ids=…` または `?presence=have`（公式画像・写真・仕上げ・紹介画像・info.json・情報.txt・下書き）。
- 自動: 種類が空の商品を分類（`server/categorize.js`、決まりごと→ローカルAI qwen3.5:4b、設定 `autoCategory`）。ASIN があって公式画像がない商品を30分ごとに10件、ログアウト状態で取得（`server/official.js` が `scripts/amazon-info.js` を呼ぶ、ロボット確認で12時間休む、設定 `autoOfficial`、状況 `GET /api/auto-jobs`）。新しい商品は観察ブラウザ連携（sync.py）が足す。テスト中（NODE_TEST_CONTEXT）は動かさない。

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
- 純正カメラ（基本の流れ・いちばん簡単な形）: 商品の「📸 純正カメラで撮る」→ ショートカット「台帳カメラ」（「アプリを開く: カメラ」だけ。合言葉なし）→ 撮って台帳に戻ると「🖼 撮った写真から選んで登録」（iPhone の写真選択→その商品の現物写真、source `native-pick`、自動仕上げへ）。詳細の「🖼 撮った写真から登録」も同じ（`pickPhotosFor`、`public/js/native.js`）。自動で送って消す版（戻るまで待機・削除）は iPhone で「パラメータが違う」と動かず取りやめ。撮影トレイ（`server/tray.js`）は「台帳に送る」で届いた写真用に残す。
- 純正カメラの写真をまとめて取り込む（いちばん簡単・ショートカット不要、`public/js/bulkimport.js`）: 一覧の下の「📸 写真を取り込む」で写真を選ぶ → 撮影時刻（EXIF、`public/js/photo-time.js`）の間で組に分け、組の写真を `POST /api/ocr` で読んで Amazon管理番号・JAN・商品名から商品を推す → 確かめて取り込む（source `native-pick`、自動仕上げへ）。
- 写真の取り込みの候補（2026-11-18）: 組ごとに写真の FNSKU・JAN・商品名で台帳の商品と、⋯→🔢 の注文の一覧で台帳にない注文（商品名）を探す。FNSKU/JAN 一致か、商品名が強く次点を大きく離すときだけ自動で決め、ほかは Amazon の公式画像つきの候補を並べて見比べる（📷撮影あり/撮影なし）。「＋新規」か台帳にない注文を選ぶと、取り込みの前に商品を作る（注文日・Amazonの商品名つき→日付ID・商品IDは自動、FNSKU は写真から codes.js が入れる）。撮影日 `shotDate`／初撮影日 `firstShotDate`（現物写真の撮影時刻の日本の日付、仕上げは数えない）は 📅期間・👁 日付の範囲で隠す・並び順に使える。
- 純正カメラ連携: アプリで撮影対象を決める（`PUT /api/native-shoot`、ユーザーのみ）→ ショートカット「台帳で撮る」が「カメラ」を開き、「戻るまで待機」（`is.workflow.actions.waittoreturn`）で左上の「◀ ショートカット」で戻るのを待って、最新の写真（10枚まで）を（送り直し用は「台帳に送る」） `POST /api/native-shoot/photos`（合言葉 `x-upload-key`、この2口だけ有効）へ送り、サーバーが sips で work/thumb を作る。画面は `public/js/native.js`。ショートカットは `tools/make_shortcuts.py` が作り `shortcuts sign` で署名、`GET /api/native-shoot/shortcut/camera|send` で配る（send は合言葉入り）。撮影開始前の写真は EXIF の撮影日時で除外。ショートカットからの連絡（合言葉違い・撮影中の商品なし・受け取り結果）は `GET /api/native-shoot/contacts`（メモリに20件）で取込画面・設定画面に出す。Mac の中だけのアドレス（127.0.0.1 等）ではショートカットを作らない（iPhone から届かないため）。
- 撮った写真の自動仕上げ（`server/studio.js`、設定 `autoStudio`）: 届いた現物写真ごとに `tools/bin/studio`（macOS Vision の切り抜き＋自動補正。ビルド `npm run build:studio`）で切り抜き→白抜き（主）とグレーのスタジオ背景（候補）の2枚・商品は正方形の約72%で少し上寄せ・接地影・色補正は控えめ・商品に落ちた影を明るく（設定 `studioStyle`）。白い商品は白く（明るい部分を白に・色かぶり除去）・陰の側を明るい側へ・周りの影は薄く下だけ。仕上げの指針は `tools/STUDIO_GUIDE.md`（変えたら VERSION を上げて redo）。四角い・細長い商品の傾き1.5〜30°を補正、余白は形で決める（細長い0.86・やや長い0.82・四角0.76）。90°/180°の向き直しは文字認識が当てにならず不採用（EXIFのまま）。ローカルAIの欠け判定は誤りが多いので「要確認」と書くだけ。旧仕上げの作り直しは `POST /api/studio/redo`（AIが作った仕上げは同じ写真のまま画像だけ差し替え `refinishPhoto`、前の画像は消さない）。主の背景は `studioStyle` auto＝白っぽい商品はグレー・ほかは白。影消しの強さは `studioDeshadow`（既定0.6、明るい商品は全力。qwen3.5:4b は影の有無を見分けられず gemma4:26b は1枚3分・16GB で不採用→数値処理）。被写体がはみ出す・大写し・見つからない写真は色補正のみ。仕上げ（source=studio）の主の1枚は出品用で元写真と入れ替える（🔒確定時は入れ替えない）。取りこぼした写真の仕上げは `POST /api/studio/run`。
- 開封チェック済み（`openCheckedAt`、ユーザーのみ・`POST /api/products/:id/open-check`）: 一覧の行と詳細のチェック。絞り込みチップ「開封未チェック」「開封チェック済み」。
- 別枠（`asideAt`、ユーザーのみ・`POST /api/products/:id/aside`・一括 `aside`・詳細のチェック）: 一覧の「すべて」などから外し、チップ「別枠」で見る（AIの処理対象からは外さない）。
- 観察ブラウザ連携（`browser`: { asin, lists, vineOrderDate }）は Mac の `~/AI-Workspace/projects/amazon-research-browser/sync/sync.py` が `PUT /api/products/:id/browser` で書く（QC はやり直しにならない）。一覧では 🔍「観察ブラウザの一覧」「観察ブラウザの画像取得」、👁 で一覧・日付の範囲（Vine注文日／注文日など）で隠す、並び順「Vine注文日」。画像取得の状況は ⋯ →「🔭 観察ブラウザの画像取得の状況」（`GET /api/browser-sync`、画像 `GET /api/browser-images/:asin`。台帳からは読むだけ・`server/browser-sync.js`）。
- 日付ID（`dateId`、`server/dateid.js`・画面は ⋯→🔢 と一覧の行・詳細）: 令和の年月日6桁＋その日の注文順＋その日の注文数（例 08101088）。いちばん新しい日で8件（`DAILY_MAX`）未満は最後が「?」、より新しい日を含む一覧が来るか8件で決まる。注文の一覧（文字 `商品名⇥リンク⇥注文日` か観察ブラウザの JSON）を `POST /api/date-ids/import`（既定 dryRun）で取り込み、日ごとの並びを `data/date-ids/orders.json` に覚える（知っている注文の順は変えず新しい注文を後ろへ・1行1注文・注文番号リンクは覚えない）。sync.py が Vine 注文を受け取るたびに自動で送る。商品とは ASIN、なければ商品名（片方がもう片方の頭と一致）で結び、迷うものは書かない。商品が増えると5秒後に付け直す（`refresh`）。手で編集しない。 同じ注文から商品ID（`productCode`、`public/js/datecode.js`＝令和日付・注文商品識別コード: [年A][月A][何番目B大文字][日A][注文数B小文字]、A は 0＝5、B は YRSFWLQB＝1〜8、例 0300Q00b、締まっていない日は末尾「?」、復号は年月の境目が曖昧なら候補を全部返す）も付ける。 出品の原稿 `channel_package` と素材Zip の info.json・情報.txt は説明の末尾に「商品ID: …」を自動で足し（`withProductCode`、既にあれば足さない）、`productCode` 欄でも渡す。出品を頼まれた AI はその説明をそのまま使う。
- 帳簿（`server/books.js`・`data/books/journal.json`＋`audit.jsonl`、画面は ⋯→🧾帳簿 と商品詳細の帳簿欄）: 念のための記録。連携（`POST /api/books/sync`）が Vine受領・レビュー投稿を1商品1回「要確認」で記録。事実（表示価格と確認日）と税務上の扱い（評価額・仕訳・5つのメモ: 主張／実際／一般的な取扱い／専門家の確認／申告で採用）を分けて持つ。承認・載せない・活動の理念はユーザーのみ。Vine受領と同額の経費を自動で作らない。作品（YouTube・ブログ）は `/api/works`（商品と多対多）。税額の試算は `server/tax.js`（年度ごとの値に出典と確認日、未確認の値は画面に表示、国保・年金の所得制限は入力時だけ）。説明資料は `/api/books/report?year=`・`/api/books/report/product/:id`（印刷用 HTML、理念と事実を分ける）。
- Amazon の価格の履歴（`server/prices.js`・`data/prices/observations.jsonl`、追記だけ）: Mac の `sync/images.mjs` がログアウト状態の商品ページで確かめた表示価格・参考価格・在庫の文を `POST /api/prices` で送る（何を確かめるかは台帳の `GET /api/prices/due`: Vine提供品を未確認→受領60日以内は週1→以後90日ごと）。`PUT /api/products/:id/amazon` の価格も記録。帳簿の Vine受領は受領日に近い確認の値（前後14日）を使い、前後30日の幅をメモに残す。商品詳細の帳簿欄に履歴。
- メルカリの売上の取り込み（`server/adapters/mercari-sales.js`＝メルカリ依存の読み方はここだけ、`POST /api/books/import/mercari`、既定は dryRun）: 個人のメルカリに公式 CSV がないため、ユーザーが貼った取引画面の文字・CSV を読む（自動で取りに行かない）。同じ取引は二重に入れず、台帳で売却済みの出品先から連携が作った売却の記録（`sold:<商品>:<出品先>`）が要確認ならそこへ手数料・送料・手取りを追記。Vine提供品には自動で結び付けない（印だけ）。
- 帳簿の分類の候補（`server/classify.js`、`POST /api/books/classify`）: 決まりごと（語の表・売却の仮の仕訳・照合）→ 分からないものだけローカルAI（Ollama qwen3.5:4b、科目の一覧からだけ選ばせる）。候補は `suggestion` に入るだけで記録は変えない。「候補を使う」（`POST /api/books/:id/apply-suggestion`）はユーザーのみで、使っても要確認のまま。業務使用割合・非課税かどうかは決めず印（`FLAGS`）で示す。
- Vine提供品（`browser` に Vine の一覧がある商品）には既定ルールが出品先を入れず、入れた分は外す（規約で販売・譲渡不可）。手で入れた出品先・判断は残して行に警告。
- 一覧の行の色: 出さない（薄い赤）・在庫なし（グレー）が優先、それ以外でフリマに入っていればオレンジの縁と淡い地。
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
