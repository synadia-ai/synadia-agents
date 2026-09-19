# Changelog

All notable changes to the Claude Code NATS channel are documented here.

## Unreleased

### Added

- Optional connection-bound signed host identity through `senderIdentity` and independent inbound
  sender policy through `minSenderTrust`.
- Safe, explicit `request_info` inspection for the classified sender of an active request.
- Opt-in tracing through `tracing: "on"` / `NATS_TRACING=on` /
  `/nats-channel:configure tracing on`: the channel adopts a traced caller's thread, or mints
  one for a prompt that carries none, and publishes two signed `served` records per prompt on
  `TRACE.edges`, binding the thread to the session id, bare, under `harness: claude` with the outcome (`ok`, `error`,
  `timeout`). Requires `senderIdentity: "signed"`; without it nothing is published, startup
  warns, and the records owed count as dropped on the heartbeat.
- Plugin hooks (`hooks/hooks.json` → `hooks/session-event.ts`): `SessionStart` records the
  current Claude Code session id under `<state dir>/sessions/<Claude Code pid>` so the binding
  follows `/clear` (the server falls back to `CLAUDE_CODE_SESSION_ID`), and `Stop` records the
  turn end, which the served `end` record waits for (at most two minutes) and carries, so the
  closing model call Claude Code makes after the reply falls inside the window; without a
  `Stop` the reply is the turn end. The hooks write nothing while tracing is off. The files
  outlive the server; a server starting with tracing on sweeps those of Claude Code processes
  that no longer exist.
- The server's instructions now say the `reply` tool may be listed as deferred and must be
  loaded before answering, otherwise the model may reply only in its own output, which the
  sender never sees.

### Changed

- Migrated service registration, prompt admission, status classification, replay protection,
  acknowledgements, heartbeats, errors, and stream termination to `AgentService`.
- Permission queries now use `PromptResponse.ask()` and pending requests settle on completion,
  expiry, or shutdown.
- The marketplace plugin runs a committed, deterministic, self-contained bundle and no longer
  installs mutable dependencies whenever its MCP server starts.
- Synchronized the existing package and Claude plugin descriptor version at `0.5.1`.
