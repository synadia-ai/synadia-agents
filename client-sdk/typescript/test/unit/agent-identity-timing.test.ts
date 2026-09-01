import { Empty, type Msg, type MsgHdrs, type NatsConnection } from "@nats-io/nats-core";
import { createUser } from "@nats-io/nkeys";
import { describe, expect, it } from "vitest";
import { Agent } from "../../src/agent.js";
import { buildAgentInfo, type RawServiceInfo } from "../../src/discovery/agent-info.js";
import { newAgentId, type AgentId } from "../../src/identity/agent-id.js";
import type { IdentityContext, SenderHeaderPlan } from "../../src/identity/context.js";
import {
  AGENT_SENDER_HEADER,
  buildClaimHeader,
  parseSenderHeader,
} from "../../src/identity/sender-header.js";

function info(): RawServiceInfo {
  return {
    name: "agents",
    id: "VMKS6MHK71PCPWGY38A7N5",
    version: "1.0.0",
    description: "test agent",
    metadata: {
      agent: "echo",
      owner: "test",
      session: "main",
      protocol_version: "0.3",
    },
    endpoints: [
      {
        name: "prompt",
        subject: "agents.prompt.echo.test.main",
        queue_group: "agents",
        metadata: {
          max_payload: "1MB",
          attachments_ok: "true",
          min_sender_trust: "any",
        },
      },
    ],
  };
}

function plan(id: AgentId, sub: string): SenderHeaderPlan {
  return {
    id,
    signed: false,
    sub,
    wireBytes: 256,
    build: () => Promise.resolve(buildClaimHeader({ id })),
  };
}

describe("Agent prompt identity timing", () => {
  it("re-plans identity at first iteration instead of publishing a pre-reconnect plan", async () => {
    const beforeKey = createUser();
    const afterKey = createUser();
    const before = newAgentId("$G", beforeKey.getPublicKey());
    const after = newAgentId("$G", afterKey.getPublicKey());
    let current = before;
    let planCalls = 0;
    let publishedHeaders: MsgHdrs | undefined;

    const identity = {
      signer: undefined,
      name: undefined,
      sendUnsignedClaim: true,
      mayAttachHeader: () => true,
      plan: (_sub: string) => {
        planCalls += 1;
        return Promise.resolve(plan(current, _sub));
      },
    } as unknown as IdentityContext;

    const nc = {
      info: { max_payload: 1024 * 1024 },
      requestMany: (_subject: string, _payload: Uint8Array, opts: { headers?: MsgHdrs }) => {
        publishedHeaders = opts.headers;
        const messages = (async function* (): AsyncGenerator<Msg> {
          await Promise.resolve();
          yield { data: Empty } as Msg;
        })();
        return Object.assign(messages, { stop: () => undefined });
      },
    } as unknown as NatsConnection;

    try {
      const agentInfo = buildAgentInfo(info());
      if (!agentInfo) throw new Error("test AgentInfo did not parse");
      const agent = new Agent(nc, agentInfo, 1_000, undefined, identity);
      const stream = await agent.prompt("hello");
      expect(planCalls).toBe(1); // early validation

      // Model a reconnect/credential rotation after prompt construction.
      current = after;
      for await (const message of stream) {
        expect(message).toEqual({ type: "status", status: "done" });
      }

      expect(planCalls).toBe(2);
      const header = publishedHeaders?.get(AGENT_SENDER_HEADER);
      expect(header).toBeDefined();
      const parsed = parseSenderHeader(header!);
      if (!parsed) throw new Error("published identity header did not parse");
      expect(`${parsed.account}.${parsed.user}`).toBe(after);
      expect(`${parsed.account}.${parsed.user}`).not.toBe(before);
    } finally {
      beforeKey.clear();
      afterKey.clear();
    }
  });
});
