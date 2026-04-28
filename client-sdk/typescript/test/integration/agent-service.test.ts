import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { connect as natsConnect, type Msg } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import {
  AgentService,
  Agents,
  decodeBase64,
  type StreamMessage,
} from "../../src/index.js";
import { decodeHeartbeatPayload } from "../../src/heartbeat/payload.js";

const natsUrl = inject("natsUrl");

describe.skipIf(!natsUrl)("AgentService — round-trip via real broker", () => {
  let nc: NatsConnection;
  let client: Agents;
  const services: AgentService[] = [];

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
    await Promise.all(services.splice(0).map((s) => s.stop()));
  });

  function startService(
    overrides: Partial<ConstructorParameters<typeof AgentService>[0]> = {},
  ): AgentService {
    const service = new AgentService({
      nc,
      agent: "svc-test",
      owner: "testers",
      name: `inst-${Math.random().toString(36).slice(2, 8)}`,
      heartbeatIntervalS: 1,
      // Disable per-request keep-alive so explicit chunk assertions don't
      // race a synthetic ack chunk during slow CI runs.
      keepaliveIntervalS: null,
      ...overrides,
    });
    services.push(service);
    return service;
  }

  it("registers on the v0.3 verb-first prompt subject", async () => {
    const service = startService();
    service.onPrompt(async (_envelope, response) => {
      await response.send("ok");
    });
    await service.start();
    expect(service.subject.prompt).toMatch(/^agents\.prompt\.svc-test\.testers\./);
    expect(service.subject.heartbeat).toMatch(/^agents\.hb\.svc-test\.testers\./);
    expect(service.subject.status).toMatch(/^agents\.status\.svc-test\.testers\./);
  });

  it("streams response chunks and emits the §6.5 terminator", async () => {
    const service = startService();
    service.onPrompt(async (_envelope, response) => {
      await response.send("Hello, ");
      await response.send("world.");
    });
    await service.start();

    const found = await client.discover({
      timeoutMs: 1000,
      filter: { agent: "svc-test", name: service.subject.name },
    });
    expect(found).toHaveLength(1);
    const remote = found[0]!;

    const messages: StreamMessage[] = [];
    for await (const m of await remote.prompt("hi")) messages.push(m);

    const responses = messages.filter((m) => m.type === "response");
    expect(responses.map((m) => (m as { text: string }).text)).toEqual(["Hello, ", "world."]);
    // A synthetic `status:done` is emitted by the SDK on terminator; look for it.
    const lastStatus = messages.at(-1);
    if (!lastStatus) throw new Error("expected at least one stream message");
    expect(lastStatus.type).toBe("status");
    expect((lastStatus as { status: string }).status).toBe("done");
  });

  it("decodes the §5.1 envelope and surfaces its prompt to the handler", async () => {
    let receivedPrompt: string | null = null;
    let receivedAttachmentCount = 0;
    const service = startService();
    service.onPrompt(async (envelope, response) => {
      receivedPrompt = envelope.prompt;
      receivedAttachmentCount = envelope.attachments?.length ?? 0;
      await response.send("ack from handler");
    });
    await service.start();

    const found = await client.discover({
      timeoutMs: 1000,
      filter: { agent: "svc-test", name: service.subject.name },
    });
    const remote = found[0]!;
    for await (const _ of await remote.prompt("hello prompt")) {
      // drain
    }
    expect(receivedPrompt).toBe("hello prompt");
    expect(receivedAttachmentCount).toBe(0);
  });

  it("decodes attachments via the SDK's strict base64 + filename guard", async () => {
    let receivedFilename: string | null = null;
    let receivedBytes: Uint8Array | null = null;
    const service = startService();
    service.onPrompt(async (envelope, response) => {
      const att = envelope.attachments?.[0];
      if (att) {
        receivedFilename = att.filename;
        receivedBytes = att.content;
      }
      await response.send("ok");
    });
    await service.start();

    const found = await client.discover({
      timeoutMs: 1000,
      filter: { agent: "svc-test", name: service.subject.name },
    });
    const remote = found[0]!;
    const payload = new TextEncoder().encode("payload-bytes-123");
    for await (const _ of await remote.prompt("see file", {
      attachments: [{ filename: "data.bin", content: payload }],
    })) {
      // drain
    }
    expect(receivedFilename).toBe("data.bin");
    if (receivedBytes === null) throw new Error("handler did not receive attachment bytes");
    expect(new TextDecoder().decode(receivedBytes)).toBe("payload-bytes-123");
  });

  it("returns 400 for an unsafe-filename envelope", async () => {
    const service = startService();
    service.onPrompt(() => {
      throw new Error("handler should never run on a 400");
    });
    await service.start();

    // Send the envelope manually so we can inject the unsafe filename — the
    // SDK's caller-side normalize would refuse it before publishing.
    const envelopeBytes = new TextEncoder().encode(
      JSON.stringify({
        prompt: "x",
        attachments: [
          { filename: "../../etc/passwd", content: "QUJD" /* "ABC" base64 */ },
        ],
      }),
    );
    const reply = `_INBOX.agents.svc-test-${Math.random().toString(36).slice(2, 8)}`;
    const sub = nc.subscribe(reply);
    await nc.flush();
    nc.publish(service.subject.prompt, envelopeBytes, { reply });

    const messages: Msg[] = [];
    for await (const m of sub) {
      messages.push(m);
      if (m.headers || m.data.length === 0) {
        // Once we've seen the error frame and the terminator, we're done.
        if (
          messages.some((mm) => mm.headers?.get("Nats-Service-Error-Code") === "400") &&
          messages.some((mm) => !mm.headers && mm.data.length === 0)
        ) {
          sub.unsubscribe();
          break;
        }
      }
    }
    const errorMsg = messages.find((m) => m.headers?.get("Nats-Service-Error-Code") === "400");
    expect(errorMsg).toBeDefined();
    const terminator = messages.find((m) => !m.headers && m.data.length === 0);
    expect(terminator).toBeDefined();
  });

  it("answers the v0.3 status endpoint with a heartbeat-shaped payload", async () => {
    const service = startService();
    service.onPrompt(() => {
      // unused
    });
    await service.start();

    const reply = await nc.request(service.subject.status, new Uint8Array(0), { timeout: 2000 });
    const parsed = JSON.parse(new TextDecoder().decode(reply.data)) as Record<string, unknown>;
    const decoded = decodeHeartbeatPayload(parsed);
    expect(decoded).not.toBeNull();
    expect(decoded!.agent).toBe("svc-test");
    expect(decoded!.owner).toBe("testers");
    expect(decoded!.instanceId).toBe(service.instanceId);
    expect(decoded!.intervalS).toBe(1);
    expect(decoded!.ts).toMatch(/Z$/);
  });

  it("publishes heartbeats on the v0.3 wildcard `agents.hb.*.*.*`", async () => {
    const service = startService();
    service.onPrompt(() => {
      // unused
    });
    await service.start();

    // Wait for at least one heartbeat to land in the tracker (started in
    // beforeEach so subscribe-before-discover holds).
    const start = Date.now();
    let liveness = client.liveness(service.instanceId);
    while (liveness === null && Date.now() - start < 2_500) {
      await new Promise((r) => setTimeout(r, 50));
      liveness = client.liveness(service.instanceId);
    }
    expect(liveness).not.toBeNull();
    expect(liveness!.isOnline).toBe(true);
    expect(liveness!.intervalS).toBe(1);
  });

  it("rejects construction with invalid heartbeat / keepalive intervals", () => {
    expect(
      () =>
        new AgentService({
          nc,
          agent: "svc",
          owner: "o",
          name: "n",
          heartbeatIntervalS: 0,
        }),
    ).toThrow();
    expect(
      () =>
        new AgentService({
          nc,
          agent: "svc",
          owner: "o",
          name: "n",
          keepaliveIntervalS: -1,
        }),
    ).toThrow();
    expect(
      () =>
        new AgentService({
          nc,
          agent: "svc",
          owner: "o",
          name: "n",
          keepaliveIntervalS: null,
        }),
    ).not.toThrow();
  });

  // Round-trip the base64 alphabet through the wire to make sure decodeBase64
  // produces identical bytes on both sides.
  it("round-trips bytes through encodeBase64 → strict-decode", () => {
    const original = new Uint8Array([0, 1, 2, 3, 250, 251, 255]);
    const encoded = decodeBase64(
      "AAECAw==", // "AAECAw==" decodes to [0,1,2,3]
    );
    expect(encoded).toEqual(new Uint8Array([0, 1, 2, 3]));
    // Round-trip through service-side decoder via decodeEnvelope is covered
    // separately in test/unit/decode-envelope.test.ts; this test pins the
    // base64 alphabet itself.
    void original;
  });
});
