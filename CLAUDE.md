# CLAUDE.md

This file orients Claude Code when working anywhere in this repo. For
language-specific deep dives, defer to the package-level CLAUDE.md (e.g.
`client-sdk/python/CLAUDE.md`) and to per-package READMEs.

## What this repo is

The home for everything around the **NATS Agent Protocol** — language
SDKs that callers use, agent plugins that host the protocol, and example
apps that exercise both. The root `README.md` covers the user-facing
view: layout, subject namespace, wire shape, quickstart. Read it before
making changes that touch user-visible surface.

The protocol spec is **not vendored here**. Canonical source:
[`synadia-ai/nats-agent-sdk-docs`](https://github.com/synadia-ai/nats-agent-sdk-docs).
Either checkout it as a sibling at `../nats-agent-sdk-docs/` or link to
the GitHub URL when reasoning about wire shape. Local
`docs/protocol-mapping.md` files inside each SDK translate spec → impl;
they are not the spec itself.

## Repository layout (and what's published)

| Path | Package | Published as | Notes |
| --- | --- | --- | --- |
| `client-sdk/typescript/` | `@synadia-ai/agents` | npm (restricted) | TS SDK — Node/Bun callers |
| `client-sdk/python/` | `synadia-ai-agents` (import: `synadia_ai.agents`) | PyPI (not yet published) | Python SDK — has its own CLAUDE.md |
| `agents/pi/` | `@synadia-ai/nats-pi-channel` | npm (restricted) | PI extension plugin |
| `agents/openclaw/` | `@synadia-ai/nats-channel` | npm (restricted) | OpenClaw plugin |
| `agents/claude-code/` | `claude-channel-nats` | npm (restricted) | Claude Code MCP plugin |
| `agents/hermes/` | — | not in repo | README only; ships from upstream Hermes |
| `examples/pi-headless/` | `@synadia-ai/nats-pi-headless` | npm (restricted) | depends on `@synadia-ai/agents@^0.1.x` |
| `examples/agent-web-ui/` | `@synadia-ai/nats-ai-testui` | npm (restricted) | depends on `@synadia-ai/agents@^0.1.x` |
| `examples/dspy/` | `@synadia-ai/nats-dspy-agent` | private | uses `file:` link to local SDK |

**No root `package.json`, no workspace manager.** Each subtree manages
its own deps and tooling. Examples that ship to npm pin the SDK by
semver range (`^0.1.x`); private/dev-only examples (currently just
`dspy`) use `file:../../client-sdk/typescript`.

**Agents do _not_ depend on the SDK package.** They use
`@nats-io/transport-node` and `@nats-io/services` directly because they
implement the server side of the protocol — the SDK is for callers.
Don't propose adding `@synadia-ai/agents` to an agent's `package.json`
just because it has a useful helper; either inline the equivalent logic
(see `agents/pi/extensions/nats-channel.ts` and
`agents/claude-code/server.ts` for prior art) or copy the helper.

## Protocol vs package versions — don't read skew

Two distinct version axes:

- **Wire protocol version** — `0.2` everywhere right now.
  - TS: `SDK_PROTOCOL_VERSION = { major: 0, minor: 2 }` in
    `client-sdk/typescript/src/version.ts`.
  - Python: `_PROTOCOL_VERSION = "0.2"` in
    `client-sdk/python/src/synadia_ai/agents/service.py`.
  - Agent harnesses hard-code the same string (e.g.
    `agents/pi/extensions/nats-channel.ts`,
    `agents/claude-code/server.ts`). If the spec ever bumps, all four
    locations move in lockstep.
- **Package version (npm/PyPI)** — independent per SDK.
  - TS: `@synadia-ai/agents@0.1.x` on npm.
  - Python: `synadia-ai-agents@0.x` — not yet published to PyPI.

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
  - Re-read the spec at `synadia-ai/nats-agent-sdk-docs` — the spec
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

The trap: examples (`pi-headless`, `agent-web-ui`) pin
`@synadia-ai/agents@^0.1.x` from npm, not via `file:` links. A new SDK
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

The same shape applies to the Python SDK, except releases are
tag-driven (`python-v*` tag in `.github/workflows/release-python.yml`)
and publish to PyPI via `uv publish`.

## CI and the Claude reviewer bot

- **Per-SDK workflows** under `.github/workflows/`:
  - `client-sdk-typescript.yml` — lint, typecheck, unit + integration
    tests across Node 20/22/24 and Bun 1.2/latest. Triggers on TS SDK
    changes.
  - `client-sdk-python.yml` — ruff, mypy, pytest across Python
    3.11/3.12/3.13.
  - `release-python.yml` — tag-triggered PyPI publish.
- **No automated TS publish workflow.** TS releases are manual (see
  release ladder).
- **`claude.yml`** runs the Claude reviewer bot on PRs. Treat its
  inline findings as review feedback to address before merge — they
  catch real issues (path traversal, missing test coverage, formatting
  drift). Acknowledge or address each one; don't ignore.

## Conventions worth knowing

- **`publishConfig.access: "restricted"`** is set on every publishable
  package. The `@synadia-ai/*` scope is private; don't flip a package
  to public-access without explicit user direction.
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
- `client-sdk/typescript/CHANGELOG.md`, `client-sdk/python/CHANGELOG.md`
  — recent API moves (Keep a Changelog format).
- `client-sdk/python/CLAUDE.md` — package-specific deep guide; mirror
  it if you need the same depth on the TS side.
- `agents/*/README.md` — per-agent config, subject layout, install.
