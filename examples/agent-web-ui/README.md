# agent-web-ui

A Bun + Vue 3 test client for the [`@synadia-ai/agents`](../../client-sdk/typescript) SDK.
Discover agents over NATS, prompt them (with optional attachments),
stream responses back, and — when a [`pi-headless`](../pi-headless) or
[`claude-code-headless`](../claude-code-headless) controller is online — spawn,
prompt, and manage sessions from the browser.

Primary use: manually poking at the [Synadia Agent Protocol for NATS](https://github.com/synadia-ai/synadia-agent-sdk-docs)
implementations - [`pi`](../../agents/pi), [`claude-code`](../../agents/claude-code),
[`openclaw`](../../agents/openclaw), [`hermes`](../../agents/hermes),
[`deerflow`](../../agents/deerflow), [`flue`](../../agents/flue),
[`open-agent`](../../agents/open-agent), [`pi-headless`](../pi-headless), and the SDK's own reference agent.

## Features

- **Unified agent grid** — every discovered agent, controller, and session shows up as a card in a single grouped grid (PI Headless Sessions · PI Headless · Claude Code Headless Sessions · Claude Code Headless · PI Interactive · Claude Code · OpenClaw · Other). No mode switching.
- **Context-aware right panel** — click a card and the right pane adapts:
  - regular agent or session → live **chat** surface (streaming responses, attachments, mid-stream queries, tool-call cards, per-turn cost)
  - `pi-headless` controller → **New Session** + **Fan-out** tabs
  - `claude-code-headless` controller → **New Session** form
- **Spawn** — fill in `cwd` + optional model / thinking-level / allowed-tools / permission-mode / lifetime and a fresh session appears in the grid the moment it heartbeats; the right panel auto-focuses it for chat.
- **Fan-out** — one prompt, an `+ add directory` list of cwds, parallel spawn-prompt-stop, per-run cards with live streaming and abort.
- **Auto-discovery** — new agents appear in the grid as soon as they publish their first heartbeat. `ReferenceAgent` fires that synchronously on `start()`, so a fresh session shows up in ~one NATS round-trip — no need to hit Refresh after spawning.
- **Mid-stream queries** — agents can pause a response to ask a permission or clarification question; the UI renders these inline with shortcut allow/deny buttons and a free-text reply box. Both PI tooling prompts and Claude Code permission requests use this same primitive.
- **Tool call rendering** — `tool_use` / `tool_result` chunks (emitted by claude-code-headless as prefix-tagged status payloads) are translated by the bridge into typed events and rendered as collapsible cards showing tool name, input JSON, and result output (with success/error glyph).
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

## Spawning sessions and fan-out

When a [`pi-headless`](../pi-headless) or [`claude-code-headless`](../claude-code-headless)
controller is discovered, it shows up in the grid under **PI Headless** /
**Claude Code Headless** with a slightly different (purple-tinted) card style.
Click it and the right panel switches from "chat" to a small workspace:

- **New Session** — `cwd` (required) + optional `session_id`, `model`,
  `thinking_level` / `allowed_tools` / `permission_mode` / `max_turns`, and
  `max_lifetime_s`. Hit Spawn; the new session appears as a card in the
  grid and the right panel auto-focuses it for chat.
- **Fan-out** _(pi-headless only)_ — one prompt, a list of cwds (use
  `+ add directory` and the `×` button to manage rows), and a checkbox to
  auto-stop sessions when their prompt finishes. The UI spawns N sessions
  in parallel, streams each into its own result card, and offers per-card
  abort plus a global clear.

Spawned sessions are first-class NATS agents: they appear under **PI Headless
Sessions** / **Claude Code Headless Sessions** in the grid, the chat surface works against
them like any other agent, and lifetime / queue-depth / cost are shown
live on each card via 5s polling of the controller's `list` endpoint.

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

**Against `pi-headless`:**

```bash
# Terminal 1: controller
cd ../pi-headless && bun run start

# Terminal 2: web UI (same command as above)
cd ../../examples/agent-web-ui && bun run build && bun run start
```

A **PI Headless** card appears in the grid. Click it, spawn a session in
`/tmp`, then try a fan-out across a few sandbox directories in parallel.
