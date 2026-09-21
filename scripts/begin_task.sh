#!/bin/zsh
set -eu
ROOT="${REMOTE_WORK_ROOT:-$HOME/.local/share/remote-work-notes}"
TASK="${1:-remote-task}"
mkdir -p "$ROOT/state" "$ROOT/sessions"
PIDFILE="$ROOT/state/$TASK.caffeinate.pid"
LOG="$ROOT/sessions/$(date +%Y%m%d_%H%M%S)_$TASK.begin.txt"

if [[ -f "$PIDFILE" ]]; then
  old="$(cat "$PIDFILE" 2>/dev/null || true)"
  [[ -n "$old" ]] && kill "$old" 2>/dev/null || true
fi

{
  echo "task=$TASK"
  echo "started=$(date -Iseconds)"
  echo "before_processes:"
  ps -axo pid,ppid,command | grep -E '[K]indle|capture.py|ui.py --app Kindle|caffeinate|desktop-commander' || true
} > "$LOG"

nohup /usr/bin/caffeinate -d -i >"/tmp/$TASK.caffeinate.out" 2>"/tmp/$TASK.caffeinate.err" &
echo $! > "$PIDFILE"
echo "started $TASK caffeinate pid=$(cat "$PIDFILE")"
