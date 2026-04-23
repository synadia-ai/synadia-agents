#!/usr/bin/env bash
# Run the dspy agent: source .env, kill any previous instance, start fresh.
# Pass-through env vars: DSPY_MODEL, DSPY_SANDBOX, DSPY_DEBUG, NATS_URL.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$HERE/../../.env"

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
else
  echo "warning: $ENV_FILE not found — NVIDIA_API_KEY must be exported some other way" >&2
fi

if [[ -z "${NVIDIA_API_KEY:-}" ]]; then
  echo "error: NVIDIA_API_KEY is not set" >&2
  exit 1
fi

# Kill any previous instance started from this directory.
if pgrep -f "bun run src/index.ts" >/dev/null; then
  echo "stopping existing dspy agent…"
  pkill -f "bun run src/index.ts" || true
  sleep 1
fi

cd "$HERE"
exec bun run src/index.ts "$@"
