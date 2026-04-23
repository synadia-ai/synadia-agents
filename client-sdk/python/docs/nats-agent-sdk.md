# Platform SDK

Goals of the SDK:

- Use an existing NATS client (just pass in connection from existing library)
- Ability to send prompt & attachments to a single detected agent
- Discover available agents
- Heartbeating
- Bidirectional communication (Agent outbox) ?
- Streaming responses

- Lifecycle Events (later) (keep different natures of agent lifecycles OC/CC/… into account)

Supported languages (sorted by priority):

- Typescript (mario)
- Python (rene)
- Go (later) (daan)

- HATEOS principles, discovery returns the subjects so subjects become flexible

Pseudo:

```
None

# Attach the client SDK to a NATS system.
client := agent.Connect("my_name", DNS, creds, ...)

# HARD PATH
# use NATS clients more directly.
nc,_ := nats.Connect()
client := agent.Attach("my_name", nc) # could be for later
# if you need the NATS connection and only have the client.
nc := client.Connection()

# Discover which clients are available on NATS
agents := client.discover()

# Bind to a specific agent
agent := client.Bind("agent-id")

# Interact with the agent, prompting with the
# ability to send attachments
responseStream := agent.prompt("...", WithAttachment(attachment))

for m in responseStream {
    switch m.type { ... }
}
```

Message types:
- status (ack, done)
- query (with reply subject)
- response (response from the agent)

Message types can be mixed, but each message has a type

---

## Python SDK resolutions

This section captures decisions made while designing the Python SDK. It is appended as decisions accumulate - the TypeScript and Go SDKs can adopt, diverge with reason, or reconcile later. Wire-level decisions live in <https://github.com/synadia-ai/nats-agent-sdk-docs>; the entries here are Python API shape only.

### Wire format discrimination (Q1 - resolved)

- Hybrid text/JSON is the v0.1 wire shape; see protocol §3.1–3.2 and §4.2.
- SDK presents a typed async stream of messages (`response`, `status`, `query` reserved). Plain-text chunks from a minimal agent are surfaced to the caller as `response` messages - the caller never has to parse raw text vs. JSON.
- Long-term direction is JSON-only; the SDK should isolate the text→envelope promotion at a single boundary (protocol §3.4).

### Attachments (Q2 - resolved)

**Wire.** See protocol §3.1 `file` part type (filename + base64 content). No MIME type at the transport layer - the agent interprets bytes by filename or content sniffing. `object` part type is dropped; structured data is either serialized into a `file` (e.g. `data.json`) or embedded in the text part.

**Python API.**

```python
from natsagent import Attachment

await remote.prompt(
    "summarize this",
    attachments=[
        Attachment(filename="doc.pdf", content=b"..."),
        Attachment.from_path("./recording.wav"),   # convenience: reads bytes, uses basename
    ],
)
```

- `Attachment` is a small Pydantic model: `filename: str`, `content: bytes`.
- `Attachment.from_path(path)` reads the file and takes the basename - no directory leakage into the wire.
- Base64 encoding happens at the transport boundary (just before publish), not in `Attachment` - `content` stays as raw bytes in Python for ergonomics.
- v0.1 is inline base64 only. When protocol §3.5 (JetStream Object Store references) lands, a second constructor `Attachment.from_object_store(bucket, key, filename=...)` will be added; the `prompt()` API does not change.

### Heartbeat (Q3 - resolved)

**Wire.** Protocol §5: pub/sub on `agents.{p}.{o}.{n}.heartbeat`, compact payload (`name` + `platform` + `owner` + `ts` + `interval_s`). On-demand reachability uses `$SRV.PING.{name}`.

**Python API - agent side.**

```python
agent = Agent(
    platform="hermes",
    owner="rene",
    name="default",
    nc=nc,
    heartbeat_interval_s=30,   # default; SDK rejects 0 - heartbeat is mandatory in v0.1
)
```

- The SDK runs the heartbeat as a background task started at agent construction.

**Python API - caller side.**

```python
# On-demand reachability
ok = await client.ping("agents.hermes.rene.default", timeout=2.0)

# Passive liveness - automatic
status = client.status("agents.hermes.rene.default")
# AgentStatus(subject="agents.hermes.rene.default", last_seen=datetime(...), interval_s=30)
```

**Behavior.**
- `Client` subscribes to `agents.*.*.*.heartbeat` *before* running `discover()`, per §5.5.
- Per-agent offline threshold: `3 × interval_s` since last observed heartbeat (matches §5.2 recommendation).
- `discover()` runs once at client startup (10⁴-agent scale assumption); subsequent liveness updates flow through the heartbeat stream, not polling.

### Mid-stream queries (Q4 - resolved)

**Wire.** Protocol §4.5: `query` is a typed JSON chunk with `id`, `reply_subject`, and `parts`. Caller publishes exactly one reply to `reply_subject` using §3.1 envelope shape (plain text or JSON envelope). The agent's response stream stays open across the round-trip; the empty-payload terminator still arrives only when the agent is fully done.

**The SDK is content-agnostic.** Queries arrive at the caller as typed messages and are surfaced verbatim - the SDK does not parse menu structures, validate replies, or enforce any answer schema. That's the application's job. Most queries in practice carry a single text part and most replies are a short string.

**Python API - caller side.**

```python
async for msg in remote.prompt("delete all 200 files"):
    match msg:
        case Response(parts=parts):
            render(parts)
        case Status(status="done"):
            ...
        case Query() as q:
            answer = await prompt_user(q.parts)   # application UX
            await q.reply(answer)                  # answer: str | Envelope
```

- `Query.reply(answer)` accepts a `str` (sent via §3.2 plain-text shorthand) or an `Envelope`. Encodes and publishes once to `q.reply_subject`. Fire-and-forget - no agent ack to await.
- The `async for` loop continues yielding chunks after the reply is sent; the agent decides when to send the next chunk.

**Python API - agent side.**

```python
async def handle_prompt(envelope, stream):
    answer = await stream.ask(
        "Confirm deletion of 200 files? Type 'yes' to proceed.",
        timeout=60,
    )
    if answer.text.strip().lower() != "yes":
        await stream.send("Aborted.")
        return
    # ... do the work, possibly more queries ...
    await stream.send("Done.")
```

- `stream.ask(prompt, timeout=N)` allocates a fresh inbox, publishes a `query` chunk (with a generated UUID `id`), awaits one reply with timeout, and returns a parsed `Envelope`.
- `prompt` accepts a `str` (single text part) or a list of part objects.
- On timeout: raises `QueryTimeout`. Per §4.5.3 the agent decides whether to error the stream or continue with a default - both are protocol-compliant.
- Multiple concurrent `stream.ask(...)` calls are allowed (each gets its own inbox); sequential is the typical pattern.

### Deferred

Session addressing was prototyped (SDK `sessions=True`, protocol §1.4) and rolled back on 2026-04-20 - the protocol stays at `agents.{platform}.{owner}.{name}` only. Any future session story starts from a blank page; carry a session id in the envelope payload if the platform needs one today.
