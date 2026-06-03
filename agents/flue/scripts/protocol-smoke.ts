import { connect as natsConnect } from "@nats-io/transport-node";
import { Agents, type StreamMessage } from "@synadia-ai/agents";
import type { FlueBridgeClient } from "../src/bridge.js";
import type { FlueChannelConfig } from "../src/config.js";
import { createFlueAgentService } from "../src/service.js";

const natsUrl = process.env["NATS_URL"] ?? "nats://127.0.0.1:4222";
const name = `smoke-${Math.random().toString(36).slice(2, 8)}`;

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
    baseUrl: "http://127.0.0.1:3583",
    agent: "assistant",
    instance: "fake-instance",
    session: "smoke-session",
    transport: "http-stream",
  },
};

const fakeFlueClient: FlueBridgeClient = {
  async prompt(input) {
    return `fake Flue response to ${input.message} for ${input.agent}/${input.instance}/${input.session}`;
  },
};

const nc = await natsConnect({ servers: natsUrl });
const callerNc = await natsConnect({ servers: natsUrl });
const service = createFlueAgentService({ nc, config, version: "0.1.0-smoke", flueClient: fakeFlueClient });

try {
  await service.start();
  const agents = new Agents({ nc: callerNc });
  const found = await agents.discover({ timeoutMs: 1000, filter: { agent: "flue", name } });
  if (found.length !== 1) throw new Error(`expected one flue smoke agent, found ${found.length}`);

  const messages: StreamMessage[] = [];
  for await (const msg of await found[0]!.prompt("hello smoke")) messages.push(msg);

  console.log(JSON.stringify({ subject: service.subject.prompt, messages }, null, 2));
  const first = messages[0];
  if (first?.type !== "status" || first.status !== "ack") throw new Error("missing leading ack status");
  if (!messages.some((m) => m.type === "status" && (m as { status: string }).status.includes("connected to Flue"))) {
    throw new Error("missing Flue connected status");
  }
  if (!messages.some((m) => m.type === "response" && m.text.includes("fake Flue response"))) {
    throw new Error("missing fake Flue response");
  }
  const last = messages.at(-1);
  if (last?.type !== "status" || last.status !== "done") throw new Error("missing done terminator status");
} finally {
  await service.stop();
  await nc.close();
  await callerNc.close();
}
