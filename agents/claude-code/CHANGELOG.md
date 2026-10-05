# Changelog

All notable changes to the Claude Code NATS channel are documented here.

## Unreleased

### Added

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
  optional `request_id`, the channel request it is made for (the last active request when
  omitted); the call runs in that request's context, so the calls it starts end with the
  request.
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

### Changed

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
