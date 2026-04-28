// DSPy-style NATS agent: ax-llm ReAct loop with sandboxed fs tools, exposed as
// a NATS Agent Protocol v0.3 service via the SDK's `AgentService` helper.
// Streams ReAct status lines and final-answer deltas as protocol-typed chunks.

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { ai, ax } from "@ax-llm/ax";
import { connect as natsConnect } from "@nats-io/transport-node";
import { AgentService } from "@synadia-ai/agents";
import { makeFsTools } from "./tools.js";

const NATS_URL = process.env["NATS_URL"] ?? "nats://127.0.0.1:4222";
const SANDBOX = path.resolve(process.env["DSPY_SANDBOX"] ?? "./sandbox");
const MODEL = process.env["DSPY_MODEL"] ?? "openai/gpt-oss-20b";
const API_URL = process.env["NVIDIA_API_URL"] ?? "https://integrate.api.nvidia.com/v1";
const API_KEY = process.env["NVIDIA_API_KEY"];

if (!API_KEY) {
  console.error("NVIDIA_API_KEY is not set. Did you `source .env`?");
  process.exit(1);
}

await fs.mkdir(SANDBOX, { recursive: true });

// NVIDIA's OpenAI-compatible endpoint returns `reasoning_content: null` for
// non-reasoning models, which ax maps to `thought` and then rejects as
// non-string. Strip it at the transport layer.
const DEBUG_TRACE = process.env["DSPY_DEBUG"] === "1";
let turn = 0;
const scrubbedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  turn += 1;
  const n = turn;
  let finalInit = init;
  // NVIDIA's llama-3.3 rejects assistant messages that carry multiple tool_calls
  // ("This model only supports single tool-calls at once"). Force sequential.
  if (init?.body && typeof init.body === "string") {
    try {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (Array.isArray(body["messages"]) && Array.isArray(body["tools"])) {
        body["parallel_tool_calls"] = false;
        finalInit = { ...init, body: JSON.stringify(body) };
      }
    } catch {
      // non-JSON body — leave it
    }
  }
  if (DEBUG_TRACE && finalInit?.body) {
    await fs.writeFile(`/tmp/dspy-req-${n}.json`, String(finalInit.body));
  }
  const res = await fetch(input, finalInit);
  if (DEBUG_TRACE) {
    console.error(`[fetch #${n}] ${res.status} ${res.statusText}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    if (DEBUG_TRACE && !res.ok) {
      const text = await res.clone().text();
      await fs.writeFile(`/tmp/dspy-res-${n}.txt`, text);
    }
    return res;
  }
  const body = await res.json();
  if (DEBUG_TRACE) {
    await fs.writeFile(`/tmp/dspy-res-${n}.json`, JSON.stringify(body, null, 2));
  }
  const scrub = (obj: unknown): unknown => {
    if (!obj || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(scrub);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k === "reasoning_content" && v === null) continue;
      out[k] = scrub(v);
    }
    return out;
  };
  return new Response(JSON.stringify(scrub(body)), {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
};

const llm = ai({
  name: "openai",
  apiKey: API_KEY,
  apiURL: API_URL,
  config: { model: MODEL as never, stream: false },
  options: { fetch: scrubbedFetch as typeof fetch },
});

const nc = await natsConnect({ servers: NATS_URL });

// AgentService takes care of:
//   - registering as the `agents` micro service with v0.3 metadata
//   - the prompt + status endpoints (verb-first subjects per §2 v0.3)
//   - per-request keep-alive ack chunks (§6.4)
//   - the §6.5 stream terminator on every completion path
//   - 400 envelope-decode errors / 500 handler errors (§9.1)
const service = new AgentService({
  nc,
  agent: "dspy",
  owner: process.env["USER"] ?? "anon",
  name: "react",
  description: "DSPy ReAct agent with sandboxed fs tools",
  version: "0.3.0",
  maxPayload: "1MB",
  attachmentsOk: false,
  heartbeatIntervalS: 10,
  // Send our own per-tool status lines mid-handler — disable AgentService's
  // keep-alive ack so the two streams don't interleave.
  keepaliveIntervalS: null,
});

service.onPrompt(async (envelope, response) => {
  // The §5.3 plain-text shorthand and §5.1 JSON envelope both surface as
  // `envelope.prompt` thanks to `AgentService`'s decoder.
  const question = envelope.prompt;

  await response.send({ type: "status", status: "ack" });

  const tools = makeFsTools(SANDBOX, (line) => {
    void response.send({ type: "status", status: line });
  });

  const program = ax(
    'question:string "user request — may require reading, listing, or writing files in the sandbox" -> answer:string "final answer to the user"',
    { functions: tools },
  );

  try {
    const result = await program.forward(llm, { question });
    if (result.answer) await response.send(String(result.answer));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await response.send(`\n[agent error] ${message}`);
  }
});

await service.start();
console.log(`dspy agent listening on ${service.subject.prompt}`);
console.log(`model:   ${MODEL}`);
console.log(`sandbox: ${SANDBOX}`);
console.log("press Ctrl+C to stop");

const shutdown = async (): Promise<void> => {
  console.log("\nshutting down…");
  await service.stop();
  await nc.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
