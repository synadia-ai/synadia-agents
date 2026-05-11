# Changelog

All notable changes to `synadia-ai-agent-service` are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html);
the 0.x line is explicitly unstable per protocol spec §11.2.

## [Unreleased]

### Changed

- **Leading `status=ack` chunk is now emitted unconditionally (§6.4).**
  Spec §6.4 was sharpened to require that every prompt handler emit
  exactly one `{"type":"status","data":"ack"}` chunk as the **first**
  message on the reply subject, **before** any work that introduces
  observable latency. `AgentService._on_prompt_request` now publishes
  the ack after a successful envelope decode and before invoking the
  user-supplied handler — so every Python agent in the repo
  (reference agent, `demo_echo`, in-tree test handlers) becomes
  spec-compliant on upgrade with no code change. The ack is emitted
  regardless of `keepalive_interval_s`; passing `None` only disables
  the periodic keep-alive cadence, not the leading ack. A malformed
  envelope still produces `error(400) → terminator` with no
  spurious ack — the ack lives after decode validation.

## [0.3.0] - 2026-05-04

Restores wire-shape parity with the spec and TS SDK after the
2026-04-28 session-name collapse mistakenly dropped `session` from
service metadata and §8.3 / §8.7 payloads. Reported as
[issue #73](https://github.com/synadia-ai/synadia-agents/issues/73).

### Fixed

- **`metadata.session` (§3.2)** — `AgentService.start()` now advertises
  `metadata.session = session_name` alongside the existing
  `{agent, owner, protocol_version}` triple. Per §3.2 a session-less
  harness MAY omit the field OR set it to `"default"`; since the
  Python constructor takes a required `session_name` (callers pass
  `"default"` when session-less), we always emit it for a uniform
  shape across both styles.
- **`HeartbeatPayload.session` (§8.3)** — `build_heartbeat_payload`
  now populates `session=subject.session_name`, so periodic
  heartbeats published on `agents.hb.{a}.{o}.{session_name}` mirror
  `metadata.session` per §8.3 / appendix B.11.
- **Status reply `session` (§8.7)** — the same builder feeds the
  `agents.status.{a}.{o}.{session_name}` request/reply endpoint, so
  a §8.7 status reply carries `session` matching the heartbeat. §8.7
  + appendix B.11a explicitly require the same §8.3 schema.

### Changed

- **Dependency floor bumped to `synadia-ai-agents>=0.7`** so the
  shared `HeartbeatPayload` model has the `session` field — needed
  for the publisher and status handler to populate it.

## [0.2.0] - 2026-05-03

### Changed

- **Dependency floor bumped to `synadia-ai-agents>=0.6`** in lockstep
  with the client-sdk's prompt-stream catch-up to the TS SDK's PR #66
  (`requestMany` + sentinel) — see
  [`client-sdk/python/CHANGELOG.md`](../../client-sdk/python/CHANGELOG.md)
  `[0.6.0]` for the substance of that change. **No agent-side
  code changes:** PR #66 was confirmed to touch only
  `client-sdk/typescript/` (`gh pr view 66 --json files`); the
  agent-host wire is identical pre/post. Agents still publish
  individual chunks to `msg.reply` with the §6.5 zero-byte
  terminator — whether the client subscribed per-stream or via a
  shared mux is invisible from the agent's POV. The bump exists
  purely to keep the published metapackage coherent so a user
  installing `synadia-ai-agent-service` via PyPI pulls a client-sdk
  that exposes the new `Agent.prompt(max_wait_s=...)` /
  `StreamMaxWaitExceededError` / `StreamStalledError` surface shared
  between both packages.

## [0.1.0] - 2026-04-30

Initial release. **Carved out of `synadia-ai-agents` at the 0.5.0
cut**: through 0.4.x the agent-host surface lived inside
`synadia-ai-agents`; the 0.5.0 release removed it there and shipped
it here as 0.1.0. Both packages were cut together —
`synadia-ai-agents@0.5.0` is the first PyPI version that no longer
carries this surface. Harness authors get a focused dependency;
callers install just the client SDK.

### Added

- `synadia_ai.agent_service.AgentService` — service registration,
  prompt endpoint, status endpoint, heartbeat publisher loop, and
  mid-stream `ask` per the §12 implementation checklist. Sourced
  from `synadia-ai-agents`'s pre-0.5.0 `service.py` (the file moved
  here at the split — `synadia-ai-agents@0.5.0` no longer carries
  it; the lineage includes the post-0.3.0 server-`max_payload`
  clamp and the v0.3 verb-first wire); rewired to import shared
  wire types (`Envelope`, `HeartbeatPayload`, `AgentSubject`, error
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

### Removed

- Dropped the unused `utf8_byte_length` helper from the private
  `synadia_ai.agent_service._bytes` module. It was copied wholesale
  from the client-sdk during the 0.1.0 extraction but has no caller
  in the agent-sdk — it's a caller-side pre-publish size check used
  inside `synadia-ai-agents` only.

### Fixed

- `run_publisher` no longer propagates publish exceptions out of the
  heartbeat task. A failed publish (e.g. `ConnectionClosedError`
  after a broker restart) is logged and the publisher exits cleanly
  so `AgentService.stop()` teardown stays deterministic instead of
  re-raising mid-cleanup. `AgentService.stop()` now suppresses
  `Exception` alongside `CancelledError` when awaiting the publisher
  task as a belt-and-braces guard against unforeseen errors that
  predate the catch in `run_publisher`. Surfaced by the Claude
  reviewer bot on PR #45.
- `test_run_publisher_emits_immediate_then_periodic` no longer
  asserts a lower bound on heartbeat inter-arrival times.
  `asyncio.wait_for(stop.wait(), ...)` can return slightly early on
  a loaded event loop, and a tight lower bound flaked on contended
  CI runners without protecting any caller-visible invariant; the
  upper bound is the load-bearing liveness check.

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

### CI

- The "Install nats-server" steps in
  `client-sdk-python-agent-service.yml` and
  `release-python-agent-service.yml` now extract the tarball into
  `${{ runner.temp }}` instead of inheriting
  `defaults.run.working-directory: agent-sdk/python`. Stops every
  run from leaving an empty `nats-server-v*-linux-amd64/` parent
  dir in `agent-sdk/python/` after the binary is `mv`'d to
  `/usr/local/bin/`. Cosmetic only — no behavior change.
