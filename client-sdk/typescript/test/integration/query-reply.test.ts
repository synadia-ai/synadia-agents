import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createInbox, type NatsConnection } from "@nats-io/nats-core";
import type { ServiceMsg } from "@nats-io/services";
import { connect as natsConnect } from "@nats-io/transport-node";
import { Agents, type QueryEvent, type StreamMessage } from "../../src/index.js";
import { ReferenceAgent } from "../../src/testing/reference-agent.js";

const natsUrl = inject("natsUrl");

function encodeChunk(chunk: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(chunk));
}

/**
 * Publish a `query` chunk from an agent handler and await exactly one
 * reply. Returns the reply body as a string (plain text, or JSON if the
 * caller sent a JSON envelope).
 */
async function askUser(
  nc: NatsConnection,
  msg: ServiceMsg,
  prompt: string,
  opts: { id?: string; timeoutMs?: number } = {},
): Promise<string> {
  const id = opts.id ?? crypto.randomUUID();
  const replySubject = createInbox();
  const sub = nc.subscribe(replySubject);
  try {
    msg.respond(encodeChunk({ type: "query", data: { id, reply_subject: replySubject, prompt } }));
    const timeoutMs = opts.timeoutMs ?? 5_000;
    const result = await Promise.race([
      sub[Symbol.asyncIterator]().next(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`query "${id}" timed out`)), timeoutMs),
      ),
    ]);
    if (result.done || !result.value) {
      throw new Error(`query "${id}" received no reply`);
    }
    return new TextDecoder().decode(result.value.data);
  } finally {
    sub.unsubscribe();
  }
}

describe.skipIf(!natsUrl)("mid-stream query (§7)", () => {
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
      agent: "q-agent",
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
      filter: { agent: "q-agent", name: instanceName },
    });
    return found!;
  }

  it("round-trips a single mid-stream query (happy path)", async () => {
    const agent = await startAgent({
      promptHandler: async (msg) => {
        const answer = await askUser(nc, msg, "Proceed? (yes/no)");
        msg.respond(encodeChunk({ type: "response", data: `you said: ${answer}` }));
        msg.respond("");
      },
    });
    const remote = await discoverRemote(agent);
    const events: StreamMessage[] = [];
    const stream = await remote.prompt("run it");
    for await (const msg of stream) {
      events.push(msg);
      if (msg.type === "query") {
        expect(msg.prompt).toBe("Proceed? (yes/no)");
        await msg.reply("yes");
      }
    }
    const response = events.find((e) => e.type === "response");
    expect(response).toMatchObject({ type: "response", text: "you said: yes" });
    expect(events.some((e) => e.type === "query")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "status", status: "done" });
  });

  it("supports multiple concurrent queries (§7.3)", async () => {
    const agent = await startAgent({
      promptHandler: async (msg) => {
        // Fire two queries concurrently — they MUST have distinct reply subjects.
        const [a, b] = await Promise.all([askUser(nc, msg, "First?"), askUser(nc, msg, "Second?")]);
        msg.respond(encodeChunk({ type: "response", data: `${a}+${b}` }));
        msg.respond("");
      },
    });
    const remote = await discoverRemote(agent);
    const stream = await remote.prompt("multi");
    const queries: QueryEvent[] = [];
    let response: Extract<StreamMessage, { type: "response" }> | null = null;
    for await (const msg of stream) {
      if (msg.type === "query") {
        queries.push(msg);
        // Reply asynchronously so both queries are in flight together.
        setImmediate(() => void msg.reply(msg.prompt === "First?" ? "1" : "2"));
      } else if (msg.type === "response") {
        response = msg;
      }
    }
    expect(queries).toHaveLength(2);
    const prompts = queries.map((q) => q.prompt).sort();
    expect(prompts).toEqual(["First?", "Second?"]);
    expect(response?.text).toBe("1+2");
  });

  it("accepts a JSON envelope reply", async () => {
    const agent = await startAgent({
      promptHandler: async (msg) => {
        const answer = await askUser(nc, msg, "Body?");
        // Server sees the caller's envelope verbatim — parse to verify.
        const parsed = JSON.parse(answer) as { prompt: string };
        msg.respond(encodeChunk({ type: "response", data: `received: ${parsed.prompt}` }));
        msg.respond("");
      },
    });
    const remote = await discoverRemote(agent);
    const stream = await remote.prompt("envelope");
    const events: StreamMessage[] = [];
    for await (const msg of stream) {
      events.push(msg);
      if (msg.type === "query") await msg.reply({ prompt: "structured reply" });
    }
    const resp = events.find(
      (e): e is Extract<StreamMessage, { type: "response" }> => e.type === "response",
    );
    expect(resp?.text).toBe("received: structured reply");
  });
});
