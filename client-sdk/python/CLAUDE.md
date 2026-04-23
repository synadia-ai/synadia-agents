# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working
with code in this repository.

## Project

This repo is a **Python SDK for the NATS Agent Protocol** — a transport
library that Python agent authors embed to add NATS as a communication
channel. Example consumer: a Hermes-style agent would use this SDK to
expose itself as a protocol-compliant agent over NATS.

**The SDK is the transport, not the harness.** In the protocol, `agent`
identifies the *agent runtime/framework* (e.g. `claude-code`, `openclaw`,
`hermes`). The SDK MUST require implementers to supply their own `agent`
identifier when constructing an `Agent` and MUST validate it against §2
(lowercase alphanumeric + hyphens). **No default.** Never register agents
under a generic `pysdk` value — that would pollute the subject namespace
and break `agent`-scoped discovery.

**The protocol spec is the source of truth.** Canonical location:
[`synadia-ai/nats-agent-sdk-docs/core-protocol.md`](https://github.com/synadia-ai/nats-agent-sdk-docs/blob/main/core-protocol.md)
(sibling checkout at `../../../nats-agent-sdk-docs/core-protocol.md`
when working locally — that repo sits next to the `synadia-agents/`
monorepo checkout). This subdir no longer keeps a copy — always read
the canonical. The implementation checklist in §12 is what "compliant"
means.

**Wire compatibility with the TypeScript SDK** at `../typescript/` is
a hard requirement. Both SDKs are validated against each other via
`tests/test_interop_e2e.py`. When the spec is silent and the two SDKs
pick a default, they MUST pick the same default — drift is tracked in
`docs/protocol-mapping.md` under "Open questions flagged upstream".

## Protocol surface at a glance

v0.2 wire shapes the SDK implements (full detail in `docs/protocol-mapping.md`):

- **Subject hierarchy**: `agents.{agent}.{owner}.{name}` plus
  `.heartbeat` sub-subject. `.attachments` is reserved for a future §5.5
  endpoint. Tokens with non-NATS-safe characters are base64-url-no-padding
  escaped internally — an SDK implementation detail, not a protocol
  contract (see `src/natsagent/subjects.py::_sanitize`).
- **Service registration** (§3): every agent registers as a NATS micro
  service named `agents` with `metadata = {agent, owner,
  protocol_version = "0.2", session?}`. The `prompt` endpoint MUST be
  registered with queue group `"agents"` (§3.3) — the framework default
  differs between SDKs, so we pin the spec value explicitly. The service
  name is shared across all compliant agents — callers filter by this
  single value.
- **Request envelope** (§5.1): `{prompt: str, attachments?: [{filename,
  content: <base64>}]}`. Plain-text request payloads are promoted to
  `{"prompt": <text>}` (§5.3).
- **Response stream** (§6): typed `{type, data}` chunks in publication
  order, terminated by a zero-byte body with no NATS headers.
- **Mid-stream queries** (§7): agent-initiated questions via
  `PromptStream.ask`; caller replies via `Query.reply`.
- **Heartbeat** (§8.3): `{agent, owner, session?, instance_id, ts,
  interval_s}` on `agents.{a}.{o}.{n}.heartbeat`.
- **Errors** (§9): `Nats-Service-Error-Code` header + optional JSON body;
  error-completed streams end with error frame THEN empty terminator.

## Toolchain

- **Python 3.11 minimum**, tested on 3.11 / 3.12 / 3.13 in CI. 3.10 goes
  EOL Oct 2026; 3.11 unlocks `Self`, `tomllib`, modern unions.
- **`uv` for everything.** Don't use `pip`, `poetry`, or `virtualenv`
  directly.
  - `uv sync` to install; `uv add <pkg>` / `uv add --dev <pkg>` for deps.
  - `uv run <tool>` to invoke (e.g. `uv run pytest`).
- Type hints everywhere; Pydantic v2 models for wire schemas; `asyncio`
  + `nats-py` for I/O. All timestamps UTC ISO 8601.

### External prereqs

- **`nats-server`** on `$PATH`. e2e tests spawn a fresh server per pytest
  session via `tests/harness/nats_server.py`; unit tests don't need it.
  The fixture `pytest.skip`s cleanly if the binary is absent.
  - macOS: `brew install nats-server`.
  - Linux: pin a version and `curl -L .../nats-server-v${VERSION}-linux-amd64.tar.gz`.
- **`bun`** + the monorepo's `../typescript/` sibling — required only
  for `tests/test_interop_e2e.py`, which spawns the TS SDK's reference
  agent and asserts the Python client can discover + prompt it on the
  same wire. Since the TS SDK lives next to this one inside the
  monorepo, the only one-time setup is populating its `node_modules/`:

      cd ../typescript && bun install

  If any prereq is absent (`bun` missing, sibling subdir unexpectedly
  absent, `node_modules/` not populated), the two interop tests
  `pytest.skip` with a pointed reason — they surface as `SKIPPED [2]`
  in the summary (pytest is configured with `-ra`, so the skip reason
  prints). Running the suite without TS interop is fine for day-to-day
  work; the wire-shape guardrail just becomes best-effort until a
  contributor with `bun` runs the full matrix.
- **`nats` CLI** (optional, for manual poking).

### Connecting to NATS

Agent authors and callers open a connection via `natsagent.connect()`
rather than calling `nats.connect()` directly. Three variants, mutually
exclusive on `nc=`:

```python
# 1. Direct URL(s)
nc = await natsagent.connect(servers="nats://127.0.0.1:4222")

# 2. Load a `nats` CLI context (~/.config/nats/context/<name>.json).
#    `context=True` or `context="current"` honours $NATS_CONTEXT →
#    `context.txt` pointer written by `nats context select`.
nc = await natsagent.connect(context="prod")
nc = await natsagent.connect(context=True)

# 3. Passthrough: return a caller-owned NATSClient as-is.
nc = await natsagent.connect(nc=existing_nc)
```

Context-field support matches the TS SDK v0.1.0: `url`, `token`,
`user`/`password`, `creds` (with `~` expansion), `user_jwt`,
`inbox_prefix`, `description`. `nkey`, TLS triple, and `nsc://...` URLs
raise `ContextNotSupportedError` with an actionable message — they are
not silently ignored. The SDK itself does NOT read `NATS_URL`; that
stays a convenience default inside `examples/`.

### Examples vs scripts

- `examples/` — user-facing demos ported one-for-one from the TS SDK:
  `_reference_agent.py`, `01-discover.py` through `05-liveness.py`. A
  user comparing the two SDKs should find the same demo set on both
  sides. Every numbered example honours `--context <name>` / `--url
  <url>` / `$NATS_URL` / selected-context resolution via the shared
  `examples/_connect_cli.py` helper.
- `scripts/` — dev diagnostics, not installed with the package.

### Canonical commands

```shell
uv sync                              # install dependencies
uv run ruff check .                  # lint
uv run ruff format --check .         # formatting check (drop --check to apply)
uv run mypy src tests examples       # strict type check
uv run pytest -v                     # full suite; e2e auto-skip if nats-server missing
uv run python scripts/demo_echo.py   # echo agent for manual poking
uv run python examples/01-discover.py --url nats://127.0.0.1:4222  # user-facing demos
uv build                             # build sdist + wheel to dist/
ls tests/_evidence/                  # last run's per-test wire traces
```

Per-test evidence lives under `tests/_evidence/<nodeid>/` (gitignored):
`messages.jsonl` (pub/sub wire trace), `chunks.jsonl` (per-stream
response chunks), `srv-info.json`, `heartbeat.json`, etc. The
session-scoped `nats-server` log sits alongside at
`tests/_evidence/_nats-server-logs/`. Read these when a test fails or
when you need to verify protocol compliance by eye.

When project structure or concrete commands change, update this file.

## Testing — no-bullshit, concrete evidence

Tests must produce **concrete, inspectable evidence** — not just green
checkmarks. A passing test that proves nothing is worse than no test.

- Prefer integration tests that run against a **real NATS server**.
  Mocking the broker defeats the point of an SDK test.
- Capture evidence in artifacts: message logs, subject traces,
  chunk-by-chunk stream transcripts. A test for streaming should be
  able to show the actual chunk sequence and the terminating empty
  payload — in a log file or captured fixture — not just assert a
  final string.
- When a test asserts protocol behavior (e.g. "agent registers with
  correct metadata"), the evidence should be the actual `$SRV.INFO`
  response recorded to a log, so a human can verify compliance by
  reading it.
- Flaky tests get fixed or deleted, never papered over with `sleep()`.
  Use deterministic waits (await a specific message, poll with a
  timeout+condition).
- Diagnostic scripts that exercise a live agent against a live NATS are
  first-class — keep them in `scripts/`, not one-off shells.
- **Cross-SDK interop**: when wire shape changes, add a matching
  assertion to `tests/test_interop_e2e.py` (or verify it still passes).
  A change that passes the Python suite but fails TS interop is a bug.

## Critical operational rules

**Never retry a failed command.** Read the error, understand it, then
either fix the cause or try a genuinely different approach. Re-running
the same failing command is never the answer.

**Always verify command output — never assume success.** After any
command, script, or API call, read the actual output and confirm it
succeeded. Check for error messages, unexpected status codes, partial
failures, rate-limit rejections. "It ran without crashing" ≠ "it worked
correctly." For multi-step scripts, every step's response must be
checked — one 429 or 500 in the middle means the whole result is suspect.

**No inline scripts, no one-liners for real work.** The temptation at
end-of-task to bang out a `python -c "..."` or chain six commands with
`&&` to "just verify" is where sloppy failures happen. Rule: **anything
that touches NATS, a database, or non-trivial state goes in a proper
script file first, then gets executed.** If it's reusable, add it to
the project's diagnostic CLI. If it's one-off, drop a short script in
`scripts/`.

**Pre-push verification must bypass ruff/mypy caches.** `ruff`
aggressively caches per-file results and can mark a file "clean" after
a fresh checkout or config change even when the current rule set would
flag it — meaning CI (which always starts cold) fails on a commit that
passed locally. Before pushing, run lint and type checks with caches
disabled:

```bash
uv run ruff check --no-cache .
uv run ruff format --check .            # format is not cache-sensitive
uv run mypy --no-incremental src tests examples
uv run pytest
```

The `Development` one-liner in `README.md` is the cache-on version for
inner-loop speed; the `--no-cache` / `--no-incremental` variant above
is the pre-push gate. If CI fails on a lint rule that passed locally,
assume cache staleness and re-run with the flags above before anything
else.

## Work execution

Use `TaskCreate`/`TaskUpdate` for non-trivial work. Update status as you
go; don't batch.

Commit early, commit often. Prefer small focused commits over one big
omnibus. Wire-format changes reference the spec section(s) in the
subject line (e.g. `wire: heartbeat carries instance_id (§8.3)`) — see
recent `git log --oneline` for the in-repo style.

## Engineering principles

**Quality over velocity.** Never rush at the expense of correctness.
Design for maintainability, not just immediate functionality. When in
doubt, do it right rather than fast.

**Reusable foundations over copy-paste.** Build shared primitives
(envelope codec, chunk decoder, test harness) once, then reuse. Three
occurrences is the threshold for abstraction — not one, not zero.

**Observability from the start.** Every subsystem should be debuggable
when it misbehaves in the field. Structured logging, traceable message
IDs, introspectable state.

**Error handling at boundaries.** Trust internal code; validate and
surface errors at system boundaries (NATS I/O, user-supplied config,
wire decoding). Never fail silently. Provide actionable context — what
failed, why, what the user can do.

**Fix gaps, don't just flag them.** When reviewing your own work — a
handoff, a spec, a diff, a test — and you spot a minor inaccuracy or
missing piece, patch it in the same turn. Flagging-but-not-fixing is
cheap for the writer and expensive for the next reader: a note in a
conversation dies with the context window; a fix in the file persists.
Reserve questions for genuine judgment calls (scope, priority, whether
a change is worth making); mechanical corrections aren't judgment calls.

## UX / DevX

The SDK is a product used by agent authors. Every API and error message
either guides them to success or frustrates them.

- **Be explicit, not vague.** Bad: "connection failed." Good: "could not
  connect to nats://localhost:4222 (connection refused) — is
  `nats-server` running? Tried for 5s."
- **Progressive disclosure.** Essential info first (what happened, what
  to do next); technical detail available but not upfront.
- **Partial-success honesty.** If something half-worked, show exactly
  what worked and what didn't.

## Alignment milestones

- **2026-04-22 — v0.2.0 wire bump.** Aligns with NATS Agent Protocol
  v0.2: service name `SynadiaAgents` → `agents` (§3.1); discovery
  subjects rebased to `$SRV.{PING,INFO}.agents` (§4.1/§4.2); `prompt`
  endpoint now registered with queue group `"agents"` (§3.3);
  `metadata.protocol_version` bumps to `"0.2"`. Envelope.session
  re-labelled as §5.6-tolerated SDK convention (v0.2 §5.1 no longer
  defines the field). TS SDK is still on v0.1 at the time of this bump
  — `tests/test_interop_e2e.py` is xfail'd until it catches up. See
  `CHANGELOG.md` for full migration notes.
- **2026-04-21 — v0.1.0 alignment PR (`align-core-protocol-0.1`).** Full
  spec compliance: service name `SynadiaAgents`; `{agent, owner,
  protocol_version, session?}` metadata; §2.1 endpoint caps; §5.4
  pre-publish validation; §8.3 `instance_id`-bearing heartbeat; §6.5
  strict terminator; plain-text shorthand forbidden on response side
  (§6.2). Cross-SDK interop test against TS SDK reference agent landed.
  API rename `platform` → `agent`, `TextPart`/`FilePart` removed,
  `session` support added. See `CHANGELOG.md` for full migration notes.
