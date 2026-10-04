#!/bin/sh
# 同じ Wi-Fi の iPhone から HTTPS（＝アプリ内カメラ可）で使うための、この Mac 専用の証明書と合言葉を作る。
# 置き場所はリポジトリの外: ~/.shohin-daicho/（SHOHIN_DAICHO_HOME で変更可）。
#
# - 親証明書(CA)は name constraints で「この Mac の .local 名」にしか署名できないよう絞る（鍵が漏れても他サイトを偽装できない）。
# - CA と合言葉は初回だけ作る。サーバー証明書は毎回作り直す（有効期限 800 日。iOS の上限 825 日以内）。
# - Mac の名前を変えたら --new-ca で CA から作り直し、iPhone に入れ直す。
#
# 使い方: scripts/make-lan-cert.sh [--new-ca]
set -eu

D="${SHOHIN_DAICHO_HOME:-$HOME/.shohin-daicho}"
NAME="$(scutil --get LocalHostName | tr '[:upper:]' '[:lower:]').local"
umask 077
mkdir -p "$D"
chmod 700 "$D"

if [ "${1:-}" = "--new-ca" ]; then rm -f "$D/ca.key" "$D/ca.crt" "$D/ca.srl" "$D/ShohinDaicho-LocalCA.cer"; fi

if [ ! -f "$D/ca.key" ]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$D/ca.key" 2>/dev/null
  openssl req -x509 -new -key "$D/ca.key" -days 3650 \
    -subj "/CN=Shohin-Daicho Local CA ($NAME)" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "nameConstraints=critical,permitted;DNS:$NAME" \
    -out "$D/ca.crt"
  # iPhone に AirDrop で送る用（公開してよい部分だけ。鍵は含まない）
  openssl x509 -in "$D/ca.crt" -outform der -out "$D/ShohinDaicho-LocalCA.cer"
  chmod 644 "$D/ca.crt" "$D/ShohinDaicho-LocalCA.cer"
  echo "CA を作成しました: $D/ShohinDaicho-LocalCA.cer（これを iPhone に入れて信頼する）"
fi

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$D/server.key" 2>/dev/null
openssl req -new -key "$D/server.key" -subj "/CN=$NAME" -out "$D/server.csr"
cat > "$D/server.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:$NAME
EOF
openssl x509 -req -in "$D/server.csr" -CA "$D/ca.crt" -CAkey "$D/ca.key" -CAcreateserial \
  -days 800 -sha256 -extfile "$D/server.ext" -out "$D/server.crt" 2>/dev/null
rm -f "$D/server.csr" "$D/server.ext"
openssl verify -CAfile "$D/ca.crt" "$D/server.crt"

if [ ! -f "$D/token" ]; then
  openssl rand -base64 24 | tr '+/' '-_' | tr -d '=\n' > "$D/token"
  echo "合言葉を作成しました: $D/token"
fi
printf 'https://%s:%s/?token=%s\n' "$NAME" "${TLS_PORT:-8443}" "$(cat "$D/token")" > "$D/iphone-url.txt"
echo "iPhone で開く URL: $D/iphone-url.txt"
