import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { connect } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import { Agents } from "@synadia-ai/agents";
import { AgentService } from "../../src/service.js";

const natsUrl = inject("natsUrl");

/**
 * Tracing must be entirely opt-in. With nothing configured, an agent must
 * behave exactly as it did before the extension existed — in particular it
 * must hand the harness no trace headers, which would otherwise be stamped
 * on model requests going to a third party the operator never opted into.
 */
describe.skipIf(!natsUrl)("tracing is opt-in", () => {
  let nc: NatsConnection;
  beforeAll(async () => {
    nc = await connect({ servers: natsUrl! });
  });
  afterAll(async () => {
    await nc.close();
  });

  async function headersSeenBy(traced: boolean, agent: string): Promise<Record<string, string>> {
    let captured: Record<string, string> = { sentinel: "never ran" };
    const svc = new AgentService({
      nc,
      agent,
      owner: "p",
      name: `${agent}-1`,
      heartbeatIntervalS: 30,
      keepaliveIntervalS: null,
      ...(traced ? { trace: {} } : {}),
    });
    svc.onPrompt(async (_e, r) => {
      captured = r.traceHeaders();
      await r.send("ok");
    });
    await svc.start();
    const client = new Agents({ nc }); // never traced
    const [a] = await client.discover({ filter: { agent } });
    const s = await a!.prompt("hi");
    for await (const _m of s) {
      /* drain */
    }
    await svc.stop();
    await client.close();
    return captured;
  }

  it("hands out no trace headers when nothing opted in", async () => {
    expect(await headersSeenBy(false, "untraced")).toEqual({});
  });

  it("hands out trace headers when the service opted in", async () => {
    const h = await headersSeenBy(true, "traced");
    expect(Object.keys(h).sort()).toEqual(["X-Synadia-Root-ID", "X-Synadia-Thread-ID"]);
  });
});
