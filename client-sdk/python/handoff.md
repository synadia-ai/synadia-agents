# Handoff

You're picking up work on `natsagent` - a Python SDK for the NATS Agent
Protocol. This document tells you where things stand and what to do next.

## Read first (in this order)

1. **`CLAUDE.md`** - project context, toolchain, canonical commands,
   engineering conventions, and the **no-bullshit testing** rule.
2. **<https://github.com/synadia-ai/nats-agent-sdk-docs>** - the wire
   protocol spec and source of truth. The implementation checklist in
   §12 defines what "compliant" means.
3. **`docs/protocol-mapping.md`** - every SDK call mapped to its spec
   section. Good cross-check when you're not sure what the SDK is
   supposed to do for some wire-level detail.
4. **`CHANGELOG.md`** - what changed and when. The `0.1.0` entry
   captures the full migration from the v0.0.1 scaffold to the
   spec-aligned release; useful context for any decision that looks
   surprising.

## Current state (as of 2026-04-21)

The `align-core-protocol-0.1` branch lands `0.1.0`: full NATS Agent
Protocol v0.1 compliance plus the release-engineering artefacts a
public package needs. Once that branch merges and is tagged `v0.1.0`,
`.github/workflows/release.yml` publishes to PyPI.

Summary of what `0.1.0` ships:

- **Spec-compliant wire** - service name `SynadiaAgents`, `{agent, owner,
  protocol_version, session?}` metadata, `max_payload` / `attachments_ok`
  endpoint caps, `{prompt, attachments}` envelope, typed `{type, data}`
  chunks with strict terminator, `instance_id`-bearing heartbeats.
- **Clean-break API** - `Agent(agent=..., owner=..., name=..., session=...)`.
  `Envelope(prompt=..., attachments=...)`. No more `TextPart` /
  `FilePart` / `Envelope.parts`. `DiscoveredAgent.prompt_endpoint`
  carries parsed endpoint caps for §5.4 pre-publish validation.
- **New error classes** - `ValidationError`, `PromptEmptyError`,
  `AttachmentsNotSupportedError`, `PayloadTooLargeError` (all rooted in
  `NatsAgentError`).
- **Cross-SDK interop** - `tests/test_interop_e2e.py` drives the TS
  reference agent at `../typescript/` and verifies round-trip on the
  same wire. Skips cleanly without `bun` or the sibling checkout.

**Tests:** 107 green (split roughly: envelope / messages / subjects /
bytes / heartbeat / validation unit tests + echo / attachment / query /
error-completion / validation / interop e2e). `ruff check`,
`ruff format --check`, `mypy --strict` all clean. CI matrix runs
3.11 / 3.12 / 3.13.

Canonical dev commands live in **CLAUDE.md → Toolchain → Canonical
commands**. This handoff doesn't duplicate them.

## Backlog (post-0.1.0)

In roughly increasing order of invasiveness:

1. **Docs site** (deferred from the 0.1.0 PR to keep the diff reviewable).
   Pick MkDocs or Sphinx, wire a `docs/` build, publish to GitHub Pages
   or Read the Docs. Mirror the structure of the TS SDK's equivalent when
   it lands.
2. **JetStream Object Store references (§5.5, post-v0.1).** The spec
   reserves the `attachments` endpoint at
   `agents.{agent}.{owner}.{name}.attachments` for out-of-band large
   files. Requires enabling JetStream in the test fixture
   (`tests/harness/nats_server.py` - today launches without `-js`).
   Coordinate with the TS SDK before nailing down the Python API;
   symmetry matters.
3. **NATS context support (§10.2).** The TS SDK has `connect({context: ...})`
   that loads `~/.config/nats/context/<name>.json`. Python doesn't have
   an equivalent yet. Track the three error subclasses
   (`NatsContextNotFoundError`, `NatsContextNotSelectedError`,
   `NatsContextInvalidError`) in the TS SDK when building the Python
   version.
4. **Multi-instance heartbeat tracking.** `HeartbeatTracker` currently
   keys on inbox subject, so two instances of the same identity tuple
   overwrite each other. Spec §8.2 says liveness is tracked per
   `instance_id`. Re-key the tracker and expose per-instance status.
5. **Server-side §5.4 enforcement.** The agent advertises `max_payload`
   + `attachments_ok` in endpoint metadata, but doesn't re-validate
   server-side. A non-compliant caller (e.g. our own `bind(inbox_str)`
   path, or a hand-crafted `nats pub`) can send oversize or
   attachments-when-forbidden payloads and the agent will try to handle
   them. Add agent-side 400s for these cases.
6. **Refreshing `docs/nats-agent-sdk.md`.** Design-sketch doc from the
   pre-v0.1 scaffold days. Either rewrite to reflect the `0.1.0` shipped
   shape, or delete and rely on `docs/protocol-mapping.md` + the SDK's
   own docstrings. Hasn't been critical to anyone reading it recently.

## Gotchas learned during alignment

- **NATS headers are single-line.** `respond_error(description)`
  descriptions with newlines (e.g. multi-line pydantic validation
  errors) get truncated by the receiver - the `Nats-Service-Error-Code`
  header vanishes because it lands after a newline. Agent.py's
  `_sanitize_error_desc` collapses newlines to ` | ` and caps at 200
  chars; respect it in any new error paths.
- **Plain text on the response side is a spec violation** (§6.2). Any
  bytes the agent emits after the prompt endpoint handler start MUST be
  JSON `{type, data}`. The v0.0.1 `encode_response_text` that emitted
  raw UTF-8 was deleted in `5f09a6b`; `PromptStream.send(str)` now wraps
  in `ResponseChunk(text=text)` and serialises to the §6.3 bare-string
  form. If you add a new helper that emits bytes to the response
  stream, make sure it goes through `encode_chunk`.
- **Empty body alone is NOT the terminator.** An empty-body message
  WITH NATS headers is an error frame (or some future protocol signal).
  The terminator requires empty body AND no headers. The client.py
  check is `if msg.data == b"" and not headers` - don't "simplify" it.
- **`$SRV.PING` doesn't carry endpoints.** v0.0.1 used `$SRV.PING` for
  discovery and derived the instance name from the service `name` field
  - a hack that broke when service name became `SynadiaAgents` for
  everyone. `0.1.0` uses `$SRV.INFO.SynadiaAgents` so each response
  carries its endpoints, and the instance name is taken from the 4th
  token of the prompt endpoint's subject (§4.3).
- **`Agent(agent=...)` not `Agent(platform=...)`.** The spec rename from
  v0.0.1 is not back-compatible. Tests use `AGENT = "test"`; never
  default the identifier in SDK code.
- **`test_interop_e2e.py` depends on sibling checkout.** The TS SDK
  isn't published to npm yet, so interop hits `../typescript/`. If
  you move either repo, the path calculation in the test needs updating
  until the TS SDK publishes and we can pin a version instead.
- **Evidence recorder subscriptions.** Spying on `agents.>` and `$SRV.>`
  misses reply-inbox traffic (response chunks, query replies). The
  harness also subscribes to `_INBOX.>` so the wire trace in
  `messages.jsonl` is complete - don't strip that.
- **Heartbeat publisher emits one beacon immediately on start**, not
  after the first interval. Deliberate so callers that do
  subscribe-before-discover observe liveness without waiting a full
  interval (§8.5).
- **`Query` carries a live NATS client** (`_nc` field). `asdict(query)`
  fails because dataclasses deepcopy chokes on `_asyncio.Task` objects
  inside the client. For serialisation (evidence snapshots, debug
  logging), build the dict by hand - see `_snapshot` in
  `tests/test_query_e2e.py`.
- **`tests/__init__.py` must exist** or pytest can't resolve
  `from tests.harness.evidence import ...`. Empty file is fine.

## Workflow reminders

- Use `TaskCreate`/`TaskUpdate` to track multi-step work. Don't batch
  status changes.
- Read **CLAUDE.md's three CRITICAL rules** before running anything:
  never retry a failed command, always verify output, no inline
  one-liners for real work.
- Use `EnterPlanMode` for any non-trivial implementation - align on
  approach before coding.
- Commit early, commit often. Prefer small focused commits over one
  big omnibus. Reference spec section(s) in wire-level commits.
