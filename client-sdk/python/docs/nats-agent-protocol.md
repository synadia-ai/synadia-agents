# NATS Agent Protocol

**Version:** 0.1.0-draft
**Status:** Draft
**Date:** 2026-04-21

## 1. Introduction

This document defines a protocol for identifying, discovering, and communicating with AI agents over NATS. Agents registered per this protocol can be enumerated, inspected, and prompted using a uniform set of subjects and message shapes regardless of the underlying agent framework, language, or runtime.

Built on two NATS primitives:

- **Subject hierarchy** for addressing, routing, and wildcard discovery.
- **Micro services** (`@nats-io/services` and equivalents) for registration and discovery.

Anything NATS already provides is used as-is. The protocol adds only what is missing: a subject convention, one shared service name, a request envelope, a streaming response wrapper, and a liveness beacon.

Out of scope for v0.1:

- End-to-end encryption and strong agent identity.
- The `attachments` endpoint (§2 reserves the subject; §5.5 sketches intent).
- JetStream-backed at-least-once streaming.

### 1.1 Conventions

Normative keywords — **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, **MAY** — follow RFC 2119 and RFC 8174.

"The protocol" is the wire contract defined here. "SDKs" are language-specific libraries built on top, specified separately in `sdk-contract.md`.

### 1.2 Version

This specification is version `0.1.0-draft`. Agents declare the protocol version they implement in service metadata (§3.2). Compatibility rules are in §11.

---

## 2. Subject hierarchy

Every agent instance occupies a subject tree rooted at:

```
agents.{agent}.{owner}.{name}
```

| Token    | Role                                                                                                                                                                   |
|----------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `agents` | Fixed prefix. Reserved for this protocol.                                                                                                                              |
| `agent`  | Identifier of the harness / runtime. SHOULD be (an abbreviation of) `metadata.agent` (§3.2). Conventional abbreviations: `ccc` for `claude-code`, `occ` for `openclaw` — see Appendix C. |
| `owner`  | Operator or account owning the instance. SHOULD match `metadata.owner`.                                                                                                |
| `name`   | Instance name within `{agent}/{owner}`. Lives only in the subject — not echoed in metadata.                                                                            |

One subject under the root is **fixed by the protocol**: the heartbeat beacon. Endpoint subjects are agent-chosen; the channel plugins shipped with this protocol use the default subjects in the table, but SDK-authored agents MAY place their endpoints on any subject.

| Subject                                     | Purpose                                                              | Fixed?             |
|---------------------------------------------|----------------------------------------------------------------------|--------------------|
| `agents.{agent}.{owner}.{name}`             | Default subject for the required `prompt` endpoint (§5, §6).         | No — default only  |
| `agents.{agent}.{owner}.{name}.heartbeat`   | Liveness beacon (§8).                                                | **Yes** (protocol-fixed) |
| `agents.{agent}.{owner}.{name}.attachments` | Default subject for the future `attachments` endpoint (§5.5).        | No — default only  |

What the protocol fixes for endpoints is the endpoint **name**, not its subject:

- An agent MUST register an endpoint named `prompt`.
- If the agent exposes the future artifact endpoint, it MUST be named `attachments`.

Callers therefore MUST learn endpoint subjects from `$SRV.INFO.Synadia Agents` (§4); they MUST NOT construct endpoint subjects from identity alone. The heartbeat subject is the one exception — it is fixed so callers can subscribe to `agents.*.*.*.heartbeat` without a lookup.

### 2.1 Prompt endpoint metadata

The `prompt` endpoint's registration (§3) MUST declare endpoint metadata:

```json
{
  "max_payload": "1MB",
  "attachments_ok": true
}
```

| Key              | Type    | Required | Description                                                                                                                                                                        |
|------------------|---------|----------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `max_payload`    | string  | Yes      | Maximum single-message request payload size. Format is a positive integer followed by `B`, `KB`, `MB`, or `GB` (e.g. `512KB`, `1MB`, `4MB`). Callers MUST enforce locally (§5.4).  |
| `attachments_ok` | boolean | Yes      | Whether the endpoint accepts JSON envelopes containing an `attachments` array. If `false`, callers MUST NOT send attachments; plain text and JSON-without-attachments remain valid. |

### 2.2 Naming rules

Subject tokens MUST conform to NATS subject naming rules (https://docs.nats.io/nats-concepts/subjects#characters-allowed-and-recommended-for-subject-names).

- Tokens MUST NOT begin with `$`.
- Tokens SHOULD use only `a`–`z`, `0`–`9`, `-`, `_`.
- Each token SHOULD be 1–63 characters; fully qualified subjects SHOULD stay under 256 characters.

Agent identifiers are not centrally registered. Collisions are the deployer's responsibility. Appendix C lists identifiers in common use and their conventional subject abbreviations.

### 2.3 Examples

```
agents.claude-code.aconnolly.synadia-com-2   # claude-code, session "synadia-com-2"
agents.ccc.aconnolly.synadia-com-2           # same, using the "ccc" abbreviation
agents.openclaw.rene.default                 # OpenClaw, long-running, session-less (name "default")
agents.pi.mario.workspace-1                  # pi, session on workspace "workspace-1"
agents.hermes.ops.summarizer                 # Hermes instance "summarizer"
```

### 2.4 Wildcard discovery

```
agents.>                             # every agent on the system
agents.claude-code.>                 # every claude-code agent (full form)
agents.ccc.>                         # every claude-code agent (abbreviated form)
agents.*.aconnolly.>                 # every agent owned by aconnolly
agents.*.*.summarizer                # every agent root named "summarizer"
agents.*.*.*.heartbeat               # every heartbeat beacon (protocol-fixed subject)
```

Note: there is no `agents.*.*.*.prompt`-style wildcard for endpoints. Endpoint subjects are agent-chosen — use `$SRV.PING.Synadia Agents` (§4) to enumerate instead.

Full-form and abbreviated subject tokens do not cross-match under a NATS wildcard. A deployment SHOULD commit to one convention per `metadata.agent` value.

---

## 3. Service registration

Every agent MUST register as a NATS micro service using `@nats-io/services` or equivalent. Registration is the authoritative source for endpoint capability metadata and for enumeration via `$SRV.PING` / `$SRV.INFO`.

### 3.1 Required service fields

| Field         | Value                                                                                                                                                       |
|---------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `name`        | MUST be `Synadia Agents`. Acts as the discovery filter that separates compliant agents from other NATS micro services. If a framework rejects the space, `SynadiaAgents` is treated as equivalent. |
| `version`     | Semver of the harness implementation (not the protocol). Example: `1.4.0`.                                                                                  |
| `description` | Human-readable description surfaced by `nats micro list` / `nats micro info`.                                                                               |
| `metadata`    | Object. See §3.2.                                                                                                                                           |

### 3.2 Required service metadata

The service `metadata` object MUST include:

```json
{
  "agent": "claude-code",
  "owner": "aconnolly",
  "session": "synadia-com-2",
  "protocol_version": "0.1"
}
```

| Key                | Type   | Required             | Description                                                                                                                                                 |
|--------------------|--------|----------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `agent`            | string | Yes                  | Canonical harness identifier (e.g. `claude-code`). The 2nd subject token MAY be an abbreviation of this value (§2).                                         |
| `owner`            | string | Yes                  | Operator / account. Matches the 3rd subject token.                                                                                                          |
| `session`          | string | When session-aware   | Harness-specific session label. MUST be set for session-aware harnesses (`claude-code`, `pi`, `hermes`); MAY be omitted or set to `"default"` for session-less harnesses (`openclaw`). |
| `protocol_version` | string | Yes                  | Protocol version implemented. MUST match a MAJOR.MINOR value from §11.3.                                                                                    |

The instance name is not echoed in metadata — callers read it from the 4th token of any endpoint subject.

Additional metadata keys MAY be included and MUST be preserved by tools that relay service info.

### 3.3 Multiple instances

Multiple physical instances of the same logical agent MAY register simultaneously. They share `agent`/`owner`/`name` identity, which yields identical endpoint subjects, which causes the NATS micro service framework to load-balance requests across them via queue groups.

Each instance is distinguished by the service `id` (per-instance, framework-assigned). This id also appears in heartbeat payloads as `instance_id` (§8.3).

Different instances of the same logical agent SHOULD expose identical endpoints and metadata.

---

## 4. Discovery

The protocol defines exactly **two stable subjects** for discovery:

| Purpose | Subject                                   | Semantics                                                 |
|---------|-------------------------------------------|-----------------------------------------------------------|
| General | `$SRV.PING.Synadia Agents`                | Every compliant agent instance responds once.             |
| Direct  | `$SRV.INFO.Synadia Agents.{instance_id}`  | One specific instance responds with full service info.    |

Discovery returns each instance's endpoints with their subjects and metadata. Callers MUST use the `subject` field from the discovery record to address an endpoint — endpoint subjects are not protocol-fixed (§2) and cannot be reliably constructed from identity alone.

### 4.1 General discovery

```shell
nats req '$SRV.PING.Synadia Agents' '' --replies=0 --timeout=2s
nats req '$SRV.INFO.Synadia Agents' '' --replies=0 --timeout=2s
```

`$SRV.PING` returns ping-level records; `$SRV.INFO` returns full records including endpoint capability metadata. Callers typically use the latter.

### 4.2 Direct lookup

Callers with a known `instance_id`:

```shell
nats req '$SRV.INFO.Synadia Agents.VMKS6MHK71PCPWGY38A7N5' '' --timeout=2s
```

Callers with a known identity tuple but no `instance_id` run general discovery and filter client-side on `metadata.agent`, `metadata.owner`, and the 4th token of the endpoint subject.

### 4.3 Using a discovery record

From a service info record, a caller:

1. Reads `metadata.agent`, `metadata.owner`, optional `metadata.session`, and `metadata.protocol_version`.
2. Locates the `prompt` endpoint by `name == "prompt"` and reads its `subject` and its metadata (`max_payload`, `attachments_ok`).
3. Derives the instance name from the 4th token of the endpoint's `subject` when the subject follows the default pattern (§2); otherwise the instance name is taken from the agent's `metadata.session` or is opaque to the caller.
4. Enforces §5.4 validation using the endpoint metadata.
5. Publishes requests to the endpoint's `subject` verbatim — no construction.

---

## 5. Request

A request is a single NATS message sent by a caller to the agent's `prompt` endpoint subject, as learned from discovery (§4.3). Request-side streaming is deferred to the future `attachments` endpoint (§5.5).

### 5.1 Envelope shape

A request payload is either:

- **Plain UTF-8 text** — shorthand for an envelope with only the `prompt` field. Enables `nats req` use without constructing JSON.
- **JSON envelope** — an object with at minimum a `prompt` field:

```json
{
  "prompt": "summarize the attached report",
  "attachments": [
    { "filename": "report.pdf", "content": "<base64>" }
  ]
}
```

| Field         | Type     | Required | Description                                                                                                              |
|---------------|----------|----------|--------------------------------------------------------------------------------------------------------------------------|
| `prompt`      | string   | Yes      | UTF-8 prompt text. MUST be non-empty.                                                                                    |
| `attachments` | object[] | No       | Zero or more attachment objects (§5.2). Agents with `attachments_ok: false` MUST reject a non-empty array with status `400` (§9). |

Additional top-level fields MAY appear; see §5.6.

### 5.2 Attachments

```json
{ "filename": "report.pdf", "content": "<base64>" }
```

| Field      | Type   | Required | Description                                                                                                                 |
|------------|--------|----------|-----------------------------------------------------------------------------------------------------------------------------|
| `filename` | string | Yes      | Authoritative file name. Agents interpret the bytes by extension or content sniff.                                          |
| `content`  | string | Yes      | Standard-alphabet, padded base64 (RFC 4648 §4). MUST NOT use URL-safe encoding and MUST NOT contain whitespace.             |

No MIME type is carried.

### 5.3 Discrimination rule

On receive, the agent:

1. Skips leading UTF-8 whitespace (`0x09`, `0x0A`, `0x0D`, `0x20`).
2. If the next byte is `{`, parses the remainder as JSON. If parsing fails, or the parsed object has no `prompt` string field, responds with status `400` (§9).
3. Otherwise, treats the original payload as UTF-8 text and promotes it to `{"prompt": <payload>}`.

A zero-byte request payload is invalid and MUST be rejected with status `400`.

### 5.4 Client-side validation

Before publishing, the caller MUST enforce the `prompt` endpoint's capability metadata (§2.1):

- If any attachment is present and `attachments_ok` is `false`, the caller MUST fail locally without publishing.
- The caller MUST compute the final encoded payload byte size and fail locally if it exceeds `max_payload`.

These local checks spare a round trip and agent-side resources. Agents MAY additionally enforce server-side and respond with `400`.

### 5.5 Future direction: artifact endpoint (≥ 0.2)

A future revision will define the `attachments` endpoint at `agents.{agent}.{owner}.{name}.attachments` for large-file upload:

- Separate endpoint from `prompt`, with its own wire contract and request-side streaming (chunked uploads).
- Uploaded files are staged in a temp directory accessible to the agent and injected by reference into the next `prompt` request's context.
- Likely backed by JetStream Object Store.

Precise wire format, chunking, lifetime, and reference-handoff semantics are deferred. v0.1 implementations SHOULD structure attachment handling so that adding the `attachments`-endpoint code path is additive, not a rewrite.

### 5.6 Unknown fields

Envelope decoders MUST tolerate unknown top-level fields and unknown fields inside attachment objects without error. They MUST preserve such fields when relaying.

---

## 6. Response streaming

The `prompt` endpoint responds by publishing a sequence of chunks to the caller's reply subject, terminated by an empty-payload message.

### 6.1 Pattern

```
Caller                                    Agent
   |                                        |
   | ——— request (reply=_INBOX.abc) ——————▶ |
   |                                        |
   | ◀——  chunk 1 (to _INBOX.abc) ————————— |
   | ◀——  chunk 2 (to _INBOX.abc) ————————— |
   |      ...                               |
   | ◀——  terminator (to _INBOX.abc) ———————|
```

### 6.2 Chunk wrapper

Every non-terminating chunk is a typed JSON object:

```json
{ "type": "<type>", "data": <value> }
```

| Field  | Type          | Required | Description                                                                           |
|--------|---------------|----------|---------------------------------------------------------------------------------------|
| `type` | string        | Yes      | Chunk discriminator. v0.1 defines `response`, `status`, `query` (§6.3–6.4, §7).       |
| `data` | string/object | Yes      | Chunk payload. Shape is determined by `type`.                                         |

Plain-text shorthand is **not** accepted on the response side: every non-terminating chunk MUST be a JSON object with a `type` discriminator.

Unknown chunk types MUST be silently ignored by callers, which continue consuming the stream (§6.6). Error responses use NATS micro service error headers instead of a typed chunk (§9).

### 6.3 `response` chunks

Content from the agent. `data` is either a string (the response text) or an object:

```json
{ "type": "response", "data": "Hello, world." }
```

```json
{ "type": "response", "data": { "text": "Hello, world.", "attachments": [ ... ] } }
```

| Field         | Type     | Required | Description                                                                                            |
|---------------|----------|----------|--------------------------------------------------------------------------------------------------------|
| `text`        | string   | Yes*     | Response text. When `data` is a bare string, that string IS the text.                                  |
| `attachments` | object[] | No       | Optional attachments from the agent; shape per §5.2. Callers MAY ignore.                               |

(*) When `data` is an object, `text` is required. When `data` is a string, the object form does not apply.

Callers MUST accept both the string and object forms transparently. Multiple `response` chunks MAY be emitted; callers concatenate `text` values in publication order.

### 6.4 `status` chunks

Lifecycle signal emitted during long-running work. `data` is a string status token:

```json
{ "type": "status", "data": "ack" }
```

v0.1 defines one status value:

| Value | Meaning                                                                                                                              |
|-------|--------------------------------------------------------------------------------------------------------------------------------------|
| `ack` | Request accepted; work in progress. Resets the caller's inactivity timeout (§6.6). MAY be emitted periodically as a keep-alive.      |

Callers MUST silently ignore unrecognized status values.

The terminal `done` is not a `status` chunk. The empty-payload terminator (§6.5) IS the done signal; SDKs MAY surface it to applications as a `status: done` event.

### 6.5 Stream termination

Every response stream MUST end with a **zero-byte body message carrying no NATS headers**. This is the uniform end-of-stream signal for all streams — successful or errored.

Agents MUST NOT publish further messages on the reply subject after the terminator.

**Successful completion.** Zero or more content / status / query chunks, then the empty terminator.

**Error completion.** Zero or more chunks, then a message carrying `Nats-Service-Error-Code` / `Nats-Service-Error` headers (with optional JSON body per §9.1), then the empty terminator. The error-headered message is not itself the terminator.

A stream consisting of a single `response` chunk followed by the empty terminator is valid and common.

### 6.6 Ordering, delivery, forward compatibility

Chunks are delivered in publication order. NATS core messaging is at-most-once; individual chunks — including the terminator — MAY be lost silently.

To prevent indefinite hangs on a lost terminator, callers MUST apply a per-stream inactivity timeout. Recommended default: **60 seconds since the last observed chunk**. On timeout, the caller treats the stream as terminated with a transport error.

Forward-compat rules for callers:

- MUST silently ignore chunks whose `type` is unrecognized.
- MUST tolerate unknown fields in `data` objects and preserve them when relaying.

Agents that require at-least-once delivery SHOULD wait for a future JetStream-backed pattern. v0.1 operates on core NATS only.

### 6.7 Cancellation

The protocol defines no cancellation signal. NATS subject delivery is interest-based: if a caller drops its subscription on the reply subject, subsequent chunks are discarded by the NATS server at no cost.

- Callers cancel by dropping the reply subscription. No wire signal is sent.
- Agents are not notified of cancellation and continue until natural completion. An agent detects an abandoned caller only if it issues a mid-stream query (§7) and the reply times out.
- Agents producing expensive long-running work SHOULD use a mid-stream query as a liveness check if cancellation semantics matter.

---

## 7. Mid-stream queries

An agent MAY pause its response stream to ask the caller a question — a permission prompt, a clarification, a menu selection. The response stream remains open; the caller publishes one reply to a fresh subject supplied by the agent; the agent resumes emitting chunks.

### 7.1 Query chunk

```json
{
  "type": "query",
  "data": {
    "id": "a8f1c2e4-9b63-4d7e-aaaa-112233445566",
    "reply_subject": "_INBOX.Xj7k9Q2pA",
    "prompt": "Confirm deletion of 200 files? (yes/no)"
  }
}
```

| Field           | Type     | Required | Description                                                                                      |
|-----------------|----------|----------|--------------------------------------------------------------------------------------------------|
| `id`            | string   | Yes      | Opaque correlation identifier. SHOULD be a UUID.                                                 |
| `reply_subject` | string   | Yes      | A fresh NATS subject (typically `_INBOX.xxx`) on which the agent expects exactly one reply.      |
| `prompt`        | string   | Yes      | The question text presented to the caller.                                                       |
| `attachments`   | object[] | No       | Optional attachments; same shape as §5.2.                                                         |

### 7.2 Reply

The caller publishes exactly one message to `reply_subject`. Payload follows §5.1 — plain UTF-8 text, or a JSON envelope with `prompt` + optional `attachments`. No acknowledgment is defined.

```shell
nats pub _INBOX.Xj7k9Q2pA "yes"
```

### 7.3 Lifecycle

- The agent chooses its own reply timeout. The protocol does not mandate a value.
- If the caller does not reply within the timeout, the agent MAY either (a) terminate the stream with an error per §9, or (b) proceed with a harness-defined default and continue emitting chunks. In case (b), the caller receives no signal.
- Multiple query chunks MAY be in flight concurrently within a single response stream. Each MUST use a distinct `reply_subject`.
- Query chunks do not terminate the stream. The §6.5 terminator rules still apply.

---

## 8. Heartbeat

Agents MUST publish a periodic heartbeat so callers can track liveness without polling. Heartbeats are pub/sub (fire-and-forget); there is no reply.

### 8.1 Subject

```
agents.{agent}.{owner}.{name}.heartbeat
```

Each instance publishes its own heartbeats to this subject. Callers distinguish instances by the `instance_id` field in the payload.

### 8.2 Cadence

Each instance chooses its own interval, configurable at SDK construction time. Recommended default: **30 seconds**. Values below 1 second SHOULD NOT be used on shared infrastructure.

The interval is carried in the payload (`interval_s`). Recommended offline threshold: **3 × interval_s since last observed heartbeat**, applied per `instance_id`.

Agents SHOULD begin publishing heartbeats only after service registration is complete, so that callers discovering the agent via `$SRV.INFO` find its metadata.

### 8.3 Payload

```json
{
  "agent": "claude-code",
  "owner": "aconnolly",
  "session": "synadia-com-2",
  "instance_id": "VMKS6MHK71PCPWGY38A7N5",
  "ts": "2026-04-21T14:23:01Z",
  "interval_s": 30
}
```

| Field         | Type   | Required           | Description                                                                                                           |
|---------------|--------|--------------------|-----------------------------------------------------------------------------------------------------------------------|
| `agent`       | string | Yes                | Matches `metadata.agent`.                                                                                              |
| `owner`       | string | Yes                | Matches `metadata.owner`.                                                                                              |
| `session`     | string | When session-aware | Matches `metadata.session`. Present iff the metadata field is set.                                                     |
| `instance_id` | string | Yes                | The micro service framework's per-instance identifier. Matches the service `id`.                                       |
| `ts`          | string | Yes                | UTC ISO 8601 timestamp of publication.                                                                                 |
| `interval_s`  | number | Yes                | This instance's cadence in seconds. > 0; recommended ≥ 1.                                                              |

The instance name is not duplicated into the payload — receivers extract it from the 4th token of the heartbeat's subject.

Callers MUST tolerate additional unknown fields.

### 8.4 On-demand reachability

For point-in-time reachability, callers SHOULD use the micro service ping instead of waiting for the next heartbeat:

```shell
nats req '$SRV.PING.Synadia Agents' '' --replies=0 --timeout=2s
```

Callers correlate ping responses with heartbeats via `instance_id`.

### 8.5 Subscribe-before-discover

To avoid a race between enumeration and the first heartbeat, callers SHOULD subscribe to the heartbeat wildcard (`agents.*.*.*.heartbeat`, scoped as narrowly as needed) **before** sending their first `$SRV.PING.Synadia Agents`.

### 8.6 Shutdown

v0.1 defines no "going away" signal. Callers detect shutdown via the missed-beats threshold (§8.2).

---

## 9. Errors

Errors are reported using the NATS micro service error response mechanism.

### 9.1 Wire shape

An error response carries two headers set by `respondError`:

- `Nats-Service-Error-Code` — numeric status code as a string (e.g. `"429"`).
- `Nats-Service-Error` — short human-readable description.

The body MAY be empty, or MAY carry a JSON object with richer context:

```json
{
  "error": "rate_limited",
  "message": "Too many concurrent requests for this agent instance",
  "retry_after_s": 30
}
```

| Field     | Type   | Required              | Description                                                                                     |
|-----------|--------|-----------------------|-------------------------------------------------------------------------------------------------|
| `error`   | string | Yes (if body is JSON) | Stable machine-readable error code. Lowercase snake_case recommended.                           |
| `message` | string | No                    | Human-readable detail. If absent, callers fall back to the `Nats-Service-Error` header.         |
| (other)   | any    | No                    | Additional fields MAY be included. Callers MUST tolerate unknown fields.                        |

If the body is empty or not valid JSON, callers MUST use the `Nats-Service-Error` header as the description.

### 9.2 Status code taxonomy

| Code | Error class                                                                                                                                         |
|------|-----------------------------------------------------------------------------------------------------------------------------------------------------|
| 400  | Malformed request: invalid envelope, empty payload, invalid base64, attachments sent when `attachments_ok=false`, request exceeds `max_payload`.   |
| 401  | Authentication required. (NATS usually enforces at connect time.)                                                                                   |
| 403  | Forbidden: caller authenticated but not authorized.                                                                                                 |
| 404  | Not found.                                                                                                                                          |
| 409  | Conflict: request conflicts with current agent state.                                                                                               |
| 429  | Rate limited.                                                                                                                                       |
| 500  | Internal error.                                                                                                                                     |

Agents MUST use codes from this table. Future revisions will add new codes but not reuse existing ones with new meanings.

### 9.3 Errors during a stream

An error mid-stream is an error-headered message (with optional JSON body per §9.1) published to the reply subject, followed by the empty terminator (§6.5). This applies whether the error occurs before any content or partway through. Error-terminated streams always end with two messages: error-headered, then empty terminator.

Agents MUST NOT publish further messages on the reply subject after the terminator.

---

## 10. Security

### 10.1 Authentication and authorization

Authentication and authorization are delegated to NATS server configuration. Agents inherit the security boundaries of the NATS accounts, users, and permissions they connect with.

- Reachability between a caller and an agent is determined entirely by NATS subject permissions.
- The protocol defines no pairing, allowlisting, or handshake.
- Deployments SHOULD use NATS accounts and subject permissions to isolate agents by tenant or environment.

E2E encryption and strong per-agent identity are deferred to a future revision.

### 10.2 Credential management

Agents and callers SHOULD support NATS CLI contexts (`~/.config/nats/context/<name>.json`) for connection configuration.

---

## 11. Versioning

The protocol version an agent implements is declared in `metadata.protocol_version` (§3.2).

### 11.1 Version string format

MAJOR.MINOR strings (e.g. `"0.1"`, `"1.0"`). Patch/pre-release qualifiers MAY be present but have no compatibility meaning — callers MUST compare only the MAJOR.MINOR prefix.

### 11.2 Compatibility rules

- **Same MAJOR.MINOR**: full interoperability.
- **Same MAJOR, different MINOR**: callers SHOULD treat the agent as compatible for the caller's MINOR feature set and rely on forward-compat escape hatches (§5.6 unknown fields, §6.6 unknown chunk types).
- **Different MAJOR**: no interoperability guarantee.

The 0.x line is explicitly unstable. MINOR bumps within 0.x MAY break compatibility; callers SHOULD pin to an exact MAJOR.MINOR until 1.0.

### 11.3 Known versions

| Version | Status | Notes          |
|---------|--------|----------------|
| `0.1`   | Draft  | This document. |

---

## 12. Implementation checklist

An **agent** is compliant with protocol `0.1` when it:

- Registers as a NATS micro service with `name = "Synadia Agents"` (or `SynadiaAgents` if the framework rejects the space).
- Declares `metadata.agent`, `metadata.owner`, `metadata.protocol_version = "0.1"`; adds `metadata.session` when session-aware.
- Registers an endpoint named `prompt` with endpoint metadata `max_payload` and `attachments_ok`. The endpoint's `subject` is agent-chosen; the recommended default (used by channel plugins) is `agents.{agent}.{owner}.{name}`.
- On the `prompt` endpoint:
  - Accepts both JSON envelopes and the plain-text shorthand (§5).
  - Rejects malformed envelopes, empty payloads, invalid base64, oversize requests, and attachments-when-`attachments_ok=false` with status `400`.
  - Tolerates and preserves unknown envelope fields.
  - Emits response streams per §6: typed `{type, data}` chunks in publication order, terminated by a zero-byte headerless message. Errors precede the terminator with error headers.
- Publishes heartbeats on `agents.{agent}.{owner}.{name}.heartbeat` at its configured cadence with all §8.3 fields.
- Responds to `$SRV.PING.Synadia Agents` and `$SRV.INFO.Synadia Agents` via the micro service framework.
- If it issues mid-stream queries: conforms to §7.
- Uses `respondError` per §9 for errors; `Nats-Service-Error-Code` is set from the §9.2 taxonomy.

A **caller** is compliant when it:

- Performs discovery only via `$SRV.PING.Synadia Agents` and `$SRV.INFO.Synadia Agents[.{instance_id}]`.
- Reads each instance's `metadata.protocol_version` and applies §11.2 compatibility rules.
- Locates the `prompt` endpoint by `endpoints[].name == "prompt"`, reads its metadata, and enforces `max_payload` / `attachments_ok` locally before publishing (§5.4).
- Publishes to the `prompt` endpoint's `subject` as reported by `$SRV.INFO.Synadia Agents`. MUST NOT construct the subject from identity alone.
- Subscribes to an appropriate heartbeat wildcard **before** initial `$SRV.PING.Synadia Agents`.
- Applies a per-stream inactivity timeout (§6.6).
- Inspects NATS headers (`Nats-Service-Error-Code`) on every received message before interpreting the body.
- Treats a zero-byte body with no NATS headers as stream termination (§6.5).
- Silently ignores unknown chunk types, unknown endpoint names, and unknown metadata keys.
- Preserves unknown metadata fields when relaying.
- Tracks liveness per `instance_id` (§8.1).

---

## Appendix A: Subject quick reference

```
# Identity and subjects (per §2)
agents.{agent}.{owner}.{name}                   # identity root; default `prompt` endpoint subject
agents.{agent}.{owner}.{name}.heartbeat         # liveness beacon  (protocol-fixed subject)
agents.{agent}.{owner}.{name}.attachments       # default subject for future `attachments` endpoint

# Endpoint subjects are agent-chosen — the two entries above are channel-plugin defaults, not
# mandatory. Callers learn actual endpoint subjects from $SRV.INFO.Synadia Agents.

# Wildcards
agents.>                                        # all agent traffic
agents.{agent}.>                                # all agents on a harness
agents.*.{owner}.>                              # all agents for an owner
agents.*.*.{name}                               # all agent roots with this instance name
agents.*.*.*.heartbeat                          # all heartbeats (protocol-fixed subject)

# Discovery — the only two stable subjects the protocol requires callers to know
$SRV.PING.Synadia Agents                        # enumerate compliant agents (multi-response)
$SRV.INFO.Synadia Agents                        # full service info per instance (multi-response)
$SRV.INFO.Synadia Agents.{instance_id}          # full service info for a specific instance
```

---

## Appendix B: Byte-level wire examples

JSON is shown formatted for readability; the wire uses compact UTF-8 encoding.

### B.1 Plain-text request

Published to `agents.claude-code.aconnolly.synadia-com-2` (the channel-plugin default subject for the `prompt` endpoint — the actual subject comes from `$SRV.INFO`):

```
summarize the attached report
```

Parsed as:

```json
{ "prompt": "summarize the attached report" }
```

### B.2 JSON request (text only)

```json
{"prompt":"summarize the attached report"}
```

### B.3 JSON request (text + attachment)

Valid only when the endpoint's `attachments_ok` metadata is `true`.

```json
{"prompt":"summarize","attachments":[{"filename":"report.pdf","content":"JVBERi0xLjQKJe..."}]}
```

### B.4 Response chunk (string `data`)

```json
{"type":"response","data":"Hello, world."}
```

### B.5 Response chunk (object `data`)

```json
{"type":"response","data":{"text":"Hello, world."}}
```

### B.6 Status chunk — `ack`

```json
{"type":"status","data":"ack"}
```

Emitted during long-running work as a keep-alive. Resets the caller's inactivity timeout (§6.6). The stream continues.

### B.7 Query chunk

```json
{"type":"query","data":{"id":"a8f1c2e4-9b63-4d7e-aaaa-112233445566","reply_subject":"_INBOX.Xj7k9Q2pA","prompt":"Confirm? (yes/no)"}}
```

### B.8 Query reply (plain-text shorthand)

Published to the query's `reply_subject`:

```
yes
```

### B.9 Empty-payload terminator

A NATS message with:

- Zero-byte body.
- No NATS headers.

Published to the reply subject as the final message of every stream — successful or errored.

### B.10 Error signal + terminator

Error-terminated streams end with two messages.

**Message 1** — error signal:

Headers:
```
Nats-Service-Error-Code: 429
Nats-Service-Error: rate limited
```

Body (optional, per §9.1):
```json
{"error":"rate_limited","message":"Too many concurrent requests","retry_after_s":30}
```

**Message 2** — the empty terminator (B.9).

### B.11 Heartbeat

Published to `agents.claude-code.aconnolly.synadia-com-2.heartbeat`:

```json
{"agent":"claude-code","owner":"aconnolly","session":"synadia-com-2","instance_id":"VMKS6MHK71PCPWGY38A7N5","ts":"2026-04-21T14:23:01Z","interval_s":30}
```

### B.12 Service info response

Returned by `$SRV.INFO.Synadia Agents` (one response per instance):

```json
{
  "name": "Synadia Agents",
  "id": "VMKS6MHK71PCPWGY38A7N5",
  "version": "0.0.1",
  "description": "Claude Code — synadia-com-2",
  "metadata": {
    "agent": "claude-code",
    "owner": "aconnolly",
    "session": "synadia-com-2",
    "protocol_version": "0.1"
  },
  "endpoints": [
    {
      "name": "prompt",
      "subject": "agents.claude-code.aconnolly.synadia-com-2",
      "queue_group": "",
      "metadata": {
        "max_payload": "1MB",
        "attachments_ok": true
      }
    }
  ]
}
```

---

## Appendix C: Known agent identifiers (informative)

Informative, not normative. Agent identifiers are not centrally registered (§2.2); the list below captures values in common use so new implementations can pick a non-colliding identifier without coordination.

| `metadata.agent` | Subject abbreviation | Harness / product            | Session semantics                                                                                          |
|------------------|----------------------|------------------------------|------------------------------------------------------------------------------------------------------------|
| `claude-code`    | `ccc`                | Anthropic's Claude Code CLI  | Session-aware. Each session SHOULD be its own registration; `metadata.session` carries the label.           |
| `openclaw`       | `occ`                | OpenClaw agent runtime       | Session-less. `metadata.session` MAY be omitted or set to `"default"`. Instance name often `default`.       |
| `pi`             | `pi`                 | `pi` agent harness           | Session-aware. Same convention as `claude-code`.                                                            |
| `hermes`         | `hermes`             | Hermes agent harness         | Session-aware. Same convention as `claude-code`.                                                            |

Additions to this table are non-normative; deployers SHOULD coordinate before claiming a new identifier to avoid collisions.
