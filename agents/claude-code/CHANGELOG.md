# Changelog

All notable changes to the Claude Code NATS channel are documented here.

## Unreleased

### Added

- `NATS_CREDS` (alias `NATS_CREDENTIALS`): with no context, the channel connects at `NATS_URL` with
  this credentials file, so a container needs no NATS context file. A context still wins;
  credentials without `NATS_URL` fail rather than go to the public default server.
- Optional connection-bound signed host identity through `senderIdentity` and independent inbound
  sender policy through `minSenderTrust`.
- Safe, explicit `request_info` inspection for the classified sender of an active request.
- The server's instructions now say the `reply` tool may be listed as deferred and must be
  loaded before answering, otherwise the model may reply only in its own output, which the
  sender never sees.
- The agent tools: the SDK's `AgentTools` on the MCP server, next to `reply` and
  `request_info`, through one persistent `Agents` client with the service's signer.
  `agentTools` in `config.json` and `NATS_AGENT_TOOLS` pick `blocking` (the default:
  `discover_agents`, `prompt_agent`, `answer_agent`), `all` or `off`. Each agent tool takes an
  optional `request_id`, the channel request it is made for (when omitted, the turn that made
  the call decides, below); the call runs in that request's context, so the calls it starts
  end with the request.
- The extension point of `agents/EXTENSIONS.md`: modules named in
  `SYNADIA_CLAUDE_CODE_EXTENSIONS`, `SYNADIA_AGENT_EXTENSIONS` or `extensions` in
  `config.json`, loaded once at start. Their interceptors go to the client and the service,
  their tool extensions to the agent tools, and they hear the session's events:
  `promptAccepted`, `promptEnded`, `aroundToolCall`, `sessionStarted`, `turnStopped`.
  `request_info` and the `connecting` log event name the modules loaded.
- An extension may return `metadata`, string keys and values merged into the service's
  registration metadata before it starts; the protocol's registration keys win on a clash, and
  an invalid key or value fails the start with an error naming the extension.
- The plugin's hooks are back, neutral and always on: `SessionStart`, `Stop` and, for the agent
  tools, `PreToolUse` record the session id, the turn's end and the model's tool-call id under
  `<state dir>/sessions/`, keyed by the Claude Code process. The server follows `/clear` with
  them, reports the turn's end, and hands the tool-call id to the agent tools. They run
  `hooks/session-event.ts` with `bun`.
- A request the model leaves without its `done` reply is ended rather than left open until
  the 30-minute TTL. The caller gets a §9 error frame, code `500`, description `the Claude Code
  turn ended without a reply to this prompt`, and no response text. A request that owned its
  turn is ended at that turn's `Stop` when no background work is left; any other request
  survives the `Stop` and is ended once no turn has started within `turnStartGraceMs` of the
  latest `Stop` (5 minutes by default; `SYNADIA_CLAUDE_CODE_TURN_START_GRACE_MS` wins over
  the config field). Each is logged as `request ended without a reply` with its request id and
  reason, and reaches the extensions' `promptEnded` with the outcome `error` (and the reason
  `no_reply`).

- A turn that ends without the `reply` is no longer given up at once. At the `Stop` of a turn
  whose request is still open, the `Stop` hook refuses the stop once, naming the open
  `request_id` and telling the model to send its answer with `reply` (`done: true`); it never
  refuses the stop that follows (`stop_hook_active`). If that turn stops again with the request
  open, the plugin sends the turn's final assistant text as the reply and completes the
  request: the text written before the refused stop, kept in `<state dir>/sessions/<pid>.nudge`
  (not counted as a stop), and the text of the stop after it only when the refused one had
  none, since what a nudged model writes is often just a reaction to the nudge. Each is Claude
  Code's `last_assistant_message`, or the last assistant message in the transcript for a
  Claude Code that does not send it. Only a turn with no final text still
  ends in the `500` error. The hook learns which requests own the running turn from
  `<state dir>/sessions/<pid>.open`, written by the server, and fails open: no file, a
  malformed one, a server no longer running, or 5 seconds gone, and it lets the turn end.
- `promptEnded` takes an optional fourth argument, the reason a prompt ended when the model
  did not end it with its own reply: `final_text` (outcome `ok`), `no_reply`, `shutdown`,
  `delivery` (outcome `error`) or `expired` (outcome `timeout`). It is left out when the model
  replied, so existing handlers see what they always saw.
- **Turns by prompt id.** Two more hooks, `UserPromptSubmit` and `StopFailure`, and a log,
  `<state dir>/sessions/<pid>.events`: one JSON line per prompt Claude Code takes (the prompt
  id of the turn it runs in, and, for this channel's own message, its `request_id` and
  `source`; never the prompt's text), per recorded `Stop`, and per `StopFailure` (the API
  error's type and its details cut to 200 characters). The server reads it from where it left
  off and follows Claude Code's turns by their prompt ids: a request belongs to the turn
  Claude Code took it into, its own or, folded at a tool result, the running one. The
  extensions hear `promptStarted(request, atMs, sessionId?)` when that happens, and
  `localTurnStarted` and `localTurnEnded` for every turn no request started (typed in the
  session, or begun by Claude Code itself), its id `local-<prompt_id>`. Each `.tools` record
  carries the call's prompt id. Until the hook reports a prompt id, and for a Claude Code that
  reports none, a request starts when it is accepted, as before, and no local turn is reported.
  Channel messages Claude Code takes together (one submit each, its own prompt id, one turn under
  the last) are one turn; a submit's channel tag `ts` keeps an earlier server's message, whose
  request id may be handed out again, from binding this server's request.
- **An API error ends the request at once.** A turn that fails on a model API error ends with
  `StopFailure`, never `Stop`, so its request waited for its caller's limit. Now it ends at
  once, without final text: the caller's error frame names the error (`the turn failed on a
  model API error: billing_error (…)`), the channel logs the same line, and the extensions
  hear `promptEnded` with `error` and `no_reply`. Without prompt ids, the failure ends the
  request that owned the turn at once and counts as a `Stop` for the others' grace period.

### Changed

- A request owns the turn Claude Code took it into, once the hooks report prompt ids, and no
  longer the turn it was delivered in while Claude Code looked quiet. A request delivered
  during a typed turn's first model call looked quiet: the typed turn's `Stop` was refused for
  it, its caller got the typed turn's final text, and its own reply then met `request is not
  active`. Now a request queued behind the running turn owns nothing in it; a permission
  question goes to the one open request of the asking call's turn; and a request still open
  when its turn ends ends then: at its `Stop` (nudged, then the final text, else the error), at
  a `StopFailure` or an interrupt with an error, at a `Stop` with background work left by the
  grace period. `<pid>.open` adds `open_ids`, every open request delivered, and `since_ms`,
  and the `Stop` hook works out by itself which of them the stopping turn took in, never
  waiting for the server.
- An agent-tool call without `request_id` runs in the turn that made it, by its prompt id: in
  the last channel request taken into that turn that is still open (the one that started it, or
  one folded into it, a typed turn's too), else, for a local turn, as the local user's. A turn whose requests have all finished runs its calls outside any
  request, no longer in the last request delivered. Only a Claude Code that reports no prompt
  ids still gets the last active request.
- The server's instructions name the channel tag as Claude Code writes it:
  `<channel source="plugin:nats-channel:nats" …>`, not `source="nats"`.

- **An explicit server in the environment beats a remembered context.** The `context` in
  `config.json` now counts only when the environment names no server: with `NATS_URL`,
  `NATS_CREDS` or `NATS_CREDENTIALS` set and non-empty (and `NATS_CONTEXT` unset), the channel
  connects to that server and does not read the file's context. Before, the file's context won,
  so a stale context could connect the session to another server than the one its environment
  named. `NATS_CONTEXT` still wins over everything, and set but empty it still selects no
  context at all. Credentials without `NATS_URL` now fail even when the file names a context,
  and the error, `invalid NATS_CREDS/NATS_CREDENTIALS: set without NATS_URL; …`, now shows on
  stderr, where it read `startup failed (Error)`. An empty `NATS_URL` now means unset
  (`demo.nats.io`), not the URL `""`.
- The `connecting` line on stderr names where the connection came from:
  `context <name> from NATS_CONTEXT` (with `, NATS_URL unused` when `NATS_URL` or the
  credentials are set too), `context <name> from <config.json's path>` (`~` for the default
  state directory), `$NATS_URL` or `default: demo.nats.io`. It is written before the context
  is read, so a context that cannot be read is reported after the line that names it.
- `permissions: query` asks the caller of the turn that made the tool call, not the prompt
  that arrived last. The `PreToolUse` hook now runs on every tool call and records the turn's
  prompt id; the `Stop` hook records whether background work could start another turn. A
  request owns a turn only when it was delivered while Claude Code was quiet, until that
  turn's `Stop`. A question is denied at once when no request owns its turn (direct input, a
  turn started by background work or going on after its request's `Stop`, a request delivered
  while a turn was running), when the owning request is finished, or when its caller's
  connection is gone — checked before asking and every 2 seconds while the question is open.
  The 2-minute timeout stays for a caller that is there and does not answer.
- Migrated service registration, prompt admission, status classification, replay protection,
  acknowledgements, heartbeats, errors, and stream termination to `AgentService`.
- Permission queries now use `PromptResponse.ask()` and pending requests settle on completion,
  expiry, or shutdown.
- The marketplace plugin runs a committed, deterministic, self-contained bundle and no longer
  installs mutable dependencies whenever its MCP server starts.
- Synchronized the existing package and Claude plugin descriptor version at `0.5.1`.
- Version `0.6.0`, package and Claude plugin descriptor.
