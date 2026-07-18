# Changelog

All notable changes to `@synadia-ai/grok-nats-channel` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-18

### Added

- Initial grok-pinned front door to the generic ACP channel
  (`@synadia-ai/acp-nats-channel`): `grok-agent start` registers a managed
  Grok Build session as a Synadia Agent Protocol for NATS v0.3 agent at
  `agents.prompt.grok.<owner>.<session>`.
- Grok-specific documentation: auth/home strategies (`--agent-home`),
  the `permission_mode = "always-approve"` interaction with the §7 query
  relay, and the live-verified approve/deny permission workflow.

### Notes

- Pre-publish, the dependency on `@synadia-ai/acp-nats-channel` is a
  `file:../acp` link; it switches to a semver range when the ACP channel
  ships to npm (release-ladder step).
