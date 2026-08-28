# DeerFlow NATS Channel

Expose a running [DeerFlow](https://deerflow.tech/) Gateway as a spec-compliant [Synadia Agent Protocol for NATS](https://github.com/synadia-ai/synadia-agent-sdk-docs) host.

Every running wrapper instance registers one DeerFlow session as a NATS micro service. Synadia Agent Protocol clients can discover it, prompt it, stream responses, and answer DeerFlow clarification requests over protocol `query` chunks.

This package is deliberately narrow: it is a **Synadia Agent Protocol channel wrapper for DeerFlow**. It is not a generic NATS toolkit, a JetStream/KV/Object Store helper, an MCP tool pack, or a DeerFlow fork.

## Install

### Package index install

```bash
pip install synadia-ai-nats-deerflow-channel
```

Or run without keeping a project-local install:

```bash
uvx --from synadia-ai-nats-deerflow-channel deerflow-nats-channel doctor \
  --owner acme \
  --session research \
  --nats-context prod \
  --deerflow-url http://localhost:2026
```

### Editable from this monorepo

```bash
git clone git@github.com:synadia-ai/synadia-agents.git
cd synadia-agents/agents/deerflow
uv sync
uv run deerflow-nats-channel doctor \
  --owner acme \
  --session research \
  --nats-url nats://127.0.0.1:4222
```

If you prefer plain pip during local development:

```bash
cd synadia-agents/agents/deerflow
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip setuptools wheel
python -m pip install -e .
deerflow-nats-channel doctor --owner acme --session research --nats-url nats://127.0.0.1:4222
```

## Prerequisites

- A reachable NATS server, or a NATS CLI context created with `nats context add`.
- A running DeerFlow Gateway. The wrapper expects the Gateway HTTP API, including `/health`, `/api/threads/{session}/uploads`, and `/api/threads/{session}/runs/stream`.
- Python 3.11+.

## Quickstart: env-first

For operators, environment variables are the cleanest path. Keep credentials in your NATS context or process environment; keep committed config files boring.

```bash
# Pick exactly one NATS connection path:
export NATS_CONTEXT=prod
# — or —
export NATS_URL=nats://127.0.0.1:4222

# Identity: SYNADIA_DEERFLOW_* (per-agent) > SYNADIA_* (fleet-wide) > legacy
# NATS_OWNER / NATS_AGENT_NAME aliases. Use whichever fits your deployment.
export SYNADIA_OWNER=acme
export SYNADIA_NAME=research
export DEERFLOW_URL=http://localhost:2026

# Preferred for current DeerFlow Gateway auth: the wrapper logs in once,
# stores access_token/csrf_token cookies, and sends X-CSRF-Token itself.
export DEERFLOW_USERNAME=operator@example.com
export DEERFLOW_PASSWORD='change-me'

# Optional. Defaults to df, giving agents.prompt.df.<owner>.<session>.
export NATS_AGENT_TOKEN=df

deerflow-nats-channel doctor
deerflow-nats-channel start
```

The wrapper registers subjects in the v0.3 verb-first layout:

```text
agents.prompt.<agent>.<owner>.<session>
agents.status.<agent>.<owner>.<session>
agents.hb.<agent>.<owner>.<session>
```

With the quickstart defaults above, callers use:

```text
agents.prompt.df.acme.research
agents.status.df.acme.research
agents.hb.df.acme.research
```

Only `prompt` forwards work to DeerFlow. `status` and `hb` are wrapper-owned protocol liveness surfaces.

## Configuration

Effective precedence is:

1. CLI flags
2. Environment variables
3. TOML config file
4. Built-in defaults

Default config path:

```text
~/.config/synadia/deerflow-channel/config.toml
```

`deerflow-nats-channel configure` prints the resolved config path. It does not write secrets or mutate the file for you.

```bash
mkdir -p "$(dirname "$(deerflow-nats-channel configure)")"
cat > "$(deerflow-nats-channel configure)" <<'TOML'
# ~/.config/synadia/deerflow-channel/config.toml
# Prefer NATS_CONTEXT/NATS_URL and NATS_OWNER in the environment for deployments.
nats_context = "prod"
owner = "acme"
session = "research"
agent = "df"
deerflow_url = "http://localhost:2026"
# Optional but recommended when DeerFlow auth is enabled.
deerflow_username = "operator@example.com"
# Prefer DEERFLOW_PASSWORD env for real deployments; shown here for field shape only.
deerflow_password = "change-me"
TOML
```

### Config file reference

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `agent` | no | `df` | Synadia Agent Protocol type token. It becomes the third token in `agents.prompt.<agent>.<owner>.<session>`. Keep it lowercase and subject-safe. |
| `owner` | yes | — | Operator/account namespace. It becomes the fourth subject token. |
| `session` | no | `default` | DeerFlow thread/session name and fifth subject token. Stable names make the wrapper easy to address. |
| `deerflow_url` | no | `http://localhost:2026` | Base URL for the DeerFlow Gateway. |
| `deerflow_username` | no | — | DeerFlow local-login username/email. When set with `deerflow_password`, the wrapper logs in via `/api/v1/auth/login/local` and uses returned session/CSRF cookies automatically. |
| `deerflow_password` | no | — | DeerFlow local-login password. Prefer the `DEERFLOW_PASSWORD` environment variable over TOML for real deployments. Redacted from `doctor` output. |
| `deerflow_cookie` | no | — | Debug fallback only: raw Cookie header for DeerFlow Gateway calls, e.g. `access_token=...; csrf_token=...`. Prefer automatic login. Redacted from `doctor` output. |
| `deerflow_csrf_token` | no | — | Debug fallback only: explicit CSRF token sent as `X-CSRF-Token`. Prefer automatic login. Redacted from `doctor` output. |
| `nats_context` | no | — | NATS CLI context name. Recommended for NGS/managed NATS because credentials stay in the NATS context. If neither `nats_context` nor `nats_url` is set, the wrapper uses the currently selected NATS CLI context. |
| `nats_url` | no | — | Raw NATS server URL. Useful for local development. If unset, `nats_context` or the current NATS CLI context is used. |
| `deerflow_timeout_s` | no | `60` | HTTP connect/read timeout for DeerFlow Gateway health and stream calls. |
| `query_timeout_s` | no | `300` | Seconds to wait for a caller reply to a DeerFlow clarification query before failing the stream. |
| `max_payload` | no | NATS server limit | Optional smaller prompt endpoint `max_payload` cap. By default the host advertises the connected NATS server limit; if configured, the value is honored unless the server limit is smaller. |

### Environment variables

| Variable | Sets | Notes |
| --- | --- | --- |
| `NATS_AGENT_TOKEN` | `agent` | Preferred env name for the protocol type token. |
| `DEERFLOW_NATS_AGENT` | `agent` | DeerFlow-specific alias. Used only when `NATS_AGENT_TOKEN` is unset. |
| `SYNADIA_DEERFLOW_OWNER` | `owner` | Per-agent override, highest priority. The `SYNADIA_<AGENT>_OWNER` form shared across all agents (here `<AGENT>` is `DEERFLOW`). |
| `SYNADIA_OWNER` | `owner` | Fleet-wide owner env var. Used when `SYNADIA_DEERFLOW_OWNER` is unset. |
| `NATS_OWNER` | `owner` | **Legacy alias.** Used only when neither `SYNADIA_*` owner var is set. |
| `DEERFLOW_NATS_OWNER` | `owner` | **Legacy alias** (DeerFlow-specific). Used only when the above are unset. |
| `SYNADIA_DEERFLOW_NAME` | `session` | Per-agent override for the 5th (session/name) token, highest priority. The `SYNADIA_<AGENT>_NAME` form shared across all agents. |
| `SYNADIA_NAME` | `session` | Fleet-wide session/name env var. Used when `SYNADIA_DEERFLOW_NAME` is unset. |
| `NATS_AGENT_NAME` | `session` | **Legacy alias.** Used only when neither `SYNADIA_*` name var is set. Note: despite the "agent" in its name it sets the 5th *session* token — the `SYNADIA_*` names fix that confusion. |
| `NATS_SESSION` | `session` | **Legacy alias.** Used only when the above are unset. |
| `DEERFLOW_URL` | `deerflow_url` | DeerFlow Gateway base URL. |
| `DEERFLOW_USERNAME` | `deerflow_username` | DeerFlow local-login username/email for automatic Gateway session login. |
| `DEERFLOW_PASSWORD` | `deerflow_password` | DeerFlow local-login password for automatic Gateway session login. Prefer env over config files. Redacted from `doctor` output. |
| `DEERFLOW_COOKIE` | `deerflow_cookie` | Debug fallback raw Cookie header. Prefer `DEERFLOW_USERNAME`/`DEERFLOW_PASSWORD`. Redacted from `doctor` output. |
| `DEERFLOW_CSRF_TOKEN` | `deerflow_csrf_token` | Debug fallback CSRF token sent as `X-CSRF-Token`. Prefer automatic login. Redacted from `doctor` output. |
| `NATS_CONTEXT` | `nats_context` | NATS CLI context. Prefer this over raw URLs in production. |
| `NATS_URL` | `nats_url` | Direct NATS server URL. |
| `DEERFLOW_TIMEOUT_S` | `deerflow_timeout_s` | Positive number of seconds for DeerFlow HTTP calls. |
| `DEERFLOW_QUERY_TIMEOUT_S` | `query_timeout_s` | Positive number of seconds to wait for clarification replies. |
| `DEERFLOW_MAX_PAYLOAD` | `max_payload` | Human byte string such as `256KB`, `1MB`, or `2MB`. |

### CLI flags

All commands accept the same config overrides:

```bash
deerflow-nats-channel doctor \
  --config-file ~/.config/synadia/deerflow-channel/config.toml \
  --agent df \
  --owner acme \
  --session research \
  --deerflow-url http://localhost:2026 \
  --deerflow-username operator@example.com \
  --deerflow-timeout-s 60 \
  --query-timeout-s 300 \
  --max-payload 1MB \
  --nats-context prod
```

Use flags for one-off smoke checks. Use env vars or TOML for services.

## Commands

| Command | Purpose |
| --- | --- |
| `deerflow-nats-channel configure` | Print the resolved config file path. Handy in shell scripts; intentionally non-mutating. |
| `deerflow-nats-channel doctor` | Print a JSON report with resolved non-secret config, subject names, required-field checks, and DeerFlow `/health` reachability. |
| `deerflow-nats-channel start` | Start the long-running Synadia Agent Protocol host. |

Example doctor output:

```json
{
  "ok": true,
  "checks": {
    "agent_token_shape": true,
    "deerflow_reachable": true,
    "deerflow_url_shape": true,
    "nats_target_configured": true,
    "nats_target_valid": true,
    "owner_configured": true
  },
  "config": {
    "agent": "df",
    "owner": "acme",
    "session": "research",
    "prompt_subject": "agents.prompt.df.acme.research",
    "status_subject": "agents.status.df.acme.research",
    "heartbeat_subject": "agents.hb.df.acme.research"
  },
  "messages": []
}
```

`doctor` treats `owner`, NATS target validity, URL shape, and agent-token shape as start gates. If no explicit NATS target is configured, `doctor` validates the currently selected NATS CLI context, matching `start`. DeerFlow reachability is reported so operators see the problem early, but the structural config can still be valid while DeerFlow is temporarily restarting.

## Verify over NATS

Start the wrapper, then from another shell:

```bash
# Discover registered agent services.
nats req '$SRV.INFO.agents' '' --replies=0 --timeout=2s

# Watch protocol heartbeats.
nats sub 'agents.hb.*.*.*'

# Prompt directly with plain text.
nats req agents.prompt.df.acme.research "Summarize the current workspace" \
  --wait-for-empty \
  --reply-timeout 30s \
  --timeout 180s
```

`--wait-for-empty` matters: protocol responses stream as typed chunks and end with an empty terminator message. `--reply-timeout 30s` avoids the NATS CLI giving up between the initial ack and DeerFlow's first content chunk.

## Talk to DeerFlow from Python

```python
import asyncio

from nats.aio.client import Client as NATS
from synadia_ai.agents import Agents

async def main() -> None:
    nc = NATS()
    await nc.connect("nats://127.0.0.1:4222")
    agents = Agents(nc=nc)

    [agent] = await agents.discover(filter={"agent": "df"})
    async for msg in await agent.prompt("What can you do?"):
        if msg.type == "response":
            print(msg.text, end="")

    await nc.close()

asyncio.run(main())
```

## Runtime behavior

- The wrapper uses `AgentService` from `synadia-ai-agent-service`.
- `attachments_ok` is advertised as `true`. The wrapper accepts protocol inline attachments, validates basename-only filenames, uploads them to `POST /api/threads/{session}/uploads`, and includes the returned DeerFlow sandbox virtual paths in `additional_kwargs.files` on the Gateway run request.
- `max_payload` follows the connected NATS server limit by default; operators may configure a smaller cap to reject expensive prompts earlier. The protocol host clamps configured values down if the NATS server is smaller and rejects oversized prompt envelopes before the DeerFlow handler runs.
- DeerFlow HTTP calls use `deerflow_timeout_s` (default `60`). Clarification replies use `query_timeout_s` (default `300`) and fail the stream if the caller does not answer in time.
- When `deerflow_username` and `deerflow_password` are configured, the wrapper logs into DeerFlow via `/api/v1/auth/login/local`, stores the returned `access_token`/`csrf_token` cookies, and sends `X-CSRF-Token` automatically on Gateway stream POSTs. Manual `deerflow_cookie`/`deerflow_csrf_token` exists only as a debug fallback.
- Before each prompt, the wrapper idempotently ensures the configured DeerFlow thread exists via `POST /api/threads`, so operators do not need to pre-create the session in the Web UI.
- DeerFlow SSE `messages`/`updates` events are normalized into protocol response chunks.
- DeerFlow `ask_clarification` tool messages are bridged to Synadia Agent Protocol `query` chunks. The caller's answer, including any safe attachments, is sent back to the same DeerFlow thread as the next user message.
- A single wrapper instance serves one `(agent, owner, session)` identity. Run multiple processes for multiple exposed DeerFlow sessions.

## Troubleshooting

- **`owner is not configured; set SYNADIA_DEERFLOW_OWNER, SYNADIA_OWNER, a legacy NATS_OWNER/DEERFLOW_NATS_OWNER alias, or pass --owner`** — also settable via `owner = "..."` in the config file. The owner is required because it is part of the protocol subject.
- **`set NATS_CONTEXT or NATS_URL before starting the channel`** — configure one NATS target. Prefer `NATS_CONTEXT` for authenticated deployments.
- **`agent token must be lowercase alphanumeric plus hyphen`** — use a subject-safe token such as `df` or `deerflow`. Do not use spaces, dots, or uppercase.
- **`DeerFlow Gateway is not reachable at .../health`** — start DeerFlow Gateway first, confirm the port, and run `curl <DEERFLOW_URL>/health` from the same host as the wrapper.
- **`403: CSRF token missing. Include X-CSRF-Token header.`** — configure `DEERFLOW_USERNAME` and `DEERFLOW_PASSWORD` so the wrapper can log into DeerFlow and send CSRF headers automatically. If you are debugging manually, provide both `DEERFLOW_COOKIE='access_token=...; csrf_token=...'` and `DEERFLOW_CSRF_TOKEN=...`.
- **`404: Thread ... not found`** — upgrade/reinstall the wrapper. Current versions create the configured DeerFlow thread automatically before streaming; older editable installs required the thread to already exist.
- **`unsafe attachment filename`** — attachment filenames must be plain basenames: no `/`, `\`, NUL bytes, empty names, `.`/`..`, or names longer than 255 UTF-8 bytes. The wrapper rejects unsafe names before calling DeerFlow.
- **`DeerFlow Gateway upload failed`** — NATS routing and envelope decoding worked; inspect DeerFlow Gateway auth/CSRF, upload limits, and `/api/threads/{session}/uploads` logs next.
- **NATS CLI receives only an ack or exits early** — include both `--wait-for-empty` and a generous `--reply-timeout`, e.g. `30s`.
- **No discovery responses** — confirm the wrapper is still running, check `NATS_CONTEXT`/`NATS_URL`, then query `$SRV.INFO.agents` on the same NATS account the wrapper uses.
- **Prompt hangs during a clarification** — DeerFlow asked for human input and the caller must support protocol `query` chunks. Use an SDK caller that handles `query`, or avoid DeerFlow flows that require clarification.
- **Local dev imports the wrong SDK version** — from `agents/deerflow`, run `uv sync`; the local `pyproject.toml` maps `synadia-ai-agents` and `synadia-ai-agent-service` to the monorepo SDK paths via `[tool.uv.sources]`.

## Limitations

- Attachments are uploaded to DeerFlow's thread uploads area and referenced in the Gateway run payload via `additional_kwargs.files`. The Synadia wrapper does not invent a DeerFlow-native multimodal API; it uses DeerFlow's existing file-upload surface.
- The wrapper fronts DeerFlow Gateway HTTP/SSE. It does not embed DeerFlow Harness directly.
- `configure` is intentionally minimal in this phase: it prints the target config path instead of running an interactive wizard.
- No generic NATS tools are exposed to DeerFlow. This is inbound protocol hosting, not a NATS toolbox.

## See also

- Sibling channel plugins: [`pi`](../pi), [`openclaw`](../openclaw), [`claude-code`](../claude-code), [`hermes`](../hermes), [`flue`](../flue), [`eve`](../eve), [`open-agent`](../open-agent), [`opencode`](../opencode), and [`codex`](../codex).
- Python caller SDK: [`../../client-sdk/python`](../../client-sdk/python).
- Python host SDK: [`../../agent-sdk/python`](../../agent-sdk/python).
- Wire protocol: [`synadia-ai/synadia-agent-sdk-docs`](https://github.com/synadia-ai/synadia-agent-sdk-docs).

## License

Apache-2.0
