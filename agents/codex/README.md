# `@synadia-ai/nats-codex-channel`

A bridge implementing the **Synadia Agent Protocol for NATS** for the
OpenAI Codex CLI via [Zed's `codex-acp`
adapter](https://github.com/zed-industries/codex-acp). Exposes a Codex
session on `agents.prompt.codex.<owner>.<session>` so any protocol
caller — the `@synadia-ai/agents` SDK, `nats req`, or `agent-web-ui` —
can drive it.

The bridge is built on `AgentService` from `@synadia-ai/agent-service`
(heartbeats, status endpoint, terminator emission). It spawns
`codex-acp` as a child process and talks ACP JSON-RPC over its stdio
using `@agentclientprotocol/sdk`.

## Status

**Experimental — v0.1.** Single-session, single-process. One bridge
handles one `(owner, session)` pair and reuses one ACP session across
prompts. Permission requests from the harness are **default-denied** in
this version — relaying them as Synadia §7 `query` chunks is the next
milestone.

## Prerequisites

- [Bun](https://bun.sh) — the bridge runs on Bun. Install with
  `curl -fsSL https://bun.sh/install | bash` and make sure `bun` is on
  your `PATH`.
- A NATS server reachable from the bridge. The bridge defaults to
  `nats://127.0.0.1:4222`; configure via a [NATS CLI
  context](https://github.com/nats-io/natscli) or `NATS_URL`.
- An OpenAI API key (`OPENAI_API_KEY` — or `CODEX_API_KEY` if you have a
  ChatGPT Plus / Pro subscription configured for Codex). The bridge
  forwards these env vars to the spawned `codex-acp` process verbatim.
- Either `npx` on your PATH (the default launcher is
  `npx -y @zed-industries/codex-acp`), or a locally-installed
  `codex-acp` binary referenced via `CODEX_ACP_COMMAND`.

## Quickstart

```sh
# terminal 1
nats-server -js

# terminal 2
cd agents/codex
bun install
OPENAI_API_KEY=sk-... bun run cli --owner $USER --session demo

# terminal 3
nats req agents.prompt.codex."$USER".demo \
  --replies=0 --reply-timeout=30s --timeout=5m \
  "write a hello.ts file that prints 'hello from codex' and run it"
```

The working directory defaults to `${TMPDIR}/codex-agent/<session>/`
and is created on demand.

## Configure

### NATS connection

Resolution order (first hit wins):

1. `--nats-url <url>` flag (or `NATS_URL` env var)
2. `--nats-context <name>` flag — resolves a saved NATS CLI context
3. `~/.codex/agent/nats-channel.json` — config file (see below)
4. fallback to `nats://127.0.0.1:4222`

### Config file (`~/.codex/agent/nats-channel.json`)

Optional. Lets you persist a default context and naming without setting
env vars or flags each time you launch the bridge.

```json
{
  "context": "my-nats-context",
  "owner": "alice",
  "session": "demo"
}
```

| Field | Purpose |
| --- | --- |
| `context` | NATS CLI context name passed to `loadContextOptions`. |
| `owner` | Default owner subject token. Flags / env override. |
| `session` | Default session subject token (instance name). Flags / env override. |

NATS CLI contexts live in `~/.config/nats/context/<name>.json`. List
yours with `nats context ls`.

### Codex / OpenAI auth

`codex-acp` honors the standard Codex env vars:

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI API token (preferred for headless use). |
| `CODEX_API_KEY` | Codex-issued token (alternative to `OPENAI_API_KEY`). |
| `OPENAI_BASE_URL` | Optional — point at a self-hosted gateway. |
| `OPENAI_ORG_ID` | Optional — restrict requests to a specific org. |
| `CODEX_HOME` | Optional — override the codex config directory. |

The bridge whitelists these variables and a handful of process-level
env vars (`PATH`, `HOME`, `TMPDIR`, locale, terminal) when spawning the
child. Anything else is **dropped** so the bridge doesn't leak
unrelated secrets into the harness.

### CLI flags / env

| Flag | Env | Default |
| --- | --- | --- |
| `--owner` | `CODEX_AGENT_OWNER` | `$USER` (or config `owner`) |
| `--session` | `CODEX_AGENT_SESSION` | `default` (or config `session`) |
| `--cwd` | `CODEX_AGENT_CWD` | `${TMPDIR}/codex-agent/<session>/` |
| `--nats-context` | — | (unset, falls through) |
| `--nats-url` | `NATS_URL` | `nats://127.0.0.1:4222` |
| — | `CODEX_ACP_COMMAND` | `npx -y @zed-industries/codex-acp` |

## Verify

The bridge advertises the standard Synadia agent endpoints:

```sh
# discovery
nats req '$SRV.PING.agents' '' --replies=0 --timeout=2s
nats micro ls
nats micro info agents

# prompt
nats req agents.prompt.codex."$USER".demo \
  --replies=0 --reply-timeout=30s --timeout=5m \
  "list the files in the cwd"
```

Or via the `@synadia-ai/agents` TypeScript SDK:

```ts
import { connect } from "@nats-io/transport-node";
import { Agents } from "@synadia-ai/agents";

const nc = await connect({ servers: "nats://localhost:4222" });
const agents = new Agents({ nc });
const codex = (await agents.discover()).find((a) => a.agent === "codex");
for await (const msg of await codex!.prompt("hello codex")) {
  if (msg.type === "response") process.stdout.write(msg.text);
}
await agents.close();
await nc.close();
```

## Subject layout

The bridge advertises:

- `agents.prompt.codex.<owner>.<session>` (queue group `agents`)
- `agents.status.codex.<owner>.<session>`
- heartbeats on `agents.hb.codex.<owner>.<session>`

`metadata.agent="codex"`, `metadata.protocol_version="0.3"`.

## Wire format

| Synadia wire chunk | ACP source |
| --- | --- |
| `{type:"response", data:"<text>"}` | `session/update` → `agent_message_chunk` text |
| `{type:"status", data:"thought:<text>"}` | `agent_thought_chunk` |
| `{type:"status", data:"tool_use:<json>"}` | `tool_call` |
| `{type:"status", data:"tool_result:<json>"}` | `tool_call_update` |
| `{type:"status", data:"plan:<json>"}` | `plan` |
| `{type:"status", data:"mode:<json>"}` | `current_mode_update` |
| terminator | ACP `prompt` response settles |

Dumb clients (`nats req`) see the model's text via `response` chunks
without tool noise; rich clients that opt into the `<prefix>:<json>`
convention used by `agents/claude-code` and `agents/open-agent` pick up
structured tool-call cards.

## Limitations

- **Permissions default-deny.** The harness's `session/request_permission`
  calls are denied automatically in v0.1. To run unattended, set the
  harness's own auto-approve via `CODEX_ACP_COMMAND` (where available)
  or wait for the §7 `query` relay milestone.
- **No file-system endpoints.** The bridge does not advertise
  `fs.readTextFile` / `fs.writeTextFile`. The harness operates on its
  own working directory (`--cwd`); we do not proxy a host file system.
- **No terminal endpoints.** Terminal capabilities are not advertised.
- **No MCP servers.** `session/new` is called with an empty
  `mcpServers` list. Operators can layer MCP via `CODEX_ACP_COMMAND`
  if the harness build supports it.
- **No attachments.** `attachments_ok=false` on the prompt endpoint.
  Inbound base64 attachments are rejected with §9.1 400.
- **Single ACP session per bridge.** One bridge = one
  `(owner, session)` pair = one Codex conversation. Spawn additional
  bridges with different `--session` values for parallel conversations.

## Smoke test

`test/smoke.mjs` is a manual verification script — starts the bridge in
a subprocess, sends one prompt, asserts at least one response chunk
arrives, then tears down. Requires `OPENAI_API_KEY` and a reachable
NATS server.

```sh
OPENAI_API_KEY=sk-... bun run smoke
```

The smoke test is intentionally **not** wired into CI — it depends on
the harness binary, an API key, and an external NATS server. Run it
locally to confirm your install.

## Troubleshooting

- **`spawn npx ENOENT`** — install Node.js (any LTS) so `npx` is on
  your PATH, or set `CODEX_ACP_COMMAND` to point at a locally
  installed `codex-acp` binary.
- **`OPENAI_API_KEY required`** in the codex-acp output — the bridge
  forwards `OPENAI_API_KEY` from its own env. Export it before
  launching the bridge.
- **Bridge connects but no response chunks** — confirm the harness
  spawned correctly (look for `acp-client: initialized` and `session
  ready` lines on stderr). codex-acp writes its own diagnostics to
  stderr, which the bridge mirrors to its own stderr.
