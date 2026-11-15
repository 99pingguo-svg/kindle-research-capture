# AI エージェントとの共同作業（商品台帳）

台帳の基本は「あるかないか」と「レビュー・発信をどうするか」。決めるのはユーザー、作業するのはエージェント。

## 入口
- ほかのエージェント（Muse など）への案内の全体は `docs/SHARED_ENTRY.md`。
- MCP（`.mcp.json` の `shohin-daicho`）:
  - `agent_queue` … やること一覧。`review_draft`（ユーザーが「する」にした商品の下書き作り）・`review_post`（「投稿OK」になった下書きの投稿）・`listing`（出品判断「出品」の出品先ごと）。
  - `get_materials(id)` … 公式画像・撮った写真・AI仕上げ・紹介画像の絶対パスと、商品情報・レビューの予定（形式・メモ・下書き）。
  - `save_review_draft(id, draft)` … 下書きを保存（状態は「下書きあり」になる）。「する」でない商品は拒否。
  - `mark_review_posted(id, url)` … 投稿済みの報告。ユーザーが「投稿OK」にした商品だけ。
  - 出品は従来どおり `channel_package(id, channel)` を正本に読む。
- REST（Mac 内 http://127.0.0.1:8787）: `GET /api/agent/queue`・`GET /api/materials.zip?ids=…`（素材Zip）・`PUT /api/products/:id/review-plan`。

## 守ること
- あるかないか・レビューをするか・投稿OK・出品判断・出品先はユーザーだけが決める（サーバーが AI からの変更を拒否する）。
- 投稿・出品など外に出る作業は、ユーザーの印（投稿OK・出品）がある商品だけ。
- Vine 提供品は規約で販売・譲渡不可（出品先を入れない）。Vine のレビューは Amazon のルールに従う。
- 素材の公式画像（Amazon）は参考用。投稿に使うときは権利を確かめる。

## 商品ID（出品・投稿のとき）
- 商品には商品ID（`productCode`、例 `0300Q00b`）がある。`channel_package` の `description` には末尾に「商品ID: …」が自動で入っているので、そのまま使う（消さない・書き換えない）。素材Zip では `info.json` の `productCode` と `情報.txt` の1行目近く。
