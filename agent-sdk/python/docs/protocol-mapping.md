# Protocol mapping (agent-side)

> **Deferred.** A full agent-side mapping table — `AgentService.start()`
> → `$SRV.INFO` shape, response-stream emission per §6, etc. — is
> coming in a follow-up PR. For the v0.1.0 release it suffices to
> point readers at the existing client-sdk mapping, which already
> covers both sides of the protocol.

See
[`../../../client-sdk/python/docs/protocol-mapping.md`](../../../client-sdk/python/docs/protocol-mapping.md)
for every SDK call mapped to its spec section. Rows describing
`AgentService`, `PromptStream`, the heartbeat publisher, and the
status handler describe behavior shipped from **this** package now;
the wire shapes themselves are unchanged.
