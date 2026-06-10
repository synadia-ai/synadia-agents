# OpenCode NATS channel

`@synadia-ai/opencode-nats-channel` exposes an OpenCode project as a Synadia Agent Protocol for NATS agent by loading a small OpenCode plugin.

The intended user path is plugin-first:

1. install the package from npm,
2. install the generated `.opencode/plugins/synadia-channel.ts` wrapper in a project,
3. start OpenCode normally,
4. discover and prompt the project over NATS.

The wrapper imports the package plugin export; it does not copy the protocol implementation into the project.

## Prerequisites

- [Bun](https://bun.sh/) installed and available on `PATH`. The package CLI is a Bun TypeScript entrypoint.
- [OpenCode](https://opencode.ai/) installed and available on `PATH`. The plugin loads inside the OpenCode process.
- A reachable NATS server, or a NATS CLI context.
- The [NATS CLI](https://github.com/nats-io/natscli) for the discovery and prompt examples below.

## Package surface

| Field | Value |
| --- | --- |
| Package | `@synadia-ai/opencode-nats-channel` |
| CLI | `opencode-agent` |
| OpenCode plugin export | `@synadia-ai/opencode-nats-channel/opencode-plugin` |
| Protocol token | `opencode` |
| Prompt subject | `agents.prompt.opencode.<owner>.<session>` |
| Status subject | `agents.status.opencode.<owner>.<session>` |
| Heartbeat subject | `agents.hb.opencode.<owner>.<session>` |
| Host SDK | `@synadia-ai/agent-service` / `AgentService` |
| Attachments | `attachments_ok=false` for v1 |

`owner` is the account/operator namespace. `session` is the NATS-visible OpenCode project/session name. It is intentionally separate from OpenCode's internal `ses_...` id.

## Install

The published CLI is a Bun TypeScript entrypoint (`#!/usr/bin/env bun`), so Bun must be installed and available on `PATH` anywhere you run it.

```sh
bunx @synadia-ai/opencode-nats-channel plugin print-env-template
bunx @synadia-ai/opencode-nats-channel plugin install --directory /path/to/repo --owner local --session main
bunx @synadia-ai/opencode-nats-channel plugin doctor --directory /path/to/repo
```

From a local clone for development:

```sh
cd agents/opencode
bun install
bun run typecheck
bun test
bun src/cli.ts plugin install --directory /path/to/repo --owner local --session main
```

Maintainers: this package must be published to npm before the `bunx` install path works. See the release ladder in [`../../README-DEV.md`](../../README-DEV.md).

## Quick start

Install the project-local plugin wrapper:

```sh
bunx @synadia-ai/opencode-nats-channel plugin install \
  --directory /path/to/repo \
  --owner local \
  --session main
```

The installer creates or updates:

```text
.opencode/plugins/synadia-channel.ts
.opencode/package.json
```

The generated wrapper is intentionally tiny:

```ts
import { SynadiaChannelPlugin } from "@synadia-ai/opencode-nats-channel/opencode-plugin";

export default SynadiaChannelPlugin;
```

Start OpenCode with the plugin environment configured:

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

If `SYNADIA_OPENCODE_SESSION` is unset, the plugin derives a `session-<hash>` token from the OpenCode directory instead of publishing local path names. Discovery metadata uses hashes and safe origins only; it does not expose raw directories, project ids, credentials, or server passwords.

## Plugin commands

After a global install, the binary is `opencode-agent`; before that, substitute `bunx @synadia-ai/opencode-nats-channel` for `opencode-agent` in the examples below.

```sh
opencode-agent plugin install --directory /path/to/repo --owner local --session main
opencode-agent plugin doctor --directory /path/to/repo
opencode-agent plugin uninstall --directory /path/to/repo
opencode-agent plugin print-env-template
```

`plugin install` updates only the generated wrapper and the project's `.opencode/package.json` dependency entry.

## Configuration

Most plugin deployments only need environment variables:

| Area | Variables |
| --- | --- |
| NATS | `NATS_CONTEXT`, `NATS_URL`, `NATS_CREDS`, `NATS_CREDENTIALS` |
| Identity | `SYNADIA_OPENCODE_OWNER`, `SYNADIA_OPENCODE_SESSION` |
| Heartbeats | `SYNADIA_OPENCODE_HEARTBEAT_INTERVAL_S`, `SYNADIA_OPENCODE_KEEPALIVE_INTERVAL_S` |
| Permissions | `OPENCODE_PERMISSION_POLICY`, `OPENCODE_PERMISSION_TIMEOUT_MS` |

Permission policy values:

| Policy | Behavior |
| --- | --- |
| `query` | Default. OpenCode permission events become protocol `query` chunks. Replies map to OpenCode `once`, `always`, or `reject`. |
| `reject` | Reject permission events immediately. Useful for conservative unattended runs. |
| `local` | Delegate permission handling to the local OpenCode UI/policy surface. |

For `query`, protocol replies of `always`, `allow`, `allow always`, or `yes always` map to OpenCode `always`; `yes`, `once`, or `true` map to one-shot approval; `no`, `deny`, `reject`, or `false` map to `reject`. Empty or ambiguous replies are rejected.

Keep real `.env`, `.creds`, and `.nkey` files untracked. The package includes `.env.example` with harmless defaults and path placeholders.

## Discover and prompt

After OpenCode starts with the plugin loaded, discover the agent:

```sh
nats req '$SRV.INFO.agents' '' --replies=0 --timeout=2s
nats req agents.status.opencode.local.main '' --timeout=2s
```

Prompt it:

```sh
nats req agents.prompt.opencode.local.main 'summarize this repository' \
  --wait-for-empty --reply-timeout=30s --timeout=5m
```

Use a protocol SDK client for prompts that may trigger permission queries. The plain `nats` CLI can display a protocol `query` chunk, but it cannot interleave the reply needed to continue the same prompt stream.

## Validation

Local checks:

```sh
bun run typecheck
bun test
```

Plugin production-path smokes:

```sh
bun run smoke:opencode-plugin-lifecycle
bun run smoke:opencode-plugin-permission
```

Protocol and real-runtime smokes are also available for maintainers:

```sh
bun run smoke:protocol
bun run smoke:opencode-lifecycle
bun run smoke:opencode-runtime
bun run smoke:opencode-permission
```

Credentialed smokes load only a narrow repo-external env file. Override it with `OPENCODE_TEST_ENV_FILE=/path/to/file`. Allowed keys:

```text
OPENROUTER_API_KEY=[REDACTED]
OPENCODE_TEST_MODEL=openrouter/provider-model
```

The scripts refuse unexpected keys, chmod the env file to `0600`, and do not print secret values.

## Current limitations

- Attachments are rejected until OpenCode file ingestion is mapped end-to-end.
- Plugin mode registers one NATS identity per loaded plugin channel. Use distinct owner/session tokens when you want multiple independently discoverable OpenCode projects.
- Permission-query bridging depends on OpenCode emitting permission events with session and permission ids. The plugin first tries `client.permission.reply`, then falls back to observed HTTP/SDK reply surfaces.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `plugin doctor` says the wrapper is missing | Run `opencode-agent plugin install --directory /path/to/repo`. |
| No agent appears in discovery | Verify NATS context/URL, then run `nats micro list` and `nats req '$SRV.INFO.agents' '' --replies=0 --timeout=2s`. |
| Prompt returns only the leading ack | Use `--wait-for-empty --reply-timeout=30s --timeout=<large enough>` with `nats req`, or use an SDK client. |
| Attachment request gets `400` | Expected for v1. The prompt endpoint advertises `attachments_ok=false`. |
| Tool call pauses forever | Use `OPENCODE_PERMISSION_POLICY=query` with an SDK/query-capable caller, or choose `reject`/`local` depending on your risk posture. |

## See also

- Sibling channel plugins: [`pi`](../pi), [`openclaw`](../openclaw), [`claude-code`](../claude-code), [`hermes`](../hermes), [`deerflow`](../deerflow), [`flue`](../flue), and [`open-agent`](../open-agent).
- TypeScript host SDK: [`../../agent-sdk/typescript`](../../agent-sdk/typescript).
- NATS CLI cookbook: [`../../docs/using-nats-cli.md`](../../docs/using-nats-cli.md).
- Wire protocol: [`synadia-ai/synadia-agent-sdk-docs`](https://github.com/synadia-ai/synadia-agent-sdk-docs).
