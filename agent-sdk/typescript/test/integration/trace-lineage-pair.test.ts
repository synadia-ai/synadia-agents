import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { connect, type Msg } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import { isThreadId } from "@synadia-ai/agents";
import { AgentService } from "../../src/service.js";

const natsUrl = inject("natsUrl");
const THREAD = "a".repeat(32);
const ROOT = "b".repeat(32);

/**
 * The envelope's lineage is a pair, adopted whole or not at all. Neither
 * field present: a service that opted in mints a root. Both present and
 * well-formed: adopted verbatim, whatever the service is configured for.
 * Exactly one, or either malformed: a malformed envelope — the §9 `400`
 * frame and the terminator, no ack, and the handler never runs — the same
 * treatment as any other wrongly shaped field, and the same as the Python
 * host. Completing a half pair would file the execution under a tree the
 * caller never named.
 */
describe.skipIf(!natsUrl)("the envelope's lineage pair", () => {
  let nc: NatsConnection;
  beforeAll(async () => {
    nc = await connect({ servers: natsUrl! });
  });
  afterAll(async () => {
    await nc.close();
  });

  interface Outcome {
    readonly frames: Msg[];
    /** What the handler was handed, or `undefined` when it never ran. */
    readonly headers: Record<string, string> | undefined;
  }

  async function send(agent: string, body: Record<string, unknown>): Promise<Outcome> {
    let headers: Record<string, string> | undefined;
    const svc = new AgentService({
      nc,
      agent,
      owner: "p",
      name: `${agent}-1`,
      heartbeatIntervalS: 30,
      keepaliveIntervalS: null,
      trace: {},
    });
    svc.onPrompt(async (_e, r) => {
      headers = r.traceHeaders();
      await r.send("ok");
    });
    await svc.start();
    const reply = `_INBOX.pair.${agent}.${Math.random().toString(36).slice(2, 8)}`;
    const sub = nc.subscribe(reply);
    await nc.flush();
    nc.publish(svc.subject.prompt, new TextEncoder().encode(JSON.stringify(body)), { reply });
    const frames: Msg[] = [];
    for await (const m of sub) {
      frames.push(m);
      // §6.5: the terminator is the one frame with no headers and no body.
      if (!m.headers && m.data.length === 0) {
        sub.unsubscribe();
        break;
      }
    }
    await svc.stop();
    return { frames, headers };
  }

  const errorCode = (frames: Msg[]): string | undefined =>
    frames.map((m) => m.headers?.get("Nats-Service-Error-Code")).find((c) => c !== undefined);

  it.each([
    ["thread_id alone", { prompt: "hi", thread_id: THREAD }],
    ["root_id alone", { prompt: "hi", root_id: ROOT }],
  ])("rejects %s with a 400 before the handler runs", async (_label, body) => {
    const { frames, headers } = await send("pair-half", body);
    expect(headers).toBeUndefined();
    expect(errorCode(frames)).toBe("400");
    expect(frames).toHaveLength(2); // the error frame and the terminator, no ack
  });

  it.each([
    ["an uppercase thread_id", { prompt: "hi", thread_id: THREAD.toUpperCase(), root_id: ROOT }],
    ["a short root_id", { prompt: "hi", thread_id: THREAD, root_id: ROOT.slice(1) }],
  ])("rejects %s with a 400 before the handler runs", async (_label, body) => {
    const { frames, headers } = await send("pair-bad", body);
    expect(headers).toBeUndefined();
    expect(errorCode(frames)).toBe("400");
    expect(frames).toHaveLength(2);
  });

  it("adopts a well-formed pair verbatim", async () => {
    const { frames, headers } = await send("pair-full", {
      prompt: "hi",
      thread_id: THREAD,
      root_id: ROOT,
    });
    expect(errorCode(frames)).toBeUndefined();
    expect(headers).toEqual({ "X-Synadia-Thread-ID": THREAD, "X-Synadia-Root-ID": ROOT });
  });

  it("mints a root when neither field is present", async () => {
    const { frames, headers } = await send("pair-none", { prompt: "hi" });
    expect(errorCode(frames)).toBeUndefined();
    expect(headers).toBeDefined();
    const thread = headers!["X-Synadia-Thread-ID"]!;
    const root = headers!["X-Synadia-Root-ID"]!;
    expect(isThreadId(thread)).toBe(true);
    expect(root).toBe(thread);
  });
});
