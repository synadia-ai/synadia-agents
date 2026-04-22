---
name: Bug report
about: Report an incorrect behaviour in the SDK
title: "bug: "
labels: bug
---

## What happened

_A clear, concrete description. Include error messages verbatim._

## What did you expect

## Reproduction

Minimal code the SDK team can run. Prefer a self-contained snippet over
a link to a full repo.

```python
# paste here
```

## Environment

- `natsagent` version: (e.g. `0.1.0`, or `git rev-parse HEAD` for a source checkout)
- Python version: (`python --version`)
- `nats-server` version: (`nats-server --version`)
- OS / arch: (e.g. `Linux 6.8 x86_64`, `macOS 14 arm64`)

## Relevant logs / wire evidence

If the bug involves a round-trip, the per-test evidence recorder under
`tests/_evidence/<testname>/messages.jsonl` is usually the fastest
artifact for the team to look at. Attach or paste relevant lines.

## Which protocol section (if applicable)

If this is a wire-shape disagreement, which section of
`docs/nats-agent-protocol.md` are you reading the SDK against? Paste the
exact sentence.
