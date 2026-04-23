---
name: Feature request
about: Suggest a capability or API addition
title: "feature: "
labels: enhancement
---

## The problem

_What are you trying to do that the SDK doesn't let you do today?
Concrete use case, not "it would be nice if..."._

## Proposed solution

What API or behaviour would you add? If you've prototyped something,
paste the signature.

## Relationship to the protocol

Does this require a change to the wire spec
([`core-protocol.md`](https://github.com/synadia-ai/nats-agent-sdk-docs/blob/main/core-protocol.md)),
or can it be built entirely on top of what's already defined?

- [ ] Purely SDK ergonomics — no spec change.
- [ ] Uses an existing-but-unimplemented spec feature (name the section).
- [ ] Requires a new spec section (expect an issue upstream at
      [`nats-agent-sdk-docs`](https://github.com/synadia-ai/nats-agent-sdk-docs) first).

## Alternatives considered

What else could solve the problem, and why is this the right trade-off?

## TS SDK parity

Does the TypeScript SDK at `../nats-ai-tssdk/` already expose this?
Keeping the two in lockstep matters — if they disagree, call that out.
