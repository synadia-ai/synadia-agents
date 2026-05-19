# `@synadia-ai/nats-gemini-channel`

A bridge implementing the **Synadia Agent Protocol for NATS** for
[Gemini CLI](https://github.com/google-gemini/gemini-cli) running in
its native ACP mode (`gemini --acp`). Exposes a Gemini session on
`agents.prompt.gemini.<owner>.<session>` so any protocol caller — the
`@synadia-ai/agents` SDK, `nats req`, or `agent-web-ui` — can drive it.

The bridge is built on `AgentService` from `@synadia-ai/agent-service`
(heartbeats, status endpoint, terminator emission). It spawns
`gemini --acp` as a child process and talks ACP JSON-RPC over its
stdio using `@agentclientprotocol/sdk`.

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
- A NATS server reachable from the bridge.
- [`gemini-cli`](https://github.com/google-gemini/gemini-cli) installed
  and on PATH (or referenced via `GEMINI_ACP_COMMAND`). Install with
  `npm install -g @google/gemini-cli`.
- Gemini auth — either an OAuth login already cached at
  `~/.config/gemini/`, or `GEMINI_API_KEY` / `GOOGLE_API_KEY` exported
  in the environment.

## Quickstart

```sh
# terminal 1
nats-server -js

# terminal 2
cd agents/gemini
bun install
GEMINI_API_KEY=AIza... bun run cli --owner $USER --session demo

# terminal 3
nats req agents.prompt.gemini."$USER".demo \
  --replies=0 --reply-timeout=30s --timeout=5m \
  "summarize the README.md in the current directory"
```

The working directory defaults to `${TMPDIR}/gemini-agent/<session>/`
and is created on demand.

## Configure

### NATS connection

Resolution order (first hit wins):

1. `--nats-url <url>` flag (or `NATS_URL` env var)
2. `--nats-context <name>` flag — resolves a saved NATS CLI context
3. `~/.gemini/agent/nats-channel.json` — config file (see below)
4. fallback to `nats://127.0.0.1:4222`

### Config file (`~/.gemini/agent/nats-channel.json`)

Optional. Lets you persist a default context and naming without
setting env vars or flags each time you launch the bridge.

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
| `owner` | Default 4th subject token. Flags / env override. |
| `session` | Default 5th subject token (instance name). Flags / env override. |

NATS CLI contexts live in `~/.config/nats/context/<name>.json`. List
yours with `nats context ls`.

### Gemini / Google auth

`gemini-cli` honors a few ways to authenticate:

| Variable / file | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | API key (preferred for headless use). |
| `GOOGLE_API_KEY` | Alternative env var name. |
| `~/.config/gemini/` | OAuth state created by `gemini auth login`. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Standard ADC for Vertex deployments. |
| `GOOGLE_CLOUD_PROJECT` | Vertex project for `GOOGLE_GENAI_USE_VERTEXAI=true`. |
| `GEMINI_MODEL` | Optional model override (e.g. `gemini-2.5-pro`). |

The bridge whitelists these variables and a handful of process-level
env vars (`PATH`, `HOME`, `TMPDIR`, locale, terminal) when spawning the
child. Anything else is **dropped** so the bridge doesn't leak
unrelated secrets into the harness.

If `gemini auth login` was run on the same machine, the bridge picks
up the cached OAuth state automatically via `$HOME`.

### CLI flags / env

| Flag | Env | Default |
| --- | --- | --- |
| `--owner` | `GEMINI_AGENT_OWNER` | `$USER` (or config `owner`) |
| `--session` | `GEMINI_AGENT_SESSION` | `default` (or config `session`) |
| `--cwd` | `GEMINI_AGENT_CWD` | `${TMPDIR}/gemini-agent/<session>/` |
| `--nats-context` | — | (unset, falls through) |
| `--nats-url` | `NATS_URL` | `nats://127.0.0.1:4222` |
| — | `GEMINI_ACP_COMMAND` | `gemini --acp` |

## Verify

The bridge advertises the standard Synadia agent endpoints:

```sh
# discovery
nats req '$SRV.PING.agents' '' --replies=0 --timeout=2s
nats micro ls
nats micro info agents

# prompt
nats req agents.prompt.gemini."$USER".demo \
  --replies=0 --reply-timeout=30s --timeout=5m \
  "list the files in the cwd"
```

Or via the `@synadia-ai/agents` TypeScript SDK:

```ts
import { connect } from "@nats-io/transport-node";
import { Agents } from "@synadia-ai/agents";

const nc = await connect({ servers: "nats://localhost:4222" });
const agents = new Agents({ nc });
const gemini = (await agents.discover()).find((a) => a.agent === "gemini");
for await (const msg of await gemini!.prompt("hello gemini")) {
  if (msg.type === "response") process.stdout.write(msg.text);
}
await agents.close();
await nc.close();
```

## Subject layout

The bridge advertises:

- `agents.prompt.gemini.<owner>.<session>` (queue group `agents`)
- `agents.status.gemini.<owner>.<session>`
- heartbeats on `agents.hb.gemini.<owner>.<session>`

`metadata.agent="gemini"`, `metadata.protocol_version="0.3"`.

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

## Limitations

- **Permissions default-deny.** The harness's `session/request_permission`
  calls are denied automatically in v0.1. To run unattended, configure
  gemini-cli's own auto-approve settings, or wait for the §7 `query`
  relay milestone.
- **No file-system endpoints.** The bridge does not advertise
  `fs.readTextFile` / `fs.writeTextFile`. The harness operates on its
  own working directory.
- **No terminal endpoints.** Terminal capabilities are not advertised.
- **No MCP servers.** `session/new` is called with an empty
  `mcpServers` list. Operators can layer MCP via `GEMINI_ACP_COMMAND`
  or gemini-cli's own settings.
- **No attachments.** `attachments_ok=false` on the prompt endpoint.
- **Single ACP session per bridge.** Spawn additional bridges with
  different `--session` values for parallel conversations.
- **`--experimental-acp` is deprecated upstream.** If you're pinned to
  an older gemini-cli that doesn't accept `--acp`, set
  `GEMINI_ACP_COMMAND="gemini --experimental-acp"`.

## Smoke test

`test/smoke.mjs` is a manual verification script — starts the bridge in
a subprocess, sends one prompt, asserts at least one response chunk
arrives, then tears down. Requires `GEMINI_API_KEY` (or cached OAuth)
and a reachable NATS server.

```sh
GEMINI_API_KEY=AIza... bun run smoke
```

The smoke test is intentionally **not** wired into CI — it depends on
gemini-cli being installed, valid credentials, and an external NATS
server. Run it locally to confirm your install.

## Troubleshooting

- **`spawn gemini ENOENT`** — install gemini-cli (`npm install -g
  @google/gemini-cli`) or set `GEMINI_ACP_COMMAND` to an absolute path.
- **`--acp` not recognized** — your gemini-cli is older than the
  release that landed native ACP. Use
  `GEMINI_ACP_COMMAND="gemini --experimental-acp"` or upgrade.
- **No response chunks arrive** — confirm the harness spawned correctly
  (look for `acp-client: initialized` and `session ready` lines on
  stderr). gemini-cli writes its own diagnostics to stderr, which the
  bridge mirrors to its own stderr.
