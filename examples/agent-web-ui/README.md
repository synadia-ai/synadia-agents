# agent-web-ui

A Bun + Vue 3 test client for the [`@synadia-ai/agents`](../../client-sdk/typescript) SDK.
Discover agents over NATS, prompt them (with optional attachments),
stream responses back, and — when a [`pi-headless`](../pi-headless) controller
is online — spawn, prompt, and fan out PI sessions from the browser.

Primary use: manually poking at the [NATS Agent Protocol](https://github.com/synadia-ai/nats-agent-sdk-docs)
implementations - [`pi`](../../agents/pi), [`claude-code`](../../agents/claude-code),
[`openclaw`](../../agents/openclaw), [`hermes`](../../agents/hermes),
[`pi-headless`](../pi-headless), and the SDK's own reference agent.

## Features

- **Chat mode** — default view. Live agent list + per-agent chat surface with streaming responses, attachments, and mid-stream query replies.
- **PI Exec mode** — appears in the header as soon as a `pi-headless` controller is discovered. Spawn PI sessions (cwd, model, thinking level, max lifetime), prompt them, and fan out one prompt across N working directories in parallel.
- **Auto-discovery** — new agents appear in the list as soon as they publish their first heartbeat. `ReferenceAgent` fires that synchronously on `start()`, so a fresh session shows up in ~one NATS round-trip — no need to hit Refresh after spawning.
- **Mid-stream queries** — agents can pause a response to ask a permission or clarification question; the UI renders these inline with shortcut allow/deny buttons and a free-text reply box.
- **Local validation** — oversized envelopes and unsupported attachments are caught before any wire traffic, with the SDK's typed errors surfaced in the UI.

## Shape

```
Browser (Vue 3)  ⇄  Bun server  ⇄  NATS  ⇄  Agent(s)
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

## PI Exec mode

When the UI discovers at least one [`pi-headless`](../pi-headless) controller, a
**PI Exec** toggle lights up in the header next to **Chat**. The workspace is a
three-column layout:

- **Left** — spawn form (`cwd`, model, thinking level, max lifetime, optional `session_id`) + a live list of currently-spawned sessions showing lifetime countdown, queue depth, running/idle status, and model/thinking metadata. Click a session to chat with it; hit ✕ to stop it.
- **Middle** — the same chat surface Chat mode uses, but pointed at whichever session is selected. Streaming chunks, attachments, and mid-stream queries all work identically.
- **Right** — **Fan-out composer**. Enter one prompt and a list of working directories; the UI spawns N sessions in parallel, streams each into its own card, and (optionally) disposes them when the prompt completes. Per-card abort plus a global clear.

Spawned sessions are first-class NATS agents: discovery sees them, Chat mode lists them, and anything speaking the protocol can prompt them directly. PI Exec mode is just an ergonomic front door for the spawn / prompt / stop / fan-out flow.

## Mid-stream queries

Agents can pause a response to ask a question (protocol's query chunk) -
a permission prompt, a clarification, anything. The UI renders these inline
as a separate bubble with:

- **Allow (yes)** / **Deny (no)** shortcut buttons
- A free-text reply box (Enter to send, Shift+Enter for newline)

Whichever you use, the reply value is sent verbatim to the query's
`reply_subject`. For the `claude-code` agent with `permissions.mode = query`,
`yes`/`no` maps to allow/deny. For other agents, type whatever answer the
prompt calls for.

## Verify

**Against the `pi` agent:**

```bash
# Terminal 1: pi session with the channel installed
cd ../../agents/pi && pi

# Terminal 2: web UI
cd ../../examples/agent-web-ui && bun run build && bun run start
```

Open the UI, pick `pi` in the agent list, prompt, attach a file, watch it stream.

**Against `pi-headless` (PI Exec mode):**

```bash
# Terminal 1: controller
cd ../pi-headless && bun run start

# Terminal 2: web UI (same command as above)
cd ../../examples/agent-web-ui && bun run build && bun run start
```

The PI Exec toggle appears. Spawn a session in `/tmp`, prompt it, then try a
fan-out across a few sandbox directories in parallel.
