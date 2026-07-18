# Grok Build NATS Channel

`@synadia-ai/grok-nats-channel` puts [Grok Build](https://x.ai/cli) (the
`grok` CLI coding agent) on the NATS bus as a spec-compliant
[Synadia Agent Protocol for NATS](https://github.com/synadia-ai/synadia-agent-sdk-docs)
v0.3 agent:

```
agents.prompt.grok.<owner>.<session>     prompt endpoint
agents.status.grok.<owner>.<session>     status endpoint
agents.hb.grok.<owner>.<session>         heartbeats
```

It is a **thin, grok-pinned front door** to the generic
[ACP channel](../acp/) (`@synadia-ai/acp-nats-channel`) — grok speaks the
[Agent Client Protocol](https://agentclientprotocol.com) natively via
`grok agent stdio`, and all bridging logic (spawn, ACP session, streaming,
§7 permission relay) lives in the ACP channel. This package pins the preset
(`grok-agent start` ≡ `acp-agent start --agent grok --mode managed`) and
documents the grok-specific workflow. For architecture, wire mapping, and
limitations (no attachments yet, no subprocess supervision), see the
[ACP channel README](../acp/README.md).

## Prerequisites

- [Bun](https://bun.sh) 1.3+
- The `grok` CLI, authenticated once interactively:
  `curl -fsSL https://x.ai/cli/install.sh | bash && grok`
- A NATS server (`nats-server` locally, or any reachable deployment)

## Quickstart

```sh
grok-agent start --agent-home ~/.grok --nats-url nats://127.0.0.1:4222
# -> acp-agent (grok, managed) listening on agents.prompt.grok.<you>.<cwd-name>
```

Prompt it from anywhere on the bus:

```sh
nats req agents.prompt.grok.<you>.<session> "hello grok" \
  --replies=0 --reply-timeout=30s --timeout=120s
```

Or with the [`@synadia-ai/agents`](../../client-sdk/typescript) SDK:

```ts
const [agent] = await agents.discover({ filter: { agent: "grok" } });
for await (const msg of await agent!.prompt("summarize this repo")) {
  if (msg.type === "response") process.stdout.write(msg.text);
  if (msg.type === "query") await msg.reply("approve");   // §7 permission relay
}
```

The grok session is long-lived: consecutive prompts share conversation
memory until the channel restarts.

## Choosing the agent home (`--agent-home`)

Managed grok runs with `GROK_HOME` pointed at the home you choose; this
decides both **auth** and **when grok asks permission**:

| Strategy | Command | Effect |
| --- | --- | --- |
| Reuse your login | `--agent-home ~/.grok` | Works immediately, but inherits your `config.toml` — including `permission_mode = "always-approve"` if set, in which case grok never asks and §7 queries never fire. |
| Dedicated authed home (recommended) | `GROK_HOME=/srv/grok-bot grok` once to authenticate, then `--agent-home /srv/grok-bot` | Clean default permission mode: file writes and non-read-only commands ask, and the asks reach the bus. |
| Ephemeral (default, no flag) | — | Isolated temp home, removed on shutdown — unauthenticated, so `start` fails with an auth hint. Useful only with future non-interactive auth. |

## The permission workflow, live-verified

With `--permission-policy query`, grok's ACP `session/request_permission`
becomes a protocol **§7 query chunk** the NATS caller answers. Verified
against grok 0.2.103 (default permission mode, scratch authed home):

**Approve** — caller replied `approve`, mapped to ACP `allow_once`:

```
[status] tool: write
[query]  ACP agent requests permission: Write `.../query-proof.txt` [edit].
         Reply approve to allow once; anything else denies.
         Details: {"variant":"Write","file_path":"...","content":"the section-7 relay works\n"}
[status] tool completed: call-cbd3f758-...
-> file created with the exact content
```

**Deny** — caller replied `deny`, mapped to `reject_once`:

```
[query]  ACP agent requests permission: Write `.../should-not-exist.txt` [edit]. ...
[status] tool failed: call-c1f5dd0e-...
[status] stop: cancelled
-> file not created
```

**Grok decides *when* to ask** (its hooks → allow/ask/deny rules → read-only
auto-approvals → permission mode pipeline runs first); the channel policy
only answers what arrives. `reject` (default policy) denies asks without
relaying; `allow` auto-approves — see the
[ACP channel README](../acp/README.md#permissions).

## Configuration

`grok-agent` accepts every `acp-agent` flag except `--agent` (pinned).
Mode defaults to `managed` here (`--mode fake` still available for smoke
runs). Identity env vars, precedence, and the TOML config file are the ACP
channel's — the grok-specific vars:

| Variable | Meaning | Default |
| --- | --- | --- |
| `SYNADIA_GROK_OWNER` | Owner (4th subject token) | sanitized `$USER` |
| `SYNADIA_GROK_SESSION` | Session (5th subject token) | sanitized cwd basename |
| `SYNADIA_GROK_HOME` | Agent home (see above) | ephemeral temp dir |
| `SYNADIA_GROK_BIN`, `SYNADIA_GROK_ARGS` | Spawn override | `grok` / `agent stdio` |
| `SYNADIA_GROK_PERMISSION_POLICY` | `reject`, `query`, `allow` | `reject` |

Run `grok-agent doctor` to print the resolved identity and a `grok --version`
probe.

## Validation

- `bun test` — wrapper pinning + package/README honesty guards.
- The full protocol/runtime suites live in the [ACP channel](../acp/)
  (`bun test`, `smoke:protocol`, `smoke:acp-fake-runtime` — deterministic,
  no grok binary needed).
- `bun run manual:live -- --session <name> --answer approve "<prompt>"` —
  discover + prompt a running channel, auto-answering §7 queries.

## Publishing note

Until `@synadia-ai/acp-nats-channel` ships to npm, this package depends on
it via a `file:../acp` link (repo-local development). The release-ladder
step that publishes the ACP channel flips this to a semver range before
`grok-nats-channel` itself is published.
