# 設計書 — AI共同型 商品在庫・メルカリ出品管理アプリ「商品台帳」

企画書 v1.0 §41 の検討事項への回答と、MVP の実装内容をまとめる。

## 1. 結論（要約）

| 論点 | 採用 | 理由 |
|---|---|---|
| アプリ形式 | **PWA（Web アプリ）+ アプリ内カメラ** | iPhone・Mac・AI が同じデータを同時に扱え、配布・更新が不要。撮影は getUserMedia のアプリ内ファインダーで「撮影→撮影→次へ」を画面遷移なしで実現できる |
| データの置き場所 | **Mac 上のフォルダ（ファイルベース）** | アプリが無くても読める（product.json / listing.txt / 写真）。Time Machine 等でそのままバックアップできる |
| iPhone↔Mac 共有 | **Mac がサーバー、iPhone はブラウザ/ホーム画面アプリ。経路は Tailscale（推奨）** | 同期処理が不要（正本は1つ）。Tailscale Serve で HTTPS になりカメラ API が使え、外出先からも安全に届く |
| AI 連携 | **MCP（Streamable HTTP, `/mcp`）** を同じサーバーに内蔵 | Claude Code / Claude Desktop が人間向け画面を介さず直接読み書き。UI と同じ業務ルールを通るので権限境界が一箇所で守られる |
| メルカリ連携 | **Mercari Adapter（データ側）+ Claude in Chrome（操作側）** | アプリ本体はメルカリの画面構造を知らない。UI 変更時は手順書 1 枚とアダプタだけ直す |
| 画像QC | **Claude Opus 5.5 限定**（サーバーで強制） | 画質・写真間の整合性・違和感の判定は最も重要な目視工程のため、モデルを固定し記録する |

## 2. ネイティブ iPhone アプリ vs PWA

| 観点 | ネイティブ (Swift) | PWA（採用） |
|---|---|---|
| 連続撮影 | ◎ AVFoundation | ○ アプリ内ファインダー＋長押し連写。解像度は動画ストリーム（多くの iPhone で 4K/12MP 相当まで要求可）。メルカリ用途（最終 1080px 程度）には十分。標準カメラ/ライブラリ追加も併用可 |
| Mac・AI との共有 | △ 同期基盤（CloudKit 等）と別途 API が必要 | ◎ 同じサーバー・同じデータ |
| 開発・保守 | △ Xcode、署名、TestFlight、iOS 更新追従 | ◎ ビルド不要、ファイルを置き換えるだけ |
| オフライン | ◎ | ○ 撮影写真は端末内（IndexedDB）に即保存し、Mac に届いた時点で自動送信 |
| 必要条件 | Apple Developer 登録 | HTTPS（Tailscale Serve で自動） |

→ 企画の最重要要件（現物を前に高速撮影＋Mac の Claude が同じデータで引き継ぐ）を最小の構成で満たすため PWA を採用。
将来ネイティブが必要になっても、REST API と MCP はそのまま使える（撮影クライアントだけ差し替え可能）。

## 3. 全体構成

```
iPhone (PWA: 一覧・撮影モード・確認)  ─┐  HTTPS (Tailscale Serve)
Mac ブラウザ (一覧・詳細・大量管理)   ─┼─► Node サーバー (Mac)  ──► data/ （正本）
Claude Code / Desktop (MCP)          ─┘      ├ REST API (/api)        products/0001/product.json
                                            ├ MCP (/mcp)              products/0001/photos/…
                                            ├ SSE (/api/events)       products/0001/history.jsonl
                                            └ Mercari Adapter         products/0001/versions/…
Claude in Chrome ──► メルカリ公式Web（下書き入力・転記QC）  ◄── outbox/mercari/0001/01.jpg…
```

- サーバーは依存パッケージゼロ（Node 20+ のみ）。`npm start` で起動。
- 変更は SSE で全端末に即時反映（Mac の Claude が更新すると iPhone の一覧もすぐ変わる）。

## 4. データ設計

### 商品（product.json）
- 基本情報: 名前・ブランド・型番・JAN・数量・色・状態メモ・メモ・購入時期/価格・出品予定価格・販売価格・保管場所（すべて任意）
- `decision`（出品する／保留／出品しない／未定）と `stage`（未整理→撮影待ち→撮影中→AI整理待ち→AI整理中→要確認→出品準備完了→出品待ち→メルカリ入力済み→最終確認待ち→出品中→売却済み）を **分離**。
  保留にしても作業の進み具合は失われない。アーカイブ・ゴミ箱は別フラグ。
- `links`（購入元/公式/メーカー/説明書/相場…）
- `photos`: `kind=actual`（現物）/ `kind=reference`（参考資料）。`listingPhotoIds` が出品用の **順番付き選択**（現物のみ。参考画像はサーバーが拒否）。
  編集版は `derivedFrom` で元写真にひも付く新しい写真として保存され、元写真は上書きしない（元写真 → 編集版 → 出品採用）。
- `facts`: AI が整理した情報。確度 `confirmed / reference / unverified / unknown` と根拠 `source` 付き。
- `listing`: タイトル・説明・カテゴリー・ブランド・状態・価格・配送・価格候補（根拠付き）
- `locks`: ユーザーが確定した項目。`proposals`: 確定項目に対する AI の変更提案（採用/却下するまで反映されない）
- `qc`: AI QC 結果（実施モデル・チェック項目・指摘・対象 rev）。`photoRequests`: 追加撮影依頼
- `aiTasks`: アプリから AI への依頼キュー。`channels.mercari`: 転記・転記QC・公開承認・出品/売却情報（他販売先も同じ形で追加可能）
- `rev`: 内容が変わるたびに増える版番号。QC や転記がどの版に対するものかを判定し、古くなったら自動で「再QCが必要」「メルカリ側と不一致」になる。

### 履歴と復元
- すべての変更を `history.jsonl`（誰が・いつ・何を・前後の値）と全体の `activity.jsonl` に記録。
- 変更直前の状態を `versions/` にスナップショット保存 →「この変更の前に戻す」、「この時点以降の Claude の変更をまとめて取り消す」が可能。復元しても写真は消えない。
- 削除はゴミ箱 → 完全削除は商品IDの再入力が必要。写真の削除も復元可能。
- 毎日メタデータを自動バックアップ（`data/backups`）、`npm run backup` で写真込みの完全バックアップ。

## 5. AI の権限境界（サーバーで強制）

| AI が自由にできる | ユーザー確定が必要 / ユーザーのみ |
|---|---|
| 調査、facts 整理、原稿案、価格候補、QC、撮影依頼、参考URL・参考画像追加、出品用写真の並べ替え（未確定時） | 出品する/保留/出品しない、販売価格と商品の状態の **確定**、出品待ちへの移動（転記依頼）、公開承認、削除・アーカイブ、参考画像→現物写真への変更 |

- ユーザーが編集した項目は自動で確定（🔒）され、以後 AI の書き込みは「提案」になる。
- AI は「公開承認」がない商品を出品中にできない（承認後に内容が変わった場合も不可）。

## 6. AI QC と画像QC

- QC チェックリストは企画書 §18 を構造化したもの＋画像QC。
  - **画像QC（group=image）**: 画質（ピント・明るさ・ブレ・白飛び・反射）、写真間の整合性（同一個体か、色・型番・傷・付属品の矛盾）、違和感（別商品・不自然な加工/合成・参考画像混入・個人情報の写り込み）、写真と商品名/色/状態/付属品の一致、必要な写真の網羅
  - **内容チェック（group=content）**: 型番・数量・付属品・参考ページとの同一モデル性・誇張・推測の事実化・価格ミス
- **QC は Claude Opus 5.5（`claude-opus-5-5`）が実施する**。サーバーは
  1. `save_qc_result` の `model` が設定 `imageQcModels`（既定 `claude-opus-5-5`）に含まれない QC を拒否、
  2. PASS には画像QC全項目の評価と fail ゼロを要求、
  3. PASS の前に出品用写真すべてを `get_photos(size=work)` で実際に取得（＝見た）していることを要求、
  4. 許可モデル以外が記録した QC は準備完了の条件として無効、
  とする。`scripts/ai-worker.sh` も `--model claude-opus-5-5` 固定。
- 機械チェック（文字数・価格範囲・「要確認」等の残骸・誇張語・数量未記載・要確認情報の記載・予定価格との桁違い）は AI に頼らずサーバーが常時判定し、エラーがある間は QC PASS にできない。

## 7. MCP ツール（AI アクセス）

| 区分 | ツール |
|---|---|
| 参照 | `get_reference_data`, `inventory_overview`, `list_products`（filter: shot_today / needs_photos / review / ready …）, `get_product`, `get_photos`（画像として返す）, `get_history`, `find_duplicates`, `ai_task_queue` |
| 登録・整理 | `create_products`（重複チェック付き）, `update_product`, `set_facts`, `add_link`, `add_reference_image`, `set_listing_photos` |
| 原稿・QC | `save_listing_draft`, `save_qc_result`, `request_photos`, `set_stage`, `start_ai_task`, `finish_ai_task` |
| メルカリ | `mercari_queue`, `mercari_prepare`, `mercari_record_entry`, `mercari_verify_entry`, `mercari_mark_listed`, `mercari_mark_sold` |
| プロンプト | `process_today`（今日撮った商品の出品準備）, `process_queue`, `mercari_transfer` |

REST API（`/api/...`）も同じルールで公開しており、スクリプトからも利用できる。

## 8. メルカリ連携

1. ユーザーが準備完了の商品を「転記依頼」（出品待ち）にする — 人間のチェックポイント。
2. `mercari_prepare`: 正本から入力値と、出品用写真を番号付きで `outbox/mercari/<id>/01.jpg…` に書き出す。
3. Claude in Chrome がメルカリ公式Webで **項目名（ラベル）を手がかりに意味的に** 入力し、**下書き保存**（公開しない）。
4. `mercari_verify_entry`: 画面から読み取った値をサーバーが正本と機械照合（転記QC）。PASS で「最終確認待ち」。
5. ユーザーがアプリで「公開を承認」→ AI が公開、または自分で公開 → 出品中。売れたら売却済み。

メルカリの HTML 構造はアプリに一切持たない。UI 変更時は `.claude/skills/mercari-adapter/SKILL.md`（必要なら `adapters/mercari.js` の項目定義）だけを直す。
下書き保存が使えない場合は「入力済み・未保存」で止めてユーザーに引き渡す安全側の代替フロー。手動出品用に各項目のコピーボタンもある。

## 9. 段階的な開発計画

| フェーズ | 内容 | 状態 |
|---|---|---|
| 1. MVP | 商品一覧（一覧上で判断・撮影・状態確認）、詳細、URL、画像3分類、一覧から撮影、撮影モード、複数写真追加、出品判断、検索・フィルター、iPhone/Mac 共有、MCP、AI 原稿・QC（画像QC）、書き出し・バックアップ、履歴・取り消し、重複検知、写真編集（回転・明るさ・コントラスト・彩度・自動補正・正方形） | **実装済み** |
| 2. メルカリ半自動 | Mercari Adapter、Chrome での下書き入力、転記QC、公開承認 | **実装済み**（実機メルカリでの手順調整が必要） |
| 3. 運用改善 | AI キュー自動処理（`ai-worker.sh --loop` / launchd）、まとめて公開、画像の類似による重複検知、バーコード/JAN スキャン、OCR | 次 |
| 4. 拡張 | 値下げ・再出品提案、他販売サイト（`channels` に追加）、利益管理、発送管理、音声操作 | 将来 |
