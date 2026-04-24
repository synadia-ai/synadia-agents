import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { connect as natsConnect } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import type { ServiceMsg } from "@nats-io/services";
import {
  AttachmentsNotSupportedError,
  Agents,
  decodeBase64,
  PayloadTooLargeError,
  type StreamMessage,
} from "../../src/index.js";
import { ReferenceAgent } from "../../src/testing/reference-agent.js";

const natsUrl = inject("natsUrl");

function encodeChunk(chunk: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(chunk));
}

/** Parses the incoming envelope and echoes attachments back unchanged. */
function echoAttachmentsHandler(msg: ServiceMsg): void {
  const req = msg.json<{
    prompt: string;
    attachments?: Array<{ filename: string; content: string }>;
  }>();
  if (req.attachments && req.attachments.length > 0) {
    msg.respond(
      encodeChunk({
        type: "response",
        data: {
          text: `received ${req.attachments.length}`,
          attachments: req.attachments,
        },
      }),
    );
  } else {
    msg.respond(encodeChunk({ type: "response", data: "no attachments" }));
  }
  msg.respond(""); // terminator
}

describe.skipIf(!natsUrl)("Agent.prompt — attachments + local validation", () => {
  let nc: NatsConnection;
  let client: Agents;
  let tmp: string;
  const agents: ReferenceAgent[] = [];

  beforeAll(async () => {
    nc = await natsConnect({ servers: natsUrl! });
    tmp = await mkdtemp(joinPath(tmpdir(), "agents-sdk-att-"));
  });

  afterAll(async () => {
    await nc.close();
    await rm(tmp, { recursive: true, force: true });
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
      agent: "att-agent",
      owner: "testers",
      name: `inst-${Math.random().toString(36).slice(2, 8)}`,
      heartbeatIntervalS: 1,
      promptHandler: echoAttachmentsHandler,
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
      filter: { agent: "att-agent", name: instanceName },
    });
    return found!;
  }

  it("round-trips a Uint8Array attachment via base64", async () => {
    const agent = await startAgent();
    const remote = await discoverRemote(agent);
    const original = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic
    const stream = await remote.prompt("describe this photo", {
      attachments: [{ filename: "vacation.png", content: original }],
    });
    const events: StreamMessage[] = [];
    for await (const msg of stream) events.push(msg);
    const response = events.find((e) => e.type === "response");
    expect(response).toBeDefined();
    const resp = response as Extract<StreamMessage, { type: "response" }>;
    expect(resp.attachments).toBeDefined();
    expect(resp.attachments![0]!.filename).toBe("vacation.png");
    const roundTripped = decodeBase64(resp.attachments![0]!.content);
    expect(roundTripped).toEqual(original);
  });

  it("reads a filesystem path and attaches the bytes", async () => {
    const path = joinPath(tmp, "doc.txt");
    const payload = "hello from disk";
    await writeFile(path, payload);
    const agent = await startAgent();
    const remote = await discoverRemote(agent);
    const stream = await remote.prompt("ingest this", { attachments: [path] });
    const events: StreamMessage[] = [];
    for await (const msg of stream) events.push(msg);
    const resp = events.find(
      (e): e is Extract<StreamMessage, { type: "response" }> => e.type === "response",
    );
    expect(resp?.attachments?.[0]!.filename).toBe("doc.txt");
    expect(new TextDecoder().decode(decodeBase64(resp!.attachments![0]!.content))).toBe(payload);
  });

  it("supports multiple attachments in one prompt", async () => {
    const agent = await startAgent();
    const remote = await discoverRemote(agent);
    const stream = await remote.prompt("combine", {
      attachments: [
        { filename: "a.txt", content: new TextEncoder().encode("A") },
        { filename: "b.txt", content: new TextEncoder().encode("B") },
      ],
    });
    const events: StreamMessage[] = [];
    for await (const msg of stream) events.push(msg);
    const resp = events.find(
      (e): e is Extract<StreamMessage, { type: "response" }> => e.type === "response",
    );
    expect(resp?.attachments).toHaveLength(2);
    expect(resp!.attachments![0]!.filename).toBe("a.txt");
    expect(resp!.attachments![1]!.filename).toBe("b.txt");
  });

  it("throws AttachmentsNotSupportedError synchronously when attachments_ok=false", async () => {
    const agent = await startAgent({ attachmentsOk: false });
    const remote = await discoverRemote(agent);
    // Sync throw — the Promise is never even constructed.
    expect(() =>
      remote.prompt("describe this", {
        attachments: [{ filename: "x.bin", content: new Uint8Array([1]) }],
      }),
    ).toThrow(AttachmentsNotSupportedError);
  });

  it("rejects oversized attachment payload with PayloadTooLargeError (async, after file I/O)", async () => {
    const agent = await startAgent({ maxPayload: "256B" });
    const remote = await discoverRemote(agent);
    const big = new Uint8Array(500);
    await expect(
      remote.prompt("summarize", {
        attachments: [{ filename: "big.bin", content: big }],
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("local validation sends NO wire traffic on attachments_ok=false", async () => {
    const agent = await startAgent({ attachmentsOk: false });
    const remote = await discoverRemote(agent);
    const seen: Uint8Array[] = [];
    const observer = nc.subscribe(agent.promptSubject, {
      callback: (err, msg) => {
        if (!err) seen.push(msg.data);
      },
    });
    try {
      expect(() =>
        remote.prompt("x", {
          attachments: [{ filename: "x.bin", content: new Uint8Array([1]) }],
        }),
      ).toThrow(AttachmentsNotSupportedError);
      await new Promise((r) => setTimeout(r, 200));
      expect(seen).toHaveLength(0);
    } finally {
      observer.unsubscribe();
    }
  });

  it("local validation sends NO wire traffic on oversized payload", async () => {
    const agent = await startAgent({ maxPayload: "128B" });
    const remote = await discoverRemote(agent);
    const seen: Uint8Array[] = [];
    const observer = nc.subscribe(agent.promptSubject, {
      callback: (err, msg) => {
        if (!err) seen.push(msg.data);
      },
    });
    try {
      await expect(
        remote.prompt("x", {
          attachments: [{ filename: "big.bin", content: new Uint8Array(500) }],
        }),
      ).rejects.toBeInstanceOf(PayloadTooLargeError);
      await new Promise((r) => setTimeout(r, 200));
      expect(seen).toHaveLength(0);
    } finally {
      observer.unsubscribe();
    }
  });
});
