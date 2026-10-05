#!/bin/sh
# 採用原稿・画像の同期（scripts/import-399.js）を毎日 朝・昼・夕 に自動実行する（ユーザー単位の LaunchAgent）。
# ローカルのスクリプトを動かすだけで、Claude や外部APIは使わない。スリープ中に時刻を過ぎた場合は、起動時に1回実行される。
# 使い方: scripts/install-sync-schedule.sh               既定 7:00・14:20・18:00 に登録
#         SYNC_TIMES="6:30 21:00" scripts/install-sync-schedule.sh   時刻を変える
#         scripts/install-sync-schedule.sh --uninstall   止めて登録を外す
#         scripts/install-sync-schedule.sh --run-now     今すぐ1回実行（動作確認）
# ログ: ~/Library/Logs/shohin-daicho-sync.log   結果: アプリの「📒 更新台帳」
set -eu

LABEL="com.$(id -un).shohin-daicho-sync"
APP="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/shohin-daicho-sync.log"
DOMAIN="gui/$(id -u)"

if [ "${1:-}" = "--run-now" ]; then
  launchctl kickstart "$DOMAIN/$LABEL" && echo "実行しました（ログ: $LOG）"
  exit 0
fi

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
for _ in 1 2 3 4 5; do launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break; sleep 1; done

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$PLIST"
  echo "止めて登録を外しました: $LABEL"
  exit 0
fi

NODE="$(command -v node)" || { echo "node が見つかりません" >&2; exit 1; }
TIMES="${SYNC_TIMES:-7:00 14:20 18:00}"
INTERVALS=""
for t in $TIMES; do
  # "07" → "7", "00" → "0" (plist integers; avoids octal/expr pitfalls)
  h=$(printf '%s' "${t%%:*}" | sed 's/^0*\([0-9]\)/\1/'); m=$(printf '%s' "${t##*:}" | sed 's/^0*\([0-9]\)/\1/')
  INTERVALS="$INTERVALS
		<dict><key>Hour</key><integer>$h</integer><key>Minute</key><integer>$m</integer></dict>"
done

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
		<string>$NODE</string>
		<string>$APP/scripts/import-399.js</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin</string>
	</dict>
	<key>WorkingDirectory</key>
	<string>$APP</string>
	<key>StartCalendarInterval</key>
	<array>$INTERVALS
	</array>
	<key>RunAtLoad</key>
	<false/>
	<key>StandardOutPath</key>
	<string>$LOG</string>
	<key>StandardErrorPath</key>
	<string>$LOG</string>
</dict>
</plist>
EOF
plutil -lint "$PLIST" >/dev/null
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "登録しました: $LABEL（毎日 $TIMES ／ ログ: $LOG）"
