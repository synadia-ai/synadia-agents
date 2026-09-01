# synadia-ai-agents

Python **client** SDK for the [Synadia Agent Protocol for NATS](https://github.com/synadia-ai/synadia-agent-sdk-docs/blob/main/core-protocol.md).
Discover protocol-compliant agents over NATS and prompt them with
streamed typed responses.

**Hosting an agent (Hermes / claude-code / openclaw / pi)?** That side
of the protocol now ships separately as
[`synadia-ai-agent-service`](../../agent-sdk/python/) (import
`synadia_ai.agent_service`). It depends on this package for the
shared wire primitives — install both when authoring an agent
harness.

**Cross-SDK parity with the [TypeScript SDK](https://github.com/synadia-ai/synadia-agents/tree/main/client-sdk/typescript)**
is tracked in [`tests/test_interop_e2e.py`](tests/test_interop_e2e.py).
Both SDKs declare `protocol_version = "0.3"` in service metadata, so the
test spawns the TS reference agent via `bun` and rounds-trips a prompt
through it. The test `pytest.skip`s cleanly when `bun` or the sibling
`../typescript/` checkout is missing — running the suite without TS
interop is fine for day-to-day work.

**Calling agents?** → [Quickstart - call an agent](#quickstart--call-an-agent).
**Hosting an agent?** → see [`synadia-ai-agent-service`](../../agent-sdk/python/).

## Installation

```bash
pip install synadia-ai-agents
```

Or from this checkout for local development:

```bash
uv pip install -e .
```

You also need a reachable `nats-server`. Pick whichever fits:

```bash
brew install nats-server                          # macOS
# Linux / anywhere with Docker:
docker run --rm -p 4222:4222 nats:2.12-alpine
# Then:
nats-server -a 127.0.0.1 -p 4222
```

See the [nats.io install docs](https://docs.nats.io/running-a-nats-service/introduction/installation)
for more options. [Synadia Cloud](https://www.synadia.com/cloud/) or
any hosted NATS works too - see
[Connecting to NATS in production](#connecting-to-nats-in-production)
below.

## Quickstart - call an agent

The SDK doesn't open NATS connections — you build a
`nats.aio.client.Client` and hand it to `Agents`. That mirrors what
`Svcm(nc)`, `jetstream(nc)`, `Kvm(nc)` do, and lets one connection serve
JetStream, KV, services, and agents at once.

```python
import asyncio
import nats
from synadia_ai.agents import Agents, ResponseChunk, StatusChunk

async def main() -> None:
    nc = await nats.connect(servers="nats://127.0.0.1:4222")
    agents = Agents(nc=nc)
    try:
        found = await agents.discover()           # list[Agent], stall by default
        for a in found:
            print(f"{a.agent}/{a.owner}/{a.name} @ {a.prompt_subject}")

        # Each Agent is directly callable — no bind step.
        async for msg in found[0].prompt("hello"):
            if isinstance(msg, ResponseChunk):
                print(msg.text, end="")
            elif isinstance(msg, StatusChunk) and msg.status == "done":
                print()
    finally:
        await agents.close()                      # SDK state only
        await nc.close()                          # caller owns this

asyncio.run(main())
```

## API matrix

| Symbol | Lives in | Purpose |
| --- | --- | --- |
| `Agents` | [`agents.py`](src/synadia_ai/agents/agents.py) | Caller-side entry point. Construct with `nc=`; owns the heartbeat wildcard sub. |
| `Agent` | [`agent.py`](src/synadia_ai/agents/agent.py) | Live handle from `Agents.discover()`. `.prompt()` is the one method that does I/O. |
| `AgentInfo` | [`discovery.py`](src/synadia_ai/agents/discovery.py) | Pure-data record (parsed `$SRV.INFO` per §4.3). What `build_agent_info()` returns. |
| `Liveness` | [`heartbeat.py`](src/synadia_ai/agents/heartbeat.py) | Frozen snapshot from `Agents.liveness(instance_id)`. |
| `load_context_options` | [`context.py`](src/synadia_ai/agents/context.py) | Resolve a `nats` CLI context into kwargs for `nats.connect(...)`. |
| `resolve_nats_connection_bundle` | [`connection_bundle.py`](src/synadia_ai/agents/connection_bundle.py) | Read connection auth once and optionally derive a signer from that exact snapshot. |
| `Identity`, `signer_from_seed` / `signer_from_creds_file` / `signer_from_context` | [`identity/`](src/synadia_ai/agents/identity/) | Sender identity: sign every `prompt` / `status` with the connection's NKEY — see below. |
| `Agents.self_id()`, `Agents.sign_sender` / `publish_signed` / `request_signed`, `Agents.resolve_sender` | [`agents.py`](src/synadia_ai/agents/agents.py) | The connection's own agent ID; signed publishes for any subject; the reverse lookup. |
| `Agent.status()` | [`agent.py`](src/synadia_ai/agents/agent.py) | The §8.7 status probe (header attached) → `HeartbeatPayload`. |
| `AgentId`, `verify_sender_header`, `parse_sender_header`, `format_sender` | [`identity/`](src/synadia_ai/agents/identity/) | The shared identity codec (also used by the host package). |
| `AgentService` | [`synadia-ai-agent-service`](../../agent-sdk/python/) | Server-side; ships in a separate distribution. Import from `synadia_ai.agent_service`. |

## Sender identity

The optional sender-identity extension lets a receiving agent know *who*
prompted it, verified per message:
the caller attaches an `Agent-Sender` header that names its agent ID —
the `(account, user)` NKEY pair authenticated on that connection — and, with
a signer, an ed25519 signature bound to the subject, the payload, a
timestamp and a nonce. Nothing in it changes protocol `0.3`: an agent
that implements the extension says so with `min_sender_trust` on its
prompt endpoint (`agent.supports_sender_identity`). Identity is off when
the `identity` argument is omitted.

```python
import nats
from synadia_ai.agents import Agents, Identity, resolve_nats_connection_bundle

bundle = resolve_nats_connection_bundle(
    url="tls://connect.ngs.global",
    creds="~/.config/nats/user.creds",
    identity="signed",
)
nc = None
try:
    nc = await nats.connect(**bundle.connection_options)
    agents = Agents(
        nc=nc,
        identity=Identity(signer=bundle.signer, name="claude-code"),
    )
    try:
        print(await agents.self_id())
    finally:
        await agents.close()
finally:
    if nc is not None:
        await nc.close()
    bundle.wipe()               # after NATS closes; reconnect needs the snapshot
```

What to know:

- **Identity is opt-in.** Omit `identity` for no lookup and no header.
  Pass `Identity()` explicitly for an unsigned claim, or use
  `Identity(send_unsigned_claim=False)` for no automatic identity work.
  An unsigned claim discloses your user NKEY to the receiver.
- **Use the connection's credentials.** Prefer
  `resolve_nats_connection_bundle(context=..., identity="signed")`, or its
  `url=...` plus `creds=...` / `nkey=...` form. It reads the selected context
  and credential file once, builds reconnect-safe NATS options, and derives
  the signer from that exact snapshot. There is no separate identity
  credential path. The older `load_context_options` and `signer_from_*`
  helpers remain available for compatibility and advanced use, but do not
  independently read the same mutable file for a new signed connection.
  Before every signed send, the SDK compares the signer's user and account
  with live `$SYS.REQ.USER.INFO`; a mismatch or unavailable binding fails
  and never downgrades to unsigned or headerless delivery. An HSM / KMS
  signer can implement `SenderSigner` (`sign` may be async).
- **One bundle belongs to one connection.** Multiple `Agents` controllers
  or sessions sharing that connection may reuse `bundle.signer`; it names
  the NATS user, not an individual chat session. Close every controller,
  close NATS, then call the idempotent `bundle.wipe()`. Do not wipe while
  reconnect is possible. `bundle.connection_options` necessarily contains
  authentication configuration: never log or serialize it. The bundle's
  own `repr` / `str` are redacted.
- An endpoint that
  declares `min_sender_trust: signed` fails early with
  `SenderSignatureRequiredError` at call time when no signer is
  configured. The error exposes stable `code` (`401`), `description`
  (`"signature required"`), and `subject` attributes, so callers do not
  need to parse its message. With a signer, an unavailable identity raises
  the `self_id()` error on the first iteration.
- **Cost.** Each identity-bearing request performs a live
  `$SYS.REQ.USER.INFO` lookup (2 s timeout at most; a permission violation
  fails at once), because nats-py exposes no reconnect generation that
  could safely invalidate a cached identity. Explicit diagnostic calls to
  `self_id()` are memoised. A signed header is ~400 bytes and counts against
  `max_payload` (header framing included — `PayloadTooLargeError.header_bytes`).
  nats-py does **not** count headers in its own check, so the SDK's is
  the only guard before the server closes the connection with
  `Maximum Payload Violation`.
- **Behind a service import that remaps the subject** — an export that
  inserts the caller's account token (`account_token_position`), or a
  `to:` / `local_subject` rename by your own account — discovery reports
  the exporter's subject, which you cannot publish to. Pass
  `prompt(text, subject=…)` / `status(subject=…)` with the local name;
  the receiver strips an inserted token by itself. Only for a rename by
  **your own** account also pass `sub=agent.prompt_endpoint.subject`
  (sign the exporter's subject). `sign_sender` / `publish_signed` /
  `request_signed` take the same `sub=` keyword.
- **A trusted server over TLS is a precondition.** The NATS handshake
  signs a server-chosen nonce with the same seed that signs
  `Agent-Sender`; a server you should not have trusted could obtain a
  signature valid for 30 s. Identity is meaningful only over TLS to a
  server whose certificate you verify.
- The verified identity is the **user** key; `account` is the sender's
  signed claim (`format_sender` / `str(sender)` renders
  `… (verified user, claimed account)`). Which verified senders a
  receiver accepts is the receiver's business — see the host package's
  `accept_sender` (`synadia-ai-agent-service` 0.5.0, whose `AgentService`
  classifies every prompt before the ack and hands the handler
  `stream.sender`).
- **Only the request is signed.** Prompt response chunks and mid-stream
  query replies are not independently authenticated; do not infer the
  actor answering a query from the original prompt sender.
- `scripts/whoami.py` prints what `self_id()` resolves for a connection
  (or why it resolves nothing).

## Mid-stream queries

Agent handlers can pause their response stream to ask the caller a
question (permission prompt, clarification, menu selection):

```python
async for msg in agent.prompt("do the thing"):
    if isinstance(msg, Query):
        await msg.reply("yes")
    else:
        print(msg)     # ResponseChunk / StatusChunk
```

Server-side, the handler asks via `stream.ask(...)` — see
[`synadia-ai-agent-service`](../../agent-sdk/python/) for the host-side
API.

## Try the examples

Six runnable client-side demos live under
[`examples/`](examples/README.md). They talk to the reference agent
which now ships with `synadia-ai-agent-service` at
[`agent-sdk/python/examples/_reference_agent.py`](../../agent-sdk/python/examples/_reference_agent.py).
The ritual to see the SDKs work end-to-end:

```shell
# terminal 1 — start the reference agent (from the agent-sdk dist)
uv run --directory ../../agent-sdk/python python examples/_reference_agent.py \
  --url nats://127.0.0.1:4222

# terminal 2 — discover and prompt (from this dist)
uv run python examples/01-discover.py --url nats://127.0.0.1:4222
uv run python examples/02-prompt-text.py --url nats://127.0.0.1:4222 "hello"
```

See [`examples/README.md`](examples/README.md) for the full tour.

## Connecting to NATS in production

For [Synadia Cloud](https://www.synadia.com/cloud/) or any self-hosted
NATS that needs credentials, JWTs, or a non-default URL, resolve a `nats`
CLI context once. Identity is off by default, so ordinary connections do
not expose a signer:

```python
import nats
from synadia_ai.agents import Agents, resolve_nats_connection_bundle

bundle = resolve_nats_connection_bundle(context="prod")
nc = None
try:
    nc = await nats.connect(**bundle.connection_options)
    agents = Agents(nc=nc)
    try:
        ...
    finally:
        await agents.close()
finally:
    if nc is not None:
        await nc.close()
    bundle.wipe()
```

Pass `identity="signed"` and configure `Identity(signer=bundle.signer)`
when outgoing requests should carry signed sender identity. Signed mode
fails clearly for anonymous, token, user/password, or JWT-without-seed
authentication; it never silently sends unsigned requests. URL mode is
also available:

```python
bundle = resolve_nats_connection_bundle(
    url="tls://connect.example.com",
    creds="~/user.creds",  # or: nkey="~/user.nk"
    identity="signed",
)
```

`load_context_options(...)` remains available as the compatibility helper
when a connection-only dict is all you need. It reads
`~/.config/nats/context/<name>.json` — URL, creds file, nkey seed
file, token, user/password, inbox prefix are all honored. See
[`CLAUDE.md`](CLAUDE.md#connecting-to-nats) for the full field-by-field
table (including which NATS-context fields are not yet supported and
fail fast rather than silently).

## Hosting an agent

The agent-host surface (`AgentService`, `PromptStream`,
`PromptHandler`, the heartbeat publisher) ships separately as
[`synadia-ai-agent-service`](../../agent-sdk/python/) — install that
package alongside this one when authoring an agent harness, and
import the host classes from `synadia_ai.agent_service`. The shared
wire types (`Envelope`, `Attachment`, error classes,
`HeartbeatPayload`, `AgentSubject`, the discovery constants) stay in
this package and continue to import from `synadia_ai.agents`.

Probe a running agent with the `nats` CLI (subjects are verb-first
per protocol v0.3):

```bash
nats micro list                                          # see "agents"
nats req  agents.prompt.demo.alice.worker-1 "hello" \
  --replies=0 --reply-timeout=30s --timeout=60s          # prompt it (see docs/using-nats-cli.md)
nats req  agents.status.demo.alice.worker-1 ""           # heartbeat-shaped status reply
nats sub  "agents.hb.demo.alice.worker-1"                # watch heartbeats
```

## Documentation

- [Synadia Agent Protocol for NATS spec](https://github.com/synadia-ai/synadia-agent-sdk-docs/blob/main/core-protocol.md)
  - the wire contract (source of truth, lives in
  [`synadia-ai/synadia-agent-sdk-docs`](https://github.com/synadia-ai/synadia-agent-sdk-docs)).
- [`docs/protocol-mapping.md`](docs/protocol-mapping.md) - every SDK call
  mapped to its spec section; for auditors and other-SDK implementers.
- [`examples/README.md`](examples/README.md) - tour of the runnable
  demos under `examples/`.
- [`CHANGELOG.md`](CHANGELOG.md) - release notes and migration guidance.
- [`CLAUDE.md`](CLAUDE.md) - project context and engineering conventions.

## Development

```bash
uv sync                              # install
uv run ruff check . && uv run ruff format --check . && uv run mypy src tests examples && uv run pytest
```

Integration tests spawn a real `nats-server` per session and record wire
evidence under `tests/_evidence/<test-nodeid>/`. Cross-SDK interop tests
(`tests/test_interop_e2e.py`) additionally spawn the TypeScript
reference agent via `bun`; they skip cleanly if `bun` or the sibling
`../typescript/` checkout isn't present.

## License

Apache-2.0. See [LICENSE](LICENSE).
