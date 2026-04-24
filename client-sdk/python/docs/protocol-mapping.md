# Protocol mapping

Every SDK call mapped to its section in the
[NATS Agent Protocol spec](https://github.com/synadia-ai/nats-agent-sdk-docs/blob/main/core-protocol.md)
(version `0.2.0-draft`). Intended for implementers of other SDKs and
for reviewers auditing this one.

## Discovery (§4)

| SDK                                      | Wire behaviour                                                                         | Spec ref   |
| ---------------------------------------- | -------------------------------------------------------------------------------------- | ---------- |
| `Client.discover()`                      | Publishes `$SRV.INFO.agents`, collects multi-reply responses until `timeout`.          | §4, §4.1   |
| `Client.ping(timeout)`                   | Publishes `$SRV.PING.agents`; `True` iff any response arrives within `timeout`. For per-instance liveness use `Client.status(inbox)`. | §8.4       |
| Implicit subscribe-before-PING           | Heartbeat wildcard SUB established on `start()` BEFORE any discovery publish.          | §8.5       |
| Service-name filter                      | Accepts only `"agents"`. v0.2 is wire-incompatible with v0.1 (§11.3), so no alias list. | §3.1       |
| Non-agent services                       | Dropped - responses whose `name` isn't `"agents"` are ignored.                         | §4.3       |
| `EndpointInfo.max_payload_bytes`         | Parsed from `metadata.max_payload` (case-insensitive; base-1024: KB=1024, MB=1024²).   | §2.1       |
| `EndpointInfo.attachments_ok`            | Parsed from `metadata.attachments_ok` (`"true"` / `"false"`).                          | §2.1       |
| `DiscoveredAgent.name` derivation        | 4th token of the prompt endpoint's subject when it matches `agents.{a}.{o}.{n}`; else `""`. | §4.3     |
| `DiscoveredAgent.session`                | From `metadata.session` (absent/empty ⇒ `None`).                                       | §3.2       |

## Service registration (§3)

| SDK                        | Wire behaviour                                                                                  | Spec ref   |
| -------------------------- | ----------------------------------------------------------------------------------------------- | ---------- |
| `Agent.start()` service    | `ServiceConfig(name="agents", ...)` - the single shared name from §3.1.                        | §3.1     |
| Service metadata emitted   | `{agent, owner, protocol_version}` + `session` when `Agent(session=...)` is set.                | §3.2       |
| `protocol_version` value   | `"0.2"` - MAJOR.MINOR only (§11.1).                                                             | §3.2, §11.1 |
| Endpoint `prompt` metadata | `{max_payload, attachments_ok}`. Boolean serialised as `"true"`/`"false"` on the wire.          | §2.1       |
| `prompt` queue group       | `"agents"` - pinned explicitly; framework defaults differ between SDKs and would break interop. | §3.3       |
| Subject layout             | `agents.{agent}.{owner}.{name}` - spec default; the SDK doesn't allow overrides today.          | §2, §2.3   |

## Request envelope (§5)

| SDK                                          | Wire behaviour                                                                        | Spec ref   |
| -------------------------------------------- | ------------------------------------------------------------------------------------- | ---------- |
| `RemoteAgent.prompt(text)`                   | Publishes JSON envelope `{"prompt":"..."}` to the prompt endpoint subject.            | §5.1       |
| `RemoteAgent.prompt(text, attachments=[...])`| Adds `attachments: [{filename, content: <base64>}]` per RFC 4648 §4 (standard alphabet, padded). | §5.1, §5.2 |
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
| Subject                      | `agents.{agent}.{owner}.{name}.heartbeat`.                                                       | §8.1       |
| Default interval             | `Agent(heartbeat_interval_s=30)` (spec recommendation).                                          | §8.2       |
| Payload fields               | `{agent, owner, session?, instance_id, ts, interval_s}` - `session` omitted when absent.         | §8.3       |
| `HeartbeatPayload` tolerance | `extra="ignore"` - unknown fields silently accepted per §8.3.                                    | §8.3       |
| `instance_id` source         | `service.id` assigned by nats-py's micro framework (matches `$SRV.INFO` `id`).                   | §3.4, §8.3 |
| First heartbeat              | Published immediately after service registration so subscribe-then-discover sees liveness.       | §8.5       |
| Tracker API                  | `Client.status(inbox)` → `AgentStatus` (indexed by subject). Multi-instance indexing is TODO.    | §8.2       |
| Liveness threshold           | `AgentStatus.is_online(slack=3)` - configurable `slack × interval_s`.                            | §8.2       |

## Versioning (§11)

| SDK                   | Wire behaviour                                                                                                     | Spec ref |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ | -------- |
| Protocol version      | Agent registers `metadata.protocol_version = "0.2"`. Callers compare MAJOR.MINOR only.                             | §11.1    |
| Compatibility         | Same MAJOR.MINOR ⇒ full interop. Forward compat rides on §5.6 and §6.6 (unknown fields / chunk types tolerated).   | §11.2    |
| SDK version (`version` service field) | `_SDK_VERSION = "0.2.0"` - harness version, distinct from protocol version.                         | §3.1, §11 |

## Security (§10)

| SDK                                   | Wire behaviour                                                                                 | Spec ref |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- | -------- |
| Authentication                        | Delegated to NATS connection (`nats.connect(...)`); SDK adds no handshake.                     | §10.1    |
| NATS context support (`~/.config/nats/context/`) | Not implemented today - context loading is a caller-side concern in both SDKs (callers pass explicit `servers` / creds / authenticator to the underlying NATS client). Tracked as a follow-up if we decide to add a shared helper.  | §10.2    |

## Cancellation (§6.7)

| SDK                    | Wire behaviour                                                                         | Spec ref |
| ---------------------- | -------------------------------------------------------------------------------------- | -------- |
| Early `break`          | Exits the async-for; `finally` unsubscribes the reply inbox; agent is not notified.    | §6.7     |
| `Client.stop()`        | Unsubscribes the heartbeat tracker; in-flight `prompt()` iterators must be unwound by the caller. | §6.7 |
| No wire-level cancel   | Not sent - spec defines none; NATS interest-based delivery handles it server-side.     | §6.7     |

## Open questions flagged upstream

These reflect points where the spec is silent and the SDK picked a default; both choices
mirror the TypeScript SDK so the two stay in lockstep.

1. **`max_payload` base (§2.1).** 1024 vs 1000 - spec silent. SDK uses **1024** (NATS server convention).
2. **Size-unit case sensitivity (§2.1).** Spec silent. SDK parses **case-insensitive**.
3. **Unparseable `max_payload` value (§2.1).** `EndpointInfo.max_payload_bytes` is `None`; raw string preserved in `metadata`. No local enforcement - the agent decides server-side.
