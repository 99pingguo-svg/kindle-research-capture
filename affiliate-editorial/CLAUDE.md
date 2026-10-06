# 編集管理（商品紹介サイト）— affiliate-editorial

本人と Claude が共同で管理する、Amazon.co.jp 商品紹介サイトの非公開編集アプリ。
公開されるのは、本人が承認した版だけ。

## 構成
- `editorial/` — Python 3.9+（標準ライブラリ＋Jinja2）。`web/` が管理画面、`web/mcp.py` が Claude 用 MCP（`/mcp`）。
- `var/` — 実データ・設定・ビルド（git 管理外。コミットしない。このリポジトリは公開リポジトリ）。
- `docs/` — 設計・運用・規約の確認結果・受入テスト。

## Claude として作業するとき
- データの読み書きは MCP `editorial`（`.mcp.json`）経由。管理画面を起動（`python3 -m editorial serve`）し、
  `python3 -m editorial create-ai-token <名前>` で作ったトークンを環境変数 `EDITORIAL_MCP_TOKEN` に入れておく。
- 手順は `.claude/skills/editorial-ai/SKILL.md`。
- Claude ができるのは「読む・提案を保存する・コメントする・メーカー公開情報のメモを足す」まで。
  承認・公開・予約・取り下げ・文章整形・素材の権利・設定は本人だけ（ツール自体がない）。
- Amazon のカスタマーレビュー・星評価・商品説明を使わない／書かない。収集済みレビューは本人の目視確認用で、Claude には渡らない。

## 開発
- テスト: `python3 -m unittest discover -s tests -t tests`（合成データのみ）。
- 本人の版（main）と提案（proposal）、本人だけの操作の境界を崩さないこと。
- 公開ページは `render.py` の許可項目だけで作る。私有データ（パス・注文情報・メモ・トークン）を出さないこと。
