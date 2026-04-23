## Summary

_One to three bullets on what this PR does and why. The diff shows
what; this block should answer "why now"._

- …

## Spec reference

_For wire-level changes, quote the section(s) of
`https://github.com/synadia-ai/nats-agent-sdk-docs` this PR implements or corrects. For
ergonomics-only PRs, delete this block._

- §X.Y - …

## Test plan

_How you verified this works. Copy-pastable commands preferred.
Checkboxes are for your own use before requesting review._

- [ ] `uv run pytest` - all green.
- [ ] `uv run ruff check . && uv run ruff format --check .`
- [ ] `uv run mypy src tests`
- [ ] Manually exercised … (if applicable)

## Interop

_Did you run the cross-SDK interop test? Circle one:_

- [ ] Yes - `tests/test_interop_e2e.py` passed against
      `../typescript/` at commit `<sha>`.
- [ ] Skipped - no wire behaviour changed.
- [ ] Skipped - TS SDK not available in my environment.

## Breaking changes

_0.x permits breaking changes per spec §11.2, but call them out
anyway so the changelog entry is accurate._

- [ ] No breaking changes.
- [ ] Breaking: _describe, and link the CHANGELOG entry._

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
