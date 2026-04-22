#!/bin/bash
# List NATS CLI contexts as a markdown table.
# Writes to ~/.claude/channels/nats/.contexts for the skill to Read.

CONTEXT_DIR="${HOME}/.config/nats/context"
STATE_DIR="${HOME}/.claude/channels/nats"
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
