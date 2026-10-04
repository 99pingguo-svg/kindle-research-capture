#!/bin/sh
# 同じ Wi-Fi の iPhone から HTTPS で使う起動方法（先に scripts/make-lan-cert.sh を一度実行しておく）。
# - iPhone 用: https://<Macの名前>.local:8443（合言葉が必要）
# - Mac 内の Claude / MCP 用: http://127.0.0.1:8787（このMacからのみ。.mcp.json はそのまま使える）
set -eu

D="${SHOHIN_DAICHO_HOME:-$HOME/.shohin-daicho}"
cd "$(dirname "$0")/.."
for f in server.crt server.key token; do
  [ -f "$D/$f" ] || { echo "$D/$f がありません。先に scripts/make-lan-cert.sh を実行してください" >&2; exit 1; }
done

export HOST=0.0.0.0 TLS_CERT="$D/server.crt" TLS_KEY="$D/server.key"
INVENTORY_TOKEN="$(cat "$D/token")"
export INVENTORY_TOKEN
exec node server/index.js
