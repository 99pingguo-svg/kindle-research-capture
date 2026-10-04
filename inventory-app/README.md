# 商品台帳 — AI共同型 商品在庫・メルカリ出品管理アプリ

個人で所有している商品を「何を持っているか → 撮影 → 出品判断 → AI整理・原稿・QC → メルカリ転記 → 出品・売却」まで一か所で管理する、
ユーザーと AI エージェントの共同ワークスペース。

- **iPhone**: 一覧から 📷 一発で撮影、撮影モードで「撮影 → 撮影完了 → 次の商品」を高速に繰り返す
- **Mac**: 大量管理、詳細確認、Claude による整理・原稿・QC・メルカリ転記
- **Claude**: MCP で商品台帳を直接読み書き（画面操作不要）。QC（画像QC含む）は Claude Opus 5.5 が実施

```bash
cd inventory-app
npm start                         # http://127.0.0.1:8787
claude mcp add --transport http shohin-daicho http://localhost:8787/mcp
```

詳しくは:
- [docs/SETUP.md](docs/SETUP.md) — Mac / iPhone（Tailscale）/ Claude の接続
- [docs/DESIGN.md](docs/DESIGN.md) — 方式検討（ネイティブ vs PWA、同期、AI 連携、メルカリ連携、権限境界、段階計画）
- [.claude/skills/inventory-ai/SKILL.md](.claude/skills/inventory-ai/SKILL.md) — AI の作業手順（整理・原稿・QC）
- [.claude/skills/mercari-adapter/SKILL.md](.claude/skills/mercari-adapter/SKILL.md) — メルカリ転記手順

## 主な機能

| | |
|---|---|
| 商品一覧 | サムネイル・名前・ブランド/型番・ステータス・写真枚数・出品用枚数・AI状態・QC・価格・要確認事項・📷・出品/保留/出さない を一覧上で操作 |
| 検索・絞り込み | 名前/型番/ブランド/JAN/ID、撮影予定・写真不足・今日撮影済み・要確認・QC問題・準備完了・出品待ち・メルカリ入力済・出品中・売却済み・保留・出品しない・アーカイブ・ゴミ箱 |
| 撮影 | アプリ内ファインダー、長押し連写、部位タグ（背面・型番ラベル…）、AI の撮影依頼から直接撮影、ライブラリ追加、＋新商品、撮影完了で自動で次へ＆AI依頼、オフライン時も端末に保持して自動送信 |
| 画像 | 現物写真 / 出品用（順番付き選択）/ 参考資料画像 を厳密に分離。編集（回転・明るさ・コントラスト・彩度・自動補正・正方形）は元写真を残して新しい写真として保存 |
| AI 共同作業 | AI タスクキュー、確度付き情報整理、原稿・価格候補、AI QC（画像QC: 画質・整合性・違和感）、追加撮影依頼、ユーザー確定項目は AI 提案として表示 |
| 安全 | 変更履歴・時点復元・AI の一括変更取り消し・ゴミ箱・確認付き完全削除・毎日の自動バックアップ・ZIP/CSV 書き出し |
| メルカリ | 出品待ちキュー → 下書き入力（Claude in Chrome）→ 転記QC（正本と機械照合）→ 公開承認 → 出品中 → 売却 |

## 開発

```bash
npm test                                   # サーバーのテスト
npm run demo && INVENTORY_DATA=./demo-data npm start
```

依存パッケージはありません（Node 20+）。データは `data/`（git 管理外）。
