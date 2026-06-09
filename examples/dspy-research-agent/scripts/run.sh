#!/usr/bin/env bash
# Run the research agent: source .env, kill any previous instance, start fresh.
# Pass-through env: RESEARCH_MODEL, RESEARCH_PROVIDER, TAVILY_API_KEY,
# RESEARCH_MAX_TURNS, RESEARCH_MAX_SUB_CALLS, RESEARCH_DEBUG, NATS_URL.
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

if [[ -z "${TAVILY_API_KEY:-}" && -z "${EXA_API_KEY:-}" ]]; then
  echo "note: neither TAVILY_API_KEY nor EXA_API_KEY is set — web.search/web.fetch will raise until you set one" >&2
fi

if pgrep -f "bun run src/index.ts" >/dev/null; then
  echo "stopping existing agent on this dir…"
  pkill -f "bun run src/index.ts" || true
  sleep 1
fi

cd "$HERE"
exec bun run src/index.ts "$@"
