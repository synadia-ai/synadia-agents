# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working
with code in this repository.

> **Status (2026-04-30).** Carved out of `synadia-ai-agents` at
> the 0.5.0 cut (the surface previously lived in `synadia-ai-agents`
> through 0.4.x; `synadia-ai-agents@0.5.0` is the first PyPI version
> that no longer carries it). This package now hosts `AgentService`,
> the heartbeat publisher, the status handler, and the reference
> agent. Shared wire primitives (`Envelope`, `HeartbeatPayload`,
> `AgentSubject`, error classes, discovery constants,
> `load_context_options`, `parse_nats_url`) stay in
> `synadia-ai-agents` and are imported from there.

## Project

This repo is a **Python agent-side SDK for the NATS Agent Protocol** —
the transport library that *agent harness authors* (Hermes, claude-code,
openclaw, pi, …) embed to expose their runtime as a protocol-compliant
agent over NATS. It is the host-side counterpart to
`../../client-sdk/python/` (`synadia-ai-agents` on PyPI), which provides
the discover-and-prompt surface that *callers* use.

**The split is "creation" vs. "consumption."** Anything used to *create*
an agent (service registration, response-stream emission, heartbeat
publishing, status answering, mid-stream `ask`) lives in this package.
Anything used to *consume* an agent (discovery, prompting, decoding
streams, replying to mid-stream queries) stays in
`synadia-ai-agents`. Wire-shape primitives shared by both sides
(envelope codec, subject helpers, validation rules, error types,
heartbeat payload model, protocol-version constant, NATS-CLI context
loader) **stay in `synadia-ai-agents`** and are imported from there.

**The SDK is the transport, not the harness.** In the protocol, `agent`
identifies the *agent runtime/framework* (e.g. `claude-code`,
`openclaw`, `hermes`). The SDK MUST require implementers to supply
their own `agent` identifier when constructing an `AgentService` and
MUST validate it against §2 (lowercase alphanumeric + hyphens). **No
default.** Never register agents under a generic `pysdk` value — that
would pollute the subject namespace and break `agent`-scoped
discovery. (This rule originated in the client-sdk's `AgentService`
and travels with it into this package.)

**The protocol spec is the source of truth.** Canonical location:
[`synadia-ai/nats-agent-sdk-docs/core-protocol.md`](https://github.com/synadia-ai/nats-agent-sdk-docs/blob/main/core-protocol.md)
(sibling checkout at `../../../nats-agent-sdk-docs/core-protocol.md`
when working locally). The §12 implementation checklist is what
"compliant" means; the §3 service-registration rules and §6/§7/§8
emission rules are the load-bearing parts for *this* SDK
specifically.

**Wire compatibility with the TypeScript SDK** is a hard requirement.
Today the TS SDK is monolithic (`@synadia-ai/agents` ships both client
and agent halves); a parallel TS split is planned but blocked on
Mario's bandwidth. Until then this Python agent-sdk validates
interop against the existing TS client (which will remain
`@synadia-ai/agents`-importable post-split per a hard backwards-compat
constraint on the TS side). When the spec is silent and the SDKs pick
a default, they MUST pick the same one — drift gets tracked in
`docs/protocol-mapping.md` (mirror the client-sdk's file in this
package).

## Package shape and dependency direction

- **Distribution name (PyPI):** `synadia-ai-agent-service`. *Not yet
  published.* A pending publisher on PyPI + a parallel
  `release-python-agent-service.yml` workflow + a distinct tag prefix
  (proposed: `python-agent-service-v*`) are required mirrors of the
  setup PR #28 landed for `synadia-ai-agents`. Trust-publishing
  environment can be the same `pypi` GitHub Environment, since the
  branch-policy gate is on the tag pattern.
- **Import path:** `synadia_ai.agent_service` (top-level under the
  `synadia_ai` PEP 420 namespace, *not* a submodule of
  `synadia_ai.agents`). This is forced by Python packaging: two
  distributions cannot both write into the same regular package
  (`synadia_ai/agents/__init__.py` is owned by `synadia-ai-agents`).
  Practical consequence:
  ```python
  # before the split
  from synadia_ai.agents import AgentService
  # after the split
  from synadia_ai.agent_service import AgentService
  ```
  Everything else (`Agent`, `Agents`, `DiscoverFilter`,
  `HeartbeatPayload`, `Envelope`, error classes, `load_context_options`,
  `parse_nats_url`, the `SERVICE_NAME` / `PROMPT_QUEUE_GROUP` constants,
  …) keeps its `from synadia_ai.agents import …` path unchanged.
- **Dependency direction:** `synadia-ai-agent-service` depends on
  `synadia-ai-agents` (`>=0.5` — the first release that ships the
  trimmed surface). Not the other way around. The client-sdk must
  remain installable and useful without ever pulling the agent-sdk.
- **No code duplication.** Anything shared (envelope codec, subject
  sanitization, `HeartbeatPayload`, `_PROTOCOL_VERSION`, validation
  helpers, error classes, NATS-context loader) is imported from
  `synadia_ai.agents`. Three occurrences is the threshold for
  abstraction in greenfield code; for a *split*, zero duplication is
  the bar — every shared symbol resolves to exactly one home.

## What lives here vs. what stays in client-sdk

Decisions are conservative — when in doubt, a primitive stays in
`synadia-ai-agents` so the client-only path remains a single
self-contained dist.

**Moves to this package** (`synadia_ai.agent_service.*`):

- `AgentService` itself — service registration, prompt endpoint, status
  endpoint, response-stream emission, mid-stream `ask`, terminator
  semantics. Sources back to today's
  `client-sdk/python/src/synadia_ai/agents/service.py`.
- The heartbeat *publisher* — periodic emission on
  `agents.hb.{a}.{o}.{session_name}`, lifecycle wiring, the
  `build_heartbeat_payload` helper used by both publisher and status
  handler. Sources back to today's `agents/heartbeat.py` (publisher
  half).
- The status *handler* (request/response on
  `agents.status.{a}.{o}.{session_name}`). Today inline in
  `service.py`.
- The agent-side reference implementation:
  `examples/_reference_agent.py` (today
  `client-sdk/python/examples/_reference_agent.py`).

**Stays in `synadia-ai-agents`** (and is imported from there):

- `Agent`, `Agents`, `DiscoverFilter`, `AgentInfo`, `EndpointInfo` —
  client surface.
- `Envelope`, `Attachment`, `encode`, `decode` — shared wire codec.
- `HeartbeatPayload` (Pydantic model) — shared shape; both publisher
  and decoder need it.
- Subject helpers (`subjects.py`) — both sides build and parse.
- Validation (`validation.py`) — both sides validate at boundaries.
- Errors (`errors.py`) — shared exception hierarchy.
- `SERVICE_NAME`, `PROMPT_ENDPOINT_NAME`, `PROMPT_QUEUE_GROUP`,
  `STATUS_ENDPOINT_NAME`, `STATUS_QUEUE_GROUP` constants — both sides
  reference these (the agent registers under them; the client filters
  on them).
- `_PROTOCOL_VERSION` — single source of truth for the wire-version
  string. The agent-sdk reads it but does not redefine it.
- `load_context_options`, `parse_nats_url` — NATS-CLI context helpers
  applicable to both sides.
- The numbered demo scripts `01-discover.py` … `06-chat.py` — they
  exercise the *client* surface against an agent, so they stay where
  the client surface lives. The agent-sdk's `_reference_agent.py` is
  what they discover and prompt.

## Protocol surface at a glance (agent-side view)

v0.3 wire shapes the SDK implements. `docs/protocol-mapping.md` in
this package currently points readers at the client-sdk's mapping
(which already covers both sides); a dedicated agent-side mirror is
deferred to a follow-up. All shapes are imported from
`synadia_ai.agents`; this list is what the agent-sdk *exercises*:

- **Subject hierarchy** (§2 v0.3): verb-first —
  `agents.{verb}.{agent}.{owner}.{session_name}` where `verb` is one
  of `prompt` / `hb` / `status` (and `attachments` reserved). Token 5
  is the session name — the subject IS the session, so a worker that
  wants to host N sessions registers N services. The agent-sdk picks
  the session names; the client filters on them.
- **Service registration** (§3): every agent registers as a NATS micro
  service named `agents` with `metadata = {agent, owner,
  protocol_version = "0.3"}` — exactly three fields under v0.3. The
  `prompt` endpoint MUST be registered with queue group `"agents"`
  (§3.3); ditto the `status` endpoint. The framework default differs
  between SDKs, so we pin the spec value explicitly.
- **Request envelope** (§5.1): `{prompt: str, attachments?:
  [{filename, content: <base64>}]}`. Plain-text request payloads are
  promoted to `{"prompt": <text>}` (§5.3). The agent-sdk decodes
  inbound; encoding is the client's job.
- **Response stream** (§6): typed `{type, data}` chunks in publication
  order, terminated by a zero-byte body with no NATS headers. The
  agent-sdk's emission API enforces the publication-order +
  terminator-shape contract; getting the terminator wrong is the most
  common interop failure, so unit-test it explicitly.
- **Mid-stream queries** (§7): agent-initiated questions emitted from
  the agent's response handler via the API equivalent of TS's
  `PromptStream.ask`. Caller replies via `Query.reply`. The agent-sdk
  owns the *initiation* path; reply decoding is shared.
- **Heartbeat** (§8.3): `{agent, owner, instance_id, ts, interval_s}`
  on `agents.hb.{a}.{o}.{session_name}`. The publisher loop lives
  here; the wire model `HeartbeatPayload` is imported from
  `synadia_ai.agents`.
- **Status** (v0.3 §-TBD): request/response on
  `agents.status.{a}.{o}.{session_name}` returns the same payload
  shape as a heartbeat, freshly built per request. Handler lives
  here; future enrichment (richer agent metadata) lands in
  `build_heartbeat_payload` so heartbeat and status share output.
- **Errors** (§9): `Nats-Service-Error-Code` header + optional JSON
  body; error-completed streams end with error frame THEN empty
  terminator. The "error frame, then empty terminator" rule is
  agent-side; the exception classes themselves are imported from
  `synadia_ai.agents`.

## Toolchain

Same toolchain as `client-sdk/python` — keep the two packages in
lockstep on Python version floor, dep manager, lint/type/test stack.

- **Python 3.11 minimum**, tested on 3.11 / 3.12 / 3.13 in CI.
- **`uv` for everything.** Don't use `pip`, `poetry`, or `virtualenv`
  directly.
  - `uv sync` to install; `uv add <pkg>` / `uv add --dev <pkg>` for
    deps. `synadia-ai-agents` itself goes in `[project.dependencies]`.
  - `uv run <tool>` to invoke (e.g. `uv run pytest`).
- Type hints everywhere; Pydantic v2 models for any new wire schemas
  introduced (most are already in `synadia-ai-agents`); `asyncio` +
  `nats-py` for I/O. All timestamps UTC ISO 8601.

### External prereqs

- **`nats-server`** on `$PATH`. e2e tests spawn a fresh server per
  pytest session (mirror `tests/harness/nats_server.py` from the
  client-sdk); unit tests don't need it. The fixture `pytest.skip`s
  cleanly if the binary is absent.
- **`bun`** + the monorepo's `../../client-sdk/typescript/` sibling —
  required for the cross-SDK interop test, which spawns the TS
  reference *client* (or, post-split, whatever package ships it) and
  asserts the Python `AgentService` here can be discovered + prompted
  on the wire. Until the TS sibling exposes a runnable client harness
  the test skips.
- **`nats` CLI** (optional, for manual poking).

### Connecting to NATS

The SDK does NOT open NATS connections — callers build a
`nats.aio.client.Client` and hand it to `AgentService(nc=nc)`. This
mirrors the broader `@nats-io/*` convention and the client-sdk's
`Agents(nc=nc)` shape. `AgentService.stop()` tears down SDK-owned
state only; the caller is responsible for `nc.close()`.

```python
import nats
from synadia_ai.agents import load_context_options
from synadia_ai.agent_service import AgentService

# 1. Direct URL(s) — caller drives nats-py directly.
nc = await nats.connect(servers="nats://127.0.0.1:4222")

# 2. Load a `nats` CLI context (~/.config/nats/context/<name>.json) and
#    splat its kwargs into nats.connect. Pass `"current"` to honour
#    $NATS_CONTEXT → the `context.txt` pointer written by
#    `nats context select`.
nc = await nats.connect(**load_context_options("prod"))
nc = await nats.connect(**load_context_options("current"))

# Then in either case:
service = AgentService(
    nc=nc,
    agent="my-runtime",   # REQUIRED, no default — see §2 rule above.
    owner="my-tenant",
    session_name="default",
    handler=my_prompt_handler,
)
await service.start()
```

`load_context_options` lives in `synadia-ai-agents` and is re-used
verbatim — same precedence rules (`creds` > `user_jwt` > inline
`token` / `user`+`password`), same unsupported-field surface
(`nkey`, TLS triple, `nsc://...` URLs raise `NatsContextError`). The
SDK itself does NOT read `NATS_URL`; that stays an `examples/`-only
convenience.

### Examples vs scripts

- `examples/` — the canonical home of `_reference_agent.py` and any
  agent-side runnable demos (e.g. an attachment-aware echo, a
  query-asking agent, a stream-error agent). The numbered consumer
  demos (`01-discover.py` …) live in `client-sdk/python/examples/`
  and *call into* this package's reference agent — keep them there
  for parity with the TS SDK's example layout.
- `scripts/` — dev diagnostics, not installed with the package.

### Canonical commands

```shell
uv sync                              # install dependencies
uv run ruff check .                  # lint
uv run ruff format --check .         # formatting check (drop --check to apply)
uv run mypy src tests examples       # strict type check
uv run pytest -v                     # full suite; e2e auto-skip if nats-server missing
uv run python examples/_reference_agent.py  # reference agent for manual poking
uv build                             # build sdist + wheel to dist/
ls tests/_evidence/                  # last run's per-test wire traces
```

Per-test evidence under `tests/_evidence/<nodeid>/` (gitignored):
`messages.jsonl` (pub/sub wire trace), `chunks.jsonl` (per-stream
response chunks), `srv-info.json`, `heartbeat.json`, `status.json`.
The session-scoped `nats-server` log sits alongside at
`tests/_evidence/_nats-server-logs/`. Read these when a test fails or
when verifying protocol compliance by eye — for an agent-side test,
`srv-info.json` is the load-bearing artifact (does it advertise the
right `metadata = {agent, owner, protocol_version}`? does the
`prompt` endpoint carry queue group `"agents"`?).

## Testing — no-bullshit, concrete evidence

Same philosophy as the client-sdk; the agent-side framing is what
shifts:

- Prefer integration tests that run against a **real NATS server**.
  Mocking the broker defeats the point of an SDK test.
- Capture evidence in artifacts. For an `AgentService` test the most
  important artifact is the `$SRV.INFO` response — record it to a
  log so a human can verify §3 metadata compliance by reading it.
  For a streaming test, the chunk-by-chunk transcript and the
  terminator's exact bytes (zero-length body, no headers) are the
  point.
- Heartbeat tests must observe **wire-level publication** at the
  expected interval on the expected subject — not just internal
  counters. Same for status: send a real `agents.status.…` request,
  verify the response is a valid `HeartbeatPayload` with current
  fields.
- Mid-stream `ask` tests exercise both directions: agent-side
  initiation and decoding the caller's reply.
- Flaky tests get fixed or deleted, never papered over with
  `sleep()`. Use deterministic waits (await a specific message, poll
  with a timeout+condition).
- Diagnostic scripts that exercise a live agent against a live NATS
  are first-class — keep them in `scripts/`, not one-off shells.
- **Cross-SDK interop**: `tests/test_interop_e2e.py` runs the Python
  reference agent and asserts the TS client can discover + prompt it.
  When the TS SDK splits, swap the test target if the client harness
  moves; until then it talks to `@synadia-ai/agents`. A change that
  passes the Python suite but fails TS interop is a bug.

## Critical operational rules

These apply identically to every Python SDK in this monorepo —
client-sdk, agent-sdk, and any future split. Carrying them verbatim
because skipping them is exactly the kind of corner-cut that produces
release fires.

**Never retry a failed command.** Read the error, understand it, then
either fix the cause or try a genuinely different approach. Re-running
the same failing command is never the answer.

**Always verify command output — never assume success.** After any
command, script, or API call, read the actual output and confirm it
succeeded. Check for error messages, unexpected status codes, partial
failures, rate-limit rejections. "It ran without crashing" ≠ "it
worked correctly." For multi-step scripts, every step's response must
be checked — one 429 or 500 in the middle means the whole result is
suspect.

**No inline scripts, no one-liners for real work.** The temptation at
end-of-task to bang out a `python -c "..."` or chain six commands
with `&&` to "just verify" is where sloppy failures happen. Rule:
**anything that touches NATS, a database, or non-trivial state goes
in a proper script file first, then gets executed.** If it's
reusable, add it to the project's diagnostic CLI. If it's one-off,
drop a short script in `scripts/`.

**Pre-push verification must bypass ruff/mypy caches.** `ruff`
aggressively caches per-file results and can mark a file "clean"
after a fresh checkout or config change even when the current rule
set would flag it — meaning CI (which always starts cold) fails on a
commit that passed locally. Before pushing, run lint and type checks
with caches disabled:

```bash
uv run ruff check --no-cache .
uv run ruff format --check .            # format is not cache-sensitive
uv run mypy --no-incremental src tests examples
uv run pytest
```

If CI fails on a lint rule that passed locally, assume cache
staleness and re-run with the flags above before anything else.

**Doc snippets are not compiler-checked — verify before
propagating.** When a sweep mechanically rewrites identifiers in
docs (rename, package move, large refactor), every code example you
touch is potentially stale. Doc text doesn't break the build, so a
snippet that referenced `Client.bind(...)` keeps "looking valid"
long after `Client` was removed. Rule: for any **current-state**
doc snippet touched in a sweep (READMEs, this file, contributor
guides), grep `src/` for every symbol it uses and confirm each is
still in `__all__` / still exported. If not, rewrite to current
API. Historical CHANGELOG diffs are different — they intentionally
describe removed APIs and a literal sweep there is fine.

**Cross-package edits require a ripple-check.** Because this package
imports from `synadia-ai-agents`, any change that *adds* a required
symbol to the agent-sdk's `from synadia_ai.agents import …` list
also requires that symbol to be (a) present in the installed
client-sdk version and (b) part of the client-sdk's pinned semver
floor in `pyproject.toml`. If you add a new shared primitive, you
land it in client-sdk first, cut a release, and *then* bump the
agent-sdk's lower bound — same release ladder shape as the
TS-SDK-→-examples one in the root `CLAUDE.md`.

## Work execution

Use `TaskCreate`/`TaskUpdate` for non-trivial work. Update status as
you go; don't batch.

Commit early, commit often. Prefer small focused commits over one
big omnibus. Wire-format changes reference the spec section(s) in
the subject line (e.g. `wire: heartbeat carries instance_id (§8.3)`)
— see the client-sdk's `git log --oneline` for the in-repo style.

## Engineering principles

**Quality over velocity.** Never rush at the expense of correctness.
Design for maintainability, not just immediate functionality. When in
doubt, do it right rather than fast.

**Reusable foundations over copy-paste.** Build shared primitives
once, then reuse. For *this* package specifically: anything that
could plausibly be shared with the client-sdk goes in the client-sdk,
not here. The threshold for a primitive moving back to client-sdk is
"both sides need it," not "two agent-side places need it."

**Observability from the start.** Every subsystem should be
debuggable when it misbehaves in the field. Structured logging,
traceable message IDs, introspectable state. The agent-side has more
long-lived state than the client-side (registered services, running
heartbeat tasks, in-flight queries) — surface it.

**Error handling at boundaries.** Trust internal code; validate and
surface errors at system boundaries (NATS I/O, user-supplied config,
wire decoding). Never fail silently. Provide actionable context —
what failed, why, what the user can do.

**Fix gaps, don't just flag them.** When reviewing your own work — a
handoff, a spec, a diff, a test — and you spot a minor inaccuracy or
missing piece, patch it in the same turn. Flagging-but-not-fixing is
cheap for the writer and expensive for the next reader.

## UX / DevX

The SDK is a product used by agent harness authors (Hermes,
claude-code, openclaw, …). Every API and error message either guides
them to success or frustrates them.

- **Be explicit, not vague.** Bad: "registration failed." Good:
  "could not register service `agents` for agent=`my-runtime`
  owner=`acme` session=`default`: another instance is already serving
  this exact subject (queue group `agents`); did you mean to start a
  second worker for load-balancing? It will share the queue group
  automatically — no config change needed."
- **Progressive disclosure.** Essential info first (what happened,
  what to do next); technical detail available but not upfront.
- **Partial-success honesty.** If a service registered but heartbeat
  publishing failed, surface both states — don't pretend the agent is
  fully online.
- **Validate the `agent` identifier loudly at construction time.**
  An invalid identifier is the single most likely first-run mistake;
  the error must point at the §2 rule and offer a corrected example.

## Alignment milestones

- **2026-04-30 — package carved out of `synadia-ai-agents` at the
  0.5.0 cut.** The surface (`AgentService` and friends) lived in
  `synadia-ai-agents` through 0.4.x; at 0.5.0 it was removed there
  and shipped here as 0.1.0. `service.py`, the publisher half of
  `heartbeat.py`, the status
  handler, `examples/_reference_agent.py`, and the agent-side e2e
  tests all moved here under `synadia_ai.agent_service`; imports
  were rewired to pull shared primitives from `synadia_ai.agents`
  (no duplication). `AgentService` and friends were dropped from
  `synadia_ai.agents.__all__` in the client-sdk, with a `[0.5.0]`
  CHANGELOG entry there explaining the new import path. A parallel
  `release-python-agent-service.yml` workflow was added, mirroring
  the post-merge shape of the client-sdk's trusted-publishing setup
  (PR #28); tag prefix is `python-agent-service-v*`. The
  pending-publisher PyPI registration and the first publish are
  user-gated follow-ups.
- **Wire-version history is shared with the client-sdk.** This
  package ships the same protocol version `"0.3"` as
  `synadia-ai-agents` and bumps in lockstep with it — there is no
  agent-sdk-specific wire history. For protocol-version changes
  (v0.1.0 alignment, v0.2.0 service-name + queue-group bump, v0.3.0
  verb-first subjects + status endpoint, the 2026-04-28 session-name
  collapse), see `client-sdk/python/CLAUDE.md`'s "Alignment
  milestones" section. When the spec next bumps, the change lands in
  *both* packages in lockstep, with the client-sdk PR going first
  (since this package depends on it for shared types).
