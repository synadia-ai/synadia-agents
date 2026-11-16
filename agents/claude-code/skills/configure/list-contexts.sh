#!/bin/bash
# List NATS CLI contexts as a markdown table.
# Writes to <state dir>/.contexts for the skill to Read. The state directory
# is $NATS_STATE_DIR when it is set and not empty, else ~/.claude/channels/nats.

CONTEXT_DIR="${HOME}/.config/nats/context"
STATE_DIR="${NATS_STATE_DIR:-${HOME}/.claude/channels/nats}"
OUT="${STATE_DIR}/.contexts"

mkdir -p "$STATE_DIR"

if [ ! -d "$CONTEXT_DIR" ]; then
  echo "No NATS contexts found (${CONTEXT_DIR} does not exist)" > "$OUT"
  exit 0
fi

{
  echo "| Name | URL | Description |"
  echo "|------|-----|-------------|"
  jq -r 'input_filename as $f |
    [($f | split("/") | last | rtrimstr(".json")), (.url // "-"), (.description // "-")] |
    "| \(.[0]) | \(.[1]) | \(.[2]) |"' "$CONTEXT_DIR"/*.json 2>/dev/null
} > "$OUT"
