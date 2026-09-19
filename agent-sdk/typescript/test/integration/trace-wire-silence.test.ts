import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { connect } from "@nats-io/transport-node";
import type { Msg, NatsConnection } from "@nats-io/nats-core";
import { Agents } from "@synadia-ai/agents";
import { AgentService } from "../../src/service.js";

const natsUrl = inject("natsUrl");
const AGENT = "silent-ts";

/**
 * With tracing off, the extension must leave no trace on the wire.
 *
 * Not "no edge records" — nothing at all: the prompt envelope stays
 * byte-identical to plain protocol 0.3, no subject outside the normal set
 * is touched, and no message carries the JetStream de-duplication header
 * the edge publisher uses. This is the guard that fails the moment
 * someone adds an unconditional publish.
 */
describe.skipIf(!natsUrl)("an untraced run is silent on the wire", () => {
  let nc: NatsConnection;
  const seen: Msg[] = [];

  beforeAll(async () => {
    nc = await connect({ servers: natsUrl! });
    const all = nc.subscribe(">");
    void (async () => {
      for await (const m of all) seen.push(m);
    })();
    await nc.flush();

    const svc = new AgentService({
      nc,
      agent: AGENT,
      owner: "p",
      name: `${AGENT}-1`,
      heartbeatIntervalS: 30,
      keepaliveIntervalS: null,
    });
    svc.onPrompt(async (_e, r) => {
      await r.send("ok");
    });
    await svc.start();

    const client = new Agents({ nc });
    const [handle] = await client.discover({ filter: { agent: AGENT } });
    const stream = await handle!.prompt("hello");
    for await (const _m of stream) {
      /* drain */
    }
    await handle!.status();
    await new Promise((r) => setTimeout(r, 200));
    await svc.stop();
    await client.close();
  });

  afterAll(async () => {
    await nc.close();
  });

  it("reaches no trace subject", () => {
    expect(seen.filter((m) => m.subject.startsWith("TRACE")).map((m) => m.subject)).toEqual([]);
  });

  it("stamps no de-duplication header", () => {
    expect(seen.filter((m) => m.headers?.get("Nats-Msg-Id")).map((m) => m.subject)).toEqual([]);
  });

  it("sends a plain v0.3 prompt envelope", () => {
    const prompts = seen.filter((m) => m.subject.startsWith(`agents.prompt.${AGENT}.`));
    expect(prompts).toHaveLength(1);
    expect(new TextDecoder().decode(prompts[0]!.data)).toBe('{"prompt":"hello"}');
  });

  it("touches no unexpected subject", () => {
    const unexpected = [
      ...new Set(
        seen
          .map((m) => m.subject)
          .filter(
            (s) => !(s.startsWith("_INBOX.") || s.startsWith("$SRV.") || s.startsWith("agents.")),
          ),
      ),
    ].sort();
    expect(unexpected).toEqual([]);
  });
});
