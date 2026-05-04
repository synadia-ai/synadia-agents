# claude-code-headless

A headless NATS agent host that spawns [Claude Code](https://docs.claude.com/en/docs/claude-code) sessions on demand via the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) and exposes each one as a first-class NATS Agent Protocol **v0.3** instance (verb-first subjects + `status` endpoint). Built on `@synadia-ai/agents` (caller-side primitives) and `@synadia-ai/agent-service` (host-side `ReferenceAgent`).

Each spawned session registers as its own NATS agent under `agents.prompt.cc-headless.<owner>.<session_id>` — discoverable via `$SRV.INFO.agents` and promptable with any protocol-compliant client, including the `@synadia-ai/agents` SDK. A small **controller** service at `agents.prompt.cc-headless.<owner>.<name>` (default `name = "control"`) adds request/reply endpoints for session lifecycle — `spawn`, `stop`, `list` — alongside the protocol-required `prompt` endpoint (which returns help text) and a `status` endpoint that replies with the same payload as a heartbeat.

In short: one process, many Claude Code sessions, all first-class NATS agents.

This example is the Claude Code analogue of [`examples/pi-headless/`](../pi-headless) and is wire-compatible with the same callers — including the [`examples/agent-web-ui/`](../agent-web-ui) browser workspace.

> **Status.** Demo-quality reference. Streams text per-token, surfaces tool calls + results inline, asks for permission via protocol §7 query chunks, and tracks cost per session. See **Features** below for the wire shapes; **Roadmap** for what's still ahead.

## Quickstart (run from npm)

The package ships a `nats-claude-code-headless` CLI binary, so the
simplest way to try it is via `npx` — no clone, no build:

```bash
export ANTHROPIC_API_KEY=sk-...
NATS_CONTEXT=localhost npx @synadia-ai/nats-claude-code-headless
# or:
NATS_URL=nats://127.0.0.1:4222 npx @synadia-ai/nats-claude-code-headless
# or:
npx @synadia-ai/nats-claude-code-headless --context localhost
```

`npx` resolves the package, runs its bundled entry point under Node ≥ 20,
and prints:

```
claude-code-headless: controller listening on agents.prompt.cc-headless.<you>.control
claude-code-headless: control endpoints — agents.spawn.cc-headless.<you>.control  …  agents.stop.…  agents.list.…
```

For a permanent install:

```bash
npm install -g @synadia-ai/nats-claude-code-headless
nats-claude-code-headless --context localhost
```

The Claude Code native binary is auto-detected via the Claude Agent
SDK's resolution chain (`--claude-code-path` flag, env var, config file,
`which claude`, then the SDK's bundled fallback). See
[Claude Code binary](#claude-code-binary) below for overrides.

## Quickstart (run from a local clone)

When you're working on the SDK or this example itself:

```bash
# 1. Build both SDKs (workspace siblings, referenced via file:).
(cd ../../client-sdk/typescript && bun install && bun run build)
(cd ../../agent-sdk/typescript  && bun install && bun run build)

# 2. Run claude-code-headless against the local SDK source via bun.
cd ../../examples/claude-code-headless
bun install
export ANTHROPIC_API_KEY=sk-...
bun run start                                    # connects via $NATS_CONTEXT or NATS_URL

# 3. Spawn a session + prompt + stop, from another shell.
bun run scripts/spawn.ts \
  --cwd /tmp/cc-sandbox \
  --prompt "list the files here and tell me what you see" \
  --allowed-tools "Read,Glob,Grep" \
  --stop-after
```

See [`README-DEV.md`](../../README-DEV.md) at the repo root for a fuller
walk-through of the build / install dance, including how to pick up SDK
edits without rebooting everything.

## Configuration

Either a NATS [context](https://docs.nats.io/using-nats/nats-tools/nats_cli/context) or an explicit URL:

```bash
NATS_CONTEXT=localhost bun run start
# or
NATS_URL=nats://127.0.0.1:4222 bun run start
# or
bun run start --context localhost
```

Optional defaults live in `~/.claude-code-headless/config.json`:

```json
{
  "context": "localhost",
  "name": "control",
  "defaultModel": "claude-sonnet-4-6",
  "defaultPermissionMode": "dontAsk",
  "defaultAllowedTools": ["Read", "Glob", "Grep"],
  "defaultMaxTurns": 50,
  "defaultMaxLifetimeS": 1800,
  "claudeCodePath": "/home/you/.local/bin/claude"
}
```

Env overrides:

| Variable | Overrides | Default |
| --- | --- | --- |
| `CLAUDE_CODE_HEADLESS_OWNER` | Owner subject token (3rd segment) | `$USER` |
| `CLAUDE_CODE_HEADLESS_NAME` | Controller instance name (4th token) | `control` |
| `CLAUDE_CODE_HEADLESS_DEFAULT_MODEL` | Default Claude model id for spawns | `claude-sonnet-4-6` |
| `CLAUDE_CODE_HEADLESS_DEFAULT_PERMISSION_MODE` | Default permission mode for spawns | `dontAsk` |
| `CLAUDE_CODE_HEADLESS_DEFAULT_ALLOWED_TOOLS` | Default tool allowlist (comma-separated) | `Read,Glob,Grep` |
| `CLAUDE_CODE_HEADLESS_DEFAULT_MAX_TURNS` | Safety cap on turns per prompt | `50` |
| `CLAUDE_CODE_HEADLESS_DEFAULT_MAX_LIFETIME` | Default session lifetime, in seconds | `1800` |
| `CLAUDE_CODE_HEADLESS_CLAUDE_PATH` | Path to the `claude` executable | (auto-detected via `which claude`) |

Precedence (high → low): CLI flags → env vars → `~/.claude-code-headless/config.json` → built-in defaults.

CLI flag: `--claude-code-path /abs/path/to/claude` (alias `--claude-path`).

### Claude Code binary

The Claude Agent SDK ships per-platform native binaries via optional npm packages, but auto-detection sometimes picks a variant that isn't installed (e.g. `linux-x64-musl` on glibc machines). When that happens you'll see `Claude Code native binary not found at .../claude-agent-sdk-<platform>/claude` on the first spawn.

This entry point side-steps that by resolving an explicit path on startup, in priority order:

1. `--claude-code-path` CLI flag
2. `CLAUDE_CODE_HEADLESS_CLAUDE_PATH` env var
3. `claudeCodePath` field in `~/.claude-code-headless/config.json`
4. Auto-detected via `which claude` on PATH (typically the binary installed by the official Claude Code installer at `~/.local/bin/claude`)
5. None of the above → the SDK falls back to its bundled native binary, which is where the failure mode above shows up

The active path is logged at startup. If you need to override it, the CLI flag is the quickest route.

### Anthropic auth

Set `ANTHROPIC_API_KEY` in env before launching. The SDK uses the API key in preference to any `~/.claude/` credentials when both are present.

Bedrock / Vertex / Azure deployments work too — set the SDK's standard provider env vars (`CLAUDE_CODE_USE_BEDROCK=1` etc) and they take precedence.

### Defaults rationale

The out-of-the-box defaults are deliberately conservative for a public reference:

| Setting | Default | Why |
| --- | --- | --- |
| `permission_mode` | `dontAsk` | Deterministic, headless-friendly. Never hangs on a permission prompt. Anything not in `allowed_tools` is denied. |
| `allowed_tools` | `["Read", "Glob", "Grep"]` | Read-only out of the box. Callers expand per-spawn for write/edit/bash. |
| `model` | `claude-sonnet-4-6` | Right cost/quality balance for a per-request spawner. |
| `max_turns` | `50` | Safety cap — runaway loops fail visibly instead of silently. |
| `max_lifetime_s` | `1800` | Sessions auto-expire after 30 min unless overridden. |

## Subject layout

Verb-first throughout — protocol verbs and claude-code-headless extension verbs share the same `agents.<verb>.cc-headless.<owner>.<token>` shape, so a tracer or audit layer can subscribe to `agents.<verb>.>` and parse identity positionally.

```
agents.prompt.cc-headless.<owner>.<name>      ← controller prompt endpoint (help text)
agents.status.cc-headless.<owner>.<name>      ← controller status (replies with heartbeat-shaped payload)
agents.hb.cc-headless.<owner>.<name>          ← controller heartbeat (30 s)
agents.spawn.cc-headless.<owner>.<name>       ← POST JSON → session descriptor
agents.stop.cc-headless.<owner>.<name>        ← POST { session_id } → { ok: true }
agents.list.cc-headless.<owner>.<name>        ← (empty) → { sessions: [...] }

agents.prompt.cc-headless.<owner>.<session_id>  ← spawned session prompt
agents.status.cc-headless.<owner>.<session_id>  ← spawned session status
agents.hb.cc-headless.<owner>.<session_id>      ← spawned session heartbeat (30 s)
```

The `cc-headless` token disambiguates this controller (and its spawned sessions) from the regular Claude Code agent at [`agents/claude-code/`](../../agents/claude-code), which uses the `cc` token for the opposite direction (Claude Code as MCP-driven NATS *client*).

## Wire examples

### Spawn

```bash
nats req agents.spawn.cc-headless.$USER.control \
  '{"cwd":"/tmp/cc-sandbox","model":"claude-sonnet-4-6","allowed_tools":["Read","Glob","Grep","Edit"],"permission_mode":"acceptEdits","max_lifetime_s":900}' \
  --timeout=15s
# → { "session_id":"sess-a1b2c3d4", "subject":"agents.prompt.cc-headless.$USER.sess-a1b2c3d4", "status_subject":"agents.status.cc-headless.$USER.sess-a1b2c3d4", ... }
```

### Prompt (protocol-standard — no custom format)

```bash
nats req agents.prompt.cc-headless.$USER.sess-a1b2c3d4 \
  'list the files here and summarise what you see' --replies=0 --timeout=120s
# → {"type":"status","data":"ack"}
# → {"type":"response","data":"There are three files: …"}
# → (empty terminator)
```

Programmatically with the SDK:

```ts
import { connect } from "@nats-io/transport-node";
import { Agents } from "@synadia-ai/agents";

const nc = await connect({ servers: "nats://localhost:4222" });
const agents = new Agents({ nc });

const all = await agents.discover();
const session = all.find((a) => a.name === "sess-a1b2c3d4")!;
for await (const ev of await session.prompt("summarise the files here")) {
  if (ev.type === "response") process.stdout.write(ev.text);
}

await agents.close();
await nc.close();
```

### Stop

```bash
nats req agents.stop.cc-headless.$USER.control '{"session_id":"sess-a1b2c3d4"}'
# → { "ok": true, "session_id":"sess-a1b2c3d4" }
```

### List

```bash
nats req agents.list.cc-headless.$USER.control ''
# → { "sessions": [ { "session_id":"sess-a1b2c3d4", "cwd":"/tmp/cc-sandbox", "remaining_lifetime_s": 867, ... } ] }
```

## Errors

Custom endpoints respond with NATS micro-service error headers (`Nats-Service-Error-Code` / `Nats-Service-Error`):

| Code | When                                                                                          |
|------|-----------------------------------------------------------------------------------------------|
| 400  | Bad JSON, missing/invalid cwd, bad session_id, unknown permission_mode, bad allowed_tools     |
| 404  | `stop` for an unknown session                                                                 |
| 500  | Claude Agent SDK threw during a prompt turn                                                   |

Session prompt endpoints follow protocol §9.

## CLI helpers

- `bun run scripts/spawn.ts --cwd /path [--prompt …] [--stop-after]` — end-to-end smoke test.
- `bun run scripts/list.ts` — print active sessions from every reachable controller.
- `bun run scripts/stop.ts SESSION_ID` — dispose a session.

## Notes

- **Session identity.** The 4th subject token is the session id; `metadata.session` echoes it. Controllers use `name = "control"` by default and sessions carry `metadata.role = "session"`.
- **Metadata marker.** The controller carries `metadata.role = "controller"` so clients can tell it apart from sessions. The shared `agent: "cc-headless"` token already disambiguates this from the regular `agent: "cc"` (Claude Code as MCP-driven NATS client).
- **Multiple controllers per host.** On startup the controller probes `$SRV.INFO.agents` and, if its target prompt subject is already claimed, picks the next free `<name>-2`, `<name>-3`, … suffix automatically. So booting a second claude-code-headless with default settings leaves the first as `control` and the second as `control-2` without explicit `--name` flags. (For deterministic naming or two stable controllers side-by-side, still pass `--name` explicitly.)
- **Serial drain per session.** Per session, prompts are queued and processed one at a time; the Claude Agent SDK's `query()` is one full multi-turn round-trip per call, and concurrent re-entry into the same session would interleave context.
- **Session resumption.** Each prompt after the first is sent to the SDK with `resume: <sdkSessionId>` so context carries forward within a session for its full lifetime.
- **Lifetime & pruning.** `max_lifetime_s` bounds a session's wall-clock life; pending requests older than 30 min are evicted (active requests are never evicted).
- **Attachments.** Base64 attachments are decoded to `~/.claude-code-headless/attachments/<session_id>/<uuid>/` and their absolute paths are prepended to the prompt text, matching the staging pattern used by `agents/pi/` and `examples/pi-headless/`.
- **Tool-call payload sizes.** Tool result outputs are truncated to 4 KB before encoding into a status chunk to stay well under `max_payload`. The truncation marker is `…[truncated]`.
- **Permission timeout.** A pending §7 permission query is denied after 2 minutes of caller silence, so a vanished UI doesn't park a session forever.

## Features

What this example showcases beyond the bare wire-compat proof:

### Per-token streaming

The SDK's `includePartialMessages` option is on — text deltas arrive as they're generated and are forwarded as individual `response` chunks. Web-UI clients see Claude "type" in real time instead of a wall of text per turn. No knob, no opt-in; it's the default.

### Tool-call observability

Every `tool_use` block Claude emits is forwarded as a status chunk with a prefix-tagged JSON payload:

```
{"type": "status", "data": "tool_use:{\"id\":\"...\",\"name\":\"Bash\",\"input\":{\"command\":\"ls /tmp\"}}"}
```

Tool results come back the same way:

```
{"type": "status", "data": "tool_result:{\"tool_use_id\":\"...\",\"output\":\"file1\\nfile2\",\"is_error\":false}"}
```

Encoding inside `status.data` keeps the wire spec-compliant (§6.4 says `data` is a string). SDK callers that don't recognize the prefix just see opaque status tokens; the agent-web-ui bridge translates them into typed events and renders them as collapsible tool cards.

### Interactive permissions via §7 queries

When the spawn spec uses `permission_mode: "default"` (or any mode other than `dontAsk`/`bypassPermissions`), the SDK calls our `canUseTool` callback for each tool not already in `allowed_tools`. We turn each call into a protocol §7 query chunk:

```
{"type": "query", "data": {"id": "...", "reply_subject": "...", "prompt": "Claude wants to use tool: Bash\n{\"command\":\"ls /tmp\"}\n\nReply 'yes' to allow or 'no' to deny."}}
```

Then we wait (up to 2 minutes) for a single reply on `reply_subject`. The reply text is normalised: `yes/y/allow/approve/ok` → allow, `no/n/deny/reject/cancel` → deny, anything else → deny with the reply preserved as the reason. The SDK proceeds (or doesn't) based on what the user answered.

### Cost tracking

Each successful turn emits a final `cost` status chunk with the per-turn and cumulative costs:

```
{"type": "status", "data": "cost:{\"turn_cost_usd\":0.0123,\"total_cost_usd\":0.0456}"}
```

Both values flow into the session summary (`total_cost_usd`, `turn_count`) and the UI surfaces them on each agent bubble (per-turn) and the session-list card (running total).

## Roadmap

What's still ahead, roughly in priority order:

1. **Programmatic MCP server attachment** through the spawn spec (`mcp_servers` field) — bring your own tools per session.
2. **System prompt / append-system-prompt** override per spawn — useful for personas (code reviewer, test writer, security auditor, …).
3. **"Always allow" stickiness for permissions** — the SDK exposes `updatedPermissions` on the canUseTool result; we currently ignore it. Wiring it would let users approve once per tool/per session.
4. **Tool result truncation policy** — we cap result output at 4 KB to keep payloads manageable; for large outputs (file dumps, build logs) a streaming or paginated approach would be nicer than `…[truncated]`.
5. **Session-file cleanup** — periodic pruning of the SDK's on-disk session store so a long-running host doesn't accumulate state forever.
6. **Bedrock / Vertex / Azure auth ergonomics** — works today via the SDK's standard env vars but undocumented here; could surface in config + status badge.
