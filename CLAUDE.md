# CLAUDE.md

This file orients Claude Code when working anywhere in this repo. For
language-specific deep dives, defer to the package-level CLAUDE.md (e.g.
`client-sdk/python/CLAUDE.md`) and to per-package READMEs.

## What this repo is

The home for everything around the **Synadia Agent Protocol for NATS** — language
SDKs that callers use, agent plugins that host the protocol, and example
apps that exercise both. The root `README.md` covers the user-facing
view: layout, subject namespace, wire shape, quickstart. Read it before
making changes that touch user-visible surface.

The protocol spec is **not vendored here**. Canonical source:
[`synadia-ai/synadia-agent-sdk-docs`](https://github.com/synadia-ai/synadia-agent-sdk-docs)
— always link to the GitHub URL when reasoning about wire shape. Local
`docs/protocol-mapping.md` files inside each SDK translate spec → impl;
they are not the spec itself.

## Reference agents — canonical implementations

Every SDK in this repo ships a spec-compliant **reference agent** that
implements the full §12 agent-checklist (service registration, prompt
endpoint, status endpoint, heartbeats on `agents.hb.*.*.*`, terminator
semantics). When reasoning about wire shape, expected on-the-wire
behaviour, or testing a new SDK / agent, read these first — they are
the authoritative on-the-wire counterpart to the spec doc.

- **TypeScript**: `agent-sdk/typescript/src/testing/reference-agent.ts`
  — the `ReferenceAgent` class, importable from third-party packages
  via `@synadia-ai/agent-service/testing` (post-SDK-split — pre-split
  it lived under `@synadia-ai/agents/testing`). Runnable script:
  `client-sdk/typescript/examples/_run-reference-agent.ts`.
- **Python**: `agent-sdk/python/examples/_reference_agent.py` — a
  runnable echo agent with conversation memory, used as the test
  harness for the numbered demos and as a wire-compat counterparty.
  (Moved with the host-side split into `synadia-ai-agent-service`; pre-
  split it lived under `client-sdk/python/examples/`.)

Each SDK also has a parallel set of numbered demo scripts that exercise
discovery, prompting (text + attachments), mid-stream queries, and
liveness against the reference agent — useful both as documentation
and as a smoke surface:

- TS: `client-sdk/typescript/examples/01-discover.ts` … `05-liveness.ts`,
  plus `06-chat.ts` (interactive REPL).
- Python: `client-sdk/python/examples/01-discover.py` … `05-liveness.py`,
  plus `06-chat.py` (interactive REPL). See
  `client-sdk/python/examples/README.md` for the full table.

The Python interop test (`client-sdk/python/tests/test_interop_e2e.py`)
runs the TS reference agent as a subprocess and validates wire
compatibility between the two SDKs.

## Repository layout (and what's published)

| Path | Package | Published as | Notes |
| --- | --- | --- | --- |
| `client-sdk/typescript/` | `@synadia-ai/agents` | npm (public) | TS SDK — Node/Bun callers |
| `client-sdk/python/` | `synadia-ai-agents` (import: `synadia_ai.agents`) | PyPI | Python SDK — has its own CLAUDE.md |
| `agents/pi/` | `@synadia-ai/nats-pi-channel` | npm (public) | PI extension plugin |
| `agents/openclaw/` | `@synadia-ai/nats-channel` | npm (public) | OpenClaw plugin |
| `agents/claude-code/` | `claude-channel-nats` | npm (public) | Claude Code MCP plugin |
| `agents/hermes/` | — | not in repo | README only; ships from upstream Hermes |
| `agents/flue/` | `@synadia-ai/flue-nats-channel` | npm (public) | Flue sidecar channel |
| `agents/opencode/` | `@synadia-ai/opencode-nats-channel` | npm (public) | OpenCode plugin channel |
| `agents/codex/` | `@synadia-ai/codex-nats-channel` | npm (public) | Codex app-server-backed channel |
| `agents/acp/` | `@synadia-ai/acp-nats-channel` | npm (public) | Generic ACP channel (grok, gemini, custom) |
| `agents/grok/` | `@synadia-ai/grok-nats-channel` | npm (public) | Grok Build front door — thin pin over `agents/acp` |
| `examples/pi-headless/` | `@synadia-ai/nats-pi-headless` | npm (public) | depends on `@synadia-ai/agents@^0.5.x` |
| `examples/agent-web-ui/` | `@synadia-ai/nats-ai-testui` | github only | local-clone test client; `private: true` so it never publishes |
| `examples/dspy/` | `@synadia-ai/nats-dspy-agent` | private | uses `file:` link to local SDK |

**No root `package.json`, no workspace manager.** Each subtree manages
its own deps and tooling. Examples that ship to npm pin the SDK by
semver range (`^0.1.x`); private/dev-only examples (currently just
`dspy`) use `file:../../client-sdk/typescript`.

**Agents _should_ reuse the SDK package where it helps.** The SDK
(primarily the TS one) has accumulated meaningful shared logic —
framing, validation, helpers — and the direction of travel is an SDK
that covers **both client and agent sides** of the protocol. If an
agent harness needs functionality the SDK already provides, prefer
adding `@synadia-ai/agents` to its `package.json` and importing from
there over inlining or copy-pasting.

This is a reversal of the prior rule that agents must stay on raw
`@nats-io/*`. That rule no longer applies — duplicated hand-written
code in the agent harnesses is now technical debt, not a deliberate
boundary.

Caveat: this is a forward-looking rule, not a retroactive sweep. The
existing agents (`agents/pi/extensions/nats-channel.ts`,
`agents/claude-code/server.ts`, `agents/openclaw/`) still use
`@nats-io/transport-node` and `@nats-io/services` directly. Migrating
them is opportunistic — do it when you're already in the file for
another reason, or when the duplication actively bites. Don't open a
standalone "convert agent X to the SDK" PR without checking with the
user first.

## Protocol vs package versions — don't read skew

Two distinct version axes:

- **Wire protocol version** — `0.3` everywhere right now.
  - TS: `SDK_PROTOCOL_VERSION = { major: 0, minor: 3 }` in
    `client-sdk/typescript/src/version.ts`.
  - Python: `_PROTOCOL_VERSION = "0.3"` in
    `agent-sdk/python/src/synadia_ai/agent_service/service.py`
    (host-side after the Python split landed in PR #45).
  - Agent harnesses derive the string from the SDK's
    `SDK_PROTOCOL_VERSION` rather than hard-coding it (see
    `agents/pi/extensions/nats-channel.ts`,
    `agents/claude-code/server.ts`,
    `agents/openclaw/src/gateway.ts`). If the spec ever bumps, change
    the SDK constants in both languages and the harnesses pick it up
    automatically.
- **Package version (npm/PyPI)** — independent per SDK pair.
  - TS: `@synadia-ai/agents` + `@synadia-ai/agent-service` — both at
    `0.4.0` in lockstep, neither published to npm yet.
  - Python: `synadia-ai-agents` (`0.6.0`) +
    `synadia-ai-agent-service` (`0.2.0`) — both published to PyPI;
    versions diverge per package.

The package versions differ for historical reasons. They are **not** a
protocol skew. The Python `tests/test_interop_e2e.py` runs the TS
reference agent as a subprocess and validates wire compat — it
`pytest.skip`s only when `bun` isn't on PATH (a prereq check, not an
xfail).

## Ripple-check before declaring a change "done"

Most regressions in this repo come from forgetting that work in one
subtree affects another. Before finishing a change, walk the list:

- **Touched the TS SDK public surface** (`client-sdk/typescript/src/index.ts`
  exports, error classes, helpers)?
  - Update `client-sdk/typescript/CHANGELOG.md` under `[Unreleased]`.
  - Search for `from "@synadia-ai/agents"` in `examples/` — anything
    affected by the change?
  - Update `client-sdk/typescript/README.md` if the change is part of
    the documented quickstart / API matrix.
  - If examples need the change, follow the **release ladder** below.
- **Touched the Python SDK public surface**?
  - Update `client-sdk/python/CHANGELOG.md`.
  - Re-read `client-sdk/python/CLAUDE.md` — it has stricter rules
    (`agent` identifier, default registration, etc.) than the root
    guidance here.
- **Touched wire format / protocol behavior** in either SDK or any
  agent?
  - Update the **other** SDK to match. Wire compat between TS and
    Python is a hard requirement; the interop test catches drift.
  - Update every agent harness that hard-codes the protocol version
    string.
  - Re-read the spec at `synadia-ai/synadia-agent-sdk-docs` — the spec
    doc, not the local `protocol-mapping.md`, is the source of truth.
- **Touched an agent harness** (`agents/*`)?
  - Update its README if user-visible config / subject layout changed.
  - Don't reach for the SDK package — agents stay on raw `@nats-io/*`.
- **Touched an example**?
  - Update the example's README if its CLI / config / quickstart
    changed.
  - If the example consumes a new SDK feature, you need a published
    SDK version first (see release ladder).

If you're unsure whether you touched something load-bearing, search for
references to the file or symbol you changed (`grep -r`, or ask an
Explore agent for cross-cutting cases). When in doubt, document the
change in the relevant `CHANGELOG.md` and call it out in the PR
description.

## Release ladder for SDK changes that examples need

The trap: published examples (`pi-headless`, `claude-code-headless`) pin
`@synadia-ai/agents@^0.4.x` from npm, not via `file:` links. A new SDK
export does not exist for them until it is **published**. Don't try to
land an example migration alongside an unpublished SDK change — typecheck
will fail in CI, and you'll waste a force-push fixing it.

Sequence:

1. Land the SDK change on `main` (own PR, reviewer bot, merge).
2. Cut the release: bump `client-sdk/typescript/package.json` version,
   add a `CHANGELOG.md` entry under the new version heading, open a PR,
   merge.
3. Get **explicit user approval** before `npm publish` — every publish
   invocation is a separate gate, run by whoever has `@synadia-ai/*`
   publish rights on their machine. Don't batch and don't assume which
   identity is logged in.
4. After publish: open the example-migration PR, bump
   `examples/*/package.json` to the new SDK semver, refresh `bun.lock`,
   verify `bun run typecheck` in each example.
5. Merge the example-migration PR.

The same shape applies to each Python SDK. Releases are tag-driven
and publish to PyPI via `pypa/gh-action-pypi-publish` (trusted
publishing — no long-lived API token):

- `python-v*` → `synadia-ai-agents` via `release-python.yml`
- `python-agent-service-v*` → `synadia-ai-agent-service` via
  `release-python-agent-service.yml`

Both workflows run in the `pypi` GitHub Environment, whose
tag-deployment policy gates them to those two prefixes. **Gotcha
when adding a new tag-triggered release workflow:** the `pypi` env
policy must be extended to cover the new tag prefix, or the
publish job fails with *"Tag X is not allowed to deploy to pypi
due to environment protection rules"* before OIDC ever runs. Add
it via:

```sh
gh api -X POST repos/synadia-ai/synadia-agents/environments/pypi/deployment-branch-policies \
  -f name='new-prefix-v*' -f type=tag
```

(Repo Admin required. Sanity check:
`gh api repos/synadia-ai/synadia-agents --jq '.permissions.admin'`
should print exactly `true`. Anything else means no admin in the
current auth context — `false` is a real "you don't have it,"
while `null` typically means a fine-grained PAT or GitHub App
token that doesn't surface the permissions sub-object at all.)

## CI and the Claude reviewer bot

- **Per-SDK workflows** under `.github/workflows/`:
  - `client-sdk-typescript.yml` — lint, typecheck, unit + integration
    tests across Node 20/22/24 and Bun 1.2/latest; runs jobs in
    `client-sdk/typescript/`.
  - `agent-sdk-typescript.yml` — same matrix; runs jobs in
    `agent-sdk/typescript/`.
  - Both TS workflows fire on changes under **either**
    `client-sdk/typescript/**` or `agent-sdk/typescript/**`, since the
    host package depends on the caller and the two are kept in lockstep.
  - `client-sdk-python.yml` — ruff, mypy, pytest across Python
    3.11/3.12/3.13 in `client-sdk/python/`. Triggers only on
    `client-sdk/python/**`.
  - `client-sdk-python-agent-service.yml` (filename prefix is
    historical) — same matrix in `agent-sdk/python/`. Triggers on
    `agent-sdk/python/**` *and* `client-sdk/python/**`, because the
    agent-sdk's tests resolve `synadia-ai-agents` to the local
    client-sdk checkout via `[tool.uv.sources]`.
  - `release-python.yml` — publishes `synadia-ai-agents` to PyPI on
    `python-v*` tags.
  - `release-python-agent-service.yml` — publishes
    `synadia-ai-agent-service` to PyPI on `python-agent-service-v*`
    tags.
- **No automated TS publish workflow.** TS releases are manual (see
  release ladder). The TypeScript agent CI workflow validates npm package
  contents, but it does not publish `@synadia-ai/*` packages.
- **`claude.yml`** runs the Claude reviewer bot on PRs. Treat its
  inline findings as review feedback to address before merge — they
  catch real issues (path traversal, missing test coverage, formatting
  drift). Acknowledge or address each one; don't ignore.

## Conventions worth knowing

- **`publishConfig.access: "public"`** is set on every publishable
  package. The `@synadia-ai/*` scope is published openly to npm; the
  `claude-channel-nats` package ships via the Claude marketplace
  subtree rather than npm.
- **No `--no-verify`, no `--force` without `--force-with-lease`.** Hooks
  exist for a reason.
- **Don't amend or force-push to other contributors' PR branches**
  unless explicitly authorized — open a parallel PR that supersedes
  instead. The repo allows it (same-org branches), the harness blocks
  it by default.
- **Prefer PRs over direct-to-`main`** for substantive work. The
  reviewer bot is part of the review loop and only runs on PRs.
- **Pull before making changes.** Multiple humans + AI agents iterate
  here on tight cycles; stale local main produces avoidable conflicts.

## Where to look first

- `README.md` — repo overview, layout, subject namespace, wire
  shape.
- `agent-sdk/typescript/src/testing/reference-agent.ts` and
  `agent-sdk/python/examples/_reference_agent.py` — canonical
  spec-compliant reference agents (see "Reference agents" section
  above). Read these before touching anything wire-shape-y.
- `client-sdk/typescript/examples/` and `client-sdk/python/examples/`
  — parallel numbered demo scripts (`01-discover` …) that exercise
  the SDKs end-to-end against the reference agent.
- `client-sdk/typescript/CHANGELOG.md`, `client-sdk/python/CHANGELOG.md`
  — recent API moves (Keep a Changelog format).
- `client-sdk/python/CLAUDE.md` — package-specific deep guide; mirror
  it if you need the same depth on the TS side.
- `agents/*/README.md` — per-agent config, subject layout, install.
- `examples/README.md` — runnable end-to-end demos in the monorepo
  (browser test client, headless controllers, DSPy ReAct).
