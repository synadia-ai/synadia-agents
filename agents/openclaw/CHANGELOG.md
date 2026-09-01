# Changelog

All notable changes to `@synadia-ai/nats-channel` (the OpenClaw plugin)
will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Optional `senderIdentity: "signed"` mode derives registration identity from
  the same immutable NATS credential snapshot used to connect. The default is
  `off`, so existing identity-free setups do no identity lookup.
- Independent `minSenderTrust: "any" | "signed"` admission policy, defaulting
  to permissive `any`. Classified sender metadata is logged and is not inserted
  into model prompts.
- `NATS_SENDER_IDENTITY` and `NATS_MIN_SENDER_TRUST` env overrides.
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

### Changed

- Replaced the hand-rolled prompt service, sender admission, heartbeat,
  keepalive, status, and stream lifecycle with `AgentService` while preserving
  the `oc` subject token, OpenClaw dispatch behavior, attachments, and raw
  outbound pub/sub extension.
- NATS contexts are now complete connection/auth sources resolved by the
  shared SDK helper. Direct env overrides choose a direct URL/credentials
  source atomically, and an invalid explicitly selected context fails startup
  instead of silently falling back. Context nkey, JWT+seed, and TLS settings
  are now supported rather than dropped.
- The OpenClaw peer range is bounded to supported calendar-version releases.
  SDK `file:` links remain branch-development inputs; their circular development
  dependency graph prevents Bun from consuming a frozen lock. The release
  manifest must first select registry SDK versions, then generate and verify the
  committed lock from a clean install.

## [0.5.6] and earlier

Changelog started 2026-06-12 (at package version 0.5.6); see the git
history of `agents/openclaw/` for earlier changes.
