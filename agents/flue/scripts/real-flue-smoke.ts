import { connect as natsConnect } from "@nats-io/transport-node";
import { Agents, type StreamMessage } from "@synadia-ai/agents";
import type { FlueChannelConfig, FlueTransport } from "../src/config.js";
import { createFlueAgentService } from "../src/service.js";

const natsUrl = process.env["NATS_URL"] ?? "nats://127.0.0.1:4222";
const flueBaseUrl = process.env["FLUE_BASE_URL"] ?? "http://127.0.0.1:3583";
const flueAgent = process.env["FLUE_AGENT"] ?? "echo";
const flueInstance = process.env["FLUE_INSTANCE"] ?? "real-flue-smoke";
const flueSession = process.env["FLUE_SESSION"] ?? `real-flue-smoke-${Date.now()}`;
const flueTransport = (process.env["FLUE_TRANSPORT"] ?? "http-sync") as FlueTransport;
const prompt = process.env["SMOKE_PROMPT"] ?? "hello-real-flow";
const expected = process.env["SMOKE_EXPECTS"] ?? `echo:${prompt}`;
const name = `real-flue-${Math.random().toString(36).slice(2, 8)}`;

const config: FlueChannelConfig = {
  nats: { url: natsUrl },
  agent: {
    owner: "smoke",
    name,
    subjectToken: "flue",
    heartbeatIntervalS: 1,
    keepaliveIntervalS: 1,
  },
  flue: {
    baseUrl: flueBaseUrl,
    agent: flueAgent,
    instance: flueInstance,
    session: flueSession,
    transport: flueTransport,
  },
};

const nc = await natsConnect({ servers: natsUrl });
const callerNc = await natsConnect({ servers: natsUrl });
const service = createFlueAgentService({ nc, config, version: "0.1.0-real-flue-smoke" });

try {
  await service.start();
  const agents = new Agents({ nc: callerNc });
  const found = await agents.discover({ timeoutMs: 1000, filter: { agent: "flue", name } });
  if (found.length !== 1) throw new Error(`expected one flue smoke agent, found ${found.length}`);

  const messages: StreamMessage[] = [];
  for await (const msg of await found[0]!.prompt(prompt)) messages.push(msg);

  console.log(JSON.stringify({ subject: service.subject.prompt, flue: config.flue, messages }, null, 2));
  const first = messages[0];
  if (first?.type !== "status" || first.status !== "ack") throw new Error("missing leading ack status");
  if (!messages.some((m) => m.type === "status" && (m as { status: string }).status.includes("connected to Flue"))) {
    throw new Error("missing Flue connected status");
  }
  if (!messages.some((m) => m.type === "response" && m.text.includes(expected))) {
    throw new Error(`missing expected real Flue response ${JSON.stringify(expected)}`);
  }
  const last = messages.at(-1);
  if (last?.type !== "status" || last.status !== "done") throw new Error("missing done terminator status");
} finally {
  await service.stop();
  await nc.close();
  await callerNc.close();
}
