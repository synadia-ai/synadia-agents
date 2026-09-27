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
