// Protocol smoke: real NATS + a scripted fake Eve bridge client.
//
// Exercises the full §12 surface end-to-end — discovery metadata
// (attachments_ok=true), a plain streamed prompt, the §7 HITL query
// round-trip (caller replies via `msg.reply`), and an attachment envelope
// mapped to an inline data: URL file part. Uses NATS_URL when set,
// otherwise spawns a disposable nats-server.

import { connect as natsConnect } from "@nats-io/transport-node";
import { Agents, type StreamMessage } from "@synadia-ai/agents";
import type { HandleMessageStreamEvent, InputRequest } from "eve/client";
import type { EveBridgeClient, EveSendInput } from "../src/bridge.js";
import type { EveChannelConfig } from "../src/config.js";
import { createEveAgentService } from "../src/service.js";
import { ensureNats } from "./disposable-nats.js";

const nats = await ensureNats();
const natsUrl = nats.url;
const name = `smoke-${Math.random().toString(36).slice(2, 8)}`;

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
    baseUrl: "http://127.0.0.1:2000",
    askTimeoutS: 10,
  },
};

const turn = { sequence: 1, stepIndex: 0, turnId: "t1" };

const appended = (messageDelta: string): HandleMessageStreamEvent => ({
  type: "message.appended",
  data: { messageDelta, messageSoFar: messageDelta, ...turn },
});

const waiting = (): HandleMessageStreamEvent => ({
  type: "session.waiting",
  data: { continuationToken: "ct-1", wait: "next-user-message" },
});

const approvalRequest: InputRequest = {
  requestId: "req-1",
  prompt: "Run the deploy tool?",
  action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "deploy" },
  options: [
    { id: "approve", label: "Approve" },
    { id: "deny", label: "Deny" },
  ],
  display: "confirmation",
};

function arrayStream(events: HandleMessageStreamEvent[]): AsyncIterable<HandleMessageStreamEvent> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

class SmokeFakeEveClient implements EveBridgeClient {
  async send(input: EveSendInput): Promise<AsyncIterable<HandleMessageStreamEvent>> {
    if (input.inputResponses !== undefined && input.inputResponses.length > 0) {
      const answer = input.inputResponses[0]!;
      return arrayStream([
        appended(`resumed with ${answer.optionId ?? answer.text ?? "?"}`),
        waiting(),
      ]);
    }
    const message = input.message;
    if (typeof message !== "string") {
      const parts = Array.isArray(message) ? message : [];
      const file = parts.find((part) => typeof part === "object" && part !== null && part.type === "file");
      const label =
        file !== undefined && file.type === "file"
          ? `${file.filename ?? "?"} (${file.mediaType})`
          : "?";
      return arrayStream([appended(`fake eve got file ${label}`), waiting()]);
    }
    if (message.includes("needs approval")) {
      return arrayStream([{ type: "input.requested", data: { requests: [approvalRequest], ...turn } }]);
    }
    return arrayStream([
      { type: "session.started", data: {} },
      appended(`fake eve response to ${message}`),
      waiting(),
    ]);
  }

  sessionId(): string | undefined {
    return "smoke-session";
  }
}

const nc = await natsConnect({ servers: natsUrl });
const callerNc = await natsConnect({ servers: natsUrl });
const service = createEveAgentService({
  nc,
  config,
  version: "0.1.0-smoke",
  eveClient: new SmokeFakeEveClient(),
});

try {
  await service.start();
  const agents = new Agents({ nc: callerNc });
  const found = await agents.discover({ timeoutMs: 1000, filter: { agent: "eve", name } });
  if (found.length !== 1) throw new Error(`expected one eve smoke agent, found ${found.length}`);
  const agent = found[0]!;
  if (agent.metadata["agent"] !== "eve") throw new Error("service metadata missing agent=eve");
  if (agent.metadata["owner"] !== "smoke") throw new Error("service metadata missing owner=smoke");
  if (agent.metadata["session"] !== name) throw new Error(`service metadata missing session=${name}`);
  if (agent.metadata["protocol_version"] !== "0.3")
    throw new Error("service metadata missing protocol_version=0.3");
  if (agent.metadata["eve_base_url"] !== "http://127.0.0.1:2000")
    throw new Error("service metadata missing eve_base_url");
  if (agent.metadata["eve_auth"] !== "none") throw new Error("service metadata missing eve_auth=none");
  if (agent.promptEndpoint.subject !== service.subject.prompt)
    throw new Error("prompt endpoint subject mismatch");
  if (agent.promptEndpoint.queueGroup !== "agents")
    throw new Error("prompt endpoint queue group mismatch");
  if (agent.promptEndpoint.attachmentsOk !== true)
    throw new Error("prompt endpoint must advertise attachments_ok=true");
  if (!agent.promptEndpoint.metadata["max_payload"])
    throw new Error("prompt endpoint missing max_payload");
  const statusEndpoint = agent.endpoints.find((e) => e.name === "status");
  if (statusEndpoint?.subject !== service.subject.status)
    throw new Error("status endpoint subject mismatch");
  if (statusEndpoint.queueGroup !== "agents")
    throw new Error("status endpoint queue group mismatch");

  // 1. Plain streamed prompt.
  const plain: StreamMessage[] = [];
  for await (const msg of await agent.prompt("hello smoke")) plain.push(msg);
  if (plain[0]?.type !== "status" || plain[0].status !== "ack")
    throw new Error("missing leading ack status");
  if (!plain.some((m) => m.type === "status" && m.status === "eve session started"))
    throw new Error("missing eve session started status");
  if (!plain.some((m) => m.type === "response" && m.text.includes("fake eve response to hello smoke")))
    throw new Error("missing fake eve response");
  const plainLast = plain.at(-1);
  if (plainLast?.type !== "status" || plainLast.status !== "done")
    throw new Error("missing done terminator status");

  // 2. HITL round-trip: query chunk → caller reply → resumed turn.
  const hitl: StreamMessage[] = [];
  let queryPrompt: string | undefined;
  for await (const msg of await agent.prompt("this needs approval")) {
    hitl.push(msg);
    if (msg.type === "query") {
      queryPrompt = msg.prompt;
      await msg.reply("approve");
    }
  }
  if (queryPrompt === undefined) throw new Error("missing §7 query chunk in HITL stream");
  if (!queryPrompt.includes("Run the deploy tool?") || !queryPrompt.includes("1. approve — Approve"))
    throw new Error(`query prompt not rendered from the Eve input request: ${queryPrompt}`);
  if (!hitl.some((m) => m.type === "status" && m.status === "eve requests operator input (1 pending)"))
    throw new Error("missing operator input status");
  if (!hitl.some((m) => m.type === "response" && m.text.includes("resumed with approve")))
    throw new Error("HITL resume did not carry the approve inputResponse back to eve");
  const hitlLast = hitl.at(-1);
  if (hitlLast?.type !== "status" || hitlLast.status !== "done")
    throw new Error("missing done terminator on HITL stream");

  // 3. Attachment envelope → inline data: URL file part.
  const attach: StreamMessage[] = [];
  const stream = await agent.prompt("describe this file", {
    attachments: [{ filename: "note.txt", content: new TextEncoder().encode("ABC") }],
  });
  for await (const msg of stream) attach.push(msg);
  if (!attach.some((m) => m.type === "response" && m.text.includes("fake eve got file note.txt (text/plain)")))
    throw new Error("attachment was not mapped to an Eve file part");
  const attachLast = attach.at(-1);
  if (attachLast?.type !== "status" || attachLast.status !== "done")
    throw new Error("missing done terminator on attachment stream");

  console.log(
    JSON.stringify(
      { subject: service.subject.prompt, metadata: agent.metadata, plain, hitl, attach },
      null,
      2,
    ),
  );
  console.log("protocol smoke passed");
} finally {
  await service.stop();
  await nc.close();
  await callerNc.close();
  await nats.close();
}
