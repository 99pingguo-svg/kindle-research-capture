#!/bin/sh
# 同じ Wi-Fi の iPhone から HTTPS で使う起動方法（先に scripts/make-lan-cert.sh を一度実行しておく）。
# - iPhone 用: https://<Macの名前>.local:8443（合言葉が必要。IPv6/IPv4 両方で待ち受け：.local は IPv6 で引かれることが多い）
# - Mac 内の Claude / MCP 用: http://127.0.0.1:8787（このMacからのみ。.mcp.json はそのまま使える）
set -eu

D="${SHOHIN_DAICHO_HOME:-$HOME/.shohin-daicho}"
cd "$(dirname "$0")/.."
for f in server.crt server.key token; do
  [ -f "$D/$f" ] || { echo "$D/$f がありません。先に scripts/make-lan-cert.sh を実行してください" >&2; exit 1; }
done

# SHOHIN_HOST=127.0.0.1 にすると Wi-Fi への公開をやめ、この Mac の中（＝Tailscale serve 経由）からだけ受け付ける。
export HOST="${SHOHIN_HOST:-::}" TLS_CERT="$D/server.crt" TLS_KEY="$D/server.key"
INVENTORY_TOKEN="$(cat "$D/token")"
export INVENTORY_TOKEN
exec node server/index.js
