# claude-code-headless

A headless NATS agent host that spawns [Claude Code](https://docs.claude.com/en/docs/claude-code) sessions on demand via the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) and exposes each one as a first-class NATS Agent Protocol v0.2.0-draft instance.

Each spawned session registers as its own NATS agent under `agents.cc.<owner>.<session_id>` — discoverable via `$SRV.INFO.agents` and promptable with any protocol-compliant client, including the `@synadia-ai/agents` SDK. A small **controller** service at `agents.cc.<owner>.<name>` (default `name = "exec"`) adds request/reply endpoints for session lifecycle — `spawn`, `stop`, `list` — alongside the protocol-required `prompt` endpoint (which returns help text).

In short: one process, many Claude Code sessions, all first-class NATS agents.

This example is the Claude Code analogue of [`examples/pi-headless/`](../pi-headless) and is wire-compatible with the same callers — including the [`examples/agent-web-ui/`](../agent-web-ui) browser workspace.

> **Status.** Spike example proving multi-session Claude Code can be fronted by the protocol. Surfaces only the assistant's text output today (tool calls / permission queries are not yet relayed as protocol §7 query chunks). See **Roadmap** below.

## Quickstart

```bash
# 1. Build the SDK once (workspace sibling, referenced via file:).
cd ../../client-sdk/typescript
bun install
bun run build

# 2. Install + run claude-code-headless.
cd ../../examples/claude-code-headless
bun install
export ANTHROPIC_API_KEY=sk-...                  # required
bun run start                                    # connects via $NATS_CONTEXT or NATS_URL
# claude-code-headless: controller listening on agents.cc.<you>.exec
# claude-code-headless: extra endpoints — …exec.spawn  …exec.stop  …exec.list

# 3. Spawn a session + prompt + stop, from another shell.
bun run scripts/spawn.ts \
  --cwd /tmp/cc-sandbox \
  --prompt "list the files here and tell me what you see" \
  --allowed-tools "Read,Glob,Grep" \
  --stop-after
```

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
  "name": "exec",
  "defaultModel": "claude-sonnet-4-6",
  "defaultPermissionMode": "dontAsk",
  "defaultAllowedTools": ["Read", "Glob", "Grep"],
  "defaultMaxTurns": 50,
  "defaultMaxLifetimeS": 1800
}
```

Env overrides:
- `CLAUDE_CODE_HEADLESS_OWNER`
- `CLAUDE_CODE_HEADLESS_NAME`
- `CLAUDE_CODE_HEADLESS_DEFAULT_MODEL`
- `CLAUDE_CODE_HEADLESS_DEFAULT_PERMISSION_MODE`
- `CLAUDE_CODE_HEADLESS_DEFAULT_ALLOWED_TOOLS` (comma-separated)
- `CLAUDE_CODE_HEADLESS_DEFAULT_MAX_TURNS`
- `CLAUDE_CODE_HEADLESS_DEFAULT_MAX_LIFETIME`

Anthropic auth comes from `ANTHROPIC_API_KEY` (the standard SDK env var). Bedrock / Vertex deployments work too — set the SDK's standard provider env vars before launch.

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

```
agents.cc.<owner>.<name>                    ← controller prompt endpoint (help text)
agents.cc.<owner>.<name>.spawn              ← POST JSON → session descriptor
agents.cc.<owner>.<name>.stop               ← POST { session_id } → { ok: true }
agents.cc.<owner>.<name>.list               ← (empty) → { sessions: [...] }
agents.cc.<owner>.<name>.heartbeat          ← §8 heartbeat (30s)

agents.cc.<owner>.<session_id>              ← spawned session prompt (§5/§6)
agents.cc.<owner>.<session_id>.heartbeat    ← §8 heartbeat (30s)
```

The `cc` token is shared with [`agents/claude-code/`](../../agents/claude-code), which speaks the inverse direction (Claude Code as MCP-driven NATS *client*). They co-exist because the controller name and per-session ids disambiguate the 4th subject token.

## Wire examples

### Spawn

```bash
nats req agents.cc.$USER.exec.spawn \
  '{"cwd":"/tmp/cc-sandbox","model":"claude-sonnet-4-6","allowed_tools":["Read","Glob","Grep","Edit"],"permission_mode":"acceptEdits","max_lifetime_s":900}' \
  --timeout=15s
# → { "session_id":"sess-a1b2c3d4", "subject":"agents.cc.$USER.sess-a1b2c3d4", ... }
```

### Prompt (protocol-standard — no custom format)

```bash
nats req agents.cc.$USER.sess-a1b2c3d4 \
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
nats req agents.cc.$USER.exec.stop '{"session_id":"sess-a1b2c3d4"}'
# → { "ok": true, "session_id":"sess-a1b2c3d4" }
```

### List

```bash
nats req agents.cc.$USER.exec.list ''
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

- **Session identity.** The 4th subject token is the session id; `metadata.session` echoes it. Controllers use `name = "exec"` by default.
- **Metadata marker.** The controller carries `metadata.role = "claude-code-headless-controller"` so clients can tell it apart from other `cc` agents.
- **One controller per `(owner, name)`.** The custom `spawn` / `stop` / `list` endpoints are NATS micro-service endpoints, which load-balance across all instances sharing the same subject. If you need multiple controllers side-by-side, give each one a distinct `--name` (e.g. `--name exec-a`, `--name exec-b`).
- **Serial drain per session.** Per session, prompts are queued and processed one at a time; the Claude Agent SDK's `query()` is one full multi-turn round-trip per call, and concurrent re-entry into the same session would interleave context.
- **Session resumption.** Each prompt after the first is sent to the SDK with `resume: <sdkSessionId>` so context carries forward within a session for its full lifetime.
- **Lifetime & pruning.** `max_lifetime_s` bounds a session's wall-clock life; pending requests older than 30 min are evicted (active requests are never evicted).
- **Attachments.** Base64 attachments are decoded to `~/.claude-code-headless/attachments/<session_id>/<uuid>/` and their absolute paths are prepended to the prompt text, matching the staging pattern used by `agents/pi/` and `examples/pi-headless/`.

## Roadmap

This spike intentionally ships the smallest end-to-end loop. Likely next steps, roughly in priority order:

1. **Stream tool calls / permission queries as protocol §7 chunks.** Today only assistant text is forwarded; tool_use blocks and permission decisions are filtered out.
2. **Per-token streaming** via the SDK's partial-message option, so the response arrives chunk-by-chunk instead of one assistant message at a time.
3. **Programmatic MCP server attachment** through the spawn spec (`mcp_servers` field).
4. **System prompt / append-system-prompt** override per spawn.
5. **Cost tracking** — surface `total_cost_usd` from each `result` event in the session summary.
6. **Session-file cleanup** — periodic pruning of the SDK's on-disk session store so a long-running host doesn't accumulate state forever.
