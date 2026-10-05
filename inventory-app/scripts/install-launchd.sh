#!/bin/sh
# ログイン時に商品台帳サーバー（scripts/start-lan.sh）を自動起動し、落ちたら自動で再起動する（ユーザー単位の LaunchAgent）。
# 使い方: scripts/install-launchd.sh             登録して今すぐ起動（再実行すると設定を作り直す）
#         scripts/install-launchd.sh --uninstall 停止して登録を外す
#         SHOHIN_HOST=127.0.0.1 scripts/install-launchd.sh   Wi-Fi に公開せず Tailscale 経由だけにする（start-lan.sh 参照）
# ログ: ~/Library/Logs/shohin-daicho.log
set -eu

LABEL="com.$(id -un).shohin-daicho"
APP="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/shohin-daicho.log"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
for _ in 1 2 3 4 5; do launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break; sleep 1; done

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$PLIST"
  echo "停止して登録を外しました: $LABEL"
  exit 0
fi

NODE="$(command -v node)" || { echo "node が見つかりません" >&2; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/sh</string>
		<string>$APP/scripts/start-lan.sh</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin</string>$([ -n "${SHOHIN_HOST:-}" ] && printf '\n\t\t<key>SHOHIN_HOST</key>\n\t\t<string>%s</string>' "$SHOHIN_HOST")
	</dict>
	<key>WorkingDirectory</key>
	<string>$APP</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>$LOG</string>
	<key>StandardErrorPath</key>
	<string>$LOG</string>
</dict>
</plist>
EOF
plutil -lint "$PLIST" >/dev/null
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "登録して起動しました: $LABEL（ログ: $LOG）"
