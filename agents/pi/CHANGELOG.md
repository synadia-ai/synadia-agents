# Changelog

All notable changes to `@synadia-ai/nats-pi-channel` will be documented in
this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Opt-in tracing through `"tracing": "on"` / `NATS_TRACING=on` /
  `/nats-configure tracing on`: the extension adopts or mints the prompt's
  thread and, while a NATS prompt is PI's active turn, stamps
  `X-Synadia-Thread-ID` and `X-Synadia-Root-ID` on PI's provider requests
  through `before_provider_headers`, so a model proxy files them under the
  caller's thread as for an SDK-built agent. Propagate-only: no record is
  published and no sender identity is needed. With tracing off nothing is
  stamped, even for a caller that sent lineage. The prompt is handed to PI
  inside the request's trace scope, so an SDK client used by a PI tool
  during the turn inherits the right thread.

### Fixed

- A NATS prompt's turn now ends on PI's `agent_settled` rather than
  `agent_end`. PI can auto-retry a failed model call, compact and retry an
  overflowed turn, or continue with queued messages after `agent_end`; the
  caller used to get its terminator before that answer, and the answer's
  text and traced model calls were lost. The next queued prompt is also
  injected as soon as PI settles instead of waiting for the next arrival.

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
- Constrained the PI peer dependency to the tested `0.84.x` line.
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
