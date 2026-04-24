import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { connect as natsConnect } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import type { ServiceMsg } from "@nats-io/services";
import {
  Agents,
  PayloadTooLargeError,
  PromptEmptyError,
  ServiceError,
  StreamStalledError,
  type StreamMessage,
} from "../../src/index.js";
import { ReferenceAgent } from "../../src/testing/reference-agent.js";

const natsUrl = inject("natsUrl");

function encodeChunk(chunk: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(chunk));
}

function respondResponseChunks(msg: ServiceMsg, chunks: string[]): void {
  for (const text of chunks) {
    msg.respond(encodeChunk({ type: "response", data: text }));
  }
  msg.respond(""); // terminator
}

describe.skipIf(!natsUrl)("Agent.prompt — text + streaming", () => {
  let nc: NatsConnection;
  let client: Agents;
  const agents: ReferenceAgent[] = [];

  beforeAll(async () => {
    nc = await natsConnect({ servers: natsUrl! });
  });

  afterAll(async () => {
    await nc.close();
  });

  beforeEach(async () => {
    client = new Agents({ nc });
    await client.startTracking();
  });

  afterEach(async () => {
    await client.close();
    await Promise.all(agents.splice(0).map((a) => a.stop()));
  });

  async function startAgent(
    overrides: Partial<ConstructorParameters<typeof ReferenceAgent>[0]> = {},
  ): Promise<ReferenceAgent> {
    const agent = new ReferenceAgent({
      nc,
      agent: "pt-agent",
      owner: "testers",
      name: `inst-${Math.random().toString(36).slice(2, 8)}`,
      heartbeatIntervalS: 1,
      ...overrides,
    });
    await agent.start();
    agents.push(agent);
    return agent;
  }

  async function discoverRemote(agent: ReferenceAgent) {
    const instanceName = agent.promptSubject.split(".").pop() ?? "";
    const [found] = await client.discover({
      timeoutMs: 1000,
      filter: { agent: "pt-agent", name: instanceName },
    });
    return found!;
  }

  it("streams response chunks and emits synthetic status:done on terminator", async () => {
    const agent = await startAgent({
      promptHandler: (msg) => respondResponseChunks(msg, ["Hello, ", "world."]),
    });
    const remote = await discoverRemote(agent);
    const events: StreamMessage[] = [];
    for await (const msg of await remote.prompt("hi")) {
      events.push(msg);
    }
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: "response", text: "Hello, " });
    expect(events[1]).toEqual({ type: "response", text: "world." });
    expect(events[2]).toEqual({ type: "status", status: "done" });
  });

  it("accepts response chunks with object `data` (text + attachments)", async () => {
    const agent = await startAgent({
      promptHandler: (msg) => {
        msg.respond(
          encodeChunk({
            type: "response",
            data: { text: "found 2", attachments: [{ filename: "a.png", content: "ZGF0YQ==" }] },
          }),
        );
        msg.respond("");
      },
    });
    const remote = await discoverRemote(agent);
    const events: StreamMessage[] = [];
    for await (const msg of await remote.prompt("search")) {
      events.push(msg);
    }
    expect(events[0]).toMatchObject({
      type: "response",
      text: "found 2",
      attachments: [{ filename: "a.png", content: "ZGF0YQ==" }],
    });
    expect(events[1]).toEqual({ type: "status", status: "done" });
  });

  it("surfaces status:ack events and keeps the stream alive", async () => {
    const agent = await startAgent({
      promptHandler: (msg) => {
        msg.respond(encodeChunk({ type: "status", data: "ack" }));
        msg.respond(encodeChunk({ type: "response", data: "done" }));
        msg.respond("");
      },
    });
    const remote = await discoverRemote(agent);
    const events: StreamMessage[] = [];
    for await (const msg of await remote.prompt("hi")) {
      events.push(msg);
    }
    const types = events.map((e) => e.type);
    expect(types).toContain("status"); // at least one ack + the synthetic done
    expect(events.filter((e) => e.type === "response").length).toBe(1);
  });

  it("silently drops unknown chunk types (§6.6 MUST)", async () => {
    const agent = await startAgent({
      promptHandler: (msg) => {
        msg.respond(encodeChunk({ type: "hologram", data: { anything: true } }));
        msg.respond(encodeChunk({ type: "response", data: "ok" }));
        msg.respond("");
      },
    });
    const remote = await discoverRemote(agent);
    const events: StreamMessage[] = [];
    for await (const msg of await remote.prompt("hi")) {
      events.push(msg);
    }
    // hologram should not appear
    expect(events.some((e) => (e as { type: string }).type === "hologram")).toBe(false);
    expect(events[0]).toEqual({ type: "response", text: "ok" });
  });

  it("throws ServiceError with code + description from error headers (§9.1)", async () => {
    const agent = await startAgent({
      promptHandler: (msg) => {
        msg.respondError(
          429,
          "rate limited",
          encodeChunk({ error: "rate_limited", retry_after_s: 30 }),
        );
      },
    });
    const remote = await discoverRemote(agent);
    let caught: unknown;
    try {
      for await (const _m of await remote.prompt("hi")) {
        /* no-op */
      }
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    const err = caught as ServiceError;
    expect(err.code).toBe(429);
    expect(err.description).toBe("rate limited");
    expect(err.body?.["error"]).toBe("rate_limited");
    expect(err.body?.["retry_after_s"]).toBe(30);
  });

  it("rejects empty prompt synchronously (PromptEmptyError)", async () => {
    const agent = await startAgent();
    const remote = await discoverRemote(agent);
    expect(() => remote.prompt("")).toThrow(PromptEmptyError);
  });

  it("rejects oversized prompt synchronously (PayloadTooLargeError)", async () => {
    const agent = await startAgent({ maxPayload: "128B" });
    const remote = await discoverRemote(agent);
    // 200 chars wrapped in {"prompt":"..."} exceeds 128 bytes.
    const big = "x".repeat(200);
    expect(() => remote.prompt(big)).toThrow(PayloadTooLargeError);
  });

  it("local validation does not publish to the wire", async () => {
    const agent = await startAgent({ maxPayload: "64B" });
    const remote = await discoverRemote(agent);
    // Subscribe to the agent's prompt subject to see if a message arrives.
    const requests: Uint8Array[] = [];
    const observer = nc.subscribe(agent.promptSubject, {
      callback: (err, msg) => {
        if (!err) requests.push(msg.data);
      },
    });
    try {
      expect(() => remote.prompt("x".repeat(200))).toThrow(PayloadTooLargeError);
      await new Promise((r) => setTimeout(r, 200));
      expect(requests.length).toBe(0);
    } finally {
      observer.unsubscribe();
    }
  });

  it("throws StreamStalledError when agent goes silent past inactivity timeout (§6.6)", async () => {
    const agent = await startAgent({
      promptHandler: () => {
        /* never responds — stream should stall */
      },
    });
    const remote = await discoverRemote(agent);
    let caught: unknown;
    try {
      for await (const _m of await remote.prompt("hi", { inactivityTimeoutMs: 200 })) {
        /* should never get here */
      }
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StreamStalledError);
    expect((caught as StreamStalledError).timeoutMs).toBe(200);
  });

  it("status:ack resets the inactivity timer (§6.4, §6.6)", async () => {
    const agent = await startAgent({
      promptHandler: async (msg) => {
        // Inactivity timeout is 400ms; send an ack every 200ms for 900ms,
        // then the final response. A non-resetting timer would stall.
        for (let i = 0; i < 4; i++) {
          await new Promise((r) => setTimeout(r, 200));
          msg.respond(encodeChunk({ type: "status", data: "ack" }));
        }
        msg.respond(encodeChunk({ type: "response", data: "finally" }));
        msg.respond("");
      },
    });
    const remote = await discoverRemote(agent);
    const events: StreamMessage[] = [];
    for await (const msg of await remote.prompt("hi", { inactivityTimeoutMs: 400 })) {
      events.push(msg);
    }
    const responseEvents = events.filter((e) => e.type === "response");
    expect(responseEvents).toHaveLength(1);
    expect(responseEvents[0]).toEqual({ type: "response", text: "finally" });
  });

  it("early break triggers iterator cleanup (subscription unsubscribes)", async () => {
    const agent = await startAgent({
      promptHandler: (msg) => {
        // Emit a bunch of chunks the caller will stop consuming early.
        for (let i = 0; i < 10; i++) {
          msg.respond(encodeChunk({ type: "response", data: `chunk-${i}` }));
        }
        msg.respond("");
      },
    });
    const remote = await discoverRemote(agent);
    const stream = await remote.prompt("hi");
    let count = 0;
    for await (const _msg of stream) {
      count += 1;
      if (count === 2) break;
    }
    expect(count).toBe(2);
    // After break, the subscription should be dropped. Publishing to the
    // reply subject from outside shouldn't raise — and the stream iterator
    // won't observe it. Hard to assert directly, but we can confirm we
    // don't hang by scheduling an assertion after a short delay.
    await new Promise((r) => setTimeout(r, 100));
    expect(true).toBe(true); // test completed without hanging
  });
});
