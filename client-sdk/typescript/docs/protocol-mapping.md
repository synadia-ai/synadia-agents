# Protocol mapping

Every SDK call mapped to its Synadia Agent Protocol for NATS section, for implementers of other SDKs or reviewers auditing this one. Section numbers refer to `core-protocol.md`.

## Discovery (§4)

| SDK                            | Wire behaviour                                                                                          | Spec ref  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- | --------- |
| `agents.discover()`            | Publishes `$SRV.INFO.agents` via `@nats-io/services`, gathers multi-replies.                            | §4, §4.1  |
| `agents.ping(instanceId)`      | Publishes `$SRV.PING.agents.{instanceId}`; `true` iff any response arrives.                             | §8.4      |
| Implicit subscribe-before-PING | On first `discover()`, heartbeat wildcard SUB is established + flushed BEFORE PING.                     | §8.5      |
| Filter by service name         | Accepts `"agents"` only; the pre-0.2 names `"Synadia Agents"` / `"SynadiaAgents"` are silently dropped. | §3.1      |
| Non-agent services             | Silently dropped - matches only services whose `name` is the protocol value.                            | §4.3      |
| `Agent.metadata`               | Preserves all unknown metadata keys verbatim.                                                           | §5.6, §12 |
| `EndpointInfo.queueGroup`      | Read from `$SRV.INFO.endpoints[].queue_group`. Prompt endpoint MUST be `"agents"` (§3.3).               | §3.3      |
| `EndpointInfo.maxPayloadBytes` | Parsed from `metadata.max_payload` (case-insensitive; base-1024: KB=1024, MB=1024²).                    | §2.1      |
| `EndpointInfo.attachmentsOk`   | Parsed from `metadata.attachments_ok` (`"true"` / `"false"`).                                           | §2.1      |

## Request envelope (§5)

| SDK                                  | Wire behaviour                                                                                                                                                                    | Spec ref   |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `remote.prompt(text)`                | Publishes JSON envelope `{"prompt":"..."}` to the prompt endpoint subject.                                                                                                        | §5.1       |
| `remote.prompt(text, {attachments})` | Adds `attachments: [{filename, content: <base64>}]` per RFC 4648 §4.                                                                                                              | §5.1, §5.2 |
| Plain-text shorthand                 | **Not emitted.** SDK always sends JSON (spec allows but doesn't require plain text).                                                                                              | §5.1       |
| Pre-publish `attachments_ok`         | Throws `AttachmentsNotSupportedError` locally - no wire traffic.                                                                                                                  | §5.4       |
| Pre-publish `max_payload`            | Throws `PayloadTooLargeError` on serialized UTF-8 byte length. Effective limit is `min(endpoint.maxPayloadBytes, nc.info?.max_payload)` — caller's broker cap binds when smaller. | §5.4       |
| Empty prompt                         | Throws `PromptEmptyError` locally.                                                                                                                                                | §5.1, §5.3 |
| Endpoint subject resolution          | Always `endpoints[].subject` from the discovery record - never constructed.                                                                                                       | §4.3, §12  |
| Unknown envelope fields              | Preserved by decoders; the SDK's reference agent passes them through.                                                                                                             | §5.6       |

## Response streaming (§6)

| SDK                                  | Wire behaviour                                                                          | Spec ref   |
| ------------------------------------ | --------------------------------------------------------------------------------------- | ---------- |
| Stream start                         | Fresh `_INBOX` reply subject; SUB established + flushed before PUBLISH.                 | §6.1       |
| `{ type: "response", text }`         | Decoded from `{"type":"response","data":"..."}` OR `{...,"data":{text, attachments?}}`. | §6.3       |
| `{ type: "status", status }`         | Decoded from `{"type":"status","data":"<token>"}`. `ack` resets inactivity timer.       | §6.4, §6.6 |
| `{ type: "query", ... }`             | Decoded from `{"type":"query","data":{id, reply_subject, prompt, attachments?}}`.       | §7         |
| `{ type: "status", status: "done" }` | Synthetic - emitted by SDK before iterator return on terminator.                        | §6.4       |
| Unknown chunk types                  | Silently dropped; iterator continues.                                                   | §6.6       |
| Stream terminator                    | Detected as empty body AND no NATS headers.                                             | §6.5       |
| Error signal + terminator            | Error-headered message → `ServiceError`; terminator following is consumed internally.   | §9.3, §6.5 |
| Per-stream inactivity timeout        | Default 60 s; resets on ANY delivered chunk (including `status: ack`).                  | §6.6       |

## Errors (§9)

| SDK                        | Wire behaviour                                                             | Spec ref |
| -------------------------- | -------------------------------------------------------------------------- | -------- |
| `ServiceError.code`        | Integer parsed from `Nats-Service-Error-Code` header.                      | §9.1     |
| `ServiceError.description` | From `Nats-Service-Error` header.                                          | §9.1     |
| `ServiceError.body`        | Parsed from JSON body when present (optional).                             | §9.1     |
| Status taxonomy            | 400 / 401 / 403 / 404 / 409 / 429 / 500 surfaced verbatim; callers branch. | §9.2     |

## Mid-stream query (§7)

| SDK                          | Wire behaviour                                                            | Spec ref |
| ---------------------------- | ------------------------------------------------------------------------- | -------- |
| `query.reply(string)`        | Publishes plain-text (shorthand per §5.1) to the query's `reply_subject`. | §7.2     |
| `query.reply({prompt, ...})` | Publishes JSON envelope to the query's `reply_subject`.                   | §7.2     |
| Fire-and-forget              | Resolves after the publish is flushed; no agent-side ack is defined.      | §7.2     |
| Concurrent queries           | Supported - each query carries a distinct `reply_subject`.                | §7.3     |
| Double-reply protection      | Second call throws `QueryAlreadyRepliedError`.                            | -        |

## Heartbeat (§8)

| SDK                      | Wire behaviour                                                                        | Spec ref   |
| ------------------------ | ------------------------------------------------------------------------------------- | ---------- |
| Subject                  | `agents.*.*.*.heartbeat` (fixed wildcard). Callers filter via `discover({ filter })`. | §8.1, §8.5 |
| Payload required fields  | `agent`, `owner`, `instance_id`, `ts`, `interval_s`. `session` when present.          | §8.3       |
| Unknown heartbeat fields | Preserved on `HeartbeatPayload.extras`.                                               | §8.3, §12  |
| Tracker keying           | `instance_id` (from the payload), NOT the subject. Multi-instance safe.               | §3.3, §8.3 |
| Liveness                 | `isOnline === (age < 3 × interval_s)`.                                                | §8.2       |
| Start timing             | Tracker SUB established + flushed before first `$SRV.PING`.                           | §8.5       |

## Versioning (§11)

| SDK                        | Wire behaviour                                                                     | Spec ref |
| -------------------------- | ---------------------------------------------------------------------------------- | -------- |
| `SDK_PROTOCOL_VERSION`     | `{ major: 0, minor: 2 }`.                                                          | §11      |
| `compareProtocolVersion()` | `compatible` (exact MAJOR.MINOR) / `minor-drift` / `incompatible` (MAJOR differs). | §11.2    |
| Version parsing            | Drops patch + pre-release (`"0.2.0-draft"` → `{ major:0, minor:2 }`).              | §11.1    |

## Security / credentials (§10)

| SDK                  | Wire behaviour                                                                                         | Spec ref |
| -------------------- | ------------------------------------------------------------------------------------------------------ | -------- |
| Connection ownership | Caller builds the `NatsConnection` and passes it to `new Agents({ nc })`. SDK delegates auth entirely. | §10.1    |
| Authentication       | Delegated entirely to NATS server configuration - the protocol defines no handshake.                   | §10.1    |

## Cancellation (§6.7)

| SDK                          | Wire behaviour                                                         | Spec ref |
| ---------------------------- | ---------------------------------------------------------------------- | -------- |
| `stream.cancel()`            | Unsubscribes the reply inbox; iterator exits cleanly.                  | §6.7     |
| Early `break` from for-await | Triggers `Symbol.asyncIterator.return()` → same cleanup as `cancel()`. | §6.7     |
| `opts.signal` (AbortSignal)  | Iterator throws `signal.reason` when aborted.                          | §6.7     |
| `agents.close()`             | Aborts ALL in-flight streams via a shared AbortController.             | §6.7     |
| Wire-level cancel message    | **Not sent** - spec defines none; interest-based delivery handles it.  | §6.7     |

## Open questions flagged upstream

1. `max_payload` base: 1024 vs 1000 - spec silent. SDK uses **1024** (NATS server convention).
2. Size-unit case sensitivity - spec silent. SDK parses **case-insensitive**.
3. Whether SDKs SHOULD emit a synthetic `status: done` - spec permits but doesn't recommend. This SDK always emits.
