# Changelog

All notable changes to `@synadia-ai/eve-nats-channel` will be documented in
this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-22

### Added

- Initial release: NATS sidecar for Vercel Eve agents built on
  `@synadia-ai/agent-service`.
- Drives one Eve conversation over HTTP via `eve/client` (lazy session,
  auto-reset after `session.completed` / `session.failed`).
- Streams Eve `message.appended` deltas as protocol `response` chunks;
  actions, subagent calls, compaction, and authorization events as
  `status` chunks; `result.completed` structured outputs as JSON
  response chunks.
- Bridges Eve `input.requested` (HITL) to protocol §7 mid-stream
  queries — option rendering, one re-ask on unresolvable replies,
  deny-shaped auto-answer on timeout, max 8 rounds per prompt.
- Attachment support (`attachments_ok=true`): protocol attachments
  become inline `data:` URL file parts with extension-derived media
  types.
- `eve-agent` CLI (`start` / `doctor` / `configure --print-template`)
  with CLI > env > TOML > default precedence and optional bearer auth
  for deployed Eve agents.
- Protocol smoke (fake Eve client) and real-eve smoke
  (`npx eve dev --no-ui` on a deterministic `mockModel` fixture).
