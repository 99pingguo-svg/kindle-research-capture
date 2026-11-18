#!/bin/zsh
# 台帳スキャン（iPhone）を作って入れる。無料の署名なので7日ごとに実行し直す。
# 台帳のアドレスとトークンは ~/.shohin-daicho から Config.swift（git 管理外）に書く。画面には出さない。
set -e
cd ${0:A:h}
DEVICE=${DEVICE:-00008150-000554982192401C}
D=${SHOHIN_DAICHO_HOME:-$HOME/.shohin-daicho}
URL=$(sed -E 's/[?#].*$//; s:/*$::' "$D/iphone-url-tailscale.txt" | head -1)
TOKEN=$(tr -d '\n' < "$D/token")
umask 077
cat > DaichoScan/Config.swift <<SWIFT
import Foundation
enum Config {
    static let baseURL = URL(string: "$URL")!
    static let token = "$TOKEN"
}
SWIFT
xcodebuild -project DaichoScan.xcodeproj -scheme DaichoScan -destination "${DEST:-generic/platform=iOS}" -configuration Debug \
  -derivedDataPath build -allowProvisioningUpdates build 2>&1 | grep -E "error|warning: .*DaichoScan|BUILD" || true
[[ -n $NOINSTALL ]] && exit 0
xcrun devicectl device install app --device $DEVICE build/Build/Products/Debug-iphoneos/DaichoScan.app 2>&1 | grep -E "ERROR|App installed|maximum|error" || true
