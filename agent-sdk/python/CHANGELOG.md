# Changelog

All notable changes to `synadia-ai-agent-service` are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html);
the 0.x line is explicitly unstable per protocol spec §11.2.

## [Unreleased]

### Changed

- Host identity registration is now opt-in: omitting `identity` performs no
  self lookup and emits no `user_nkey`, `account`, or `id_sig` metadata;
  incoming sender classification and the default `min_sender_trust="any"`
  behavior are unchanged. Explicit `ServiceIdentity()` remains a
  best-effort unsigned registration request.
- A configured host signer is bound to the live connection's user and
  account with an uncached lookup. Every binding failure aborts `start()` and
  never downgrades the registration.
- Replay rejection details omit raw nonces. Acceptance-hook failures log only
  the exception type, not an application-controlled message or traceback.

## [0.5.0] - 2026-08-29

The receiver side of the **sender-identity extension** (PR-P2 of the
identity plan; the caller side is `synadia-ai-agents` 0.8.0, now the
floor). Every `prompt` request is classified **before** the §6.4 ack
and the handler sees the result as `stream.sender`; the registration
carries the agent's own identity; `min_sender_trust` is always
advertised. The wire protocol stays `0.3` — support is advertised by
feature detection (`min_sender_trust` on the prompt endpoint ⇔ the agent
implements the extension). The extension is additive to protocol `0.3`.
Behaviour-equal with `@synadia-ai/agent-service` 0.6.0 (same dispatch
order, wire descriptions, nonce-cache semantics); the reverse interop
test runs the TS client probe signed against this host.

### Added

- **Classification before the ack** — `AgentService` runs the shared
  verifier (`synadia_ai.agents.verify_sender`) on every `prompt`
  request after the envelope checks and before the leading ack: no
  `Agent-Sender` / unknown `v` → served with `stream.sender is None`;
  malformed header → `400 malformed Agent-Sender header`; failing
  signature, replayed nonce, stale `ts`, `sub` not the arrival subject
  → `401 sender rejected` in every mode; unsigned / header-less request
  on a `min_sender_trust: signed` endpoint → `401 signature required`.
  A refused request yields exactly the §9 error frame and the §9.3
  terminator — no ack, no handler call. `status` is classified and
  logged (its verified nonce enters the shared set), never rejected.
- **`PromptStream.sender`** (`PromptStream(request, nc, *, sender=None)`)
  — the classified `VerifiedSender` (has `id`, `account_attested`,
  `resolve()`), `ClaimedSender` (has `claim`, **no** `id`) or `None`.
  `VerifiedSender.resolve()` is bound to a TTL-cached `$SRV.INFO.agents`
  reverse lookup on the host's connection (`resolve_ttl_s`, default
  10 s; `0` enumerates per call).
- **`AgentService` options** — `identity=ServiceIdentity(signer=…)`
  (the host's own signer; the host never sends `Agent-Sender`, so no
  display name), `min_sender_trust` (`"any"` default / `"signed"`),
  `replay_window_s` (30), `account_token_position` (1-based; validated
  and honoured by the classifier — note the five-token hosting limit in
  the README), `accept_sender` (the acceptance hook: `False` → `403` for
  a verified sender, `401 signature required` for a claimed / absent
  one; a raise → `500 server error`, logged, never served; sync or
  async), `resolve_ttl_s`, `operator_attested` (off by default — the
  `Nats-Request-Info` cross-check of a *closed* endpoint: a present
  stamp that disagrees with the signed `account` / `user`, or a stamp
  the server would not write, → `401`; agreement on `acc` — or the
  `account_token_position` cross-check — sets
  `sender.account_attested`, rendered `(verified)`). Properties
  `identity` (the registered `AgentId`, `None` without one),
  `min_sender_trust`, `operator_attested`, `instance_id`.
- **Registration metadata** — `start()` learns the connection's agent
  ID once (`self_id`; a signer that is not the connection's user raises
  `IdentityMismatchError`; no identity → logged, started without the
  keys) and registers `user_nkey` / `account` whenever it is known,
  `id_sig` (`AGENT-ID-V1` over the prompt subject) only with a signer,
  and **always** `min_sender_trust` on the prompt endpoint (never on
  `status`). `start()` now `flush()`es before returning — "started"
  means registered at the server, so a prompt from another connection
  right after `start()` cannot race the subscriptions.
- **`SenderGate` / `NonceCache`** (`synadia_ai.agent_service.identity`,
  re-exported) — the stateful classification for hand-rolled services:
  `SenderGate(min_sender_trust=…, replay_window_s=…,
  account_token_position=…, accept_sender=…, operator_attested=…,
  resolver=…)` with `classify(msg)`, `admit_prompt(msg)` →
  `SenderAdmission(sender, rejection)`, `classify_status(msg)`;
  `NonceCache` keyed `(user, nonce)`, expiry anchored on the header `ts`
  (a `ts = now + 29 s` header is still rejected on replay at arrival +
  31 s), second-bucketed sweeps, a hard cap (100 000; oldest evicted,
  warned once per overload with hysteresis), synchronous check-and-set
  `record()` — the CAS under concurrent requests with the same nonce.
  Defaults `DEFAULT_MIN_SENDER_TRUST`, `DEFAULT_REPLAY_WINDOW_S`,
  `DEFAULT_NONCE_CACHE_MAX_ENTRIES`; `AcceptSenderHook`,
  `SenderRejection`, `SenderAdmission`, `ServiceIdentity` exported.
- **Examples** — `examples/_connect_cli.py` gained `--nkey` / `--creds`
  (`$NATS_NKEY_SEED_FILE` / `$NATS_CREDS`; a file, never an environment
  value holding the seed) and `signer_from_cli`; `_reference_agent.py`
  and the ladder examples pass the resulting `ServiceIdentity`; the
  reference agent adds `--min-sender-trust any|signed`
  (`$REFERENCE_AGENT_MIN_SENDER_TRUST`), prints
  `identity: <id> (min_sender_trust=…)` (or `identity: none (…)`) on
  its own line after the ready marker, and appends ` sender: <id>
  (<trust class>)` to the echo only when a sender was classified.
- Tests: `test_nonce_cache.py`, `test_identity_classify_e2e.py` (T0 /
  T1), `test_identity_accounts_e2e.py` (T2–T4 incl. operator-attested
  mode, the remapped import and `resolve()` across accounts),
  `test_registration_identity_e2e.py`, the signed reverse-interop leg
  (`--signed` probe), the reference agent under `--nkey`.
- **Agent-ladder examples** (`examples/01-echo.py` … `05-tools.py`,
  plus the shared `examples/llm.py` base) — the Python mirror of
  `agent-sdk/typescript/examples/`: echo, Ollama, OpenRouter, a
  combined auto-selecting agent, and a tool-calling agent backed by a
  NATS microservice. Identity and heartbeat are flags that default to
  env vars (env-first, flag-overridable); connection uses the shared
  `_connect_cli.py` resolver. Identity follows the same `SYNADIA_*`
  ladder the TypeScript agents use, first non-empty wins:
  `SYNADIA_<AGENT>_OWNER` (per-agent) > `SYNADIA_OWNER` (fleet-wide) >
  `NATS_AGENT_OWNER` (legacy alias) > `$USER` > `anon`, and the `NAME`
  analogue (`SYNADIA_<AGENT>_NAME` > `SYNADIA_NAME` > `NATS_AGENT_NAME`
  > the `--session-name` fallback) for the 5th subject token.
  `<AGENT>` is the example's registered subject token uppercased with
  hyphens turned into underscores (e.g. `echo` → `SYNADIA_ECHO_OWNER`).
  Heartbeat cadence stays config, not identity — it keeps its single
  `NATS_AGENT_HEARTBEAT_INTERVAL` var. The `_reference_agent.py` flags
  default through the fleet-wide + legacy + fallback rungs only (no
  per-agent var — its `agent` token is a runtime CLI flag). Non-breaking
  — explicit flags still win, and the legacy `NATS_AGENT_*` vars keep
  working as lowest-priority aliases.
- **`examples` extra** — `httpx`, used by the LLM/tool example scripts
  (`uv sync --extra examples`). Not part of the published SDK surface.

### Changed

- **Dependency floor `synadia-ai-agents>=0.8`** (was `>=0.7`): the
  shared identity codec (`synadia_ai.agents.identity`) is what this
  package classifies with. `python-v0.8.0` must be on PyPI before
  `python-agent-service-v0.5.0` is tagged.
- The host does **not** count `Agent-Sender` bytes in its own
  `max_payload` check (`len(request.data)`) — the broker enforces the
  total; the caller SDKs count the framed header on their side.
- The debug log of every served `prompt` / `status` request and the
  warning of every refusal render the sender through `format_sender`,
  so a claimed identity never reads as verified in a log line.

## [0.4.1] - 2026-05-12

### Changed

- **Protocol name** — package metadata, module docstring, and README
  updated to "Synadia Agent Protocol for NATS" (was: "NATS Agent
  Protocol"). Renamed in PR #103. No wire format, public identifier,
  or behavior change — protocol version stays `"0.3"`, leading-ack
  semantics from 0.4.0 unchanged.

## [0.4.0] - 2026-05-11

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
