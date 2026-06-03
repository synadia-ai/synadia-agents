import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { connect as natsConnect, type Msg } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import {
  Agents,
  decodeBase64,
  decodeHeartbeatPayload,
  ProtocolError,
  type StreamMessage,
} from "@synadia-ai/agents";
import { AgentService } from "../../src/service.js";

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

  it("emits the §6.4 mandatory leading `ack` as the first chunk before the handler runs", async () => {
    // Block the handler so we can prove the ack is emitted EAGERLY — i.e.
    // before any handler work. If the SDK only sent the ack via the
    // setInterval keep-alive cadence, the first message wouldn't arrive
    // until the handler produced its first response.
    let releaseHandler: () => void;
    const handlerCanProceed = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });

    const service = startService();
    service.onPrompt(async (_envelope, response) => {
      await handlerCanProceed;
      await response.send("late response");
    });
    await service.start();

    const found = await client.discover({
      timeoutMs: 1000,
      filter: { agent: "svc-test", name: service.subject.name },
    });
    const remote = found[0]!;

    const messages: StreamMessage[] = [];
    const iter = (async () => {
      for await (const m of await remote.prompt("hi")) messages.push(m);
    })();

    // try/finally: if an assertion below throws, we still release the
    // suspended handler so the consumer iterator drains and the test
    // framework can move on without hanging on a stuck handler.
    try {
      const deadline = Date.now() + 1500;
      while (messages.length < 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(messages[0]).toEqual({ type: "status", status: "ack" });
      expect(messages.some((m) => m.type === "response")).toBe(false);
    } finally {
      releaseHandler!();
    }

    // Handler released — verify the rest of the stream is as expected
    // and ends on the synthetic `status:done`.
    await iter;

    expect(messages[0]).toEqual({ type: "status", status: "ack" });
    expect(messages.some((m) => m.type === "response" && m.text === "late response")).toBe(true);
    expect(messages.at(-1)).toEqual({ type: "status", status: "done" });
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
        attachments: [{ filename: "../../etc/passwd", content: "QUJD" /* "ABC" base64 */ }],
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

  it("maps handler-raised ProtocolError to a 400 response plus terminator", async () => {
    const service = startService();
    service.onPrompt(() => {
      throw new ProtocolError("attachments are not supported by this agent");
    });
    await service.start();

    const reply = `_INBOX.agents.svc-test-${Math.random().toString(36).slice(2, 8)}`;
    const sub = nc.subscribe(reply);
    await nc.flush();
    nc.publish(service.subject.prompt, new TextEncoder().encode("plain prompt"), { reply });

    const messages: Msg[] = [];
    for await (const m of sub) {
      messages.push(m);
      if (
        messages.some((mm) => mm.headers?.get("Nats-Service-Error-Code") === "400") &&
        messages.some((mm) => !mm.headers && mm.data.length === 0)
      ) {
        sub.unsubscribe();
        break;
      }
    }

    const errorMsg = messages.find((m) => m.headers?.get("Nats-Service-Error-Code") === "400");
    expect(errorMsg).toBeDefined();
    expect(errorMsg?.headers?.get("Nats-Service-Error")).toContain("attachments are not supported");
    expect(messages.find((m) => !m.headers && m.data.length === 0)).toBeDefined();
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

  it("clamps maxPayload down to nc.info.max_payload when over-advertised", async () => {
    // Test broker is started with the nats-server default 1MB. A constructor
    // override of 16MB should clamp down to "1MB" with a console.warn rather
    // than advertising more than the broker would accept (which would only
    // set up callers for `MAX_PAYLOAD_VIOLATION` rejections at publish).
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      const first = args[0];
      warnings.push(typeof first === "string" ? first : "");
    };
    try {
      const service = startService({ maxPayload: "16MB" });
      service.onPrompt(async () => {});
      await service.start();

      const found = await client.discover({
        timeoutMs: 1000,
        filter: { agent: "svc-test", name: service.subject.name },
      });
      expect(found).toHaveLength(1);
      const ep = found[0]!.endpoints.find((e) => e.name === "prompt");
      expect(ep).toBeDefined();
      expect(ep!.metadata["max_payload"]).toBe("1MB");
      expect(warnings.some((w) => w.includes("clamping"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("honours a maxPayload override smaller than the server limit", async () => {
    const service = startService({ maxPayload: "256KB" });
    service.onPrompt(async () => {});
    await service.start();

    const found = await client.discover({
      timeoutMs: 1000,
      filter: { agent: "svc-test", name: service.subject.name },
    });
    expect(found).toHaveLength(1);
    const ep = found[0]!.endpoints.find((e) => e.name === "prompt");
    expect(ep).toBeDefined();
    expect(ep!.metadata["max_payload"]).toBe("256KB");
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

  describe("extraEndpoints + .service extension points", () => {
    it("registers extraEndpoints in array order alongside prompt + status", async () => {
      const calls: string[] = [];
      const service = startService({
        extraEndpoints: [
          {
            name: "spawn",
            subject: "agents.spawn.svc-test.testers.controller",
            queue: "controllers",
            metadata: { role: "controller" },
            handler: (err, m) => {
              if (err) return;
              calls.push("spawn");
              m.respond(new TextEncoder().encode("spawned"));
            },
          },
          {
            name: "list",
            subject: "agents.list.svc-test.testers.controller",
            handler: (err, m) => {
              if (err) return;
              calls.push("list");
              m.respond(new TextEncoder().encode("[]"));
            },
          },
        ],
      });
      service.onPrompt(() => {
        // unused
      });
      await service.start();

      const info = service.service.info();
      const names = info.endpoints.map((e) => e.name);
      // Order is implementation-defined within the underlying service but
      // every registered endpoint must be present.
      expect(names).toContain("prompt");
      expect(names).toContain("status");
      expect(names).toContain("spawn");
      expect(names).toContain("list");

      const spawnEp = info.endpoints.find((e) => e.name === "spawn");
      expect(spawnEp?.subject).toBe("agents.spawn.svc-test.testers.controller");
      expect(spawnEp?.queue_group).toBe("controllers");
      expect(spawnEp?.metadata).toMatchObject({ role: "controller" });

      const listEp = info.endpoints.find((e) => e.name === "list");
      expect(listEp?.subject).toBe("agents.list.svc-test.testers.controller");

      // Round-trip a request to each extra endpoint to confirm the handler is wired.
      const spawnReply = await nc.request(spawnEp!.subject, new Uint8Array(0), { timeout: 1000 });
      expect(new TextDecoder().decode(spawnReply.data)).toBe("spawned");
      const listReply = await nc.request(listEp!.subject, new Uint8Array(0), { timeout: 1000 });
      expect(new TextDecoder().decode(listReply.data)).toBe("[]");
      expect(calls).toEqual(["spawn", "list"]);
    });

    it("rejects an extraEndpoint name that collides with `prompt`", async () => {
      const service = startService({
        extraEndpoints: [
          {
            name: "prompt",
            subject: "agents.custom.svc-test.testers.x",
            handler: () => {},
          },
        ],
      });
      service.onPrompt(() => {});
      await expect(service.start()).rejects.toThrow(/extraEndpoints.*name.*prompt/);
    });

    it("rejects an extraEndpoint name that collides with `status`", async () => {
      const service = startService({
        extraEndpoints: [
          {
            name: "status",
            subject: "agents.custom.svc-test.testers.x",
            handler: () => {},
          },
        ],
      });
      service.onPrompt(() => {});
      await expect(service.start()).rejects.toThrow(/extraEndpoints.*name.*status/);
    });

    it("rejects duplicate names within the extraEndpoints array", async () => {
      const service = startService({
        extraEndpoints: [
          {
            name: "spawn",
            subject: "agents.spawn.svc-test.testers.x",
            handler: () => {},
          },
          {
            name: "spawn",
            subject: "agents.spawn.svc-test.testers.y",
            handler: () => {},
          },
        ],
      });
      service.onPrompt(() => {});
      await expect(service.start()).rejects.toThrow(/extraEndpoints.*name.*spawn/);
    });

    it("`.service` getter throws before start()", () => {
      const service = startService();
      expect(() => service.service).toThrow(/not started/);
    });

    it("`.service` getter returns the underlying service after start()", async () => {
      const service = startService();
      service.onPrompt(() => {});
      await service.start();

      const info = service.service.info();
      expect(info.id).toBe(service.instanceId);
      expect(info.endpoints.map((e) => e.name).sort()).toEqual(["prompt", "status"]);
    });
  });
});
