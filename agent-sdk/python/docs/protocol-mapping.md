# Protocol mapping (agent-side)

> **Core protocol rows: deferred.** A full agent-side mapping table for
> the 0.3 core — `AgentService.start()` → `$SRV.INFO` shape,
> response-stream emission per §6, etc. — is still a follow-up. See
> [`../../../client-sdk/python/docs/protocol-mapping.md`](../../../client-sdk/python/docs/protocol-mapping.md)
> for every SDK call mapped to its spec section; rows describing
> `AgentService`, `PromptStream`, the heartbeat publisher, and the
> status handler describe behavior shipped from **this** package now;
> the wire shapes themselves are unchanged.

## Sender identity (optional extension)

The sender-identity extension is additive on top of the unchanged 0.3
protocol. This package ships the **receiver** side over the
shared codec in `synadia-ai-agents` (`synadia_ai.agents.identity`); it
adds only the stateful parts.

| SDK | Wire behaviour | Spec ref |
| --- | --- | --- |
| `AgentService.start()` registration | Omitted `identity` performs no self lookup and registers no `user_nkey`, `account`, or `id_sig`; explicit `ServiceIdentity()` attempts unsigned metadata; a signer requires uncached live user/account binding and makes any binding failure fatal. `id_sig` is `AGENT-ID-V1\n{user}\n{account}\n{agent}\n{owner}\n{prompt_subject}\n`. `min_sender_trust` is **always** on prompt metadata, defaults to `"any"`, and is never on `status`. `protocol_version` stays `"0.3"`. | Registration, Declaring the requirement, Relation to protocol 0.3 |
| `prompt` dispatch order | envelope `400` → header parse `400` → (`ts` window / `sub` acceptance / operator-attested cross-check / nonce lookup / ed25519) `401` → `signed` + unsigned `401 signature required` → nonce **record** (check-and-set, last) → `accept_sender` `403` (verified) / `401` (claimed, absent) / raise `500 server error` → §6.4 ack → handler. A refusal is the §9 error frame + the §9.3 terminator, no ack. Two wire descriptions only: `signature required` and `sender rejected`; the detail goes to the log. | Verification (the check order is advisory: cheap checks first, same outcome) |
| `PromptStream.sender` | `VerifiedSender` (`id`, `account_attested`, `resolve()` bound to the host's `SenderResolver`), `ClaimedSender` (`claim`, no `id`), or `None` for no header / unknown `v`. | Verification, Reverse lookup |
| Nonce set (`NonceCache`) | Per instance, keyed `(user, nonce)`; entries expire at `ts + replay_window_s` (default 30 s), never at arrival + window; second-bucketed sweeps; hard cap (100 000, oldest evicted, warned once per overload); `record()` is the synchronous CAS — no `await` between the last check and the record. Not shared across queue-group instances; a restart empties it. | Verification |
| `status` | Classified through the same gate before the reply (never spawned); a failing classification is logged and the reply is sent anyway; a verified prober's nonce enters the shared set; `accept_sender` never runs. | Declaring the requirement |
| `account_token_position` | Validated (1-based int) and passed to the shared verifier: the arrival token at that position MUST equal the header's `account`; `sub` accepted by equality or by token removal. `AgentService` hosts five-token subjects, so hosting *behind* such an export needs a hand-rolled service on the wildcard subject (`SenderGate` / `verify_sender_header`). | Verification |
| `operator_attested` | Off by default. Signed headers only: a present `Nats-Request-Info` `acc` / `user` must equal the signed pair, a stamp the server would not write → `401`, an absent stamp is compared to nothing; agreement on `acc` — or the `account_token_position` cross-check — sets `account_attested` (`format_sender` → `(verified)`). The header is read nowhere else. | Appendix A |
| `resolve_ttl_s` | TTL of the `$SRV.INFO.agents` index behind `sender.resolve()` (default 10 s; `0` enumerates per call); account-local; identifies, never authorizes. | Reverse lookup |
| Logging | Every served request is logged at DEBUG and every refusal at WARNING with the sender rendered by `format_sender` (trust class next to the id); foreign strings are `repr`-quoted. | Registration ("show the trust class") |
| Prompt responses / query replies | Not independently signed. A response or approval actor is not inferred from the original prompt sender. | Protocol boundary |

Not in the spec (SDK choices, shared with the TypeScript host): the
generic wire descriptions, the nonce-cache cap and its hysteresis, the
`500 server error` text for a raising hook, and the flush at the end of
`start()`.
