# Changelog

All notable changes to `@synadia-ai/nats-pi-channel` will be documented in
this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

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
