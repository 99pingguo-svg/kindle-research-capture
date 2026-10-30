# 公開用素材キット（public-kit）

商品台帳から「外に出してよい項目」だけを書き出したもの。作り直しは台帳側で
`node scripts/export-public.js`（台帳のサーバーが動いていること）。このフォルダは毎回まるごと作り直される。

## ファイル
- `products.json` — 商品の配列（下の形）。
- `meta.json` — 書き出し日時・件数・種類ごとの件数。
- `photos/` — 商品写真（AI仕上げで切り抜いたもの: 白抜き・グレー背景）。撮影日時・機器などの付属情報は消してある。Amazon の倉庫ラベル（X00…の番号とバーコード）はラベルごと単色で塗りつぶし、読み直して欠片も読めないことを確認済み（判定できない・読めた写真は入れない）。付属情報は区画（APP1〜15・COM）まで調べて無いことを確認。`<商品ID>-<写真ID>.jpg`（長辺〜2048px）と `.thumb.jpg`（長辺400px）。

## products.json の1件
| 項目 | 中身 |
|---|---|
| `id` | 台帳の商品ID（4桁） |
| `name` | 商品名（台帳で整えた短い名前） |
| `category` | 種類（例: スマホ・タブレット用品） |
| `brand` / `model` / `color` / `jan` | 分かっていれば |
| `status.decision` | 出品判断: `undecided` 未判断 / `sell` 出品 / `draft` 下書き / `hold` 保留 / `no_sell` 出さない / `no_stock` 在庫なし |
| `status.targets` | 出品先: `mercari` `jmty`(ジモティー) `yahoo`(ヤフオク) `paypay`(ヤフーフリマ) `rakuma` `flea`(フリマ) |
| `listing` | 出品原稿: `title`・`description`・`condition`・`price`（円、未定は null） |
| `size` | 梱包の大きさの目安 `cm:[長,幅,高]`・`kg`・`estimated`（推定なら true） |
| `shipping` | 一番安いメルカリ便の目安 `label`・`price` |
| `amazon` | Amazon の `asin`・`url`・商品名 `title`・価格 `price`（調べた時点） |
| `market` | 売れた値段の集計（サイトごと）: `median` 中央値・`low`・`high`・`count`・`match`（`same` 同じ商品 / `similar` 似た商品）・`checkedAt` |
| `netEstimates` | 手取りの見込み（サイトごと、高い順）: 中央値 − 手数料 − 送料の目安 |
| `facts` | 確定した仕様（ラベルと値） |
| `photos` | 写真: `file`・`thumb`・`kind`（`finished` AI仕上げ）・`background`（`white`/`grey`）・`inListing`（出品用に選ばれている） |
| `updatedAt` | 台帳での最終更新日 |

## 入っていないもの（意図して外している）
メモ、注文日・到着日・購入日・購入価格、Amazon管理番号（FNSKU）、保管場所、AI作業の記録・提案・QC、
Amazon の公式画像、AI紹介画像、撮ったままの写真と切り抜けなかった仕上げ（部屋が写る。`--with-own-photos` を付けたときだけ入る）、相場の個々の売れた商品のURL。

## 注意
- 相場・手取りは調べた時点の目安。手数料は メルカリ10%・ヤフーフリマ5%・ラクマ10%（実績で4.5〜10%）・ヤフオク10%で計算。
- 説明原稿（`listing.description`）は AI が下書きしたもの。公開前に内容を確認すること。
