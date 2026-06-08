// 05-tools.ts — an LLM agent whose tool calls a NATS microservice.
//
// Examples 2–4 gave the agent a model (Ollama,
// OpenRouter, or either); this gives it a *tool*, and wires that tool to a
// NATS microservice. The point of the demo:
//
//   any microservice already on your NATS network can become an agent
//   capability — the agent need not embed the database, device, or
//   credential that sits behind it.
//
// The agent process here holds only an LLM and a NATS connection — it can't
// read a sensor itself. So when the model needs live data it calls a tool,
// the tool makes a NATS request, and a microservice answers. That service
// could run anywhere: another host, a leaf node, a Raspberry Pi wired to a
// real thermometer. For a self-contained demo we start it in this same file;
// in production it lives elsewhere and the agent never knows where.
//
// Two round-trips with Ollama (`/api/chat` with `tools`):
//   1. Send the prompt + tool schema; the model replies asking to call
//      `read_sensor(location)`.
//   2. We run the tool (a NATS request), feed the result back, and the model
//      streams its final answer.
//
// Prereqs: a local Ollama with a tool-capable model:
//   ollama pull llama3.1:8b
//
// Connection resolution (same as the other agents):
//   $NATS_CONTEXT > $NATS_URL > nats://127.0.0.1:4222

import { connect as natsConnect, type NatsConnection } from "@nats-io/transport-node";
import { Svcm, type ServiceMsg } from "@nats-io/services";
import { loadContextOptions, parseNatsUrl } from "@synadia-ai/agents";
import { AgentService } from "@synadia-ai/agent-service";

const MODEL = process.env["OLLAMA_MODEL"] ?? "llama3.1:8b";
const OLLAMA_URL = process.env["OLLAMA_URL"] ?? "http://localhost:11434";

// Subject the sensor microservice listens on. The agent's tool sends requests
// here; nothing else couples the agent to the service.
const SENSOR_SUBJECT = "sensors.read";

// ---------------------------------------------------------------------------
// The microservice — a stand-in for "some service already on your network".
// Given a location, reply with its current temperature in °C. Backed by a
// lookup table so the demo is deterministic; swap in a real sensor at will.
// ---------------------------------------------------------------------------
const READINGS: Record<string, number> = {
  "cold-storage-1": 3.4,
  "cold-storage-2": 2.8,
  "cold-storage-3": 6.2, // too warm on purpose — gives the agent something to flag
};

async function startSensorService(nc: NatsConnection): Promise<void> {
  const service = await new Svcm(nc).add({
    name: "sensors",
    version: "0.1.0",
    description: "Returns the current temperature (°C) for a location",
  });
  service.addEndpoint("read", {
    subject: SENSOR_SUBJECT,
    handler: (err, msg: ServiceMsg) => {
      if (err) return;
      const reading = READINGS[msg.string()]; // request body is the bare location
      msg.respond(reading === undefined ? "unknown" : String(reading));
    },
  });
}

// ---------------------------------------------------------------------------
// The tool — what we advertise to the model, and what runs when it's called.
// The handler body is the whole point: one NATS request to the microservice.
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_sensor",
      description: "Read the current temperature in Celsius at a location.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "sensor location, e.g. 'cold-storage-3'" },
        },
        required: ["location"],
      },
    },
  },
];

async function runTool(
  nc: NatsConnection,
  name: string,
  args: Record<string, unknown> | string,
): Promise<string> {
  if (name !== "read_sensor") return `error: unknown tool '${name}'`;
  // Most models hand back parsed arguments; some return a JSON string instead.
  const parsed: Record<string, unknown> =
    typeof args === "string" ? (JSON.parse(args) as Record<string, unknown>) : args;
  const location = typeof parsed["location"] === "string" ? parsed["location"] : "";
  const reply = await nc.request(SENSOR_SUBJECT, location, { timeout: 5000 });
  const value = reply.string();
  return value === "unknown" ? `no sensor at '${location}'` : `${location} is ${value}°C`;
}

// ---------------------------------------------------------------------------
// Ollama `/api/chat` helpers.
// ---------------------------------------------------------------------------
interface ChatMessage {
  role: string;
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> | string } }[];
}

// One non-streamed turn — used for the tool-decision round, where we want a
// clean `tool_calls` array back rather than a token stream.
async function chat(messages: ChatMessage[]): Promise<ChatMessage> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama chat failed: ${res.status} ${res.statusText}`);
  return ((await res.json()) as { message: ChatMessage }).message;
}

// Final turn — stream the model's answer token by token (same NDJSON parsing
// as 02-ollama, but `/api/chat` carries each token at `message.content`). No
// tools here: the model has its data and just needs to answer.
async function* chatStream(messages: ChatMessage[]): AsyncGenerator<string> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, stream: true }),
  });
  if (!res.ok || res.body === null) {
    throw new Error(`Ollama chat failed: ${res.status} ${res.statusText}`);
  }
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of res.body) {
    buffer += decoder.decode(bytes as Uint8Array, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() === "") continue;
      // One JSON object per line; tolerate a rare non-JSON line (e.g. an error
      // emitted mid-stream) instead of crashing the whole reply.
      try {
        const token =
          (JSON.parse(line) as { message?: { content?: string } }).message?.content ?? "";
        if (token) yield token;
      } catch {
        /* skip malformed line */
      }
    }
  }
}

async function main(): Promise<void> {
  const opts = process.env["NATS_CONTEXT"]
    ? await loadContextOptions(process.env["NATS_CONTEXT"])
    : process.env["NATS_URL"]
      ? parseNatsUrl(process.env["NATS_URL"])
      : { servers: "nats://127.0.0.1:4222" };
  const nc = await natsConnect(opts);

  // Start the microservice the agent's tool will call. In production this is a
  // separate process somewhere on the network — here it just shares `nc`.
  await startSensorService(nc);

  // Identity and heartbeat cadence are env-overridable (see 01-echo.ts).
  const heartbeatIntervalS = Number(process.env["NATS_AGENT_HEARTBEAT_INTERVAL"]) || undefined;
  const service = new AgentService({
    nc,
    agent: "tools",
    owner: process.env["NATS_AGENT_OWNER"] ?? process.env["USER"] ?? "anon",
    name: process.env["NATS_AGENT_NAME"] ?? "main",
    ...(heartbeatIntervalS !== undefined ? { heartbeatIntervalS } : {}),
    description: "LLM agent with a read_sensor tool backed by a NATS microservice",
  });

  service.onPrompt(async (envelope, response) => {
    const messages: ChatMessage[] = [{ role: "user", content: envelope.prompt }];

    // Round 1 — does the model want a tool? (non-streamed, for clean tool_calls)
    const decision = await chat(messages);
    messages.push(decision);

    // Run whatever tools the model asked for, appending each result to the
    // conversation. (One round is plenty for this demo; a fuller agent would
    // loop until the model stops requesting tools.)
    for (const call of decision.tool_calls ?? []) {
      const result = await runTool(nc, call.function.name, call.function.arguments);
      messages.push({ role: "tool", content: result });
    }

    // No tool needed → round 1 was already the answer.
    if (!decision.tool_calls?.length) {
      await response.send(decision.content);
      return;
    }

    // Round 2 — the model now has the sensor reading; stream its final answer.
    for await (const token of chatStream(messages)) {
      await response.send(token);
    }
  });

  await service.start();
  console.log(`tools agent listening on ${service.subject.prompt}`);
  console.log(`sensor service on '${SENSOR_SUBJECT}', model '${MODEL}' at ${OLLAMA_URL}`);
  console.log("press Ctrl+C to stop");

  const shutdown = async (): Promise<void> => {
    console.log("\nshutting down…");
    await service.stop();
    await nc.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main().catch((err: unknown) => {
  console.error("tools agent failed:", err);
  process.exit(1);
});
