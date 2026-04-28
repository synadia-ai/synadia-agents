# Examples

End-to-end apps built with the SDK in `../client-sdk/`. Some are **callers** that drive agents from `../agents/`; others **build a new agent from scratch** on top of the SDK. Either way they're the fastest path to a working system.

## Examples in this monorepo

| Path                    | Kind   | Stack                                    | What it shows                                                                 |
| ----------------------- | ------ | ---------------------------------------- | ----------------------------------------------------------------------------- |
| `agent-web-ui/`         | caller | Vue 3 + Bun (server) + `@synadia-ai/agents` | Browser client for discovery, prompting with attachments, and streaming responses. Renders mid-stream `query` chunks inline with allow/deny controls. When a pi-headless controller is discovered, a second "PI Exec" workspace unlocks: spawn form, session list with lifetime/queue metadata, and a fan-out composer that streams one prompt across N working directories in parallel. |
| `claude-code-headless/` | agent  | Bun + `@synadia-ai/agents` + [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) | Claude Code analogue of `pi-headless/`. One process spawns and manages headless Claude Code sessions; each registers as its OWN first-class NATS agent at `agents.prompt.cc.<owner>.<session_id>` (v0.3 verb-first). A controller at `agents.prompt.cc.<owner>.exec` adds `spawn`/`stop`/`list` endpoints alongside the protocol-required `prompt`. Per-token text streaming, tool calls + results forwarded as inline cards, mid-stream §7 query chunks for permission requests, per-turn cost tracking. Wire-compatible with the same callers as `pi-headless/` (including `agent-web-ui/`). |
| `dspy/`                 | agent  | Bun + `@synadia-ai/agents` + [ax-llm](https://github.com/ax-llm/ax) | A standalone NATS Agent Protocol service built from scratch with the SDK's `ReferenceAgent` helper. Runs a DSPy-style ReAct loop with four sandboxed tools (`list_files`, `read_file`, `write_file`, `bash`). Registers as type token `dspy` and can be driven by any caller - including `agent-web-ui/`. |
| `pi-headless/`          | agent  | Bun/Node + `@synadia-ai/agents` + `@mariozechner/pi-coding-agent` | One process that spawns and manages any number of headless PI coding-agent sessions. Each session registers as its OWN first-class NATS agent at `agents.prompt.pi.<owner>.<session_id>` (v0.3 verb-first) - discoverable and promptable with any protocol client. A small controller at `agents.prompt.pi.<owner>.exec` adds request/reply endpoints for session lifecycle (`spawn`, `stop`, `list`) alongside the protocol-required `prompt`. Pairs naturally with `agent-web-ui/` for an interactive spawn/prompt/fan-out UI. |

## Architecture pattern (browser examples)

The TypeScript SDK is Node/Bun only - it can't run in a browser. Browser-facing examples use a thin server process that owns the NATS connection and bridges to the UI over WebSocket:

```
Browser (Vue / React / …)  ⇄  server process (SDK + NATS)  ⇄  NATS  ⇄  agent host
```

`agent-web-ui/` follows exactly this shape: Vite on `:5173` in dev, a Bun server on `:3300` holding the SDK and serving a single `/ws` endpoint.

## What to look for in each example

**In caller examples:**

1. **Discovery** - enumerate agents via `client.discover()`, filter by type token.
2. **Prompting** - both plain-text and JSON envelopes with attachments.
3. **Streaming** - iterate typed chunks (`response`, `status`, `query`) correctly.
4. **Local validation** - handle `PayloadTooLargeError` / `AttachmentsNotSupportedError` before hitting the wire.
5. **Mid-stream queries** - reply to `_INBOX`-style query chunks (permission prompts, clarifications).
6. **Liveness** - track the v0.3 heartbeat wildcard `agents.hb.*.*.*` so UIs reflect agent up/down without polling.

**In agent examples (like `dspy/`):**

1. **Building on `ReferenceAgent`** - the SDK's `@synadia-ai/agents/testing` helper handles registration, heartbeats, and stream termination for you.
2. **Envelope handling** - accept both plain text and JSON envelopes.
3. **Chunk streaming** - emit `status` for progress/keep-alive and `response` for content deltas.
4. **Metadata** - advertise `max_payload` and `attachments_ok` correctly.

## Adding a new example

1. Create `examples/<name>/` with a minimal project.
2. Depend on the SDK via workspace link (`file:../../client-sdk/typescript` for TS examples) so a local SDK change is picked up immediately.
3. Keep the example focused on one thing - don't bundle "discovery" and "permission handling" and "attachments" into one sprawling demo unless that's the *point*.
4. Add a row to the table above, plus a README in the example explaining **what it demonstrates** and **how to run it**.
