// Real-eve smoke: spawns `npx eve dev --no-ui` on the mockModel fixture in
// test/fixtures/eve-agent and drives it end-to-end over NATS through the
// real SdkEveBridgeClient. Manual/local gate — needs Node >= 24 on PATH
// (eve's engine floor) and the fixture's dependencies installed once:
//
//   ( cd test/fixtures/eve-agent && npm install )
//
// The fixture needs no model provider key (deterministic mockModel).
// CI candidate for a follow-up job: mockModel means no secrets required,
// only a Node 24 toolchain next to Bun.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect as natsConnect } from "@nats-io/transport-node";
import { Agents, type StreamMessage } from "@synadia-ai/agents";
import type { EveChannelConfig } from "../src/config.js";
import { createEveAgentService } from "../src/service.js";

const natsUrl = process.env["NATS_URL"] ?? "nats://127.0.0.1:4222";
const port = Number(process.env["EVE_SMOKE_PORT"] ?? "2000");
const baseUrl = `http://127.0.0.1:${port}`;
const fixtureDir = fileURLToPath(new URL("../test/fixtures/eve-agent/", import.meta.url));
const name = `real-eve-${Math.random().toString(36).slice(2, 8)}`;

const nodeVersion = Bun.spawnSync(["node", "--version"]).stdout.toString().trim();
const nodeMajor = Number(/^v(\d+)/.exec(nodeVersion)?.[1] ?? "0");
if (nodeMajor < 24) {
  console.error(`eve dev needs Node >= 24 on PATH; found ${nodeVersion || "no node"}.`);
  console.error("Install one (e.g. `mise install node@24`) and re-run:");
  console.error("  mise exec node@24 -- bun run smoke:real-eve");
  process.exit(1);
}

if (!existsSync(join(fixtureDir, "node_modules"))) {
  console.error("fixture dependencies missing — run once:");
  console.error("  ( cd test/fixtures/eve-agent && npm install )");
  process.exit(1);
}

const config: EveChannelConfig = {
  nats: { url: natsUrl },
  agent: {
    owner: "smoke",
    name,
    subjectToken: "eve",
    heartbeatIntervalS: 1,
    keepaliveIntervalS: 1,
  },
  eve: {
    baseUrl,
    askTimeoutS: 30,
  },
};

console.log(`starting eve dev --no-ui on port ${port} (Node ${nodeVersion})…`);
const eveDev = spawn("npx", ["eve", "dev", "--no-ui", "--port", String(port)], {
  cwd: fixtureDir,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, FORCE_COLOR: "0" },
});
let eveDevOutput = "";
eveDev.stdout?.on("data", (chunk: Buffer) => {
  eveDevOutput += chunk.toString();
});
eveDev.stderr?.on("data", (chunk: Buffer) => {
  eveDevOutput += chunk.toString();
});

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (eveDev.exitCode !== null) {
      throw new Error(`eve dev exited before becoming healthy:\n${eveDevOutput}`);
    }
    try {
      const res = await fetch(`${baseUrl}/eve/v1/health`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      throw new Error(`eve dev did not report healthy within 120s:\n${eveDevOutput}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function collect(stream: AsyncIterable<StreamMessage>): Promise<StreamMessage[]> {
  const messages: StreamMessage[] = [];
  for await (const msg of stream) messages.push(msg);
  return messages;
}

function responseText(messages: readonly StreamMessage[]): string {
  return messages
    .filter((m) => m.type === "response")
    .map((m) => m.text)
    .join("");
}

let nc: Awaited<ReturnType<typeof natsConnect>> | undefined;
let callerNc: Awaited<ReturnType<typeof natsConnect>> | undefined;
let service: ReturnType<typeof createEveAgentService> | undefined;

try {
  await waitForHealth();
  console.log("eve dev is healthy; registering the sidecar on NATS…");

  nc = await natsConnect({ servers: natsUrl });
  callerNc = await natsConnect({ servers: natsUrl });
  service = createEveAgentService({ nc, config, version: "0.1.0-real-eve-smoke" });
  await service.start();

  const agents = new Agents({ nc: callerNc });
  const found = await agents.discover({ timeoutMs: 1000, filter: { agent: "eve", name } });
  if (found.length !== 1) throw new Error(`expected one eve smoke agent, found ${found.length}`);
  const agent = found[0]!;
  if (agent.promptEndpoint.attachmentsOk !== true)
    throw new Error("prompt endpoint must advertise attachments_ok=true");

  const first = await collect(await agent.prompt("hello-eve"));
  console.log(JSON.stringify({ turn: 1, messages: first }, null, 2));
  if (first[0]?.type !== "status" || first[0].status !== "ack")
    throw new Error("missing leading ack status");
  const firstText = responseText(first);
  if (!firstText.includes("echo:hello-eve") || !firstText.includes("(turn 1)"))
    throw new Error(`unexpected first response: ${JSON.stringify(firstText)}`);
  const firstLast = first.at(-1);
  if (firstLast?.type !== "status" || firstLast.status !== "done")
    throw new Error("missing done terminator on first turn");

  const second = await collect(await agent.prompt("still-there"));
  console.log(JSON.stringify({ turn: 2, messages: second }, null, 2));
  const secondText = responseText(second);
  if (!secondText.includes("echo:still-there") || !secondText.includes("(turn 2)"))
    throw new Error(
      `second turn did not continue the eve session (expected turn 2): ${JSON.stringify(secondText)}`,
    );

  console.log("real-eve smoke passed");
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await service?.stop();
  await nc?.close();
  await callerNc?.close();
  if (eveDev.exitCode === null) {
    eveDev.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      if (eveDev.exitCode === null) eveDev.kill("SIGKILL");
    }, 5_000);
    await new Promise((resolve) => eveDev.once("exit", resolve));
    clearTimeout(killTimer);
  }
}
