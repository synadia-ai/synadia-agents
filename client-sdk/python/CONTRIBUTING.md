# Contributing to synadia-ai-agents

Thanks for wanting to contribute! This project is the Python SDK for the
Synadia Agent Protocol for NATS; the wire spec at
[`synadia-ai/nats-agent-sdk-docs/core-protocol.md`](https://github.com/synadia-ai/nats-agent-sdk-docs/blob/main/core-protocol.md)
is the source of truth, and [`docs/protocol-mapping.md`](docs/protocol-mapping.md)
shows how every SDK call maps to a spec section. When in doubt about
what the code should do, check the spec.

## Setup

Prereqs:

- **Python 3.11+** (3.11, 3.12, and 3.13 are covered by CI).
- **[uv](https://docs.astral.sh/uv/)** for dependency and venv management.
- **[`nats-server`](https://docs.nats.io/running-a-nats-service/introduction/installation)**
  on `PATH`. Integration tests spawn one per test session; skip cleanly
  if absent.
- **[`bun`](https://bun.sh)** + sibling `../typescript/` checkout with
  `node_modules/` populated, for cross-SDK interop tests. Optional -
  `tests/test_interop_e2e.py` skips if any of these is missing.

```bash
git clone https://github.com/synadia-ai/synadia-agents
cd synadia-agents/client-sdk/python
uv sync
```

## Local workflow

```bash
uv run pytest                            # unit + e2e
uv run pytest -k envelope                # single module / case
uv run ruff check .                      # lint
uv run ruff format .                     # apply formatting
uv run mypy src tests examples           # strict type check
uv build                                 # build sdist + wheel to dist/
```

The full check sequence before pushing - with caches disabled so a
stale ruff/mypy cache can't hide a regression that CI will hit on a
cold checkout:

```bash
uv run ruff check --no-cache . && uv run ruff format --check . && \
  uv run mypy --no-incremental src tests examples && uv run pytest
```

CI runs this on every PR across Python 3.11 / 3.12 / 3.13 and fails on
any non-green step.

## Evidence recorder

Every integration test writes wire-level evidence to
`tests/_evidence/<test-nodeid>/`:

- `messages.jsonl` - every NATS message published during the test
  (agents + discovery + heartbeats).
- `chunks.jsonl` - decoded response-stream items yielded to the client
  iterator.
- Per-test extras: `srv-info.json`, `heartbeat.json`, `wire.jsonl`, etc.

When a test fails, these files are the first place to look. They're
gitignored by default; the repo includes them under
`tests/_evidence/.gitignore` so the directory stays tracked but its
contents don't pollute diffs.

## Pull requests

### Scope

Keep PRs focused. A PR that mixes a wire-format fix with a refactor and
a doc pass is hard to review and hard to revert. If you find yourself
wanting to bundle, open the work as multiple PRs against the same
branch.

### Commit style

- Present-tense, imperative: "`fix`", "`add`", "`rename`", not "fixed",
  "added", "renamed".
- Lowercase scope prefix separated by a colon: `wire: ...`, `client: ...`,
  `tests: ...`, `docs: ...`, `release: ...`.
- For wire changes, reference the spec section(s) in the subject line:
  e.g. `wire: heartbeat carries instance_id (§8.3)`.
- Body: explain **why**, not **what**. The diff shows what. If a fix is
  non-obvious, describe the failure mode it addresses.
- Sign off with `Co-Authored-By:` when co-authored. Keep trailers in the
  final commit block.

Look at recent `git log --oneline` for the in-repo style.

### Tests

Every behavioural change needs coverage:

- **Wire format** changes: a unit test on the encoder/decoder AND an
  e2e test that asserts the change on `nats-server` round-trip bytes.
- **API surface** changes: a test that exercises the new shape from the
  outside.
- **Bug fixes**: a regression test that fails before the fix.

Docs-only and pure-refactor PRs are the only exception.

### Protocol spec

If you find the implementation contradicts the
[canonical spec](https://github.com/synadia-ai/nats-agent-sdk-docs/blob/main/core-protocol.md),
the implementation is wrong - open an issue or PR against the code.

If you find the spec is ambiguous and the TS SDK at
`../typescript/` picks a different default than this one, the two
have drifted - flag it on the PR and both SDKs should land a coordinated
fix. The interop test at `tests/test_interop_e2e.py` catches drifts that
actually break cross-implementation talk.

If you believe the spec itself is wrong, open an issue in the
[`synadia-ai/nats-agent-sdk-docs`](https://github.com/synadia-ai/nats-agent-sdk-docs)
repo first; the SDK follows the spec.

## Reporting bugs and requesting features

Use the [issue templates](.github/ISSUE_TEMPLATE/). For security issues
please follow [`SECURITY.md`](SECURITY.md) instead of opening a public
issue.

## License

By contributing, you agree your contributions are licensed under the
[Apache License 2.0](LICENSE) - the same license as the rest of the
project.
