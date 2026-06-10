# OpenCode NATS channel

`@synadia-ai/opencode-nats-channel` exposes an [OpenCode](https://opencode.ai/) project/session as a Synadia Agent Protocol for NATS agent. The primary path is an in-process OpenCode plugin; the external `opencode-agent start` adapter remains available for managed or attached server workflows. Both paths are TypeScript/Bun and use `@synadia-ai/agent-service` rather than hand-written protocol subjects.

It registers a first-class `agents` micro service, routes protocol prompts into OpenCode sessions, streams OpenCode SSE text events as protocol `response` chunks, maps OpenCode permission events to protocol `query` chunks when configured, and advertises `attachments_ok=false` until OpenCode file ingestion is wired end-to-end.

## Package surface

| Field | Value |
| --- | --- |
| Package | `@synadia-ai/opencode-nats-channel` |
| Binary | `opencode-agent` |
| OpenCode plugin export | `@synadia-ai/opencode-nats-channel/opencode-plugin` |
| Type token | `opencode` |
| Prompt subject | `agents.prompt.opencode.<owner>.<session>` |
| Status subject | `agents.status.opencode.<owner>.<session>` |
| Heartbeat subject | `agents.hb.opencode.<owner>.<session>` |
| Host SDK | `@synadia-ai/agent-service` / `AgentService` |
| Attachments | `attachments_ok=false` for v1 |

`owner` is the account/operator namespace. `session` is the registered OpenCode adapter instance name, not necessarily the upstream OpenCode session id.

## Install

The published `opencode-agent` binary is a Bun TypeScript entrypoint (`#!/usr/bin/env bun`), so Bun must be installed and available on `PATH` anywhere you run the package binary.

From npm:

```sh
bunx @synadia-ai/opencode-nats-channel plugin print-env-template
bunx @synadia-ai/opencode-nats-channel plugin install --directory /path/to/repo --owner local --session main
bunx @synadia-ai/opencode-nats-channel doctor
```

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

## Process model: TUI vs server vs adapter

There are four different processes/surfaces that are easy to conflate:

- **OpenCode TUI** — the interactive terminal UI a developer uses locally.
- **OpenCode plugin** — code loaded by OpenCode from `.opencode/plugins/`, running inside the OpenCode process and registering the current project/session on NATS.
- **OpenCode HTTP/SSE server** — the `opencode serve` process that exposes sessions and event streams to the OpenCode SDK.
- **Synadia adapter process** — `opencode-agent start`, the fallback external process that connects NATS to one OpenCode server/session surface and registers one Synadia Agent Protocol identity.

The plugin path is the default heavy-user flow: install the wrapper in a repo, start OpenCode normally, and the running OpenCode process registers that project/session on NATS. Attached mode connects to the OpenCode HTTP/SSE server URL given by `--base-url`; it does not attach to arbitrary terminal TUI processes. If a TUI and server share the same upstream OpenCode session surface, the adapter can make that session NATS-addressable. If only a plain `opencode` TUI is running and no server URL exists, use the plugin path or start `opencode serve` explicitly.

## Quick start: OpenCode plugin mode

Install a thin project-local wrapper. It imports the package plugin export and does not duplicate the protocol implementation.

```sh
opencode-agent plugin install \
  --directory /path/to/repo \
  --owner local \
  --session main
```

The installer creates or updates:

```text
.opencode/plugins/synadia-channel.ts
.opencode/package.json
```

Start OpenCode with plugin-safe environment variables:

```sh
export NATS_URL=nats://127.0.0.1:4222
export SYNADIA_OPENCODE_OWNER=local
export SYNADIA_OPENCODE_SESSION=main
export OPENCODE_PERMISSION_POLICY=query
opencode serve --hostname 127.0.0.1 --port 4096
```

When the plugin loads, it registers:

```text
agents.prompt.opencode.local.main
agents.status.opencode.local.main
agents.hb.opencode.local.main
```

If `SYNADIA_OPENCODE_SESSION` is not set, the plugin derives a `session-<hash>` token from the OpenCode directory instead of publishing local path names. Discovery metadata uses hashes and safe origins only; it does not expose raw directories, project ids, credentials, or server passwords.

Plugin commands:

```sh
opencode-agent plugin doctor --directory /path/to/repo
opencode-agent plugin uninstall --directory /path/to/repo
opencode-agent plugin print-env-template
```

## Quick start: managed mode

Managed mode starts and owns an `opencode serve` process through `@opencode-ai/sdk`. Use this fallback when a separate adapter process is preferred or plugin installation is not available.

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

Attached mode connects to an already-running OpenCode HTTP/SSE server and must not spawn a second server. Use this fallback for control-plane workflows where a local OpenCode server already owns the session surface and a plugin is not the right deployment shape.

```sh
opencode serve --hostname 127.0.0.1 --port 4096

opencode-agent start \
  --base-url http://127.0.0.1:4096 \
  --owner local \
  --session main \
  --directory /path/to/repo \
  --nats-url nats://127.0.0.1:4222
```

Set `--opencode-session-id <id>` when you want prompts to reuse an existing upstream OpenCode session. Without it, the adapter creates or reuses its own session through the OpenCode SDK. Config files should use `opencode_session_id`; the loader also accepts `session_id` as a compatibility alias.

## Multi-session recipe

The v1 adapter registers one NATS identity per adapter process. To expose multiple OpenCode sessions from one server, run one shared `opencode serve` on a fixed port and start one adapter process for each NATS identity/session you want callers to discover:

```sh
opencode serve --hostname 127.0.0.1 --port 4096

opencode-agent start \
  --base-url http://127.0.0.1:4096 \
  --owner team \
  --session frontend \
  --opencode-session-id ses_frontend \
  --directory /path/to/frontend \
  --nats-url nats://127.0.0.1:4222

opencode-agent start \
  --base-url http://127.0.0.1:4096 \
  --owner team \
  --session backend \
  --opencode-session-id ses_backend \
  --directory /path/to/backend \
  --nats-url nats://127.0.0.1:4222
```

Those adapters register separate prompt subjects:

```text
agents.prompt.opencode.team.frontend
agents.prompt.opencode.team.backend
```

Use separate `opencode serve` ports instead when you need full server/process isolation rather than several sessions behind one OpenCode HTTP/SSE server.

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
# Protocol subject token is fixed for this adapter; changing it is rejected.
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

For env-first local runs, copy the package template and edit only local values:

```sh
# from agents/opencode/
cp .env.example .env
```

Keep real `.env`, `.creds`, and `.nkey` files untracked. The example file uses harmless defaults and credential paths only.

| Area | Variables |
| --- | --- |
| Config | `SYNADIA_OPENCODE_CONFIG` |
| NATS | `NATS_CONTEXT`, `NATS_URL`, `NATS_CREDS`, `NATS_CREDENTIALS` |
| Adapter identity | `SYNADIA_OPENCODE_OWNER`, `SYNADIA_OPENCODE_SESSION` |
| OpenCode server | `OPENCODE_SERVER_URL`, `OPENCODE_HOSTNAME`, `OPENCODE_PORT`, `OPENCODE_DIRECTORY`, `OPENCODE_WORKSPACE`, `OPENCODE_SERVER_PASSWORD`, `OPENCODE_SESSION_ID`, `OPENCODE_MODEL`, `OPENCODE_AGENT`, `OPENCODE_PERMISSION_POLICY` |
| Plugin runtime | `SYNADIA_OPENCODE_HEARTBEAT_INTERVAL_S`, `SYNADIA_OPENCODE_KEEPALIVE_INTERVAL_S`, `OPENCODE_PERMISSION_TIMEOUT_MS` |

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

For `query`, protocol replies of `always`, `allow always`, or `yes always` map to OpenCode `always`; `yes`, `once`, `allow`, or `true` map to one-shot approval; `no`, `deny`, `reject`, or `false` map to `reject`. Empty or ambiguous replies are rejected instead of silently granting tool access.

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

# OpenCode plugin lifecycle and permission bridge smoke entrypoints.
bun run smoke:opencode-plugin-lifecycle
bun run smoke:opencode-plugin-permission
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
- Permission-query bridging depends on OpenCode emitting permission events with session and permission ids. The plugin first tries `client.permission.reply`, then falls back to the observed HTTP/SDK reply surfaces.
- Plugin mode registers one NATS identity per loaded plugin channel. External fallback mode registers one NATS identity per adapter process. Use distinct owner/session tokens when you want multiple independently discoverable OpenCode instances.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `doctor` says OpenCode binary is missing | Managed mode needs `opencode` on `PATH`. Run `which opencode` in the same shell that starts the adapter, or use attached mode with `--base-url`. |
| No agent appears in discovery | Verify NATS context/URL, then run `nats micro list` and `nats req '$SRV.INFO.agents' '' --replies=0 --timeout=2s`. |
| Prompt returns only the leading ack | Use `--wait-for-empty --reply-timeout=30s --timeout=<large enough>` with `nats req`, or use an SDK client. |
| Attached mode connects to the wrong server | Check `--base-url` and `OPENCODE_SERVER_PASSWORD`; doctor reports only the safe origin, not full secret-bearing details. |
| Attachment request gets `400` | Expected for v1. The prompt endpoint advertises `attachments_ok=false`. |
| Tool call pauses forever | Use `permission_policy=query` with an SDK/query-capable caller, or choose `reject`/`local` depending on your risk posture. In plugin mode, verify OpenCode emits `permission.asked` or `permission.v2.asked` events with ids. |

## See also

- Plugin-first implementation plan: [`PLUGIN_FIRST_IMPLEMENTATION_SPEC.md`](PLUGIN_FIRST_IMPLEMENTATION_SPEC.md).
- Sibling channel plugins: [`pi`](../pi), [`openclaw`](../openclaw), [`claude-code`](../claude-code), [`hermes`](../hermes), [`deerflow`](../deerflow), [`flue`](../flue), and [`open-agent`](../open-agent).
- TypeScript host SDK: [`../../agent-sdk/typescript`](../../agent-sdk/typescript).
- NATS CLI cookbook: [`../../docs/using-nats-cli.md`](../../docs/using-nats-cli.md).
- Wire protocol: [`synadia-ai/synadia-agent-sdk-docs`](https://github.com/synadia-ai/synadia-agent-sdk-docs).
