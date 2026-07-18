# ACP NATS Channel

`@synadia-ai/acp-nats-channel` exposes **ACP-speaking coding agents** — Grok
Build, Gemini CLI, and any other agent that implements the
[Agent Client Protocol](https://agentclientprotocol.com) — through the
[Synadia Agent Protocol for NATS](https://github.com/synadia-ai/synadia-agent-sdk-docs) v0.3.

One generic bridge instead of one bespoke channel per agent: the adapter
spawns the agent in ACP-over-stdio mode, opens a long-lived ACP session, and
maps the two protocols onto each other:

| Synadia Agent Protocol (NATS) | ACP |
| --- | --- |
| prompt envelope (§5) | `session/prompt` |
| response chunks (§6.3) | `agent_message_chunk` updates |
| status chunks (§6.4) | `tool_call` / `plan` updates (terse summaries) |
| mid-stream query chunks (§7) | `session/request_permission` |
| stream terminator (§6.5) | `session/prompt` resolves with a stop reason |

Service registration, heartbeats, keepalives, error mapping, and stream
terminators come from `@synadia-ai/agent-service`, exactly as in the
[codex channel](../codex/) this adapter is modeled on.

## Package surface

- Package: `@synadia-ai/acp-nats-channel`
- Binary: `acp-agent`
- Prompt subject: `agents.prompt.<token>.<owner>.<session>` where `<token>`
  comes from the preset (`grok`, `gemini`, or your custom token)
- Status subject: `agents.status.<token>.<owner>.<session>`
- Heartbeat subject: `agents.hb.<token>.<owner>.<session>`

## Presets

| Preset | `metadata.agent` | Subject token | Spawns | Home isolation |
| --- | --- | --- | --- | --- |
| `grok` (default) | `grok` | `grok` | `grok agent stdio` | `GROK_HOME` → ephemeral temp dir |
| `gemini` | `gemini-cli` | `gemini` | `gemini --experimental-acp` | — |
| `custom` | `--agent-id` | `--agent-id` (or `--subject-token`) | `--acp-bin` + `--acp-args` | — |

Any agent on the [ACP agents list](https://agentclientprotocol.com/get-started/agents)
that supports core `initialize` / `session/new` / `session/prompt` should work
via `custom`; presets just bundle the spawn command and env-var conventions.

## Prerequisites

- Bun 1.3+ for local development and smoke tests.
- `nats-server` on `PATH` for the smoke tests (they start disposable loopback
  servers).
- The agent binary for managed mode: [`grok`](https://x.ai/cli) or
  [`gemini`](https://github.com/google-gemini/gemini-cli). Not required for
  `fake` mode or the deterministic smokes.

## Quickstart (grok)

```sh
# 1. Install grok and authenticate it once (browser flow):
curl -fsSL https://x.ai/cli/install.sh | bash
grok   # complete auth, then quit

# 2. Start the channel against your NATS server, reusing that auth:
acp-agent start --agent grok --mode managed --agent-home ~/.grok \
  --nats-url nats://127.0.0.1:4222

# -> acp-agent (grok, managed) listening on agents.prompt.grok.<you>.<cwd-name>
```

Prompt it from anywhere on the bus:

```sh
nats req agents.prompt.grok.<you>.<session> "hello grok" \
  --replies=0 --reply-timeout=30s --timeout=120s
```

Or with the [`@synadia-ai/agents`](../../client-sdk/typescript) SDK:

```ts
import { connect } from "@nats-io/transport-node";
import { Agents } from "@synadia-ai/agents";

const nc = await connect({ servers: "nats://127.0.0.1:4222" });
const agents = new Agents({ nc });
const [agent] = await agents.discover({ filter: { agent: "grok" } });
for await (const msg of await agent!.prompt("summarize this repo")) {
  if (msg.type === "response") process.stdout.write(msg.text);
  if (msg.type === "query") await msg.reply("yes");   // permission relay (§7)
}
await agents.close();
await nc.close();
```

The ACP session is long-lived: consecutive prompts share conversation memory
until the channel restarts.

## Modes

- **`managed`** — the adapter spawns and owns the agent subprocess and one ACP
  session. This is the real mode.
- **`fake`** (default) — a deterministic in-process bridge used by the
  protocol smoke tests; no subprocess. The config-file template ships with
  `mode = "managed"`.

There is **no automatic restart / supervision**: if the agent process crashes,
in-flight and subsequent prompts fail with protocol 500s until the channel is
restarted (same crash model as the codex channel).

## Configuration

Precedence: CLI flags > per-agent env (`SYNADIA_GROK_*`) > channel env
(`SYNADIA_ACP_*`) > fleet-wide env (`SYNADIA_OWNER` / `SYNADIA_NAME`) > TOML
config file > derived defaults. Config file:
`~/.config/synadia/acp-nats-channel.toml` (print a starter with
`acp-agent configure --print-template`).

| Variable | Meaning | Default |
| --- | --- | --- |
| `SYNADIA_ACP_AGENT` | Preset: `grok`, `gemini`, `custom` | `grok` |
| `SYNADIA_GROK_OWNER`, `SYNADIA_ACP_OWNER`, `SYNADIA_OWNER` | Owner (4th subject token) | sanitized `$USER` |
| `SYNADIA_GROK_SESSION`, `SYNADIA_ACP_SESSION`, `SYNADIA_NAME` | Session (5th subject token) | sanitized cwd basename |
| `SYNADIA_ACP_MODE` | `fake` or `managed` | `fake` |
| `SYNADIA_GROK_BIN`, `SYNADIA_ACP_BIN` | Agent binary override | preset (`grok`) |
| `SYNADIA_GROK_ARGS`, `SYNADIA_ACP_ARGS` | Spawn args override (space-separated) | preset (`agent stdio`) |
| `SYNADIA_GROK_HOME`, `SYNADIA_ACP_HOME` | Agent home dir (reuse auth) | ephemeral temp dir (grok) |
| `SYNADIA_ACP_CWD` | ACP session working directory | process cwd |
| `SYNADIA_GROK_PERMISSION_POLICY`, `SYNADIA_ACP_PERMISSION_POLICY` | `reject`, `query`, `allow` | `reject` |
| `NATS_URL` / `NATS_CONTEXT` / `NATS_CREDS` | NATS connection | `nats://127.0.0.1:4222` |

Run `acp-agent doctor` to print the resolved identity, spawn command, and a
`--version` probe of the agent binary.

## Permissions

ACP agents ask the *client* for tool-call authorization
(`session/request_permission`). The adapter policy decides the answer:

- **`reject`** (default) — deny every request (`reject_once` option). The
  agent keeps working within whatever it may do without approval.
- **`query`** — relay the request to the NATS caller as a protocol §7 query
  chunk. Reply `approve` (or `yes`) to allow once; anything else denies; no
  reply within 30 s cancels.
- **`allow`** — approve everything (`allow_once`). Headless demos only; the
  agent runs commands without a human in the loop.

**The agent decides *when* to ask.** The adapter policy only answers requests
the agent actually sends. Grok runs its own authorization pipeline first
(hooks → allow/ask/deny rules → built-in read-only auto-approvals → its
*permission mode*), configured in the agent home's `config.toml`. In grok's
`default` mode, file writes and non-read-only commands produce
`session/request_permission` — which `query` relays to the bus. But if the
agent home sets `permission_mode = "always-approve"` (common in interactive
setups — check `~/.grok/config.toml` before reusing it via `--agent-home`),
grok auto-approves internally and **no queries ever reach the caller**. For a
bus-governed agent, use a dedicated home containing just the auth state and no
`permission_mode` override.

## Auth and home isolation (grok)

Managed grok runs with `GROK_HOME` pointed at an **ephemeral temp directory**
by default, removed on shutdown. That keeps the channel's agent state — and
grok's leader socket, which lives under `GROK_HOME` — fully isolated from any
interactive grok session you may have open. The tradeoff: a fresh home is
unauthenticated, so `session/new` fails with an auth error until you either

- pass `--agent-home ~/.grok` (or `SYNADIA_GROK_HOME=~/.grok`) to reuse the
  auth from an interactive `grok` login, or
- authenticate a dedicated home once: `GROK_HOME=/srv/grok-bot grok`, then
  `--agent-home /srv/grok-bot`.

Gemini CLI has no home env var in the preset; it uses its normal user
configuration and auth.

## Protocol compliance and limitations

Implements the Synadia Agent Protocol for NATS v0.3 host checklist via
`@synadia-ai/agent-service`: `agents` micro service registration, `prompt` +
`status` endpoints, heartbeats, leading + periodic `ack` status chunks, typed
response chunks, §7 queries, §9 error frames, and the empty-body terminator.

Current limitations (v0.1):

- **Attachments are not supported** — the prompt endpoint advertises
  `attachments_ok=false` and rejects envelopes with attachments (400). ACP
  content blocks make native attachment mapping possible later.
- Responses stream **assistant text only**; agent thoughts are dropped and
  tool calls/plans surface as terse status chunks.
- One ACP session per channel instance; prompts are serialized per session
  (concurrent NATS requests queue).
- No subprocess supervision (see Modes above).

## Validation

| Command | What it proves | Needs |
| --- | --- | --- |
| `bun test` | Config/presets/bridge/permission mapping + managed runtime against the fake ACP agent | — |
| `bun run smoke:protocol` | Full wire compliance (discovery, metadata, heartbeat, §6/§7/§9 shapes) with the fake bridge | `nats-server` |
| `bun run smoke:acp-fake-runtime` | NATS → managed runtime → spawned fake ACP agent end-to-end | `nats-server` |
| `acp-agent start --agent grok --mode managed ...` | The real thing | `grok` binary + auth |
| `bun run manual:acp-live -- --session <name> "<prompt>"` | Discover + prompt a running channel, auto-answering §7 queries | a running channel |

The fake ACP agent (`scripts/fake-acp-agent.ts`) speaks raw newline-delimited
JSON-RPC with no SDK dependency, so the smokes exercise the adapter against
the actual wire shape without any real agent binary or model credentials.

## Troubleshooting

- **`failed to start managed ACP agent ... auth`** — the isolated home is
  unauthenticated; see *Auth and home isolation* above.
- **`spawn grok ENOENT`** — the binary is not on `PATH`; check
  `acp-agent doctor` and `--acp-bin`.
- **Prompt returns 500 mid-stream** — the agent process likely exited; the
  error carries the tail of its stderr. Restart the channel.
- **`query` policy set but no queries arrive** — the agent isn't asking. For
  grok, check the agent home's `config.toml` for
  `permission_mode = "always-approve"` (see *Permissions* above).
