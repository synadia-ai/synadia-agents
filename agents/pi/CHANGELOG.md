# Changelog

All notable changes to `@synadia-ai/nats-pi-channel` will be documented in
this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Agent tools.** PI's model is offered the SDK's agent tools through
  `pi.registerTool()` once the session is on the bus: `discover_agents`,
  `prompt_agent` and `answer_agent` by default (the SDK's
  `BLOCKING_AGENT_TOOLS`), the six with `agentTools: "all"`, none with
  `"off"`; `NATS_AGENT_TOOLS` overrides the config field. The channel keeps
  one persistent `Agents` client with the same signer as its service, and
  PI's own address is refused. A prompt to another agent blocks within
  PI's turn, and the other agent's questions come back to the model. Note
  that PI's `--no-tools` disables these tools too; `--no-builtin-tools`
  keeps them.
- **Extensions.** Optional modules named in `SYNADIA_PI_EXTENSIONS`,
  `SYNADIA_AGENT_EXTENSIONS` or the `extensions` array of
  `nats-channel.json` — a package name or an absolute path, or
  `{ "module": "…", "options": { … } }` in the config — add prompt and
  request interceptors, heartbeat extras and agent-tools extensions to the
  channel's client, service and tools, and handlers for PI's events
  (`promptAccepted`, `promptEnded`, `aroundInject`, `providerHeaders`,
  `aroundToolCall`). Modules load once before the connection; one that
  fails is logged once and skipped. The contract is `agents/EXTENSIONS.md`;
  the types are exported from `extensions/extensions.ts`.
- `/nats-status` names the agent tools registered and the extensions
  loaded; `/nats-configure` prints both settings.

### Fixed

- A NATS prompt's turn now ends on PI's `agent_settled` rather than
  `agent_end`. PI can auto-retry a failed model call, compact and retry an
  overflowed turn, or continue with queued messages after `agent_end`; the
  caller used to get its terminator before that answer, and the answer's
  text was lost. The next queued prompt is also injected as soon as PI
  settles instead of waiting for the next arrival.

### Changed

- Migrated protocol hosting to `AgentService`. Sender admission now happens
  before the SDK-owned acknowledgement, while queued PI turns keep a deferred
  `PromptResponse` open until `agent_settled`, expiration, or shutdown. Expired and
  shutdown requests receive an error and terminator instead of being dropped.
- Added optional, connection-bound sender identity. `senderIdentity: "signed"`
  uses the shared SDK connection-bundle helper so the NATS authenticator and
  registration signer come from one credential snapshot; the default remains
  `"off"`. There is no separate identity credential path.
- Added independent inbound policy with `minSenderTrust: "any" | "signed"`;
  the default remains permissive. `NATS_SENDER_IDENTITY` and
  `NATS_MIN_SENDER_TRUST` override the matching config fields.
- Active sender metadata is available only through the trust-labelled
  `/nats-status` diagnostic and is never inserted into PI's model prompt.
- Constrained the PI peer dependency to the tested `0.84.x` and `0.85.x`
  lines (`>=0.84.0 <0.86.0`).
- **Identity env vars adopt the `SYNADIA_*` convention** shared across
  `agents/*`. Owner: `SYNADIA_PI_OWNER` > `SYNADIA_OWNER` >
  `NATS_PI_OWNER` (legacy) > config `owner` > `$USER` > `unknown`.
  Session name: `SYNADIA_PI_NAME` > `SYNADIA_NAME` >
  `NATS_SESSION_NAME` (legacy) > config `sessionName` > CWD basename.
  The legacy vars keep working indefinitely as lower-priority aliases.
- **BREAKING (owner precedence): env vars now beat the config file.**
  Previously the `owner` field in `~/.pi/agent/nats-channel.json` won
  over `$NATS_PI_OWNER`; now any owner env var wins over the config
  field — uniform with flue, opencode, openclaw, open-agent, and pi's
  own session-name handling. Only setups that set *both* the config
  `owner` field *and* an owner env var to different values are
  affected; everyone else sees no change.
- `/nats-configure` learns `owner <name|clear>` and shows the owner
  override in its status output.

## [0.5.6] and earlier

Changelog started 2026-06-12 (at package version 0.5.6); see the git
history of `agents/pi/` for earlier changes.
