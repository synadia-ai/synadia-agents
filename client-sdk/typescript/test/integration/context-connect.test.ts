// End-to-end integration: `connect({ context })` opens a working NATS
// connection from a context file, discovers a running agent, and streams
// a prompt response.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { connect as natsConnect } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import { connect, type StreamMessage } from "../../src/index.js";
import { ReferenceAgent } from "../../src/testing/reference-agent.js";

const natsUrl = inject("natsUrl");

describe.skipIf(!natsUrl)("connect({ context }) end-to-end", () => {
  let root: string;
  let natsConfigHome: string;
  let originalEnv: { NATS_CONFIG_HOME: string | undefined; NATS_CONTEXT: string | undefined };

  let nc: NatsConnection;
  let agent: ReferenceAgent;

  beforeAll(async () => {
    root = await mkdtemp(joinPath(tmpdir(), "agents-ctx-e2e-"));
    natsConfigHome = joinPath(root, "nats");
    await mkdir(joinPath(natsConfigHome, "context"), { recursive: true });

    // Point the SDK at our fake context dir for the whole suite.
    originalEnv = {
      NATS_CONFIG_HOME: process.env["NATS_CONFIG_HOME"],
      NATS_CONTEXT: process.env["NATS_CONTEXT"],
    };
    process.env["NATS_CONFIG_HOME"] = natsConfigHome;
    delete process.env["NATS_CONTEXT"];

    // Shared NATS connection for the reference agent (not the one under test).
    nc = await natsConnect({ servers: natsUrl! });
    agent = new ReferenceAgent({
      nc,
      agent: "ctx-agent",
      owner: "testers",
      name: "e2e",
      heartbeatIntervalS: 1,
      promptHandler: (msg) => {
        msg.respond(new TextEncoder().encode(JSON.stringify({ type: "response", data: "ok" })));
        msg.respond("");
      },
    });
    await agent.start();
  });

  afterAll(async () => {
    await agent.stop();
    await nc.close();
    // Restore env.
    if (originalEnv.NATS_CONFIG_HOME === undefined) delete process.env["NATS_CONFIG_HOME"];
    else process.env["NATS_CONFIG_HOME"] = originalEnv.NATS_CONFIG_HOME;
    if (originalEnv.NATS_CONTEXT === undefined) delete process.env["NATS_CONTEXT"];
    else process.env["NATS_CONTEXT"] = originalEnv.NATS_CONTEXT;
    await rm(root, { recursive: true, force: true });
  });

  async function writeContext(name: string, body: Record<string, unknown>): Promise<void> {
    await writeFile(
      joinPath(natsConfigHome, "context", `${name}.json`),
      JSON.stringify(body, null, 2),
    );
  }

  async function selectContext(name: string): Promise<void> {
    await writeFile(joinPath(natsConfigHome, "context.txt"), name);
  }

  beforeEach(async () => {
    // Clean selection between tests.
    await rm(joinPath(natsConfigHome, "context.txt"), { force: true });
  });

  afterEach(() => {
    delete process.env["NATS_CONTEXT"];
  });

  it("connects using a context loaded by name", async () => {
    await writeContext("by-name", { url: natsUrl! });
    const client = await connect({ name: "ctx-test", context: "by-name" });
    try {
      const agents = await client.discover({ timeoutMs: 1000, filter: { agent: "ctx-agent" } });
      expect(agents).toHaveLength(1);
      const remote = client.bind(agents[0]!);
      const events: StreamMessage[] = [];
      for await (const msg of await remote.prompt("hi")) events.push(msg);
      expect(events.find((e) => e.type === "response")).toEqual({ type: "response", text: "ok" });
    } finally {
      await client.close();
    }
  });

  it("resolves `context: 'current'` via the selection file", async () => {
    await writeContext("selected-one", { url: natsUrl! });
    await selectContext("selected-one");
    const client = await connect({ name: "ctx-test", context: "current" });
    try {
      const agents = await client.discover({ timeoutMs: 1000, filter: { agent: "ctx-agent" } });
      expect(agents).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("`context: true` is an alias for 'current'", async () => {
    await writeContext("selected-via-true", { url: natsUrl! });
    await selectContext("selected-via-true");
    const client = await connect({ name: "ctx-test", context: true });
    try {
      const agents = await client.discover({ timeoutMs: 500, filter: { agent: "ctx-agent" } });
      expect(agents).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("$NATS_CONTEXT env var wins over selection file", async () => {
    await writeContext("via-env", { url: natsUrl! });
    await writeContext("wrong-one", { url: "nats://127.0.0.1:1" }); // unreachable
    await selectContext("wrong-one");
    process.env["NATS_CONTEXT"] = "via-env";
    const client = await connect({ name: "ctx-test", context: "current" });
    try {
      // If env-var resolution worked, discover() reaches our real agent.
      const agents = await client.discover({ timeoutMs: 500, filter: { agent: "ctx-agent" } });
      expect(agents).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("explicit `servers` overrides context url", async () => {
    await writeContext("ignored-url", { url: "nats://127.0.0.1:1" });
    const client = await connect({
      name: "ctx-test",
      context: "ignored-url",
      servers: natsUrl!,
    });
    try {
      const agents = await client.discover({ timeoutMs: 500, filter: { agent: "ctx-agent" } });
      expect(agents).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("throws when neither servers nor context is provided", async () => {
    await expect(connect({ name: "ctx-test" })).rejects.toThrow(/servers.*context/);
  });
});
