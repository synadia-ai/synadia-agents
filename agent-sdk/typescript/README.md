# @synadia-ai/agent-service

Server-side TypeScript SDK for the NATS Agent Protocol — host an agent
(`AgentService`, `ReferenceAgent`, server-side wire helpers).

Pairs with [`@synadia-ai/agents`](../../client-sdk/typescript/) (the
caller-side SDK). Agent harness authors install both:

```sh
npm install @synadia-ai/agents @synadia-ai/agent-service
```

The two packages are versioned in lockstep. See the root
[`README.md`](../../README.md) and the
[`CLAUDE.md`](../../CLAUDE.md) for the broader repo overview.

## Status

Pre-publish. The package is consumed inside this monorepo via a `file:`
link to the sibling caller checkout. Not yet published to npm.
