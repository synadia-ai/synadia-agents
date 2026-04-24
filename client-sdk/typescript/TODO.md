# TODO - tracked follow-ups

Items we've deliberately deferred past `0.1.0`. Each has context so future work
doesn't have to re-derive the decision.

## Protocol spec questions to raise upstream

From planning + implementation:

1. `max_payload` numeric base - 1024 vs 1000. Spec §2.1 is silent. We use
   1024 (matches `nats-server` config conventions).
2. Size-unit case sensitivity - spec §2.1 is silent. We parse
   case-insensitive.
3. Whether SDKs SHOULD emit a synthetic `status: done` at stream end -
   spec §6.4 permits but doesn't recommend. We always emit.

Open these when convenient after publishing `0.1.0-beta.1` so other SDK
authors converge on the same answers.

## Python SDK drift (coordination)

Flag once this SDK is tested & published:

- Service name: Python SDK registers with the instance name, not
  `"agents"` (spec §3.1) - breaks cross-SDK discovery.
- Metadata field `protocol` vs `protocol_version` - Python uses the
  shorter form; spec §3.2 requires `protocol_version`.
- Envelope shape - Python ships `{parts: [...]}` where the spec is now
  `{prompt, attachments}` (post-doc-refresh).
- Heartbeat payload missing `instance_id` - multi-instance tracking is
  broken without it (§3.3, §8.3).

## Agent-hosting surface (planned for 0.2)

`@synadia/agents` today is client-only. A future release adds an
agent-hosting side so TS authors can build protocol-compliant agents
without re-implementing service registration + chunk framing by hand.

Scope sketch:

- `hostAgent({ nc, agent, owner, name, session?, maxPayload, attachmentsOk, onPrompt })` -
  wraps `@nats-io/services`, installs the heartbeat publisher, enforces
  request-side validation.
- `PromptRequest` handle with `.respond(text | chunk)`, `.ask(prompt) → answer`,
  `.attachments` - mirrors the client's StreamMessage shape.
- Reference implementation: promote `src/testing/reference-agent.ts` into
  the production `host*` API and keep `ReferenceAgent` as a thin
  test-focused wrapper.

## Browser build

Architecture is ready (pure core is transport-agnostic; lint rule enforces
it). Ship when a browser consumer asks - needs:

- Transport swap: `@nats-io/transport-ws` instead of `@nats-io/transport-node`.
- `src/prompt/attachments.ts` needs a browser variant that uses `File` /
  `Blob` instead of `node:fs/promises`.
- Base64 already runtime-agnostic (`src/prompt/envelope.ts`).
- Tests against a WebSocket-enabled `nats-server`.

## Attachments upload endpoint (spec §5.5, ≥ 0.2)

Spec reserves the subject today and sketches intent for a
request-side-streaming upload path. When the spec finalizes, add the
corresponding send path. Not a blocker for 0.1.
