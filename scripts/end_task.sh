#!/bin/zsh
set -eu
ROOT="${REMOTE_WORK_ROOT:-$HOME/.local/share/remote-work-notes}"
TASK="${1:-remote-task}"
PIDFILE="$ROOT/state/$TASK.caffeinate.pid"
LOG="$ROOT/sessions/$(date +%Y%m%d_%H%M%S)_$TASK.end.txt"

if [[ -f "$PIDFILE" ]]; then
  p="$(cat "$PIDFILE" 2>/dev/null || true)"
  [[ -n "$p" ]] && kill "$p" 2>/dev/null || true
  rm -f "$PIDFILE"
fi

{
  echo "task=$TASK"
  echo "ended=$(date -Iseconds)"
  echo "remaining_related_processes:"
  ps -axo pid,ppid,command | grep -E '[K]indle|capture.py|ui.py --app Kindle|caffeinate|desktop-commander' || true
  echo "relevant_launchagents:"
  launchctl list | grep -Ei 'kindle|capture|keepawake|remote|commander' || true
} > "$LOG"

echo "cleanup recorded: $LOG"
