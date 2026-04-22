# Client SDKs

Language SDKs that speak the **NATS Agent Protocol** (`0.2.0-draft`). Each SDK is the *caller* side: it discovers agents, sends prompts (with optional attachments), and streams typed response chunks back.

## Available SDKs

| Language   | Path                 | Package            | Runtime                  | Status      |
| ---------- | -------------------- | ------------------ | ------------------------ | ----------- |
| TypeScript | `typescript/`        | `@synadia/agents`  | Node ≥ 20, Bun ≥ 1.2     | pre-release |
| Python     | `python/`            | `natsagent`        | Python ≥ 3.11            | pre-release |

(Go and other languages are planned but not yet in-tree.)

## What every SDK must provide

Every compliant SDK exposes the same primitives — names may vary by idiom, semantics do not:

| Primitive                  | Purpose                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `connect(options)`         | Open a NATS connection. Accepts a NATS CLI context name or raw server URLs.                |
| `discover({ timeoutMs })`  | Enumerate agents via `$SRV.PING.agents`. Subscribe-before-ping is the SDK's responsibility.|
| `bind(agent)` → `remote`   | Wrap a discovered agent descriptor for subsequent calls.                                   |
| `remote.prompt(text, opts)`| Send an envelope, return an async iterable over typed chunks (`response`, `status`, `query`). |
| `liveness(id)` / heartbeat | Track `agents.<type>.<owner>.<session>.heartbeat` for up/down state without polling.       |
| `ping(id)`                 | On-demand `$SRV.PING.agents.<id>`.                                                         |

**Local validation is mandatory.** Oversized payloads, unsupported attachments, and invalid base64 must be rejected **before** hitting the wire, by inspecting the target agent's advertised `max_payload` and `attachments_ok`. This is spec §5.4.

## Protocol reference

- **Spec:** <https://github.com/synadia-ai/nats-agent-sdk-docs> (external).
- **Subject format:** `agents.<type-token>.<owner>.<session>` for prompts; `.heartbeat` suffix for liveness.
- **Request body:** plain UTF-8 text OR JSON `{"prompt": "...", "attachments": [{"filename": "...", "content": "<base64>"}]}`. Base64 must be RFC 4648 §4 (standard alphabet, padded, no URL-safe, no whitespace).
- **Response chunks:**
  - `{"type":"response","data":"<text>"}` — content delta
  - `{"type":"status","data":"ack"}` — accepted / keep-alive
  - `{"type":"query","data":{...}}` — mid-stream question; reply to `reply_subject`
- **Terminator:** empty body **and no headers**.
- **Errors:** `Nats-Service-Error-Code: 400` (client) or `500` (server) header on an otherwise-empty final message.

## Adding a new language SDK

1. Create `client-sdk/<lang>/` with the language's standard project layout.
2. Implement the primitives above. Re-use the canonical test vectors from `typescript/test/` where possible.
3. Verify against the `testing` sub-export's `ReferenceAgent` (TypeScript ships one; other languages can translate it).
4. Add a row to the table above and a paragraph describing any language-idiomatic divergences.

Agents can be tested against any SDK interchangeably — the wire is the contract, not the API shape.
