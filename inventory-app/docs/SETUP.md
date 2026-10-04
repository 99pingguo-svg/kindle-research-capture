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
ログイン時に自動起動したい場合は launchd を使います（`~/Library/LaunchAgents/jp.daicho.plist` で `node server/index.js` を `KeepAlive` 指定）。
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

### Tailscale を使わない場合（同じ Wi-Fi 内）

```bash
HOST=0.0.0.0 INVENTORY_TOKEN=好きな長い文字列 npm start
```

iPhone で `http://<MacのIP>:8787/?token=…` を一度開くとログイン状態になります。
ただし HTTP ではアプリ内カメラが使えず、シャッターを押すたびに標準カメラが起動する方式になります。
HTTPS にするには mkcert 等で証明書を作り `TLS_CERT=… TLS_KEY=…` を指定し、iPhone に CA を信頼させてください。

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
