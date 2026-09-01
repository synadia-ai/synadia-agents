# Changelog

All notable changes to the Claude Code NATS channel are documented here.

## Unreleased

### Added

- Optional connection-bound signed host identity through `senderIdentity` and independent inbound
  sender policy through `minSenderTrust`.
- Safe, explicit `request_info` inspection for the classified sender of an active request.

### Changed

- Migrated service registration, prompt admission, status classification, replay protection,
  acknowledgements, heartbeats, errors, and stream termination to `AgentService`.
- Permission queries now use `PromptResponse.ask()` and pending requests settle on completion,
  expiry, or shutdown.
- The marketplace plugin runs a committed, deterministic, self-contained bundle and no longer
  installs mutable dependencies whenever its MCP server starts.
- Synchronized the existing package and Claude plugin descriptor version at `0.5.1`.
