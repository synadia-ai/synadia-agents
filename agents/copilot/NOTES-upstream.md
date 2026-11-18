# Notes for the Copilot CLI / SDK team

Feedback from putting GitHub Copilot on an agent fleet (the Synadia Agent
Protocol for NATS) in three ways:

1. **Extension** (`synadia-nats`): makes a live Copilot session a fleet
   member, taking inbound prompts from other agents, and gives Copilot
   tools to call the fleet (outbound).
2. **`serve`**: a headless fleet agent on `@github/copilot-sdk`
   `CopilotClient`.
3. **ACP prototype**: ran `copilot --acp` behind a generic ACP-to-NATS
   bridge. That prototype is not part of this package.

Observed on Windows with:

- Copilot CLI 1.0.114 (`@microsoft/copilot-sdk`) and 1.0.106-8.unstable;
- the GitHub Copilot App 1.0.106 (`@github/copilot-sdk`);
- npm `@github/copilot-sdk` 1.0.34.

This is draft feedback; nothing here has been filed.

## Extension

### What worked well

- `joinSession()` + `session.send` + the event stream is enough to bridge a
  whole turn: `user.message` → `assistant.message_delta` →
  `tool.execution_*` → `session.idle` mapped one-to-one onto a streaming
  agent protocol.
- The id returned by `session.send` lets an extension tell its own turn
  from the human's, so a remote caller never sees the human's output.
- Permission requests for extension tools (`kind: "custom-tool"`,
  `toolName`) reach the session host's handler, so an embedding host can
  apply its own policy to remote-originated turns.

### Rough edges (with repros)

1. **SDK rename silently drops tools.** The App bundles
   `@github/copilot-sdk` (tools as an array, `onPermissionRequest`), the CLI
   `@microsoft/copilot-sdk` (`tools: { definitions }`,
   `permissions.onRequest`). An extension written for one shape joins fine
   under the other but registers **no tools**, with no warning. Ask: one
   package name with aliasing, or a version/shape the extension can query;
   and an error/notification when `joinSession` options contain unknown keys.
2. **`--available-tools` / `--allow-tool` ignore extension tools.** Only
   `--allow-all-tools` lets `-p` run them. Ask: a selector for extension
   tools (e.g. `--allow-tool 'extension(synadia-nats)'`).
3. **`-p` hangs on an unapproved `custom-tool` permission** instead of
   failing the call. Ask: deny-and-continue (like other unapproved tools in
   prompt mode).
4. **Plugin auto-update reloads extensions mid-turn.** In `-p` runs the
   background plugin update restarted the extension while a tool call was in
   flight ("External tool removed"). `CI=true` avoids it. Ask: defer reloads
   until idle, or skip auto-update in prompt mode.
5. **`skipPermission: true` is an undiscoverable gate.** It makes the CLI
   require a separate extension-level approval, which `-p` denies; there is
   no error pointing at the field. (We dropped it — every tool call now goes
   through normal permission prompts, which is the right default anyway.)
6. **Extensions only load in some modes.** Prompt mode needs
   `GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS=true`; **ACP mode (`--acp`) never
   loads extensions**; SDK sessions need `extensions: { enabled: true }`.
   Ask: one documented switch, and ACP support (ACP is how other editors
   and agent hosts embed Copilot).
7. **Extension tools are deferred behind tool search by default.** With
   several MCP servers loaded, the model (haiku) never searched for them and
   reported the tools missing. `defer: "never"` fixes it but is only in the
   modern SDK types. Ask: document `defer`; consider not deferring the first
   N extension tools.
8. **`setForegroundSessionId` throws outside TUI+server mode**, so a
   headless SDK host can't mirror what the App does. A no-op would be kinder.
9. **Read-only shell commands are auto-approved without consulting the
   permission handler.** Fine for a human at the keyboard; for a turn that
   came from a remote agent the host may want to see every request. Ask: an
   option (per session or per turn) to route *all* permission decisions to
   the handler.
10. **Permission denials look like tool errors to the model.** When the host
    rejected `prompt_agent` the model told the remote caller the *target
    agent* had refused. Ask: pass the `reject` feedback text through to the
    model as the tool result.

## SDK (`serve`, `@github/copilot-sdk` 1.0.34)

### What worked well

- **The SDK covers everything a headless fleet agent needs.** The pieces are
  `createSession` / `resumeSession`, `session.send`, typed events,
  `onPermissionRequest`, `onUserInputRequest`, and native tools with raw
  JSON-schema parameters. `serve` reuses the extension's turn bridge
  unchanged.
- **Permission requests are typed and rich enough to show to a remote
  human.** A shell request carries `fullCommandText` and `intention`, so the
  relayed question reads well. Verified live: a signed caller approved a
  `shell` request through a protocol query.
- **`ask_user` is reachable from the host** (`onUserInputRequest`), which
  ACP does not offer.
- **Resuming sessions by id** made persistent conversations easy to
  implement.

### Rough edges

1. **Streaming deltas are opt-in.** Without `streaming: true` there are no
   `assistant.message_delta` events, only the final `assistant.message`. A
   streaming bridge that misses this sees nothing until the turn ends. A
   note in the event docs would help.
2. **`managedApprovalRequired` is undocumented.** It appears in the
   permission request type with no explanation of what a host should do. `serve` rejects
   such requests. A short contract ("hosts must not approve these
   programmatically") would help.
3. **Reasoning effort fails at session creation for models without it**
   (e.g. `claude-haiku-4.5`). This is the same issue as ACP note 1 below.
   Per-model capability in `listModels()` would let a host validate the
   setting up front.
4. **`approve-for-session` lets a remote caller widen permissions.** A host
   that relays permission decisions must avoid it deliberately. A
   host-level switch to disable "for session" approvals would make a safe
   default easier.

## Feature requests for agent-fleet scenarios

- **Inbound channel API.** Today an extension fakes "a message from
  elsewhere" with `session.send` plus a text banner. A first-class
  `session.send({ prompt, source: { kind: "agent", id, verified } })` that
  the UI renders distinctly (and that appears on `user.message`) would make
  provenance visible to the human and to the model without prompt framing.
  (`src/host.ts` already tries `source` and falls back when rejected.)
- **Per-turn permission routing.** Let the sender of a turn (the extension,
  for remote turns) receive that turn's permission requests, so they can be
  forwarded to the remote caller (our `permissions: "query"`) without
  registering a session-wide handler that triggers the extension gate.
- **Correlate `send` → `user.message` → `idle`.** A turn id on every event
  of a turn would replace our text-matching fallback when `user.message`
  arrives before `send` resolves.
- **`ask_user` from a remote turn.** Expose the pending `ask_user` request
  (question, choices, request id) to the turn's sender so it can be mapped
  to the protocol's mid-stream query instead of blocking on the local UI.
- **AHP exposure.** The App's host protocol already models sessions,
  awaiting-input and plans; exposing a session as an addressable endpoint
  (or letting an extension publish one) would let fleets reach App sessions
  without a per-machine extension.
- **Stable session name** available to extensions (the title the user sees),
  for use as the agent instance name instead of a session-id prefix.

## ACP (`copilot --acp` prototype)

These are observations from bridging `copilot --acp` onto NATS through a
generic ACP channel prototype.

They were observed with Copilot CLI `1.0.106-8.unstable` on Windows 11, using
a raw JSON-RPC probe and the live NATS bridge. Each note is labelled
*verified* (reproduced) or *unverified* (inferred, not reproduced).

### Gaps that affected the integration

1. **Reasoning effort is not reachable over ACP** *(verified)*.
   `session/new` returns `configOptions` for `mode`, `model`, `agent`, and
   `allow_all`, but has no option for reasoning effort. The only control is
   the process-wide `--reasoning-effort` flag, so an ACP client cannot vary it
   per session. Clients also cannot tell which models support it. With
   `--model claude-haiku-4.5 --reasoning-effort low`, `session/new` fails with
   "Model 'claude-haiku-4.5' does not support reasoning effort configuration.
   Use models.list…", but `models.list` is not an ACP method. Suggested fix:
   expose effort as a `configOption`, with per-model availability in the
   `models` payload.
2. **There is no `reject_always` permission option** *(verified)*. The options
   are `allow_once`, `allow_always`, and `reject_once`. ACP defines
   `reject_always`; without it, a client that wants to deny a tool
   permanently must keep denying it every turn.
3. **"Info:" notices arrive as ordinary assistant text** *(verified)*. Lines
   such as `Info: <path>` and `Info: Operation cancelled by user` stream as
   `agent_message_chunk` with no separator. The visible result is
   `…hello.txtDone. File created.` Bridges cannot tell these notices from the
   model's answer. They would fit better as tool-call content or a distinct
   update type.
4. **A rejected permission ends the turn with `end_turn`, not `cancelled`**
   *(verified)*. When the client answers `reject_once`, the `tool_call_update`
   fails ("The user rejected this tool call.") and the turn stops with
   `stopReason: "end_turn"`. Clients therefore can't tell "the agent finished"
   apart from "the user's denial aborted the work" without parsing the text.
   Grok reports `cancelled` here.
5. **Authentication cannot be completed headlessly over ACP** *(verified for
   the advertised methods; failure path unverified)*. The only entry in
   `authMethods` is `copilot-login`, a terminal-auth `_meta` entry that runs
   `copilot login` interactively. Bus-hosted agents need a non-interactive
   path (token or device-code over ACP). We believe an unauthenticated
   session fails at prompt time rather than at `session/new`, but could not
   reproduce that on Windows (see 6).

### Behaviour worth confirming or documenting

6. **An invalid `COPILOT_GITHUB_TOKEN` silently falls back to stored
   credentials** *(verified)*. With a bogus token and a fresh `COPILOT_HOME`,
   prompts still succeed via the OS credential store. `copilot help
   environment` says the token "takes precedence". A silent fallback hides
   misconfiguration on shared hosts.
7. **`COPILOT_ALLOW_ALL=true` also trusts the working directory**
   *(verified, from `copilot help environment`)*. That loads the directory's
   hooks and MCP servers. An inherited environment variable that both
   auto-approves every tool and trusts the cwd is risky for a bridged agent.
   The prototype stripped it. A dedicated "ACP host owns permissions" switch would
   be cleaner.
8. **The `allow_all` configOption is settable by any ACP client**
   *(verified as advertised)*. That is expected for a local IDE. For bridges,
   a CLI flag to lock or hide it would be helpful.
9. **`session/request_permission` uses JSON-RPC id `0`** *(verified)*. This
   is valid JSON-RPC, but clients that test ids for truthiness drop it.
   Starting ids at 1 would avoid a class of client bugs.
10. **Mode ids are URLs** *(verified)*, ending in `#agent`, `#plan`, and
    `#autopilot`. They work, but they are unusual compared with other ACP
    agents' short ids, and they make config files and logs verbose.
11. **The `agent` configOption lists the user's installed custom agents**
    *(verified with the default home)*. This can expose private agent names
    to whichever client is connected. It's fine for an IDE, but surprising
    for a bridge.
12. **The `tool_call` title differs from the permission request's title**
    *(verified)*. For example, `Creating <path>` versus `Create file`.
    Matching titles would make the relayed query easier to follow.

### Efficiency

13. **`available_commands_update` is sent four times per `session/new`, and
    each one is large** *(verified)*. One emission, or deltas, would cut the
    startup chatter.
14. **Thought chunks always stream** *(verified)*. `agent_thought_chunk`
    updates cannot be turned off, even when the client discards them, as this
    bridge does.
15. **The baseline prompt cost is high** *(verified via `usage_update`)*. A
    one-line prompt uses about 17.7k input tokens with an empty home, and
    about 35k with a typical user home (instructions, MCP servers, custom
    agents). An ACP-level "minimal context" switch would help small bus
    agents.

### Works well (for balance)

- `initialize`, `session/new`, `session/prompt`, `session/load` (with history
  replay), and `session/request_permission` all behave per the ACP spec. The
  generic ACP channel needed no Copilot-specific bridging code.
- Read-only tools run without asking. Writes and shell commands ask, which is
  the right default for a governed bus agent.
- In ACP mode there is no interactive `ask_user` tool, so the agent asks
  clarifying questions in plain text and never blocks on a UI that the
  bridge can't show.
