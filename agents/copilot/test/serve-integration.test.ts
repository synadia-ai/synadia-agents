// Integration: the headless `serve` agent on a real nats-server (random free
// port), with a scripted Copilot client in place of the SDK. One plain
// server for prompts and conversations, one nkey server (the shared
// test-fixtures/identity alice user) for the signed-caller permission path.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connect, nkeyAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { Agents, signerFromSeed, type PromptInterceptor } from "@synadia-ai/agents";

import type { BridgeEvent } from "../src/bridge.js";
import { resolveServeSettings, resolveSettings } from "../src/config.js";
import {
  CopilotServe,
  type ServeClient,
  type ServePermissionResult,
  type ServeSession,
  type ServeSessionConfig,
} from "../src/serve.js";

// Each ask() waits out a 1.5s discovery window; a multi-turn test needs more than 5s.
setDefaultTimeout(30_000);

const NATS_SERVER = process.env.NATS_SERVER_BIN ?? "nats-server";
const FIXTURES = join(import.meta.dir, "..", "..", "..", "test-fixtures", "identity");
const ALICE = (JSON.parse(readFileSync(join(FIXTURES, "keys.json"), "utf8")) as {
  users: { alice: { seed: string } };
}).users.alice;

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

const servers: ChildProcess[] = [];
const connections: NatsConnection[] = [];
let plainUrl: string;
let nkeyUrl: string;
let stateDir: string;

async function startServer(extra: string[], probe: (url: string) => Promise<NatsConnection>): Promise<string> {
  const port = await freePort();
  const url = `nats://127.0.0.1:${port}`;
  servers.push(spawn(NATS_SERVER, [...extra, "-a", "127.0.0.1", "-p", String(port)], { stdio: "ignore" }));
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await (await probe(url)).close();
      return url;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

const aliceAuth = () => nkeyAuthenticator(new TextEncoder().encode(ALICE.seed));

beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "serve-itest-"));
  plainUrl = await startServer([], (url) => connect({ servers: url }));
  nkeyUrl = await startServer(["-c", join(FIXTURES, "nkey-noaccounts.conf")], (url) =>
    connect({ servers: url, authenticator: aliceAuth() }),
  );
});

afterAll(async () => {
  for (const c of connections) await c.close().catch(() => undefined);
  for (const s of servers) s.kill();
  rmSync(stateDir, { recursive: true, force: true });
});

async function nc(url = plainUrl, nkey = false): Promise<NatsConnection> {
  const c = await connect({ servers: url, ...(nkey ? { authenticator: aliceAuth() } : {}) });
  connections.push(c);
  return c;
}

/** A Copilot session that plays one turn per prompt; `turn` can raise permission requests. */
class ScriptedSession implements ServeSession {
  readonly handlers = new Set<(e: BridgeEvent) => void>();
  readonly prompts: string[] = [];
  disconnected = false;
  #n = 0;

  constructor(
    readonly sessionId: string,
    readonly config: ServeSessionConfig,
    readonly turn: (prompt: string, config: ServeSessionConfig) => Promise<string>,
  ) {}

  on(handler: (e: BridgeEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async send(options: { prompt: string }): Promise<string> {
    const id = `${this.sessionId}-m${++this.#n}`;
    this.prompts.push(options.prompt);
    setTimeout(() => void this.#play(id, options.prompt), 5);
    return id;
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }

  #emit(type: string, data: Record<string, unknown> = {}): void {
    for (const h of this.handlers) h({ type, data });
  }

  async #play(id: string, prompt: string): Promise<void> {
    this.#emit("user.message", { content: prompt, messageId: id });
    this.#emit("tool.execution_start", { toolCallId: `${id}-t`, toolName: "powershell" });
    const reply = await this.turn(prompt, this.config);
    this.#emit("tool.execution_complete", { toolCallId: `${id}-t`, success: true });
    this.#emit("assistant.message_delta", { deltaContent: reply, messageId: `${id}-a` });
    this.#emit("session.idle", {});
  }
}

class ScriptedClient implements ServeClient {
  readonly sessions: ScriptedSession[] = [];
  readonly resumed: string[] = [];
  started = false;
  stopped = false;
  #n = 0;

  constructor(readonly turn: (prompt: string, config: ServeSessionConfig) => Promise<string> = echo) {}

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async createSession(config: ServeSessionConfig): Promise<ServeSession> {
    const s = new ScriptedSession(`sess-${++this.#n}-${Math.random().toString(36).slice(2, 6)}`, config, this.turn);
    this.sessions.push(s);
    return s;
  }

  async resumeSession(sessionId: string, config: ServeSessionConfig): Promise<ServeSession> {
    this.resumed.push(sessionId);
    const s = new ScriptedSession(sessionId, config, this.turn);
    this.sessions.push(s);
    return s;
  }
}

async function echo(prompt: string): Promise<string> {
  return `echo: ${prompt.split("\n").at(-1)}`;
}

/** A turn that asks permission to run a shell command and reports the decision. */
async function permissionTurn(_prompt: string, config: ServeSessionConfig): Promise<string> {
  const d: ServePermissionResult = await config.onPermissionRequest({ kind: "shell", fullCommandText: "echo hi" });
  return `decision: ${d.kind}`;
}

function makeServe(
  client: ServeClient,
  connection: NatsConnection,
  name: string,
  env: Record<string, string> = {},
): CopilotServe {
  const fullEnv = {
    NATS_URL: plainUrl,
    SYNADIA_COPILOT_OWNER: "itest",
    SYNADIA_COPILOT_NAME: name,
    SYNADIA_COPILOT_STATE_FILE: join(stateDir, `${name}.json`),
    SYNADIA_COPILOT_PERMISSION_TIMEOUT_MS: "5000",
    ...env,
  };
  const settings = resolveSettings({}, fullEnv);
  return new CopilotServe({
    settings,
    serve: resolveServeSettings({}, fullEnv, settings, stateDir),
    client,
    log: () => undefined,
    nc: connection,
  });
}

/** Tags each prompt with `context.conversation` as the `conversation` extra. */
const conversationExtra: PromptInterceptor = {
  beforePrompt: (ctx) =>
    typeof ctx.context.conversation === "string" ? { fields: { conversation: ctx.context.conversation } } : undefined,
};

async function ask(
  agents: Agents,
  subject: string,
  text: string,
  options: { conversation?: string; answer?: string } = {},
) {
  const agent = (await agents.discover({ timeoutMs: 1500 })).find((a) => a.promptSubject === subject);
  if (!agent) throw new Error(`not discovered: ${subject}`);
  let out = "";
  const statuses: string[] = [];
  const queries: string[] = [];
  const stream = await agent.prompt(text, options.conversation ? { context: { conversation: options.conversation } } : {});
  for await (const msg of stream) {
    if (msg.type === "response") out += msg.text;
    else if (msg.type === "status") statuses.push(msg.status);
    else if (msg.type === "query") {
      queries.push(msg.prompt);
      await msg.reply(options.answer ?? "no");
    }
  }
  return { out, statuses, queries };
}

describe("serve", () => {
  test("registers as copilot, streams a turn back, and maps tool events to status", async () => {
    const client = new ScriptedClient();
    const serve = makeServe(client, await nc(), "round");
    await serve.start();
    try {
      expect(client.started).toBe(true);
      expect(serve.promptSubject).toBe("agents.prompt.copilot.itest.round");
      const agents = new Agents({ nc: await nc() });
      const meta = (await agents.discover({ timeoutMs: 1500 })).find((a) => a.promptSubject === serve.promptSubject);
      expect(meta?.metadata?.harness).toBe("github-copilot-sdk");
      const r = await ask(agents, serve.promptSubject as string, "hello there");
      expect(r.out).toBe("echo: hello there");
      expect(r.statuses).toContain("tool: powershell");
      expect(client.sessions[0]?.config).toMatchObject({ streaming: true, workingDirectory: stateDir, tools: [] });
    } finally {
      await serve.stop();
    }
    expect(client.stopped).toBe(true);
    expect(client.sessions[0]?.disconnected).toBe(true);
  });

  test("one Copilot session per conversation, resumed after a restart", async () => {
    const client = new ScriptedClient();
    const serve = makeServe(client, await nc(), "conv");
    await serve.start();
    const agents = new Agents({ nc: await nc(), interceptors: [conversationExtra] });
    const subject = serve.promptSubject as string;
    await ask(agents, subject, "one", { conversation: "a" });
    await ask(agents, subject, "two", { conversation: "a" });
    await ask(agents, subject, "three", { conversation: "b" });
    expect(client.sessions.length).toBe(2);
    expect(client.sessions[0]?.prompts.length).toBe(2);
    const first = client.sessions[0]?.sessionId as string;
    await serve.stop();

    const client2 = new ScriptedClient();
    const again = makeServe(client2, await nc(), "conv");
    await again.start();
    try {
      await ask(agents, subject, "four", { conversation: "a" });
      expect(client2.resumed).toEqual([first]);
    } finally {
      await again.stop();
    }
  });

  test("an unsigned caller is never asked: the permission is rejected", async () => {
    const client = new ScriptedClient(permissionTurn);
    const serve = makeServe(client, await nc(), "unsigned");
    await serve.start();
    try {
      const r = await ask(new Agents({ nc: await nc() }), serve.promptSubject as string, "run it", { answer: "yes" });
      expect(r.queries).toEqual([]);
      expect(r.out).toBe("decision: reject");
    } finally {
      await serve.stop();
    }
  });

  test("min_sender_trust=signed refuses an unsigned caller before Copilot sees it", async () => {
    const client = new ScriptedClient();
    const serve = makeServe(client, await nc(), "strict", { NATS_MIN_SENDER_TRUST: "signed" });
    await serve.start();
    try {
      let refused = false;
      try {
        await ask(new Agents({ nc: await nc() }), serve.promptSubject as string, "hi");
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
      expect(client.sessions.length).toBe(0);
    } finally {
      await serve.stop();
    }
  });
});

describe("serve with a signed caller", () => {
  async function signedCase(answer: string): Promise<{ out: string; queries: string[] }> {
    const client = new ScriptedClient(permissionTurn);
    const serve = makeServe(client, await nc(nkeyUrl, true), `signed-${answer}`, {
      NATS_URL: nkeyUrl,
      NATS_MIN_SENDER_TRUST: "signed",
    });
    await serve.start();
    try {
      const agents = new Agents({ nc: await nc(nkeyUrl, true), identity: { signer: signerFromSeed(ALICE.seed) } });
      return await ask(agents, serve.promptSubject as string, "run it", { answer });
    } finally {
      await serve.stop();
    }
  }

  test("a permission request becomes a query; yes approves once", async () => {
    const r = await signedCase("yes");
    expect(r.queries.length).toBe(1);
    expect(r.queries[0]).toContain("echo hi");
    expect(r.out).toBe("decision: approve-once");
  });

  test("any other answer rejects", async () => {
    const r = await signedCase("no");
    expect(r.queries.length).toBe(1);
    expect(r.out).toBe("decision: reject");
  });
});
