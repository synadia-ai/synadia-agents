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

`AgentService` implements the receiver side of the
[sender-identity extension](https://github.com/synadia-ai/synadia-agent-fabric-docs/blob/master/docs/agent-protocol-sender-identity.md):
every `prompt` request is classified **before** the §6.4 ack, and the
handler sees the result as `stream.sender`.

```python
from synadia_ai.agents import format_sender, signer_from_seed
from synadia_ai.agent_service import AgentService, PromptStream, ServiceIdentity

service = AgentService(
    agent="echo",
    owner="demo",
    session_name="main",
    nc=nc,
    identity=ServiceIdentity(signer=signer_from_seed(Path(os.environ["NATS_NKEY_SEED_FILE"]).read_bytes())),
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

- **Registration.** When the connection has an NKEY identity the service
  registers `user_nkey` and `account`; with `identity=ServiceIdentity(signer=…)`
  it also registers `id_sig` (`AGENT-ID-V1` over the prompt subject) so
  callers can verify the claim (`AgentInfo.id_sig_verified`).
  `min_sender_trust` is **always** emitted on the prompt endpoint — its
  presence is what advertises the extension — and never on `status`. A
  signer that is not the connection's user makes `start()` raise
  `IdentityMismatchError`; a connection without an identity starts
  without the keys (logged) — verifying *senders* needs no host identity.
  `start()` returns only once the endpoints are registered at the server
  (`flush()`).
- **The verified identity is `user`.** `account` is the sender's signed
  claim; `format_sender` / `str(sender)` renders
  `… (verified user, claimed account)`. Which verified senders to accept
  is authorization — the `accept_sender` hook is where a harness
  consults a list it provisions or, later, the fabric's agent registry.
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
- **`account_token_position`** is for a service behind an export that
  inserts the caller's account token (`account_token_position`, the
  ScratchPad shape): the receiver checks the token against the header's
  `account` and accepts `sub` with the token removed. The inserted token
  is a server stamp only on a **closed** endpoint. Note that
  `AgentService` hosts five-token `agents.{verb}.a.o.n` subjects, which
  such an export turns into six-token arrivals its subscription never
  sees — the option is validated and honoured by the classifier, but
  hosting *behind* such an export today means a hand-rolled service on
  the wildcard subject calling `verify_sender_header(…,
  account_token_position=…)` or a `SenderGate` (see
  `test_signed_wrappers_e2e.py` in the client package).
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
  and agreement on `acc` — or the `account_token_position` cross-check —
  surfaces as `stream.sender.account_attested is True` (`format_sender`
  → `(verified)`). Claims are never cross-checked. On an open endpoint
  (the typical NGS account where peers call each other) leave it off: a
  peer can write that header, and the mode would attest a forgery.
- **A trusted server over TLS is a precondition** of identity: the NATS
  handshake signs a server-chosen nonce with the same seed that signs
  `Agent-Sender`.
- The reference agent takes `--nkey` / `--creds` (`$NATS_NKEY_SEED_FILE`
  / `$NATS_CREDS` — a file, never an environment value holding the seed)
  and `--min-sender-trust` (`$REFERENCE_AGENT_MIN_SENDER_TRUST`), prints
  `identity: <id> (min_sender_trust=…)` after its ready line and appends
  ` sender: <id> (<trust class>)` to the echo when a sender was
  classified. The ladder examples take the same `--nkey` / `--creds`.

`SenderGate` / `NonceCache` (`synadia_ai.agent_service.identity`) expose
the same classification for hand-rolled services; the codec itself
(`verify_sender`, `verify_sender_header`, `SenderInfo`, `format_sender`,
`AgentId`, `SenderResolver`, the `signer_from_*` helpers) lives in
`synadia-ai-agents` (`>=0.8`) and is not re-exported here.

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
