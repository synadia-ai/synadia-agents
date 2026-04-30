# Changelog

All notable changes to `synadia-ai-agent-service` are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html);
the 0.x line is explicitly unstable per protocol spec §11.2.

## [Unreleased]

## [0.1.0] - 2026-04-30

Initial release. **Extracted from `synadia-ai-agents@0.5.0`** so the
agent-host surface ships as a focused dependency for harness authors
while callers can install just the client SDK.

### Added

- `synadia_ai.agent_service.AgentService` — service registration,
  prompt endpoint, status endpoint, heartbeat publisher loop, and
  mid-stream `ask` per the §12 implementation checklist. Sourced
  from `synadia-ai-agents@0.5.0`'s `service.py` (which carries the
  full lineage including the post-0.3.0 server-`max_payload` clamp
  and the v0.3 verb-first wire); rewired to import shared wire
  types (`Envelope`, `HeartbeatPayload`, `AgentSubject`, error
  classes, discovery constants) from `synadia_ai.agents`.
- `synadia_ai.agent_service.PromptStream` — emit response chunks /
  ask mid-stream queries / observe terminator semantics.
- `synadia_ai.agent_service.PromptHandler` — handler-callable type
  alias.
- `DEFAULT_MAX_PAYLOAD`, `DEFAULT_KEEPALIVE_INTERVAL_S`,
  `DEFAULT_ATTACHMENTS_OK` — agent-side defaults; previously
  exported from `synadia_ai.agents`.
- Heartbeat publisher helpers `build_heartbeat_payload`,
  `run_publisher`, `publish_one` in
  `synadia_ai.agent_service.heartbeat`. Imports
  `HeartbeatPayload`, `now_iso`, `AgentSubject` from
  `synadia_ai.agents`.
- `examples/_reference_agent.py` — spec-compliant runnable echo
  agent, used by both this package's tests and the client-sdk's
  numbered demos.
- `scripts/demo_echo.py` — one-shot dev-diagnostic echo agent for
  manual `nats` CLI poking. Moved from
  `client-sdk/python/scripts/`.

### Wire compatibility

Same protocol version as the client-sdk:
`metadata.protocol_version = "0.3"`. Wire-version history is shared
with `synadia-ai-agents` — see its
[CHANGELOG](../../client-sdk/python/CHANGELOG.md) for protocol
milestones (v0.1 alignment, v0.2 service-name + queue-group, v0.3
verb-first subjects + status endpoint, the 2026-04-28 session-name
collapse).

### Migration from `synadia-ai-agents`

For agent harness code that imported the host surface directly:

```diff
- from synadia_ai.agents import AgentService, PromptStream, PromptHandler
+ from synadia_ai.agent_service import AgentService, PromptStream, PromptHandler
+ # Envelope / Attachment / HeartbeatPayload / errors continue to import
+ # from synadia_ai.agents.
```

The constructor signature, behavior, and wire emission are
unchanged.
