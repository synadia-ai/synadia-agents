// Integration: a real nats-server on a random free port, the extension
// runtime with a scripted fake Copilot session, real SDK callers/agents.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

import { connect, type NatsConnection } from "@nats-io/transport-node";
import { AgentService } from "@synadia-ai/agent-service";
import { Agents } from "@synadia-ai/agents";

import type { BridgeEvent, BridgeSession } from "../src/bridge.js";
import { resolveSettings } from "../src/config.js";
import { ExtensionRuntime } from "../src/runtime.js";

const NATS_SERVER = process.env.NATS_SERVER_BIN ?? "nats-server";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

let server: ChildProcess;
let url: string;
const connections: NatsConnection[] = [];

async function nc(): Promise<NatsConnection> {
  const c = await connect({ servers: url });
  connections.push(c);
  return c;
}

beforeAll(async () => {
  const port = await freePort();
  url = `nats://127.0.0.1:${port}`;
  server = spawn(NATS_SERVER, ["-a", "127.0.0.1", "-p", String(port)], { stdio: "ignore" });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      (await connect({ servers: url })).close();
      break;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

afterAll(async () => {
  for (const c of connections) await c.close().catch(() => undefined);
  server?.kill();
});

/**
 * Plays a Copilot turn for every prompt it is sent: echoes the last line
 * back as two deltas, with one tool call. `onTurn` can replace the reply.
 */
class ScriptedSession implements BridgeSession {
  readonly sessionId: string;
  readonly handlers = new Set<(e: BridgeEvent) => void>();
  readonly prompts: string[] = [];
  onTurn?: (prompt: string) => Promise<string>;
  #n = 0;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  on(handler: (e: BridgeEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async send(options: { prompt: string }): Promise<string> {
    const id = `msg-${++this.#n}`;
    this.prompts.push(options.prompt);
    setTimeout(() => void this.#play(id, options.prompt), 5);
    return id;
  }

  emit(type: string, data: Record<string, unknown> = {}): void {
    for (const h of this.handlers) h({ type, data });
  }

  async #play(id: string, prompt: string): Promise<void> {
    this.emit("user.message", { content: prompt, messageId: id });
    this.emit("assistant.turn_start", {});
    this.emit("tool.execution_start", { toolCallId: `${id}-t`, toolName: "view" });
    this.emit("tool.execution_complete", { toolCallId: `${id}-t`, success: true });
    const reply = this.onTurn ? await this.onTurn(prompt) : `echo: ${prompt.split("\n").at(-1)}`;
    const half = Math.ceil(reply.length / 2);
    this.emit("assistant.message_delta", { deltaContent: reply.slice(0, half), messageId: `${id}-a` });
    this.emit("assistant.message_delta", { deltaContent: reply.slice(half), messageId: `${id}-a` });
    this.emit("assistant.message", { content: reply, messageId: `${id}-a` });
    this.emit("session.idle", {});
  }
}

async function collect(agents: Agents, subject: string, text: string) {
  const agent = (await agents.discover({ timeoutMs: 1500 })).find((a) => a.promptSubject === subject);
  if (!agent) throw new Error(`not discovered: ${subject}`);
  let out = "";
  const statuses: string[] = [];
  for await (const msg of await agent.prompt(text)) {
    if (msg.type === "response") out += msg.text;
    else if (msg.type === "status") statuses.push(msg.status);
  }
  return { out, statuses };
}

function settings(env: Record<string, string>) {
  return resolveSettings({}, { NATS_URL: url, SYNADIA_COPILOT_OWNER: "itest", ...env });
}

describe("inbound", () => {
  test("disabled by default: tools only, nothing registered", async () => {
    const runtime = new ExtensionRuntime({ settings: settings({}), log: () => undefined, nc: await nc() });
    await runtime.start(new ScriptedSession("off-session"));
    expect(runtime.promptSubject).toBeUndefined();
    const agents = new Agents({ nc: await nc() });
    const found = await agents.discover({ timeoutMs: 800 });
    expect(found.some((a) => a.promptSubject.includes(".copilot."))).toBe(false);
    await runtime.stop();
  });

  test("a fleet prompt runs in the session and streams back", async () => {
    const session = new ScriptedSession("abcd1234-ffff");
    const runtime = new ExtensionRuntime({
      settings: settings({ SYNADIA_COPILOT_INBOUND: "1" }),
      log: () => undefined,
      nc: await nc(),
    });
    await runtime.start(session);
    try {
      expect(runtime.promptSubject).toBe("agents.prompt.copilot.itest.copilot-abcd1234");
      const agents = new Agents({ nc: await nc() });
      const { out, statuses } = await collect(agents, runtime.promptSubject!, "say hi");
      expect(out).toBe("echo: say hi");
      expect(statuses).toContain("tool: view");
      expect(session.prompts[0]).toContain("[Remote prompt from the NATS agent fleet");
      expect(session.prompts[0]!.endsWith("\n\nsay hi")).toBe(true);
    } finally {
      await runtime.stop();
    }
  });

  test("concurrent prompts are queued and each gets its own reply", async () => {
    const session = new ScriptedSession("queue-session");
    session.onTurn = async (p) => {
      await new Promise((r) => setTimeout(r, 150));
      return `done ${p.split("\n").at(-1)}`;
    };
    const runtime = new ExtensionRuntime({
      settings: settings({ SYNADIA_COPILOT_INBOUND: "1", SYNADIA_COPILOT_NAME: "queue" }),
      log: () => undefined,
      nc: await nc(),
    });
    await runtime.start(session);
    try {
      const agents = new Agents({ nc: await nc() });
      const results = await Promise.all(
        ["one", "two", "three"].map((t) => collect(agents, runtime.promptSubject!, t)),
      );
      expect(results.map((r) => r.out).sort()).toEqual(["done one", "done three", "done two"]);
      expect(results.some((r) => r.statuses.some((s) => s.startsWith("queued:")))).toBe(true);
    } finally {
      await runtime.stop();
    }
  });

  test("min_sender_trust=signed refuses an unsigned caller before the session sees it", async () => {
    const session = new ScriptedSession("signed-session");
    const runtime = new ExtensionRuntime({
      settings: settings({ SYNADIA_COPILOT_INBOUND: "1", NATS_MIN_SENDER_TRUST: "signed", SYNADIA_COPILOT_NAME: "signed" }),
      log: () => undefined,
      nc: await nc(),
    });
    await runtime.start(session);
    try {
      const agents = new Agents({ nc: await nc() });
      await expect(collect(agents, runtime.promptSubject!, "let me in")).rejects.toThrow();
      expect(session.prompts).toEqual([]);
    } finally {
      await runtime.stop();
    }
  });

  test("permission query mode never asks an unverified caller (stays with the UI)", async () => {
    const session = new ScriptedSession("perm-session");
    const runtime = new ExtensionRuntime({
      settings: settings({ SYNADIA_COPILOT_INBOUND: "1", SYNADIA_COPILOT_PERMISSIONS: "query", SYNADIA_COPILOT_NAME: "perm" }),
      log: () => undefined,
      nc: await nc(),
    });
    session.onTurn = async () => {
      const decision = await runtime.decidePermission({ kind: "shell", fullCommandText: "ls" });
      return `decision=${decision.kind}`;
    };
    await runtime.start(session);
    try {
      const agents = new Agents({ nc: await nc() });
      const { out } = await collect(agents, runtime.promptSubject!, "run ls");
      expect(out).toBe("decision=no-result");
    } finally {
      await runtime.stop();
    }
  });
});

describe("outbound tools", () => {
  test("discover_agents and prompt_agent reach a fleet agent", async () => {
    const ref = new AgentService({ nc: await nc(), agent: "echo", owner: "itest", name: "ref", heartbeatIntervalS: 1 });
    ref.onPrompt(async (envelope, response) => {
      await response.send(`pong: ${envelope.prompt}`);
    });
    await ref.start();
    const runtime = new ExtensionRuntime({ settings: settings({}), log: () => undefined, nc: await nc() });
    await runtime.start(new ScriptedSession("tools-session"));
    try {
      const tools = runtime.extensionTools().map((t) => t.name);
      expect(tools).toEqual(["discover_agents", "prompt_agent", "answer_agent"]);
      expect(runtime.extensionTools().some((t) => "skipPermission" in t)).toBe(false);
      expect(runtime.extensionTools().map((t) => t.defer)).toEqual(["never", "never", undefined]);

      const discovered = JSON.parse(await runtime.executeTool("discover_agents", {}, "c1"));
      const text = JSON.stringify(discovered);
      expect(text).toContain("echo.itest.ref");
      const entry = (discovered.agents as Array<{ address: string }>).find((a) => a.address.includes("ref"));
      expect(entry).toBeDefined();

      const reply = JSON.parse(
        await runtime.executeTool("prompt_agent", { address: entry!.address, prompt: "ping" }, "c2"),
      );
      expect(reply.state).toBe("completed");
      expect(reply.reply).toBe("pong: ping");
    } finally {
      await runtime.stop();
      await ref.stop();
    }
  });

  test("the session's own address is not offered to itself", async () => {
    const session = new ScriptedSession("selfself-0000");
    const runtime = new ExtensionRuntime({
      settings: settings({ SYNADIA_COPILOT_INBOUND: "1" }),
      log: () => undefined,
      nc: await nc(),
    });
    await runtime.start(session);
    try {
      const discovered = await runtime.executeTool("discover_agents", {}, "c3");
      expect(discovered).not.toContain("copilot-selfself");
    } finally {
      await runtime.stop();
    }
  });

  test("tools report a clear error when NATS is unreachable", async () => {
    const port = await freePort();
    const runtime = new ExtensionRuntime({
      settings: resolveSettings({}, { NATS_URL: `nats://127.0.0.1:${port}` }),
      log: () => undefined,
    });
    const result = JSON.parse(await runtime.executeTool("discover_agents", {}, "c4"));
    expect(result.error).toContain("not connected to NATS");
    await runtime.stop();
  });
});
