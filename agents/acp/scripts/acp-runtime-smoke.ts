#!/usr/bin/env bun
// End-to-end managed-runtime smoke: NATS caller -> AgentService -> managed
// ACP runtime -> fake ACP agent subprocess (real NDJSON JSON-RPC wire).
// Deterministic — no real coding-agent binary required.
import { createConnection, createServer } from "node:net";
import { connect as natsConnect } from "@nats-io/transport-node";
import { Agents, type StreamMessage } from "@synadia-ai/agents";
import { ManagedAcpRuntime } from "../src/managed-runtime.js";
import { createAcpAgentService } from "../src/service.js";
import type { AcpChannelConfig } from "../src/config.js";

const nats = await ensureNats();
const config: AcpChannelConfig = {
  nats: { url: nats.url },
  agent: { owner: "smoke", session: "managed", subjectToken: "grok", heartbeatIntervalS: 1, keepaliveIntervalS: 1 },
  acp: {
    mode: "managed",
    preset: "grok",
    agentId: "grok",
    bin: "grok",
    args: ["agent", "stdio"],
    homeEnvVar: "GROK_HOME",
    cwd: process.cwd(),
    permissionPolicy: "reject",
  },
};

const nc = await natsConnect({ servers: nats.url });
const callerNc = await natsConnect({ servers: nats.url });
const runtime = new ManagedAcpRuntime({ config, command: "bun", args: ["scripts/fake-acp-agent.ts"] });
const service = createAcpAgentService({ nc, config, version: "0.1.0-smoke", client: runtime });
try {
  await runtime.start();
  await service.start();
  const agents = new Agents({ nc: callerNc });
  const found = await agents.discover({ timeoutMs: 1000, filter: { agent: "grok", name: "managed" } });
  if (found.length !== 1) throw new Error(`expected one managed grok agent, found ${found.length}`);
  const messages: StreamMessage[] = [];
  for await (const msg of await found[0]!.prompt("hello runtime")) messages.push(msg);
  const responseText = messages.filter((m): m is Extract<StreamMessage, { type: "response" }> => m.type === "response").map((m) => m.text).join("");
  if (!responseText.includes("fake ACP response to hello runtime")) throw new Error(`missing managed response text: ${responseText}`);
  if (responseText.includes("pondering")) throw new Error("thought chunk leaked into the response stream");
  if (messages.some((m) => m.type === "response" && m.text === "")) throw new Error("managed bridge emitted an empty response chunk");
  if (!messages.some((m) => m.type === "status" && m.status.includes("tool: echo fixture tool"))) throw new Error("missing tool_call status chunk");
  console.log(JSON.stringify({ ok: true, natsUrl: nats.url, subject: service.subject.prompt, messageTypes: messages.map((m) => m.type), responseText, isolatedHome: runtime.agentHome !== undefined }, null, 2));
} finally {
  await service.stop();
  await runtime.close();
  await nc.drain();
  await callerNc.drain();
  await nats.close();
}

async function ensureNats(): Promise<{ url: string; close(): Promise<void> }> {
  const port = await freePort();
  const url = `nats://127.0.0.1:${port}`;
  const proc = Bun.spawn(["nats-server", "-a", "127.0.0.1", "-p", String(port)], { stdout: "ignore", stderr: "pipe" });
  await waitForPort(port, 5000).catch(async (err) => {
    proc.kill();
    const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
    throw new Error(`failed to start disposable nats-server: ${(err as Error).message}${stderr ? `\n${stderr}` : ""}`);
  });
  return { url, close: async () => { proc.kill(); await proc.exited.catch(() => undefined); } };
}
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("failed to allocate free port")));
    });
    server.on("error", reject);
  });
}
async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port }, () => { socket.end(); resolve(); });
        socket.on("error", reject);
      });
      return;
    } catch { await Bun.sleep(50); }
  }
  throw new Error(`port ${port} did not open within ${timeoutMs}ms`);
}
