# synadia-ai-agent-service

Python **agent-host** SDK for the [Synadia Agent Protocol for NATS](https://github.com/synadia-ai/synadia-agent-sdk-docs/blob/main/core-protocol.md).
Embed `AgentService` in a Python agent harness (Hermes-style,
claude-code, openclaw, pi, …) to register a spec-compliant agent on a
NATS bus.

> **Calling agents (rather than hosting them)?** → use the sibling
> [`synadia-ai-agents`](../../client-sdk/python/) package
> (`from synadia_ai.agents import Agents, …`). This package depends
> on it for the shared wire primitives.

## Install

```bash
pip install synadia-ai-agent-service
```

This pulls `synadia-ai-agents` automatically. For local development against the sibling checkout:

```bash
uv pip install -e ../../client-sdk/python
uv pip install -e .
```

## Quickstart — host an agent

```python
import asyncio
import nats
from synadia_ai.agents import Envelope                       # shared wire types
from synadia_ai.agent_service import AgentService, PromptStream

async def echo(envelope: Envelope, stream: PromptStream) -> None:
    await stream.send(f"echo: {envelope.prompt}")

async def main() -> None:
    nc = await nats.connect(servers="nats://127.0.0.1:4222")
    service = AgentService(
        agent="demo",            # your harness identifier (§2: lowercase + hyphens)
        owner="alice",           # operator / account (§2)
        session_name="worker-1", # 5th subject token / session this instance serves
        nc=nc,
        description="demo echo agent",
    )
    service.on_prompt(echo)
    await service.start()
    try:
        await asyncio.Event().wait()   # run until Ctrl-C
    finally:
        await service.stop()
        await nc.close()

asyncio.run(main())
```

Harness-specific registration keys (a model name, a role, …) go in
`extra_metadata={"role": "controller"}`. Keys and values must be `str`
(`TypeError` otherwise). The protocol's required keys (`agent`, `owner`,
`session`, `protocol_version`) and the identity keys (`user_nkey`,
`account`, `id_sig`) always win over an extra entry with the same name.

A spec-compliant runnable echo agent ships at
[`examples/_reference_agent.py`](examples/_reference_agent.py) — used
both as the test harness for the client-side numbered demos in
`../../client-sdk/python/examples/` and as the wire-compat counterparty
for cross-SDK interop.

Alongside it, [`examples/`](examples/) carries a numbered **agent
ladder** — `01-echo.py` → `05-tools.py` (echo, Ollama, OpenRouter,
combined, and a tool-calling agent backed by a NATS microservice) —
the Python mirror of `../typescript/examples/`. See
[`examples/README.md`](examples/README.md) for the full table and how
to run them.

## Sender identity

`AgentService` implements the receiver side of the optional sender-identity
extension: every `prompt` request is classified **before** the §6.4 ack,
and the handler sees the result as `stream.sender`.

```python
from synadia_ai.agents import format_sender
from synadia_ai.agent_service import AgentService, PromptStream, ServiceIdentity

service = AgentService(
    agent="echo",
    owner="demo",
    session_name="main",
    nc=nc,
    # host_signer must come from the same credential snapshot that authenticated `nc`.
    identity=ServiceIdentity(signer=host_signer),
    min_sender_trust="signed",  # default "any"
    accept_sender=lambda sender: sender is not None
    and sender.trust == "verified"
    and sender.id in allowlist,
)

async def handler(envelope: Envelope, stream: PromptStream) -> None:
    await stream.send(f"hello from {format_sender(stream.sender)}")
```

| Outcome | Wire |
| --- | --- |
| No `Agent-Sender`, or an unknown `v` | served; `stream.sender is None` |
| Malformed header | `400` |
| Failing signature, replayed nonce, stale `ts`, `sub` not the arrival subject | `401` — in every mode |
| Unsigned / header-less request on a `min_sender_trust: signed` endpoint | `401` (`signature required`) |
| `accept_sender` returns `False` for a verified sender / for a claimed or absent one | `403` / `401` |
| `accept_sender` raises | `500`, logged, never served |
| Verified sender | served; `stream.sender.trust == "verified"`, `.id` is the `AgentId` |
| Unsigned claim | served; `stream.sender.trust == "claimed"` — **no `id`**, never authorize on it |

What to know:

- **Registration is opt-in.** Omit `identity` for no host-identity lookup
  and no `user_nkey`, `account`, or `id_sig` metadata; incoming senders
  are still classified. Pass `ServiceIdentity()` explicitly for
  best-effort unsigned registration, or provide a signer to register
  `id_sig` (`AGENT-ID-V1` over the prompt subject).
  `min_sender_trust` is **always** emitted on the prompt endpoint — its
  presence is what advertises the extension — and never on `status`; it
  defaults to `"any"` independently of host identity. A signer is checked
  against the live connection's user and account; mismatch or unavailable
  binding makes `start()` fail and never downgrades.
  `start()` returns only once the endpoints are registered at the server
  (`flush()`).
- **The verified identity is `user`.** `account` is the sender's signed
  claim; `format_sender` / `str(sender)` renders
  `… (verified user, claimed account)`. Which verified senders to accept
  is authorization — the `accept_sender` hook is where a harness
  consults its provisioned policy.
  The hook runs for every classified prompt (never for `status`), may be
  sync or async; per-request network I/O in it delays the ack and is an
  amplification vector on `any` endpoints. A refused claimed / absent
  sender gets `401 signature required`, which reads as "sign and retry"
  on the wire — a hook cannot express "blocked regardless of signing".
- **Replay protection** is a per-instance nonce set (`replay_window_s`,
  default 30; entries expire at `ts + window`, bounded by a hard cap of
  100 000 entries). Instances behind the `agents` queue group do not
  share it and a restart empties it; the `ts` window bounds both.
- **`status`** is classified and logged (its verified nonce enters the
  shared set), never rejected — a liveness probe must not depend on the
  prober's credentials.
- **Every heartbeat is signed** when a signer is configured: the frame
  carries the `Agent-Sender` header of the extension — `sub` the heartbeat
  subject as published, `ts` the frame's own `ts`, a fresh nonce per beat,
  `sig` over subject · ts · nonce · sha256 of the bytes published — with
  the same signer as `id_sig`. Nothing in the payload changes and a 0.3
  subscriber ignores headers; without a signer the service beats unsigned.
  A consumer verifies a beat with `verify_sender(msg, "live")` over its own
  nonce set (`synadia_ai.agent_service.heartbeat.sign_heartbeat` builds
  the header for a hand-rolled publisher). The status reply carries no
  header.
- **Only the incoming request and the service's own heartbeats are
  signed.** Prompt responses, the status reply and mid-stream query
  replies are not independently authenticated; do not attribute a query
  reply to the original prompt sender.
- **Account-token insertion requires a hand-rolled wildcard service.** An
  export with `account_token_position` turns AgentService's fixed
  five-token subject into a six-token arrival its subscription cannot
  receive, so AgentService deliberately exposes no such option. Use
  `SenderGate(account_token_position=…)` or
  `verify_sender_header(…, account_token_position=…)` on the wildcard
  subscription; the inserted token is a server stamp only on a **closed**
  endpoint (see `test_signed_wrappers_e2e.py` in the client package).
- **Cross-account callers** need the deployment's help: export the prompt
  subject with `response_type: stream` (a response is many messages —
  without it every reply after the first is dropped silently), export
  `$SRV.>` for discovery, and export the inbox prefix if the agent asks
  mid-stream queries. Callers behind a renaming import (`to:` /
  `local_subject`) publish the local name and sign the exporter's
  subject (`prompt(text, subject=…, sub=…)`); nothing to configure here.
- **Reverse lookup.** `await stream.sender.resolve()` on a verified
  sender returns the `AgentInfo` of the agent that registered that ID
  with a verifying `id_sig` (enumerated through `$SRV.INFO.agents` on
  this connection, so account-local; `None` when no verified instance
  claims the key — a human user, a plain service, an agent that is
  offline). The index is cached for `resolve_ttl_s` (default 10 s). It
  identifies; whether to accept is still `accept_sender`'s call.
- **Operator-attested mode** (`operator_attested=True`, off by default)
  reads the server's `Nats-Request-Info` stamp and is a **deployment
  promise the SDK cannot verify**: turn it on only when the endpoint is
  *closed* — no same-account user may publish to its subjects, so every
  arriving request crossed a service import and the stamp is the
  server's. With it on, a verified header whose signed `account` /
  `user` disagree with a present stamp is refused (`401`), a present but
  unparseable stamp is refused, an absent stamp is compared to nothing,
  and agreement on `acc` surfaces as
  `stream.sender.account_attested is True` (`format_sender`
  → `(verified)`). Claims are never cross-checked. On an open endpoint
  (the typical NGS account where peers call each other) leave it off: a
  peer can write that header, and the mode would attest a forgery.
- **A trusted server over TLS is a precondition** of identity: the NATS
  handshake signs a server-chosen nonce with the same seed that signs
  `Agent-Sender`.
- The reference agent takes connection credentials via `--nkey` / `--creds`
  (`$NATS_NKEY_SEED_FILE` / `$NATS_CREDS`) and enables identity separately
  with `--sender-identity signed` (`$NATS_SENDER_IDENTITY`). It uses one
  connection bundle for authentication and signing. With
  `--min-sender-trust` (`$REFERENCE_AGENT_MIN_SENDER_TRUST`) it prints
  `identity: <id> (min_sender_trust=…)` after its ready line and appends
  ` sender: <id> (<trust class>)` to the echo when a sender was
  classified. The ladder examples use the same credential and identity-mode
  flags.

`SenderGate` / `NonceCache` (`synadia_ai.agent_service.identity`) expose
the same classification for hand-rolled services; the codec itself
(`verify_sender`, `verify_sender_header`, `SenderInfo`, `format_sender`,
`AgentId`, `SenderResolver`, the `signer_from_*` helpers) lives in
`synadia-ai-agents` (`>=0.8`) and is not re-exported here.

## Request interceptors and heartbeat extras

An extension on the host side plugs in around the prompt handler as a
`RequestInterceptor`, and adds heartbeat fields with `heartbeat_extras`:

```python
from contextvars import ContextVar
from synadia_ai.agent_service import (
    AgentService, CallNext, RequestInterceptorContext, RequestRejectedError,
)

request_id: ContextVar[str | None] = ContextVar("request_id", default=None)
handled = 0

class Tagging:
    async def around_request(self, ctx: RequestInterceptorContext, call_next: CallNext) -> None:
        # ctx.envelope (unknown fields in ctx.envelope.extras), ctx.sender, ctx.subject, ctx.headers
        global handled
        value = ctx.envelope.extras.get("x_request")
        if value is not None and not isinstance(value, str):
            raise RequestRejectedError(400, "bad x_request")
        handled += 1
        token = request_id.set(value)  # the handler sees request_id.get()
        try:
            await call_next()
        finally:
            request_id.reset(token)

service = AgentService(
    agent="my-agent", owner="me", session_name="demo", nc=nc,
    interceptors=[Tagging()],
    heartbeat_extras=lambda: {"handled": handled},
)
```

- Interceptors run for every admitted prompt — after the envelope is
  decoded and the sender classified, before the §6.4 ack — the first
  listed outermost. Raising before `call_next()` refuses the request with
  no ack: a `RequestRejectedError` answers its §9 code, a `ProtocolError`
  `400`, anything else `500`.
- `call_next()` acks, runs the rest of the chain and the handler, and
  returns when they are done; an interceptor must call it once or raise.
  An exception after `call_next()` returned leaves the handler's full
  reply standing — no error frame — and is logged with a fixed line, never
  the exception's details: an interceptor that wants those logged logs
  them itself.
- `heartbeat_extras` is read when each heartbeat and `status` reply is
  built. A provider that raises, a §8.3 field name, or a value that does
  not serialise costs that beat its extras, never the beat.

## Concurrency

By default one `AgentService` instance serves **one prompt at a time**:
the prompt endpoint awaits your handler for each request in turn, and the
next request waits in the subscription until the handler is done. Every
earlier release worked this way. Handler code written for it, such as a
conversation history shared across prompts, stays correct without a lock.

`max_concurrent_prompts=N` serves up to N prompts at once. It must be an
`int` of at least 1; anything else raises `ValueError`.

```python
service = AgentService(
    agent="my-agent", owner="me", session_name="demo", nc=nc,
    max_concurrent_prompts=8,
)
```

- Above 1, each request runs in an `asyncio` task of its own, in its own
  copy of the `contextvars` context, so what a request interceptor binds
  stays with its prompt. With all N slots busy, the next request waits in
  the subscription, as at 1. Nothing changes on the wire.
- Your handler and interceptors then run interleaved with themselves:
  any state they share across prompts must be safe at every `await`.
  Guard it with an `asyncio.Lock`, or keep it per prompt.
- `stop()` cancels the prompts in flight in both modes: the handler gets
  `CancelledError`, and the caller gets the terminator. Above 1 it also
  waits for those tasks to end. A request still waiting for a slot gets no
  reply, like one still queued at 1.
- The prompt endpoint's `$SRV.STATS` report the same as at 1: each
  request, its time from start to terminator (without the wait for a
  slot), and each error. nats-py measures only its call to the endpoint
  handler, which above 1 returns once the task starts, so the SDK adds each
  task's share to nats-py's counters. If it cannot reach them in a given
  nats-py version, `start()` logs a warning and the stats time only the
  dispatch.
- Concurrency matters most when an agent prompts another agent while it
  serves a prompt. At 1, a loop A → B → A cannot complete: A takes B's
  prompt only after its own call has ended, so the loop waits for a
  timeout.

The TypeScript host (`@synadia-ai/agent-service`) already serves every
prompt as it arrives, with no limit.

## Where things live

- This package — `synadia_ai.agent_service`: `AgentService`,
  `PromptStream`, `PromptHandler`, the heartbeat publisher loop,
  the status endpoint handler, and the reference agent.
- Sibling package — `synadia_ai.agents` (the
  [client SDK](../../client-sdk/python/)): the shared wire primitives
  (`Envelope`, `Attachment`, `HeartbeatPayload`, `AgentSubject`,
  error classes, discovery constants, `load_context_options`,
  `parse_nats_url`).

## Documentation

- [Root README](../../README.md) — protocol overview and monorepo
  layout.
- [`synadia-ai-agents`](../../client-sdk/python/) — the client surface
  this package depends on.
- [Synadia Agent Protocol for NATS spec](https://github.com/synadia-ai/synadia-agent-sdk-docs/blob/main/core-protocol.md)
  — wire-level source of truth.
- [`CHANGELOG.md`](CHANGELOG.md) — release notes.
- [`CLAUDE.md`](CLAUDE.md) — project context and engineering
  conventions.

## Development

```bash
uv sync
uv run ruff check . && uv run ruff format --check . && uv run mypy src tests examples && uv run pytest
```

Integration tests spawn a real `nats-server` per session and record
wire evidence under `tests/_evidence/<test-nodeid>/`. The local
`[tool.uv.sources]` override resolves `synadia-ai-agents` to the
sibling client-sdk checkout, so no PyPI publish is required for CI to
pass.

## License

Apache-2.0. See [LICENSE](LICENSE).
