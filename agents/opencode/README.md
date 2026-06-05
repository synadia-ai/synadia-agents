# OpenCode NATS channel

`@synadia-ai/opencode-nats-channel` exposes an [OpenCode](https://opencode.ai/) server/session as a Synadia Agent Protocol for NATS agent. It is a TypeScript/Bun adapter built on `@synadia-ai/agent-service` and `@opencode-ai/sdk`.

It registers a first-class `agents` micro service, routes protocol prompts into OpenCode sessions, streams OpenCode SSE text events as protocol `response` chunks, maps OpenCode permission events to protocol `query` chunks when configured, and advertises `attachments_ok=false` until OpenCode file ingestion is wired end-to-end.

## Package surface

| Field | Value |
| --- | --- |
| Package | `@synadia-ai/opencode-nats-channel` |
| Binary | `opencode-agent` |
| Type token | `opencode` |
| Prompt subject | `agents.prompt.opencode.<owner>.<session>` |
| Status subject | `agents.status.opencode.<owner>.<session>` |
| Heartbeat subject | `agents.hb.opencode.<owner>.<session>` |
| Host SDK | `@synadia-ai/agent-service` / `AgentService` |
| Attachments | `attachments_ok=false` for v1 |

`owner` is the account/operator namespace. `session` is the registered OpenCode adapter instance name, not necessarily the upstream OpenCode session id.

## Install

From a local clone:

```sh
cd agents/opencode
bun install
bun run typecheck
```

For local development, run the CLI through Bun:

```sh
bun src/cli.ts doctor
bun src/cli.ts start --help
```

When installed as a package, use the published binary name:

```sh
opencode-agent doctor
opencode-agent start --help
```

Managed mode also needs the OpenCode CLI available on `PATH` because `@opencode-ai/sdk` starts the server lifecycle for the adapter.

## Quick start: managed mode

Managed mode starts and owns an `opencode serve` process through `@opencode-ai/sdk`. Use this when the adapter should create the OpenCode server for one repo/worktree.

```sh
opencode-agent start \
  --owner local \
  --session main \
  --directory /path/to/repo \
  --nats-url nats://127.0.0.1:4222
```

Useful flags:

- `--directory /path/to/repo` sets the OpenCode working directory.
- `--model provider/model` pins an OpenCode model for prompts.
- `--opencode-agent build` selects an OpenCode agent/profile when configured upstream.
- `--permission-policy query|local|reject` controls tool-permission behavior.

## Quick start: attached mode

Attached mode connects to an already-running OpenCode HTTP/SSE server and must not spawn a second server. Use this for power-user workflows where a local OpenCode process already owns the session surface.

```sh
opencode serve --hostname 127.0.0.1 --port 4096

opencode-agent start \
  --base-url http://127.0.0.1:4096 \
  --owner local \
  --session main \
  --directory /path/to/repo \
  --nats-url nats://127.0.0.1:4222
```

Set `--opencode-session-id <id>` when you want prompts to reuse an existing upstream OpenCode session. Without it, the adapter creates or reuses its own session through the OpenCode SDK.

## Configuration

Default config path:

```text
~/.config/synadia/opencode-nats-channel.toml
```

Precedence:

```text
CLI flags > environment variables > config file > defaults
```

Print a template:

```sh
opencode-agent configure --print-template
# local clone equivalent:
bun src/cli.ts configure --print-template
```

Example config:

```toml
[nats]
# Prefer a named NATS context when available.
context = "local"
# Or use a direct local/dev URL.
url = "nats://127.0.0.1:4222"
# Or point to a creds file by path. Never paste credential contents here.
creds = "/path/to/user.creds"

[agent]
owner = "local"
name = "main"
subject_token = "opencode"
heartbeat_interval_s = 30
keepalive_interval_s = 30

[opencode]
# Empty base_url means managed mode. Set a URL for attached mode.
base_url = ""
hostname = "127.0.0.1"
port = 4096
directory = "/path/to/repo"
workspace = ""
opencode_session_id = ""
model = ""
opencode_agent = ""
permission_policy = "query"
permission_timeout_ms = 300000
```

Environment variables supported by the config loader include:

| Area | Variables |
| --- | --- |
| Config | `SYNADIA_OPENCODE_CONFIG` |
| NATS | `NATS_CONTEXT`, `NATS_URL`, `NATS_CREDS`, `NATS_CREDENTIALS` |
| Adapter identity | `SYNADIA_OPENCODE_OWNER`, `SYNADIA_OPENCODE_SESSION` |
| OpenCode server | `OPENCODE_SERVER_URL`, `OPENCODE_HOSTNAME`, `OPENCODE_PORT`, `OPENCODE_DIRECTORY`, `OPENCODE_WORKSPACE`, `OPENCODE_SERVER_PASSWORD`, `OPENCODE_SESSION_ID`, `OPENCODE_MODEL`, `OPENCODE_AGENT`, `OPENCODE_PERMISSION_POLICY` |

If both a NATS context and creds path are set, the adapter uses the context. Keep credential material in NATS config files or creds files; do not inline secrets in shell history, docs, or committed config.

## Doctor

Run `doctor` before exposing a server on a shared NATS account:

```sh
opencode-agent doctor \
  --owner local \
  --session main \
  --directory /path/to/repo \
  --nats-context local
```

In managed mode, doctor checks config parsing, subject validity, NATS option resolution, OpenCode SDK availability, OpenCode CLI availability, and permission policy. In attached mode, it probes the configured HTTP/SSE server instead of checking for the local CLI launcher.

Doctor output redacts password-shaped fields, creds-path values, and NATS seed-like strings before printing.

## Prompt from the NATS CLI

After the adapter starts, discover it:

```sh
nats req '$SRV.INFO.agents' '' --replies=0 --timeout=2s
nats req agents.status.opencode.local.main '' --timeout=2s
```

Prompt it with the protocol stream flags:

```sh
nats req agents.prompt.opencode.local.main 'summarize this repository' \
  --wait-for-empty --reply-timeout=30s --timeout=5m
```

Use an SDK client for query-bearing prompts. The plain `nats` CLI can display a protocol `query` chunk, but it cannot interleave the reply needed to continue that same prompt stream.

## Permission policies

| Policy | Behavior |
| --- | --- |
| `query` | Default. OpenCode permission events become protocol `query` chunks. Replies map to `once`, `always`, or `reject`. |
| `reject` | Permission events are rejected immediately. Useful for non-interactive smoke tests and conservative unattended runs. |
| `local` | Permission handling is delegated to the local OpenCode UI/policy surface; the adapter reports the delegation as a status chunk. |

For `query`, protocol replies of `always`, `allow always`, or `yes always` map to OpenCode `always`; `no`, `deny`, `reject`, or `false` map to `reject`; anything else maps to `once`.

## Validation ladder

Local checks:

```sh
bun run typecheck
bun test
```

Smoke scripts exercise the adapter in layers:

```sh
# Real disposable nats-server + injected fake OpenCode client.
bun run smoke:protocol

# Real OpenCode SDK server lifecycle, attached doctor probe, and no-second-server attached mode check.
bun run smoke:opencode-lifecycle

# Credentialed real OpenCode runtime smoke. Requires a scoped env file; see below.
bun run smoke:opencode-runtime

# Real NATS + real OpenCode permission-query denial path. Requires the same scoped env file.
bun run smoke:opencode-permission
```

Credentialed smokes load only a narrow env file. Default path:

```text
~/.config/synadia/opencode-runtime-smoke.env
```

Override it with `OPENCODE_TEST_ENV_FILE=/path/to/file`. Allowed keys:

```text
OPENROUTER_API_KEY=[REDACTED]
OPENCODE_TEST_MODEL=openrouter/provider-model
```

The scripts refuse unexpected keys, chmod the env file to `0600`, and do not print secret values.

## Current limitations

- Attachments are rejected until OpenCode file ingestion is mapped end-to-end.
- Managed mode uses the OpenCode SDK server launcher, which resolves the `opencode` binary from `PATH`; this adapter does not expose a custom binary-path setting because the SDK launcher does not accept one.
- Attached mode targets the OpenCode server/session surface. It should not be described as a TUI-specific API unless OpenCode exposes a typed TUI/session attach API.
- Permission-query bridging depends on OpenCode emitting permission events with session and permission ids.
- The adapter registers one NATS identity per process. Run more processes when you want multiple independently discoverable OpenCode instances.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `doctor` says OpenCode binary is missing | Managed mode needs `opencode` on `PATH`. Run `which opencode` in the same shell that starts the adapter, or use attached mode with `--base-url`. |
| No agent appears in discovery | Verify NATS context/URL, then run `nats micro list` and `nats req '$SRV.INFO.agents' '' --replies=0 --timeout=2s`. |
| Prompt returns only the leading ack | Use `--wait-for-empty --reply-timeout=30s --timeout=<large enough>` with `nats req`, or use an SDK client. |
| Attached mode connects to the wrong server | Check `--base-url` and `OPENCODE_SERVER_PASSWORD`; doctor reports only the safe origin, not full secret-bearing details. |
| Attachment request gets `400` | Expected for v1. The prompt endpoint advertises `attachments_ok=false`. |
| Tool call pauses forever | Use `permission_policy=query` with an SDK/query-capable caller, or choose `reject`/`local` depending on your risk posture. |

## See also

- Sibling channel plugins: [`pi`](../pi), [`openclaw`](../openclaw), [`claude-code`](../claude-code), [`hermes`](../hermes), [`deerflow`](../deerflow), [`flue`](../flue), and [`open-agent`](../open-agent).
- TypeScript host SDK: [`../../agent-sdk/typescript`](../../agent-sdk/typescript).
- NATS CLI cookbook: [`../../docs/using-nats-cli.md`](../../docs/using-nats-cli.md).
- Wire protocol: [`synadia-ai/synadia-agent-sdk-docs`](https://github.com/synadia-ai/synadia-agent-sdk-docs).
