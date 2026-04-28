# Protocol mapping

Every SDK call mapped to its section in the
[NATS Agent Protocol spec](https://github.com/synadia-ai/nats-agent-sdk-docs/blob/main/core-protocol.md)
(spec target: v0.3 verb-first wire). Intended for implementers of other
SDKs and for reviewers auditing this one. The Python SDK currently ships
**ahead** of the spec text — see "Open questions flagged upstream" below
for the verb-first-shape and `status`-endpoint additions waiting on the
spec to catch up.

## Discovery (§4)

| SDK                                      | Wire behaviour                                                                         | Spec ref   |
| ---------------------------------------- | -------------------------------------------------------------------------------------- | ---------- |
| `Agents.discover()`                      | Publishes `$SRV.INFO.agents`, collects multi-reply responses (stall by default; `timeout=` switches to timer strategy). | §4, §4.1 |
| `Agents.ping(instance_id, timeout=...)`  | Publishes `$SRV.PING.agents.{instance_id}`; `True` iff a reply arrives within `timeout`. | §8.4    |
| Implicit subscribe-before-PING           | Heartbeat wildcard SUB established lazily on the first `discover()`/`on_heartbeat()` BEFORE any discovery publish. | §8.5 |
| Service-name filter                      | Accepts only `"agents"`. v0.2 is wire-incompatible with v0.1 (§11.3), so no alias list. | §3.1       |
| Non-agent services                       | Dropped - responses whose `name` isn't `"agents"` are ignored.                         | §4.3       |
| `EndpointInfo.max_payload_bytes`         | Parsed from `metadata.max_payload` (case-insensitive; base-1024: KB=1024, MB=1024²).   | §2.1       |
| `EndpointInfo.attachments_ok`            | Parsed from `metadata.attachments_ok` (`"true"` / `"false"`).                          | §2.1       |
| `AgentInfo.name` derivation              | 5th token of the prompt endpoint's subject when it matches `agents.prompt.{a}.{o}.{n}` (v0.3); else `""`. | §4.3     |
| `AgentInfo.session`                      | From `metadata.session` (absent/empty ⇒ `None`).                                       | §3.2       |

## Service registration (§3)

| SDK                        | Wire behaviour                                                                                  | Spec ref   |
| -------------------------- | ----------------------------------------------------------------------------------------------- | ---------- |
| `AgentService.start()`     | `ServiceConfig(name="agents", ...)` - the single shared name from §3.1.                        | §3.1     |
| Service metadata emitted   | `{agent, owner, protocol_version}` + `session` when `AgentService(session=...)` is set.         | §3.2       |
| `protocol_version` value   | `"0.3"` - MAJOR.MINOR only (§11.1).                                                             | §3.2, §11.1 |
| Endpoint `prompt` metadata | `{max_payload, attachments_ok}`. Boolean serialised as `"true"`/`"false"` on the wire.          | §2.1       |
| `prompt` queue group       | `"agents"` - pinned explicitly; framework defaults differ between SDKs and would break interop. | §3.3       |
| `status` endpoint          | Registered alongside `prompt` with subject `agents.status.{a}.{o}.{n}` and queue group `"agents"` (v0.3, §-TBD). Replies with a freshly-built `HeartbeatPayload` (§8.3 shape). | v0.3 §-TBD |
| Subject layout             | `agents.{verb}.{agent}.{owner}.{name}` (v0.3 verb-first); the SDK doesn't allow overrides today. | §2, §2.3   |

## Request envelope (§5)

| SDK                                          | Wire behaviour                                                                        | Spec ref   |
| -------------------------------------------- | ------------------------------------------------------------------------------------- | ---------- |
| `Agent.prompt(text)`                         | Publishes JSON envelope `{"prompt":"..."}` to the prompt endpoint subject.            | §5.1       |
| `Agent.prompt(text, attachments=[...])`      | Adds `attachments: [{filename, content: <base64>}]` per RFC 4648 §4 (standard alphabet, padded). | §5.1, §5.2 |
| Plain-text request shorthand                 | NOT emitted by this SDK; always JSON. Decoders accept it per §5.3.                    | §5.3       |
| Pre-publish `attachments_ok` check           | `AttachmentsNotSupportedError` before any wire I/O.                                   | §5.4       |
| Pre-publish `max_payload` check              | `PayloadTooLargeError(limit, actual)` before any wire I/O.                            | §5.4       |
| Empty prompt rejected pre-publish            | `PromptEmptyError` before any wire I/O.                                               | §5.1, §5.3 |
| Endpoint subject resolution                  | Always `endpoints[].subject` from discovery; never constructed from identity.         | §4.3, §12  |
| Unknown envelope fields                      | `Envelope` uses `extra="allow"`; decode → encode round-trips lossless per §5.6.       | §5.6       |
| `Envelope.session`                           | SDK convention tolerated per §5.6 (no longer a §5.1 field in v0.2); still round-trips. | §5.6      |

## Response streaming (§6)

| SDK                                  | Wire behaviour                                                                              | Spec ref   |
| ------------------------------------ | ------------------------------------------------------------------------------------------- | ---------- |
| Stream start                         | Fresh `_INBOX` reply subject; SUB established before request PUBLISH.                       | §6.1       |
| `ResponseChunk.text`                 | Decoded from `{"type":"response","data":"..."}` OR `{...,"data":{text, attachments?}}`.     | §6.3       |
| `StatusChunk.status`                 | Decoded from `{"type":"status","data":"<token>"}`. Unknown tokens flow through unchanged.   | §6.4, §6.6 |
| `QueryChunk` → `Query` event         | Decoded from `{"type":"query","data":{id, reply_subject, prompt, attachments?}}`.           | §7         |
| Unknown chunk `type`                 | `decode_chunk` returns `None`; the stream iterator drops it and continues.                  | §6.6       |
| Plain-text on response side          | **Rejected** - `decode_chunk` requires JSON with a `type` discriminator.                    | §6.2       |
| Stream terminator                    | Empty body AND no NATS headers. Error frames carry headers and are NOT terminators.         | §6.5, §9.3 |
| `PromptStream.send(str)`             | Wraps the string in a `ResponseChunk`, emits the §6.3 bare-string form.                     | §6.3       |
| Per-stream inactivity timeout        | Caller-supplied `timeout=` kwarg; raises `ProtocolError("stream stalled")` on lapse.        | §6.6       |

## Errors (§9)

| SDK                    | Wire behaviour                                                                          | Spec ref |
| ---------------------- | --------------------------------------------------------------------------------------- | -------- |
| Agent error emission   | `respond_error(code, description)` + subsequent empty-headerless terminator.            | §9.1, §9.3 |
| Description sanitation | Newlines collapsed to ` \| `, capped at 200 chars (NATS headers are single-line).       | §9.1     |
| Caller error surfacing | `ProtocolError(f"service error {code}: {desc}")` raised from the iterator.              | §9.1     |
| Status taxonomy        | 400 / 401 / 403 / 404 / 409 / 429 / 500 propagated verbatim; callers match on `code`.   | §9.2     |
| JSON error body        | Optional per §9.1; not currently parsed into a structured field (follow-up).            | §9.1     |

## Mid-stream query (§7)

| SDK                         | Wire behaviour                                                                           | Spec ref |
| --------------------------- | ---------------------------------------------------------------------------------------- | -------- |
| `PromptStream.ask(prompt)`  | Emits a `query` chunk with a fresh `_INBOX` reply subject and awaits one reply.          | §7.1, §7.2 |
| `Query.reply(str)`          | Publishes §5.3 plain-text shorthand bytes to `reply_subject`.                            | §7.2     |
| `Query.reply(Envelope)`     | Publishes `{"prompt":...,"attachments":...}` to `reply_subject`.                         | §7.2     |
| No ack                      | Fire-and-forget - the publish awaits the NATS publish buffer only.                       | §7.2     |
| Concurrent queries          | Supported via `asyncio.gather`; each query carries a distinct `reply_subject` + `id`.    | §7.3     |
| `QueryTimeout`              | `ask(timeout=...)` - handler catches to proceed with a default or re-raise.              | §7.3     |

## Heartbeat (§8)

| SDK                          | Wire behaviour                                                                                   | Spec ref   |
| ---------------------------- | ------------------------------------------------------------------------------------------------ | ---------- |
| Subject                      | `agents.hb.{agent}.{owner}.{name}` (v0.3 verb-first; `hb` abbreviates `heartbeat`).              | §8.1       |
| Default interval             | `AgentService(heartbeat_interval_s=30)` (spec recommendation).                                   | §8.2       |
| Payload fields               | `{agent, owner, session?, instance_id, ts, interval_s}` - `session` omitted when absent.         | §8.3       |
| `HeartbeatPayload` tolerance | `extra="ignore"` - unknown fields silently accepted per §8.3.                                    | §8.3       |
| `instance_id` source         | `service.id` assigned by nats-py's micro framework (matches `$SRV.INFO` `id`).                   | §3.4, §8.3 |
| First heartbeat              | Published immediately after service registration so subscribe-then-discover sees liveness.       | §8.5       |
| Tracker API                  | `Agents.liveness(instance_id)` → `Liveness \| None` (keyed on `payload.instance_id`).            | §8.2       |
| Liveness threshold           | `Liveness.is_online` precomputed at read time against `DEFAULT_LIVENESS_SLACK × interval_s`.     | §8.2       |

## Versioning (§11)

| SDK                   | Wire behaviour                                                                                                     | Spec ref |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ | -------- |
| Protocol version      | Agent registers `metadata.protocol_version = "0.3"`. Callers compare MAJOR.MINOR only.                             | §11.1    |
| Compatibility         | Same MAJOR.MINOR ⇒ full interop. Forward compat rides on §5.6 and §6.6 (unknown fields / chunk types tolerated).   | §11.2    |
| SDK version (`version` service field) | Read from `pyproject.toml` via `importlib.metadata.version("synadia-ai-agents")` - harness version, distinct from protocol version. | §3.1, §11 |

## Security (§10)

| SDK                                   | Wire behaviour                                                                                 | Spec ref |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- | -------- |
| Authentication                        | Delegated to NATS connection (`nats.connect(...)`); SDK adds no handshake.                     | §10.1    |
| NATS context support (`~/.config/nats/context/`) | `load_context_options(name)` translates a `nats` CLI context into kwargs for `nats.connect(...)`. Supports `url`, `creds` (with `~` expansion), `user_jwt`, `user`/`password`/`token`, `inbox_prefix`. `nkey`, TLS triple, and `nsc://...` URLs raise `NatsContextError`.  | §10.2    |

## Cancellation (§6.7)

| SDK                    | Wire behaviour                                                                         | Spec ref |
| ---------------------- | -------------------------------------------------------------------------------------- | -------- |
| Early `break`          | Exits the async-for; `finally` unsubscribes the reply inbox; agent is not notified.    | §6.7     |
| `Agents.close()`       | Unsubscribes the heartbeat tracker and signals in-flight `prompt()` iterators to short-circuit; the underlying `NatsConnection` is caller-owned and untouched. | §6.7 |
| No wire-level cancel   | Not sent - spec defines none; NATS interest-based delivery handles it server-side.     | §6.7     |

## Open questions flagged upstream

These reflect points where the spec is silent and the SDK picked a default; both choices
mirror the TypeScript SDK so the two stay in lockstep.

1. **`max_payload` base (§2.1).** 1024 vs 1000 - spec silent. SDK uses **1024** (NATS server convention).
2. **Size-unit case sensitivity (§2.1).** Spec silent. SDK parses **case-insensitive**.
3. **Unparseable `max_payload` value (§2.1).** `EndpointInfo.max_payload_bytes` is `None`; raw string preserved in `metadata`. No local enforcement - the agent decides server-side.
4. **Verb-first subject hierarchy (§2 v0.3).** Spec text still describes
   the v0.2 noun-first layout (`agents.{a}.{o}.{n}` plus `.heartbeat`
   sub-subject). This SDK ships the verb-first form
   (`agents.{verb}.{a}.{o}.{n}`) ahead of the spec text so a working
   reference exists for the spec PR + the TS SDK port. Companion work
   tracked in `CHANGELOG.md` [Unreleased] under "Anticipated companion
   work".
5. **`status` request/response endpoint.** Not yet defined in the spec.
   This SDK registers a NATS micro endpoint named `status` on
   `agents.status.{a}.{o}.{n}` (queue group `"agents"`) that replies
   with the §8.3 heartbeat payload, freshly built per request.
   Anticipated to land in the spec as a §-TBD section once the verb-
   first PR settles.

## Deferred TS-parity work

Items surfaced during the 2026-04-26 TS-parity sweep that were
intentionally **not** addressed in that round, kept here so the team
can decide which ones land in a follow-up. Each entry says **what**
the gap is, **why** it matters, and a hint at the **next step**.

### Convenience features the TS reference harnesses ship that the Python SDK doesn't

1. **Session-name auto-resolution at `Agent.start()`.**
   PI's harness (`agents/pi/extensions/nats-channel.ts` ~lines 356-377)
   queries `$SRV.INFO.agents` on startup, sees a name collision, and
   auto-suffixes `-2`, `-3`, … so two PI instances under the same owner
   don't fight over a single subject. Python `Agent(name=...)` registers
   the name as-given; collisions are the developer's problem. Convenience,
   not wire-compat. Next step: optional `Agent(autosuffix=True)` mirroring
   the PI behaviour.

2. **Filesystem attachment-staging helper.**
   PI and Claude Code stage base64-decoded attachments to disk under
   `ATTACHMENT_DIR/{requestId}` so handlers can pass file paths to
   tools (shell-outs, MCP servers, etc.). Python keeps attachments
   in-memory on `Envelope.attachments` and leaves staging to the
   developer. Next step: an `Attachment.stage_to(path)` helper that
   handles tempdir creation, RFC 4648 base64 decode, and safe filename
   sanitisation in one call.

### Behavioural divergences (both spec-valid, different shape)

3. **Bare-string vs JSON-wrapped `response` chunks (§6.3).**
   Python's `encode_chunk(ResponseChunk)` emits the bare-string
   shorthand `{"type":"response","data":"<text>"}` when there are no
   attachments; the TS reference harnesses always emit the wrapped
   `{"text":...,"attachments":[]}` form even for text-only. Both are
   valid per §6.3. Worth aligning before any cross-SDK assertion test
   tries to compare exact wire bytes. Next step: pick one as the
   canonical Python emit shape, document in CHANGELOG.

4. **Pending-request TTL on mid-stream `ask()` queries (§7).**
   TS harnesses prune pending request state >30 minutes old (defends
   against memory leaks from caller-dropped queries). Python's
   `PromptStream.ask()` pending replies are bounded by an explicit
   `timeout=` and the surrounding handler's lifetime, so the failure
   mode is "handler hangs forever" rather than "memory leak"; still,
   a global ceiling parallel to TS's would be a useful belt. Next
   step: cap `ask()` at a sensible upper bound or document that
   handlers are responsible for setting `timeout=`.

### Caller-side parity confirmed but not test-covered

5. **`Agents.close_event` exposed for lazy materialisation.**
   Python's `Agents` exposes a public `close_event: asyncio.Event`
   (the analogue of TS's `closeSignal: AbortSignal`) so callers that
   build `Agent` instances outside `discover()` (e.g. from a heartbeat
   + `$SRV.INFO.agents.{id}` direct lookup) can pass it to the `Agent`
   constructor. In-flight prompt streams on those handles then
   short-circuit when `Agents.close()` is called. Not currently
   exercised by an e2e test — covered by code review.

6. **`NatsContextError` aligned with TS.**
   v0.3.0 collapses the previous `ContextNotFoundError` /
   `ContextNotSelectedError` / `ContextInvalidError` /
   `ContextNotSupportedError` classes into a single `NatsContextError`
   matching the TS SDK's surface. Branch on the class, not on
   sub-types; the message carries actionable detail.

### Behaviour-change risks introduced by the 2026-04-26 sweep

7. **Default-on 30 s keep-alive ack.**
   `AgentService` emits a `status="ack"` chunk every 30 s during
   long-running handlers by default (`keepalive_interval_s=30.0`).
   This is extra wire traffic vs prior Python releases - quiet
   handlers that comfortably fit under the TS SDK's 60 s stream
   inactivity timeout don't need it. No spec violation (§6.4 status
   chunks are at the agent's discretion). Pass
   `keepalive_interval_s=None` to disable. Next step: monitor for
   integrator complaints; consider documenting "when to disable" as
   the SDK matures.
