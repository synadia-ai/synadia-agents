# Changelog

All notable changes to `@synadia-ai/nats-channel` (the OpenClaw plugin)
will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Identity env vars adopt the `SYNADIA_*` convention** shared across
  `agents/*`. Owner: `SYNADIA_OPENCLAW_OWNER` > `SYNADIA_OWNER` >
  `NATS_OWNER` (legacy) > `NATS_ORG` (legacy) > account config. Agent
  name: `SYNADIA_OPENCLAW_NAME` > `SYNADIA_NAME` > `NATS_AGENT_NAME`
  (legacy) > account config. Purely additive — the legacy vars keep
  working with identical behavior; the new vars only sit above them.
- `NATS_CREDS` is accepted as an alias for `NATS_CREDENTIALS` — the
  spelling flue and opencode also accept. Tie-break differs
  deliberately: here the incumbent `NATS_CREDENTIALS` wins when both
  are set (zero change for existing deployments), whereas flue/opencode
  check `NATS_CREDS` first.
- The env-override log line now names the variable that actually
  supplied the value (e.g. `SYNADIA_OWNER`), not just the legacy name.

## [0.5.6] and earlier

Changelog started 2026-06-12 (at package version 0.5.6); see the git
history of `agents/openclaw/` for earlier changes.
