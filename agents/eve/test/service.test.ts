import { describe, expect, test } from "bun:test";
import type { RequestEnvelope } from "@synadia-ai/agents";
import type { Chunk } from "@synadia-ai/agent-service";
import type { HandleMessageStreamEvent } from "eve/client";
import { buildAgentServiceOptions, createSerializedPromptHandler } from "../src/service.js";
import type { BridgeResponse, EveBridgeClient } from "../src/bridge.js";
import type { EveChannelConfig } from "../src/config.js";
import { mappingFromConfig } from "../src/config.js";

function config(overrides: Partial<EveChannelConfig["eve"]> = {}): EveChannelConfig {
  return {
    nats: { url: "nats://127.0.0.1:4222" },
    agent: {
      owner: "rene",
      name: "support",
      subjectToken: "eve",
      heartbeatIntervalS: 30,
      keepaliveIntervalS: 30,
    },
    eve: {
      baseUrl: "http://127.0.0.1:2000",
      askTimeoutS: 120,
      ...overrides,
    },
  };
}

describe("service construction", () => {
  test("builds AgentService options for eve with attachments enabled", () => {
    const opts = buildAgentServiceOptions({ nc: {} as never, config: config(), version: "0.1.0" });
    expect(opts.agent).toBe("eve");
    expect(opts.subjectToken).toBe("eve");
    expect(opts.owner).toBe("rene");
    expect(opts.name).toBe("support");
    expect(opts.session).toBe("support");
    expect(opts.attachmentsOk).toBe(true);
    expect(opts.extraMetadata).toEqual({
      eve_base_url: "http://127.0.0.1:2000",
      eve_auth: "none",
    });
  });

  test("advertises bearer auth mode without ever exposing the token", () => {
    const opts = buildAgentServiceOptions({
      nc: {} as never,
      config: config({ authToken: "super-secret" }),
      version: "0.1.0",
    });
    expect(opts.extraMetadata).toEqual({
      eve_base_url: "http://127.0.0.1:2000",
      eve_auth: "bearer",
    });
    expect(JSON.stringify(opts.extraMetadata)).not.toContain("super-secret");
    expect(opts.description).not.toContain("super-secret");
  });
});

class QueueRecordingResponse implements BridgeResponse {
  readonly chunks: Array<string | Chunk> = [];
  async send(chunk: string | Chunk): Promise<void> {
    this.chunks.push(chunk);
  }
  async ask(): Promise<RequestEnvelope> {
    throw new Error("ask not expected in queue tests");
  }
}

const waitingEvent: HandleMessageStreamEvent = {
  type: "session.waiting",
  data: { continuationToken: "ct", wait: "next-user-message" },
};

describe("createSerializedPromptHandler", () => {
  test("serializes concurrent prompts: the second turn starts only after the first finishes", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const eveClient: EveBridgeClient = {
      async send() {
        calls += 1;
        const n = calls;
        order.push(`send${n}`);
        return (async function* () {
          if (n === 1) await gate;
          order.push(`stream${n}`);
          yield waitingEvent;
        })();
      },
      sessionId: () => undefined,
    };
    const handler = createSerializedPromptHandler({
      mapping: mappingFromConfig(config()),
      eveClient,
    });

    const p1 = handler({ prompt: "one" }, new QueueRecordingResponse());
    const p2 = handler({ prompt: "two" }, new QueueRecordingResponse());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["send1"]);

    releaseFirst();
    await p1;
    await p2;
    expect(order).toEqual(["send1", "stream1", "send2", "stream2"]);
  });

  test("a rejected prompt surfaces to its caller without poisoning the queue", async () => {
    let calls = 0;
    const eveClient: EveBridgeClient = {
      async send() {
        calls += 1;
        if (calls === 1) throw new Error("eve server unreachable at http://x: boom");
        return (async function* () {
          yield waitingEvent;
        })();
      },
      sessionId: () => undefined,
    };
    const handler = createSerializedPromptHandler({
      mapping: mappingFromConfig(config()),
      eveClient,
    });

    const first = new QueueRecordingResponse();
    const second = new QueueRecordingResponse();
    const p1 = handler({ prompt: "one" }, first);
    const p2 = handler({ prompt: "two" }, second);

    await expect(p1).rejects.toThrow("eve server unreachable");
    await p2;
    expect(second.chunks).toEqual([{ type: "response", text: "" }]);
  });
});
