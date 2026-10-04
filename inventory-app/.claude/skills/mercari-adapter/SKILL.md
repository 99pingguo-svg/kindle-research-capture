---
name: mercari-adapter
description: 商品台帳の「出品待ち」商品をメルカリWeb（Claude in Chrome）へ下書き入力し、入力内容を正本と照合（転記QC）する手順。「メルカリに入力して」「転記して」で使う。公開ボタンはユーザー承認がない限り押さない。
---

# Mercari Adapter（メルカリ転記手順）

アプリ内の商品データが正本。メルカリはコピー先。**この手順書と `server/adapters/mercari.js` だけがメルカリ依存部分**。
メルカリの画面が変わったら、このファイルの「画面の探し方」だけを直す（アプリ本体は変更不要）。

## 前提

- MCP `shohin-daicho` が接続済み。Claude in Chrome でユーザーがメルカリにログイン済み。
- 対象はユーザーが「出品待ち」にした商品だけ: `mercari_queue`。

## 1商品の流れ

1. `mercari_prepare(id)` → `fields`（入力値）、`photos`（outbox の `01.jpg`… 絶対パス、順番どおり）、`form`（画面上の項目名）を受け取る。
   エラー（準備未完了）なら飛ばして報告。
2. 新しいタブで `sellUrl`（https://jp.mercari.com/sell/create）を開く。
3. `form` の順に、**ラベル文字列で項目を探して** 入力する（CSSセレクタや座標を覚えて使い回さない）:
   - 出品画像: `photos` を番号順にアップロード。ファイル選択でパスを指定できない場合は、
     ユーザーに「outbox フォルダ（`outboxDir`）の写真を番号順にドラッグしてください」と依頼して待つ。
   - 商品名・商品の説明: `fields.title` / `fields.description` をそのまま（改行を保持）。
   - カテゴリー: `fields.category` を「>」で分割し上の階層から順に選ぶ。完全一致が無ければ最も近いものを選び、notes に記録。
   - ブランド: 候補から一致するものを選ぶ。無ければ空欄。
   - 商品の状態・配送料の負担・配送の方法・発送元の地域・発送までの日数: 選択肢から完全一致を選ぶ。
   - 販売価格: 数字のみ。
4. **「下書きに保存する」** を押す。公開（「出品する」）ボタンは押さない。
   下書き保存が無い/使えない場合は保存せず入力済みのまま止め、`saved_as=unsaved_form` で記録してユーザーに知らせる。
5. `mercari_record_entry(id, saved_as="draft", draft_url=…)`。
6. **転記QC**: 下書きを開き直し、画面に実際に入っている値を読み取って `mercari_verify_entry(id, observed)` に送る:
   `title, description, category（画面表示の階層）, brand, condition, shippingPayer, shippingMethod, shippingFrom, shippingDays, price, photoCount`
   と、画像を見て判断する `photoOrderOk`（outbox の番号順か）、`photosMatchProduct`（この商品の現物写真か）、`productMatches`（別商品の下書きでないか）。
   読み取れなかった項目は入れない（未確認として NG になる）。サーバーが正本と機械照合し、PASS なら「最終確認待ち」になる。
7. NG なら画面を修正して 6 をやり直す。直せない場合は notes に理由を書いて次へ。

## 公開について

- 公開ボタンを押してよいのは、ユーザーがアプリで **「公開を承認」** した商品だけ（`get_product` の `channels.mercari.publishApproved` があり、その `rev` が現在の `rev` と一致）。
- 公開したら `mercari_mark_listed(id, item_url)`。承認がない場合サーバーは記録を拒否する。
- 売れたことを確認したら `mercari_mark_sold(id, price)`。

## 画面の探し方（メルカリUI変更時はここを更新）

- 出品画面: トップの「出品」→「出品する」、または直接 `https://jp.mercari.com/sell/create`。
- 下書き一覧: マイページ →「出品した商品」→「下書き」。
- 各項目は見出しテキスト（商品名 / 商品の説明 / カテゴリー / 商品の状態 / 配送料の負担 / 配送の方法 / 発送元の地域 / 発送までの日数 / 販売価格）で特定する。

## 最後の報告

「出品待ち N件: 下書き入力 M件（転記QC PASS K件）、要対応: #0012 カテゴリー候補なし …」。
ユーザーには「アプリの『最終確認待ち』で内容を確認し、問題なければ公開を承認してください」と伝える。
