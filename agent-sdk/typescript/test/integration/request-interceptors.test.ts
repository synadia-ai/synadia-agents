// `AgentService`'s extension hooks on the wire: request interceptors around
// the handler (order, refusal, context, the contract on `next()`) and the
// `heartbeatExtras` provider on the heartbeat and the status reply.

import { AsyncLocalStorage } from "node:async_hooks";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { connect, type Msg } from "@nats-io/transport-node";
import { createInbox, type NatsConnection } from "@nats-io/nats-core";
import {
  decodeHeartbeatPayload,
  ProtocolError,
  type HeartbeatPayload,
  type Logger,
} from "@synadia-ai/agents";
import { RequestRejectedError, type RequestInterceptor } from "../../src/interceptor.js";
import { AgentService, type AgentServiceOptions } from "../../src/service.js";

const natsUrl = inject("natsUrl");
const dec = new TextDecoder();

interface Frame {
  readonly kind: "ack" | "response" | "error" | "terminator";
  readonly code?: string;
  readonly description?: string;
  readonly text?: string;
}

function frame(m: Msg): Frame {
  const code = m.headers?.get("Nats-Service-Error-Code");
  if (code) return { kind: "error", code, description: m.headers?.get("Nats-Service-Error") ?? "" };
  if (m.data.length === 0) return { kind: "terminator" };
  const chunk = JSON.parse(dec.decode(m.data)) as { type: string; data?: unknown };
  return chunk.type === "status" ? { kind: "ack" } : { kind: "response", text: String(chunk.data) };
}

interface LogLine {
  readonly level: string;
  readonly msg: string;
  readonly ctx: Record<string, unknown> | undefined;
}

function capturingLogger(lines: LogLine[]): Logger {
  const push =
    (level: string) =>
    (msg: string, ctx?: Record<string, unknown>): void => {
      lines.push({ level, msg, ctx });
    };
  return { debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error") };
}

describe.skipIf(!natsUrl)("AgentService request interceptors and heartbeat extras", () => {
  let nc: NatsConnection;
  const services: AgentService[] = [];

  beforeAll(async () => {
    nc = await connect({ servers: natsUrl! });
  });
  afterAll(async () => {
    await nc.close();
  });
  afterEach(async () => {
    await Promise.all(services.splice(0).map((s) => s.stop()));
  });

  async function start(
    overrides: Partial<AgentServiceOptions>,
    handler: (text: string) => Promise<string> = (t) => Promise.resolve(`echo:${t}`),
  ): Promise<AgentService> {
    const svc = new AgentService({
      nc,
      agent: "icpt",
      owner: "o",
      name: `i-${Math.random().toString(36).slice(2, 8)}`,
      keepaliveIntervalS: null,
      ...overrides,
    });
    svc.onPrompt(async (envelope, response) => {
      await response.send(await handler(envelope.prompt));
    });
    services.push(svc);
    await svc.start();
    return svc;
  }

  /** Every frame a request draws, up to and including the terminator. */
  async function frames(svc: AgentService, body: string): Promise<Frame[]> {
    const inbox = createInbox();
    const sub = nc.subscribe(inbox, { timeout: 5_000 });
    nc.publish(svc.subject.prompt, body, { reply: inbox });
    const out: Frame[] = [];
    for await (const m of sub) {
      out.push(frame(m));
      if (m.data.length === 0 && !m.headers) break;
    }
    sub.unsubscribe();
    return out;
  }

  it("runs the chain first-listed outermost, around the ack and the handler", async () => {
    const order: string[] = [];
    const tag = (name: string): RequestInterceptor => ({
      async aroundRequest(_ctx, next) {
        order.push(`${name}:before`);
        await next();
        order.push(`${name}:after`);
      },
    });
    const svc = await start({ interceptors: [tag("outer"), tag("inner")] }, (t) => {
      order.push("handler");
      return Promise.resolve(t);
    });
    expect(await frames(svc, "hi")).toEqual([
      { kind: "ack" },
      { kind: "response", text: "hi" },
      { kind: "terminator" },
    ]);
    expect(order).toEqual([
      "outer:before",
      "inner:before",
      "handler",
      "inner:after",
      "outer:after",
    ]);
  });

  it("lets the handler see the context an interceptor runs next() in", async () => {
    const storage = new AsyncLocalStorage<string>();
    const bind: RequestInterceptor = {
      aroundRequest: (ctx, next) => storage.run(`bound:${ctx.envelope.prompt}`, next),
    };
    const svc = await start({ interceptors: [bind] }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return storage.getStore() ?? "unbound";
    });
    expect((await frames(svc, "x"))[1]).toEqual({ kind: "response", text: "bound:x" });
  });

  it("answers a refusal before next() with its code and no ack", async () => {
    const cases: ReadonlyArray<[Error, string, string]> = [
      [new RequestRejectedError(403, "go away"), "403", "go away"],
      [new RequestRejectedError(429, "slow down\nplease"), "429", "slow down | please"],
      [new ProtocolError("bad extras"), "400", "bad extras"],
      [new Error("secret detail"), "500", "handler error"],
    ];
    for (const [thrown, code, description] of cases) {
      const refuse: RequestInterceptor = { aroundRequest: () => Promise.reject(thrown) };
      let handled = false;
      const svc = await start({ interceptors: [refuse] }, (t) => {
        handled = true;
        return Promise.resolve(t);
      });
      expect(await frames(svc, "x")).toEqual([
        { kind: "error", code, description },
        { kind: "terminator" },
      ]);
      expect(handled).toBe(false);
    }
  });

  it("keeps a full reply when an interceptor throws after next(), and logs it", async () => {
    for (const thrown of [new Error("secret detail"), new RequestRejectedError(403, "too late")]) {
      const lines: LogLine[] = [];
      const late: RequestInterceptor = {
        async aroundRequest(_ctx, next) {
          await next();
          throw thrown;
        },
      };
      const svc = await start({ interceptors: [late], logger: capturingLogger(lines) });
      expect(await frames(svc, "x")).toEqual([
        { kind: "ack" },
        { kind: "response", text: "echo:x" },
        { kind: "terminator" },
      ]);
      expect(lines.filter((l) => l.level === "error")).toEqual([
        {
          level: "error",
          msg: "request interceptor failed after the handler completed; the reply is kept",
          ctx: { subject: svc.subject.prompt, error: "exception" },
        },
      ]);
      // The fixed line only: the error's own text never reaches the log.
      expect(JSON.stringify(lines)).not.toMatch(/secret detail|too late/);
    }
  });

  it("passes a handler's failure through the chain, which may replace it", async () => {
    const seen: unknown[] = [];
    const watch: RequestInterceptor = {
      async aroundRequest(_ctx, next) {
        try {
          await next();
        } catch (err) {
          seen.push(err);
          throw new RequestRejectedError(503, "handler unavailable");
        }
      },
    };
    const svc = await start({ interceptors: [watch] }, () => Promise.reject(new Error("boom")));
    expect(await frames(svc, "x")).toEqual([
      { kind: "ack" },
      { kind: "error", code: "503", description: "handler unavailable" },
      { kind: "terminator" },
    ]);
    expect(seen).toHaveLength(1);
  });

  it("answers 500 when an interceptor neither refuses nor calls next()", async () => {
    const swallow: RequestInterceptor = { aroundRequest: () => Promise.resolve() };
    const svc = await start({ interceptors: [swallow] });
    expect(await frames(svc, "x")).toEqual([
      { kind: "error", code: "500", description: "handler error" },
      { kind: "terminator" },
    ]);
  });

  it("refuses a second call of next()", async () => {
    let second: unknown;
    const twice: RequestInterceptor = {
      async aroundRequest(_ctx, next) {
        await next();
        second = await next().catch((err: unknown) => err);
      },
    };
    let calls = 0;
    const svc = await start({ interceptors: [twice] }, (t) => {
      calls += 1;
      return Promise.resolve(t);
    });
    expect((await frames(svc, "x")).map((f) => f.kind)).toEqual(["ack", "response", "terminator"]);
    expect(calls).toBe(1);
    expect(second).toBeInstanceOf(Error);
  });

  it("rejects a RequestRejectedError code outside 400–599", () => {
    for (const code of [200, 399, 600, 400.5, Number.NaN]) {
      expect(() => new RequestRejectedError(code, "x")).toThrow(RangeError);
    }
  });

  async function firstBeatAndStatus(
    heartbeatExtras: AgentServiceOptions["heartbeatExtras"],
  ): Promise<{ beat: HeartbeatPayload; status: HeartbeatPayload }> {
    const name = `hb-${Math.random().toString(36).slice(2, 8)}`;
    const sub = nc.subscribe(`agents.hb.icpt.o.${name}`, { max: 1 });
    await nc.flush();
    const svc = await start({ name, ...(heartbeatExtras ? { heartbeatExtras } : {}) });
    let beat: HeartbeatPayload | null = null;
    for await (const m of sub) beat = decodeHeartbeatPayload(JSON.parse(dec.decode(m.data)));
    const reply = await nc.request(svc.subject.status, new Uint8Array(0), { timeout: 2_000 });
    const status = decodeHeartbeatPayload(JSON.parse(dec.decode(reply.data)));
    if (!beat || !status) throw new Error("malformed heartbeat payload");
    return { beat, status };
  }

  it("merges the heartbeatExtras provider into every beat and status reply", async () => {
    let calls = 0;
    const { beat, status } = await firstBeatAndStatus(() => ({ calls: ++calls, role: "worker" }));
    expect(beat.extras).toEqual({ calls: 1, role: "worker" });
    // Read when each payload is built: the status reply is a later read.
    expect(status.extras).toEqual({ calls: 2, role: "worker" });
  });

  it("costs a beat its extras, never the beat, when the provider misbehaves", async () => {
    const providers: ReadonlyArray<AgentServiceOptions["heartbeatExtras"]> = [
      () => {
        throw new Error("provider down");
      },
      () => ({ instance_id: "forged" }),
      () => ({ big: BigInt(1) }),
    ];
    for (const provider of providers) {
      const { beat, status } = await firstBeatAndStatus(provider);
      for (const payload of [beat, status]) {
        expect(payload.extras).toEqual({});
        expect(payload.instanceId).not.toBe("forged");
      }
    }
  });
});
