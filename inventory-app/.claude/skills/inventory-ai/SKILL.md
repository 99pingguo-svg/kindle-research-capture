---
name: inventory-ai
description: 商品台帳（shohin-daicho MCP）のAI作業手順。AIタスクキュー処理、商品整理、メルカリ原稿作成、AI QC（画像QC含む）、追加撮影の依頼。「今日撮った商品を確認して」「出品準備を進めて」「QCして」などで使う。
---

# 商品台帳 AI 作業手順

商品台帳アプリのデータが **正本**。MCP サーバー `shohin-daicho` のツールだけで読み書きする（画面操作は不要）。

## 絶対に守ること

1. **推測と事実を混ぜない。** 情報は `set_facts` に確度付きで保存する:
   `confirmed`（写真・ラベル・公式資料で確認）/ `reference`（参考情報）/ `unverified`（要確認）/ `unknown`（不明）。
   原稿には confirmed（と、明示した上での reference）だけを書く。分からないことは書かない。
2. **参考画像は出品に使わない。** `kind=reference` の写真は確認用。出品用写真は `kind=actual` からのみ選ぶ（サーバーも拒否する）。
3. **ユーザー確定（🔒）を尊重する。** 確定済み項目への書き込みは「提案」になる。提案には `reason` を必ず付ける。
4. **ユーザーの権限に触れない。** 出品する/しない判断、販売価格と商品の状態の確定、出品待ちへの移動、公開承認、削除はユーザーのみ。
5. **QC（画像QCを含む）は Claude Opus 5.5 が行う。** `save_qc_result` の `model` には自分の実際のモデルID（`claude-opus-5-5`）を入れる。
   別モデルで動いている場合は QC を保存せず、「QC は Opus 5.5 で実行が必要」と報告して `finish_ai_task(status=error)` にする。
6. 1商品の失敗で全体を止めない。最後に結果をまとめて報告する。

## キュー処理の流れ

```
ai_task_queue
for each task (古い順):
  start_ai_task(id, task_id)
  get_product(id)
  ── type に応じて ──
  organize / full → 商品整理
  draft    / full → 原稿作成
  qc       / full → AI QC
  price           → 価格調査（price_candidates を保存）
  finish_ai_task(id, task_id, status, message="型番特定・原稿作成・QC PASS" など短く)
```

「今日撮った商品を全部」と言われたら `list_products(filter=shot_today)` とキューの両方を対象にする。

## 1. 商品整理

- `get_photos(id, kind=actual, size=work)` で現物写真を見る。型番ラベル・印字・付属品・傷を読む。
- 登録URL（`links`）を WebFetch で読み、公式名称・型番・仕様を確認。現物と同一モデルか照合する（型番末尾・色・容量）。
- 必要なら `add_link`（公式ページ等）と `add_reference_image`（公式画像。参考用）を追加。
- `set_facts`: 型番 / 正式名称 / ブランド / 色 / 主な仕様 / 付属品（写真で確認できたもの）/ 状態所見 / 発売年 など。各 fact の `source` に根拠（写真ID・URL）を書く。
- 基本情報（`name`, `brand`, `model`, `jan`, `color`）は `update_product` で更新（確定済みなら提案になる）。
- 名称未設定の商品は写真から特定する。特定できなければ facts に unknown で残し、`request_photos`（例: 型番ラベル）。
- `find_duplicates(id)` で重複の可能性があれば QC issues に書く。

## 2. 原稿作成（save_listing_draft）

- タイトル（≤40字）: ブランド + 商品名 + 型番 + 主要特徴。誇張語（激レア・完璧・絶対 など）禁止。
- 説明（≤1000字）: 商品概要 / 状態（写真で見えた事実のみ）/ 付属品（写真で確認できたもののみ。確認できない物は「付属しません」か触れない）/ 注意事項。
  `unverified` の情報は書かない。「要確認」「TODO」等のプレースホルダーを残さない（機械チェックで NG になる）。
- カテゴリー: 「>」区切りの階層。ブランド: メルカリのブランド名。
- 商品の状態と価格は **提案**（ユーザー確定が必要）。価格は相場を WebSearch / WebFetch で調べ、`price_candidates` に根拠URL付きで 2〜3 案。
- 出品用写真は `set_listing_photos` で並べる: 1枚目=全体がよく分かる写真、次に正面/背面/型番ラベル/付属品/傷。ブレ・重複は外す。

## 3. AI QC（save_qc_result）— Claude Opus 5.5 で実施

必ず次の順で **実際に画像を見て** 判定する:

1. `get_product(id)` — readiness と lint（機械チェック）を確認。
2. `get_photos(id, kind=listing, size=work)` — 出品用写真を **全部** 見る（見ていない写真があると PASS できない）。
3. `get_photos(id, kind=actual, size=thumb)` と `get_photos(id, kind=reference)` — 出品用以外の現物・参考画像と比較。
4. `get_reference_data` の `qcChecks` を **全項目** 評価し、各 `note` に根拠（写真IDなど）を書く。

### 画像QC（group=image。PASS に必須）

| チェック | 見るポイント |
|---|---|
| image_quality 画質 | ピンぼけ・手ブレ・暗すぎ・白飛び・映り込み/反射・大きな傾き・被写体が小さすぎる |
| image_consistency 整合性 | 全写真が **同一個体** か。色・形状・型番ラベル・傷の位置・付属品が写真間で矛盾しないか。数量と写っている個数 |
| image_anomaly 違和感 | 別商品や私物の混入、不自然な加工・合成、スクリーンショット/参考画像の混入、宛名・伝票・画面・顔など個人情報の写り込み、背景の生活感が強すぎる |
| photo_matches_name | 写真の商品が商品名・型番と一致 |
| color_matches | 写真の色と原稿の色が一致 |
| condition_consistent | 傷・汚れ・使用感が「商品の状態」「説明」と矛盾しない |
| no_unphotographed_accessories | 説明に書いた付属品が写真に写っている |
| photo_coverage | 背面・型番ラベル・傷のアップ・付属品全体など必要な写真があるか |

画像に問題があれば `result=needs_review` または `fail` にし、`photo_requests` に撮り直し/追加撮影を具体的に依頼する
（例: `{label:"背面", reason:"背面の傷の有無が確認できない"}`、`{label:"型番ラベル", reason:"末尾が読めない"}`）。
ラベルは写真タグ（全体/正面/背面/側面/上面/底面/型番ラベル/付属品/箱・パッケージ/傷・汚れ/動作確認）に合わせると、
ユーザーがそのタグで撮影した時点で依頼が自動で完了になる。

### 内容チェック（group=content）

型番・数量・付属品・参考ページとの同一モデル性・誇張/断定・推測の事実化・価格の桁ミス。

### 結果

- 全項目問題なし → `pass`（機械チェックのエラーや fail 項目があるとサーバーが拒否する）
- ユーザー判断が必要 → `needs_review`（summary に何を確認してほしいか一行で）
- 修正必須 → `fail`

QC 後に内容が変わると自動で「再QCが必要」になる。

## 最後の報告

「N商品中 M商品が準備完了（あとはあなたの価格・状態の確定のみ）。K商品は追加撮影が必要: #0012 背面、…」の形で短く。
