# Changelog

All notable changes to `@synadia-ai/open-agent` will be documented in
this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Identity env vars adopt the `SYNADIA_*` convention** shared across
  `agents/*`. Owner: `--owner` > `SYNADIA_OPEN_AGENT_OWNER` >
  `SYNADIA_OWNER` > `OPEN_AGENT_OWNER` (legacy) > `$USER` > `anon`.
  Session: `--session` > `SYNADIA_OPEN_AGENT_NAME` > `SYNADIA_NAME` >
  `OPEN_AGENT_SESSION` (legacy) > `default`. Hyphens in the agent name
  map to underscores in the env prefix. Legacy vars keep working.
- `$NATS_CONTEXT` env var is honored (previously context selection was
  CLI-only via `--nats-context`).

### Changed

- **Connection precedence: a selected NATS context now wins over
  `$NATS_URL`** (`--nats-context` flag > `$NATS_CONTEXT` > `$NATS_URL`
  > localhost), matching every other agent plugin. Previously
  `$NATS_URL` silently overrode `--nats-context`. Only setups passing
  `--nats-context` *while also* exporting `NATS_URL` are affected.

## [0.0.1] and earlier

Changelog started 2026-06-12 (at package version 0.0.1); see the git
history of `agents/open-agent/` for earlier changes.
