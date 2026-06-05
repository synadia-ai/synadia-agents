# OpenCode multi-session/NATS UX mitigation spike

Date: 2026-06-05 19:56 CEST
Kanban: `t_82ecdc47` / Phase 6.5B
Repo branch inspected: `feat/opencode-adapter` at `058eb78 Document OpenCode adapter public DX`
Scope: OpenCode adapter repo, OpenCode CLI/docs, OpenCode SDK/plugin type surface, and fixed-port local server probes.

## Executive recommendation

Ship the current standalone OpenCode adapter as the immediate PR, but do not pretend the UX concern is solved. Open a follow-up PR/phase for a wrapper launcher plus a multi-session manager.

Why: the current adapter is already a working `AgentService` bridge with managed and attached modes. Blocking it for an in-process plugin rewrite would trade a known working protocol adapter for a larger speculative integration. The evidence says OpenCode has enough hooks to make the UX much better, but the lowest-risk mitigation is not the deepest rewrite; it is a launcher/manager that starts or attaches OpenCode sessions and registers NATS identities automatically.

Best path:
1. Merge/PR the current adapter with explicit UX limitations.
2. Follow immediately with `opencode-nats` launcher UX: start OpenCode server/TUI plus adapter from one command.
3. Then add adapter-side multi-session registration: one process, many OpenCode sessions, many `AgentService` identities.
4. Spike in-process OpenCode plugin registration only after the wrapper and manager prove the desired UX shape.

In legal terms: ship the contract, add the rider, do not burn the courthouse down to improve the lobby.

## Questions answered

### 1. Can OpenCode support an in-process plugin/MCP/channel pattern like PI or Claude Code?

Partly yes, via plugins. Not via MCP alone.

Evidence:
- OpenCode docs say local plugins in `.opencode/plugins/` and global plugins in `~/.config/opencode/plugins/` are automatically loaded at startup.
- Plugins receive `client`, `project`, `directory`, `worktree`, `serverUrl`, `experimental_workspace`, and Bun shell `$`.
- Plugin hooks include `event`, `config`, `permission.ask`, `chat.message`, `tool.execute.before`, `tool.execute.after`, `shell.env`, and compaction hooks.
- OpenCode exposes a server URL to plugins (`PluginInput.serverUrl`) and the SDK client (`PluginInput.client`), which is enough for a plugin to register the active OpenCode instance/session externally.

Limits:
- A plugin can observe events and call the OpenCode client, but it is not automatically a separate long-running process manager. Running a NATS `AgentService` inside plugin code would need careful lifecycle handling (`dispose`), NATS connection management, duplicate subject avoidance, and packaging.
- MCP is useful as a tool bridge inside OpenCode, but MCP does not make OpenCode sessions discoverable as Synadia protocol agents by itself. NATS registration still needs adapter/channel logic.

Answer: yes, a plugin-loaded NATS channel is feasible enough for a spike; no, it should not replace the current adapter before the first PR.

### 2. Does OpenCode expose hooks, event APIs, config, or CLI extension points for loading/registering a NATS channel from inside each TUI/session?

Yes.

Evidence from OpenCode plugin docs and `@opencode-ai/plugin` v1.16.2 types:
- Plugin load paths:
  - `.opencode/plugins/` project-level
  - `~/.config/opencode/plugins/` global
  - npm packages listed in OpenCode config `plugin` array
- Plugin input includes:
  - `client: ReturnType<typeof createOpencodeClient>`
  - `project: Project`
  - `directory: string`
  - `worktree: string`
  - `serverUrl: URL`
  - `$: BunShell`
  - `experimental_workspace.register(...)`
- Server-side hooks include:
  - `event({ event })`
  - `config(input)`
  - `permission.ask(input, output)`
  - `chat.message(...)`
  - `chat.params(...)`
  - `command.execute.before(...)`
  - `tool.execute.before(...)`
  - `tool.execute.after(...)`
  - `shell.env(...)`
  - `experimental.session.compacting(...)`
  - `experimental.compaction.autocontinue(...)`
  - `tool.definition(...)`
- TUI plugin types expose:
  - `route.register(...)`
  - `route.navigate(...)`
  - `ui.toast(...)`
  - `ui.dialog`
  - `client: OpencodeClient`
  - `event.on(...)`
  - `plugins.activate/deactivate/add/install(...)`
  - `TuiPromptRef.submit()` and prompt mutation APIs through UI/plugin types

CLI extension evidence:
- `opencode plugin <module>` installs a plugin and updates config.
- `opencode serve` starts a headless server.
- `opencode attach <url>` attaches a TUI to a running server.
- `opencode run --attach <url>` sends prompts to a running server.
- `opencode run --dir`, `--session`, `--continue`, `--fork`, `--agent`, `--model`, and `--variant` expose the session/model/agent knobs a wrapper needs.

Server API evidence:
- `GET /global/health` returns health/version.
- `GET /doc` serves OpenAPI 3.1.
- `GET /event` and `/api/event` expose event streams.
- Session endpoints include list/create/status/get/delete/fork/abort/share/diff/summarize/revert.
- Permission endpoints include `/session/{sessionID}/permissions/{permissionID}` and `/api/session/{sessionID}/permission/request/{requestID}/reply`.
- TUI endpoints include `/tui/append-prompt`, `/tui/submit-prompt`, `/tui/execute-command`, and `/tui/show-toast`.

Answer: yes; OpenCode has enough native extension and server surface to register sessions automatically, but the exact production-safe shape needs a follow-up build.

### 3. Can the current standalone adapter multiplex several upstream OpenCode sessions from one process?

Yes, with a real manager refactor. The current implementation is single-service/single-active-session by design.

Current implementation evidence:
- `src/cli.ts` loads one config, creates one OpenCode client, connects one NATS connection, creates one `AgentService`, and starts it.
- `src/service.ts` builds one `AgentServiceOptions` with `agent: "opencode"`, one `owner`, one `name`, `session: mapping.name`, and one prompt handler.
- `src/opencode-client.ts` stores one `#activeSessionId` and filters SSE events by that session id.
- `src/config.ts` has one `[agent] name/owner` and one `[opencode] opencode_session_id/base_url/directory/model/agent`.
- Permission routing currently assumes one bridge client and one prompt stream can handle one permission event context at a time.

Required changes:
- Add a `SessionRegistry` / `OpenCodeAgentManager` that owns multiple child registrations.
- Change config from one `[agent]`/`[opencode]` mapping to either:
  - static `[[sessions]]` entries, or
  - dynamic discovery from OpenCode `/session`, `/session/status`, and event stream.
- For each OpenCode session, create a unique `AgentService` identity:
  - `owner`: configured owner
  - `subjectToken`: still `opencode`
  - `session`/`name`: derived from OpenCode session id/title/workspace, sanitized and suffix-safe
  - metadata: OpenCode server origin, directory label, OpenCode session id, model/agent defaults, attached/managed source
- Replace single `#activeSessionId` with per-service session binding.
- Route permission events by session id and request id; never allow a permission prompt from one OpenCode session to answer another.
- Lifecycle: start/stop each `AgentService`; stop removed sessions; heartbeat each active service; close OpenCode client/server only after all services stop.
- Tests:
  - two sessions register two distinct discovery identities
  - duplicate titles/id suffixes cannot collide
  - prompt to agent A uses only session A
  - SSE events for session B are ignored by agent A
  - permission request for session B cannot be replied from prompt stream A
  - session deletion/unregister stops the corresponding `AgentService`

Answer: yes, but it is a phase, not a quick config tweak.

### 4. Can we create a wrapper/launcher so UX becomes “start more OpenCode agents, they appear on NATS” without rewriting the adapter?

Yes. This is the best immediate mitigation.

The wrapper can compose the current adapter instead of replacing it:

```text
opencode-nats start [--tui] [--name NAME] [--session SESSION]
  -> choose/fix OpenCode server host+port
  -> start `opencode serve` or use `--attach`
  -> start `opencode-agent start --base-url http://... --name NAME ...`
  -> optionally launch `opencode attach http://...` or `opencode run --attach http://... --interactive`
  -> on exit, cleanly stop adapter and managed server
```

Variants:
- `opencode-nats serve`: starts headless OpenCode + adapter, no TUI.
- `opencode-nats tui`: starts fixed-port OpenCode server, adapter, and attached TUI.
- `opencode-nats attach <url>`: registers an existing OpenCode server on NATS.
- `opencode-nats session <session-id>`: binds a specific OpenCode session as one NATS agent.
- `opencode-nats watch`: watches `/session` and registers sessions dynamically; this becomes the bridge to multi-session manager mode.

Why this is attractive:
- Uses the current adapter’s tested `AgentService` path.
- Avoids running NATS service lifecycle inside OpenCode plugin runtime.
- Makes UX one command.
- Keeps implementation package boundaries clean.
- Can later use OpenCode plugins to auto-install/configure or notify, without depending on plugin internals for first mitigation.

Answer: yes, and this is the recommended next PR.

### 5. Risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| Permission prompt misrouting | A NATS caller could approve/reject the wrong OpenCode permission request if sessions are multiplexed poorly. | Key permission state by OpenCode session id + permission/request id. Add regression tests that cross-session replies fail. |
| TUI bleed | A wrapper that drives `/tui/*` endpoints could mutate the wrong local TUI prompt/session. | Keep protocol prompts on session API, not TUI endpoints. Use TUI endpoints only for explicit UX actions/toasts. |
| Server/session mismatch | `opencode serve` starts a new server; TUI starts its own server unless attached/fixed port is used. | Wrapper must own port/base URL and launch TUI with `opencode attach <url>` or `opencode run --attach <url>`. |
| Cleanup leaks | Detached child server/adapter processes could leave NATS agents discoverable after OpenCode exits. | Parent process owns child PIDs; SIGINT/SIGTERM stop adapter, `AgentService`s, OpenCode server, and NATS connection. Add lifecycle smoke. |
| Duplicate subject suffixes | Multiple sessions with same title/workspace can collide under `agents.*.*.*`. | Use sanitized session id or short stable hash suffix. Make collision tests mandatory. |
| Externally attached sessions | User’s existing TUI/server may have auth, random port, different directory, or changing sessions. | Attached mode requires explicit base URL/password/dir; dynamic watch mode should treat external sessions as read/discover first. |
| Auth/secrets | `OPENCODE_SERVER_PASSWORD` protects the server; docs/examples must not leak secret-shaped values. | Use env/config redaction; no dummy credential shapes. Test docs for seed/token-shaped fixtures. |
| Plugin lifecycle uncertainty | In-process NATS plugin must not leave sockets open or double-register on plugin reload. | Implement `dispose`; include reload/disable tests before production. |
| Heartbeat ownership | Many `AgentService`s from one process need independent heartbeat/keepalive behavior. | Manager tracks service state; unregister stale/deleted sessions; include heartbeat metadata in tests. |
| UX overreach | Full plugin rewrite could delay current PR while solving less than wrapper mode. | Ship current adapter; follow with wrapper/multiplexer in staged phases. |

## Options matrix

| Option | UX result | Feasibility | Implementation cost | Risk | Recommendation |
|---|---:|---:|---:|---:|---|
| A. Current standalone adapter as-is | User starts adapter separately per OpenCode backing session | High, already implemented | Low | Medium UX regression | Ship, but only with limitation called out |
| B. Wrapper launcher around current adapter | One command starts server/TUI + NATS registration | High | Low-medium | Low-medium | Do next |
| C. Adapter multi-session manager | One process exposes many OpenCode sessions as many NATS agents | High | Medium-high | Medium | Do after wrapper or as Phase 2 of wrapper |
| D. OpenCode server plugin starts NATS channel in-process | Launching OpenCode auto-registers the active project/session | Medium | Medium-high | Medium-high | Spike after B/C; do not block current PR |
| E. TUI plugin adds NATS controls/status UI | User sees NATS registration/status inside TUI | Medium | Medium | Medium | Nice companion, not the core bridge |
| F. MCP-only integration | OpenCode gains NATS/MCP tools | Low for protocol hosting | Low | High product mismatch | Do not use as primary solution |

## Implementation sketches

### Option A — current adapter as-is

Already present:
- `opencode-agent start`
- managed mode: adapter starts OpenCode server via `createOpencodeServer`
- attached mode: `--base-url` points at an existing OpenCode server
- one `AgentService` registered per process
- permission policy: `query`, `local`, or `reject`

Acceptance for PR:
- README states standalone process model and attached/power-user mode plainly.
- Current smoke tests and conformance tests pass.
- Follow-up card exists for wrapper/multi-session UX.

### Option B — wrapper launcher

Add a binary, likely `opencode-nats`, in the same package or a thin wrapper package.

Core flow:
1. Resolve config and choose a stable port.
2. If no `--attach`, start `opencode serve --hostname 127.0.0.1 --port <port>`.
3. Wait for `/global/health`.
4. Start `opencode-agent start --base-url http://127.0.0.1:<port> --name <derived>`.
5. If `--tui`, launch `opencode attach http://127.0.0.1:<port>`.
6. Relay logs with prefixes: `[opencode]`, `[nats]`, `[tui]`.
7. On shutdown, stop children in reverse order.

Tests:
- child process cleanup on SIGINT
- fixed-port health wait timeout
- auth/password propagation
- attached mode does not start a second OpenCode server
- README quickstart smoke

### Option C — multi-session manager

Add a manager API:

```ts
class OpenCodeAgentManager {
  async start(): Promise<void>;
  async reconcile(): Promise<void>;
  async stop(): Promise<void>;
}
```

Inputs:
- one NATS connection
- one OpenCode SDK client/base URL
- session selection config: all sessions, session ids, title filters, project directory filters, or static `[[session]]` entries

Responsibilities:
- list sessions/status via OpenCode SDK/server
- create one `AgentService` per selected session
- watch event stream for session create/delete/status changes
- generate stable NATS identities
- route prompts and permissions to bound session ids

Tests:
- two active sessions -> two discovery records
- session deletion -> service stop
- duplicate names -> stable suffixes
- event filtering does not cross streams

### Option D — server plugin NATS channel

A plugin could load from `.opencode/plugins/` or npm config and register NATS when OpenCode starts.

Sketch:

```ts
import type { Plugin } from "@opencode-ai/plugin";

export const SynadiaNatsPlugin: Plugin = async ({ client, directory, project, serverUrl }) => {
  const channel = await startNatsRegistration({ client, directory, project, serverUrl });
  return {
    event: async ({ event }) => channel.handleOpenCodeEvent(event),
    "permission.ask": async (input, output) => channel.observePermission(input, output),
    dispose: async () => channel.stop(),
  };
};
```

Open questions:
- Does plugin reload happen in cases that would double-register?
- Can long-lived NATS sockets live safely inside OpenCode plugin lifecycle?
- What config file owns NATS creds/URL without creating secret leakage?
- How does this behave when both TUI and `serve` load plugins?

Acceptance before production:
- plugin reload/dispose tests
- NATS disconnect/reconnect behavior
- duplicate registration detection
- no credentials in OpenCode logs/config examples

### Option E — TUI plugin companion

Use TUI plugin APIs for UX polish only:
- show NATS registration status/toasts
- add command palette entries like “NATS: copy agent subject”
- show route/dialog with owner/session/NATS URL health
- do not drive protocol prompt flow through TUI endpoints

This improves confidence but does not replace the adapter/service lifecycle.

### Option F — MCP-only

Not recommended. MCP can expose tools to OpenCode, but the product need is the reverse: OpenCode sessions must appear as Synadia protocol agents on NATS. MCP-only misses discovery, heartbeats, prompt streaming, status, and permission routing.

## Estimated phase plan

### Phase 7 — wrapper UX mitigation

Deliverables:
- `opencode-nats` launcher
- docs quickstart: managed TUI, headless, attached existing server
- lifecycle smoke test with fixed local server
- no broad architecture rewrite

Estimate: 1 focused implementation phase + independent review.

### Phase 8 — multi-session manager

Deliverables:
- multi-session registry/manager
- static config and/or dynamic watch mode
- per-session `AgentService` identities
- collision-safe naming
- cross-session permission regression tests

Estimate: 2 implementation phases: manager core, then dynamic watch/session lifecycle.

### Phase 9 — plugin/TUI integration spike

Deliverables:
- throwaway OpenCode plugin proof that starts/stops NATS registration on plugin lifecycle
- optional TUI plugin showing registration status
- recommendation whether to productize plugin or keep wrapper as canonical UX

Estimate: spike + review gate. Do not put this on the critical path for the current adapter PR.

## Evidence log

Commands/probes run in this spike:

```text
# Repo state
git status --short --branch
git log --oneline -5
# Evidence: branch feat/opencode-adapter at 058eb78, no status entries printed.

# OpenCode CLI surface
which -a opencode
opencode --version
opencode serve --help
opencode run --help
opencode attach --help
opencode plugin --help
opencode mcp --help
# Evidence: OpenCode 1.16.2; serve/attach/run/plugin/mcp commands available.

# Fixed-port local OpenCode server probe
opencode serve --hostname 127.0.0.1 --port 49166 --print-logs
curl -fsS http://127.0.0.1:49166/global/health
curl -fsS http://127.0.0.1:49166/doc
curl -sS -o /tmp/opencode-tui.html -w "%{http_code} %{content_type} %{size_download}\n" http://127.0.0.1:49166/tui
# Evidence: health returned {"healthy":true,"version":"1.16.2"}; /doc advertised OpenAPI 3.1.0; /tui returned 200 text/html.

# OpenCode docs extraction
curl -fsSL https://opencode.ai/docs/plugins | pandoc -f html -t plain > /tmp/opencode-doc-plugins.txt
curl -fsSL https://opencode.ai/docs/server | pandoc -f html -t plain > /tmp/opencode-doc-server.txt
curl -fsSL https://opencode.ai/docs/sdk | pandoc -f html -t plain > /tmp/opencode-doc-sdk.txt
curl -fsSL https://opencode.ai/docs/config | pandoc -f html -t plain > /tmp/opencode-doc-config.txt

# OpenCode plugin type extraction
npm pack @opencode-ai/plugin@1.16.2
# inspected /tmp/opencode-plugin-pkg/package/dist/index.d.ts and tui.d.ts
```

Key source files inspected:
- `agents/opencode/src/cli.ts`
- `agents/opencode/src/service.ts`
- `agents/opencode/src/opencode-client.ts`
- `agents/opencode/src/bridge.ts`
- `agents/opencode/src/config.ts`
- `agents/opencode/package.json`
- `/tmp/opencode-plugin-pkg/package/dist/index.d.ts`
- `/tmp/opencode-plugin-pkg/package/dist/tui.d.ts`
- `/tmp/opencode-doc-plugins.txt`
- `/tmp/opencode-doc-server.txt`

Temporary process cleanup:
- Fixed-port `opencode serve` process on port `49166` was killed after probes.

## Final recommendation

Do not block the current OpenCode adapter PR for a full UX rewrite.

Ship the adapter, but immediately schedule follow-up work for:
1. wrapper launcher (`opencode-nats`) as the short-term UX mitigation;
2. multi-session manager as the medium-term real fix;
3. OpenCode plugin/TUI integration as a later spike once lifecycle and duplicate-registration risks are better understood.

This keeps the working protocol bridge moving while attacking the UX regression with the least risky architecture first.
