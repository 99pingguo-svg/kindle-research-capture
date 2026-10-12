# セットアップ（Mac + iPhone + Claude）

## 1. Mac でサーバーを起動

必要: Node.js 20 以上（`brew install node`）。追加パッケージは不要です。

```bash
cd inventory-app
npm start
# → http://127.0.0.1:8787 で起動。データは inventory-app/data/ に保存
```

データの保存場所を変える場合（例: 外付けディスク）:

```bash
INVENTORY_DATA="$HOME/Documents/商品台帳" npm start
```

試しに触るだけなら: `npm run demo && INVENTORY_DATA=./demo-data npm start`

### 常駐させる（任意）
ログイン時に自動起動し、落ちても自動で再起動させるには `scripts/install-launchd.sh`（`scripts/start-lan.sh` を LaunchAgent `com.<ユーザー名>.shohin-daicho` として登録。ログは `~/Library/Logs/shohin-daicho.log`）。解除は `scripts/install-launchd.sh --uninstall`。常駐中は手で `npm start` しないこと（ポートが重なる）。
撮影中に Mac がスリープすると iPhone から届かないので、作業中は「システム設定 → ディスプレイ → 詳細 → 電源アダプタ接続時はスリープさせない」等を推奨（写真は iPhone 側に保持され、復帰後に自動送信されます）。

## 2. iPhone から使う（推奨: Tailscale）

iPhone のブラウザでカメラ（アプリ内ファインダー）を使うには HTTPS が必要です。Tailscale を使うと設定なしで HTTPS になり、自宅外からも安全に使えます。

1. Mac と iPhone に Tailscale をインストールし、同じアカウントでログイン
2. Mac で:
   ```bash
   tailscale serve --bg 8787
   ```
   表示された `https://<mac名>.<tailnet>.ts.net` を iPhone の Safari で開く
3. 共有ボタン → **ホーム画面に追加**（全画面のアプリとして起動できます）

サーバーは既定で 127.0.0.1 のみで待ち受けるため、Tailscale 経由以外からはアクセスできません。

**`scripts/start-lan.sh`（常駐）と併用する場合:** 8787 は「この Mac からのみ・合言葉不要」の入口なので、Tailscale はそちらではなく合言葉つきの HTTPS 入口へ向けます。

```bash
tailscale serve --bg https+insecure://localhost:8443   # tailnet 内のみ（Funnel ではない）
```

iPhone では `https://<mac名>.<tailnet>.ts.net/?token=<~/.shohin-daicho/token>` を一度開きます（ts.net の証明書は本物なので、自前 CA の信頼設定は不要）。初回は Tailscale 管理画面で Serve/HTTPS の有効化を求められます。解除は `tailscale serve --https=443 off`。

Tailscale だけで使う（Wi-Fi 内には公開しない）場合は、HTTPS 入口も Mac 内に閉じます:

```bash
SHOHIN_HOST=127.0.0.1 scripts/install-launchd.sh
tailscale serve --bg https+insecure://127.0.0.1:8443
```

Wi-Fi 公開に戻すときは `scripts/install-launchd.sh`（SHOHIN_HOST なし）で再登録します。

### Tailscale を使わない場合（同じ Wi-Fi 内・HTTPS・外部サービスなし）

Mac 標準の openssl で自分専用の証明書を作り、アプリ内カメラが使える HTTPS で開きます。

```bash
scripts/make-lan-cert.sh   # 初回だけ。~/.shohin-daicho/ に CA・サーバー証明書・合言葉を作る
scripts/start-lan.sh       # 起動
```

起動すると入口が2つできます（同じデータを共有）:
- iPhone 用: `https://<Macの名前>.local:8443`（合言葉が必要。証明書が `.local` 名で発行されるので IP では開かない）
- Mac 内の Claude / MCP 用: `http://127.0.0.1:8787`（この Mac からのみ・合言葉不要。`.mcp.json` はそのまま）

iPhone 側（初回だけ）:
1. `~/.shohin-daicho/ShohinDaicho-LocalCA.cer` を AirDrop で iPhone に送る
2. 設定 → 一般 → VPNとデバイス管理 → ダウンロード済みプロファイル → インストール
3. 設定 → 一般 → 情報 → 証明書信頼設定 → 「Shohin-Daicho Local CA」をオン
4. `~/.shohin-daicho/iphone-url.txt` の URL を Safari で一度開く（合言葉が Cookie に保存される）→ 共有 → ホーム画面に追加

CA は name constraints でこの Mac の `.local` 名にしか署名できないよう絞ってあります。Mac の名前を変えたら `scripts/make-lan-cert.sh --new-ca` で作り直し、iPhone にも入れ直してください。サーバー証明書の期限は約 2 年（`make-lan-cert.sh` の再実行で更新）。

HTTP で手早く試すだけなら `HOST=0.0.0.0 INVENTORY_TOKEN=好きな長い文字列 npm start` → `http://<MacのIP>:8787/?token=…` でも開けますが、アプリ内カメラは使えず、シャッターのたびに標準カメラが起動します。

## 3. Claude（Mac）を接続

Claude Code:

```bash
claude mcp add --transport http shohin-daicho http://localhost:8787/mcp
# INVENTORY_TOKEN を使っている場合:
# claude mcp add --transport http shohin-daicho http://localhost:8787/mcp --header "Authorization: Bearer <token>"
```

`inventory-app/` で `claude` を起動すると `.mcp.json` と `.claude/skills/` が自動で読み込まれます。

QC（画像QCを含む）は Claude Opus 5.5 で行う設定です。Claude Code では `/model` で `claude-opus-5-5` を選ぶか、`claude --model claude-opus-5-5` で起動してください。
他のモデルで QC を保存しようとするとサーバーが拒否します（設定画面の「QCを実施できるモデル」で変更可能）。

頼み方の例:
- 「今日撮った商品を全部確認して、出品準備を進めて」
- 「AIタスクキューを処理して」
- 「この商品リストを登録して（貼り付け）」
- 「出品待ちの商品をメルカリに下書き入力して」（Claude in Chrome が必要）

Claude Desktop（stdio のみの場合）:

```json
{
  "mcpServers": {
    "shohin-daicho": {
      "command": "node",
      "args": ["/path/to/inventory-app/bin/mcp-stdio.js"],
      "env": { "INVENTORY_URL": "http://localhost:8787" }
    }
  }
}
```

### AI キューの自動処理（任意）
iPhone で「撮影完了」すると AI 整理が自動で依頼されます。Mac で次を動かしておくと、依頼が溜まるたびに Opus 5.5 が処理します:

```bash
./scripts/ai-worker.sh --loop
```

## 4. バックアップと書き出し

- 自動: 毎日 `data/backups/metadata-*.tar.gz`（写真以外）
- 手動・写真込み: `npm run backup`（`BACKUP_DIR=/Volumes/USB npm run backup` も可）
- 書き出し: 設定画面から ZIP（`Products/0001/product.json, listing.txt, originals/, edited/, listing_photos/, references/`）や CSV
- `data/` フォルダ自体が普通のファイルなので、Time Machine や iCloud Drive へのコピーでも保全できます（同時に2台のサーバーで同じフォルダを使わないこと）。

## 5. 399商品（Codex の素材・原稿・採用画像）の取り込みと更新

```bash
node scripts/import-399.js            # 初回は取り込み、2回目以降は「元フォルダで変わった分だけ」同期
node scripts/import-399.js --dry-run  # 件数だけ確認（何も書かない）
```

- 元フォルダ（`~/Documents/Codex/…`）は読むだけ。商品名・タイトル／説明文の下書き・Amazon リンク、正式採用の紹介画像（生成画像＝出品用に選べる）、Amazon 商品ページ画像（参考画像＝出品不可）を登録する。
- 再実行で、差し替わった採用画像（指紋 sha256 で判定）は新版に置き換え（旧版は残す）、原稿の変更は取り込み時のままの項目だけ更新。あなたが確定（🔒）した項目は「提案」になる。
- 変化はアプリの「⋯ → 📒 更新台帳」と `data/imports/update-ledger.csv` に記録。メルカリに入れた版が変わった商品は、商品画面にも「メルカリ側の更新が必要」と出る。
- メルカリの状況（出品中・取引中・売却済み）は「メルカリの状況を確認して」と頼んだときだけ Claude が確認して反映する（手順は `.claude/skills/mercari-adapter/SKILL.md`）。

自動同期（任意）: `scripts/install-sync-schedule.sh` で毎日 7:00・14:20・18:00 に上の同期を実行（ローカル実行のみ・Claude は使わない。時刻は `SYNC_TIMES="7:00 18:00"` で変更、解除は `--uninstall`、今すぐ1回は `--run-now`）。初回は macOS が node の「書類」フォルダへのアクセス許可を求めるので「許可」する。ログは `~/Library/Logs/shohin-daicho-sync.log`。

## 6. 状態の保存（セーブポイント・自動保存）とロールバック

アプリの「⋯ → 💾 状態の保存・ロールバック」（iPhone から Tailscale 経由でも使える）。
- **セーブポイント**: 名前を付けて全商品の内容と設定を保存。削除するまで残る。
- **自動保存**: サーバー起動時と30分ごと（変更があったときだけ。`AUTOSAVE_MINUTES` で変更）、10件以上の一括操作・ロールバックの直前。定期48件・操作の前30件を残して古いものから整理。
- **ロールバック**: 選んだ時点に全商品を戻す。直前の状態は自動保存されるので取り消せる。後から登録した商品はゴミ箱へ（写真は消えない）。ロールバックと保存の削除はユーザーのみ。
- 保存先は `data/snapshots/`（product.json と設定のみ。1回数MB）。

## 7. 価格の一括設定

一覧の「💴 価格帯」で記録の Amazon 価格（セール込み）で絞り込み → 「選択」→「全選択」または個別に選ぶ →「💴 価格を設定」。
金額指定か Amazon 価格の％（1/10/100円で丸め）、設定先は共通の販売価格か出品先ごとの価格。設定済みがあれば「上書きする／未設定のものだけ」を確認する。
