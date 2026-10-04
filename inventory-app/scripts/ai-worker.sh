#!/usr/bin/env bash
# Process the AI task queue headlessly with Claude Code on the Mac.
# QC (incl. 画像QC: image quality / consistency / anomaly checks) must be done by
# Claude Opus 5.5, so the worker is pinned to that model.
#
#   ./scripts/ai-worker.sh            # process the queue once
#   ./scripts/ai-worker.sh --loop     # keep polling every 5 minutes
#
# Requires: `claude` CLI logged in, and the MCP server registered:
#   claude mcp add --transport http shohin-daicho http://localhost:8787/mcp
set -euo pipefail
cd "$(dirname "$0")/.."

MODEL="${DAICHO_MODEL:-claude-opus-5-5}"
INTERVAL="${DAICHO_INTERVAL:-300}"
PROMPT='商品台帳の AI タスクキュー（ai_task_queue）を古い順にすべて処理してください。
.claude/skills/inventory-ai/SKILL.md の手順に従うこと。QC では出品用写真を get_photos(size=work) で必ず全部見て、画像QC（画質・写真間の整合性・違和感）を含めて評価し、save_qc_result の model には実際のモデルID（'"$MODEL"'）を入れること。
1件の失敗で止めず、最後に処理結果を短くまとめてください。'

run_once() {
  claude -p "$PROMPT" \
    --model "$MODEL" \
    --allowedTools "mcp__shohin-daicho" "WebFetch" "WebSearch" "Read"
}

if [[ "${1:-}" == "--loop" ]]; then
  while true; do
    run_once || echo "worker run failed; retrying later" >&2
    sleep "$INTERVAL"
  done
else
  run_once
fi
