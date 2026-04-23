# agent-web-ui

A Bun + Vue 3 test client for the [`@synadia/agents`](../../client-sdk/typescript) SDK.
Discover agents over NATS, send prompts (with optional attachments), and
stream responses back in a slick browser UI.

Primary use: manually poking at the [NATS Agent Protocol](https://github.com/synadia-ai/nats-agent-sdk-docs)
implementations - [`pi`](../../agents/pi), [`claude-code`](../../agents/claude-code),
[`openclaw`](../../agents/openclaw), and the SDK's own reference agent.

## Shape

```
Browser (Vue 3)  ⇄  Bun server  ⇄  NATS  ⇄  Agent (pi, claude, ...)
                     (SDK lives here)
```

The SDK targets Node/Bun, not browsers, so the Bun process owns the NATS
connection and serves the UI over HTTP + a single WebSocket at `/ws`.

## Setup

```bash
# 1. Build the SDK so the file:../../client-sdk/typescript link resolves.
cd ../../client-sdk/typescript
bun install
bun run build

# 2. Install example deps.
cd ../../examples/agent-web-ui
bun install
```

## Run

**Dev** - Vite serves HMR on :5173 and proxies `/ws` to the Bun server on :3300:

```bash
# Terminal 1
bun run dev          # Bun server on :3300 (SDK + WS)

# Terminal 2
bun run vite         # Vite dev server on http://localhost:5173
```

Open <http://localhost:5173>.

**Production-ish** - single command, Bun serves the built UI and the WS:

```bash
bun run build
bun run start        # http://localhost:3300
```

## Flags & env

```
bun run server/index.ts [--port 3300] [--context current] [--servers nats://...] [--dev]
```

| flag | env | default | meaning |
|------|-----|---------|---------|
| `--port <n>` | `PORT` | `3300` | HTTP + WS port |
| `--context <name>` | `NATS_CONTEXT` | `current` | NATS CLI context in `~/.config/nats/context/` |
| `--servers <url>` | `NATS_URL` | - | Raw NATS URL (overrides context if given) |
| `--dev` | - | off | Skip static serving; requires `bun run vite` alongside |

## Mid-stream queries

Agents can pause a response to ask a question (protocol §7 query chunk) -
a permission prompt, a clarification, anything. The UI renders these inline
as a separate bubble with:

- **Allow (yes)** / **Deny (no)** shortcut buttons
- A free-text reply box (Enter to send, Shift+Enter for newline)

Whichever you use, the reply value is sent verbatim to the query's
`reply_subject`. For the `claude-code` agent with `permissions.mode = query`,
`yes`/`no` maps to allow/deny. For other agents, type whatever answer the
prompt calls for.

## Verify against the `pi` agent

```bash
# 1. In one terminal, start a pi session with the channel installed.
cd ../../agents/pi && pi

# 2. In another, launch the web UI.
cd ../../examples/agent-web-ui && bun run build && bun run start

# 3. Open the UI, select the `pi` agent, prompt, attach a file, watch it stream.
```
