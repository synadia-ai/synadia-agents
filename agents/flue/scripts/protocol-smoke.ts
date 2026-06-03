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
const service = createFlueAgentService({
  nc,
  config,
  version: "0.1.0-smoke",
  flueClient: fakeFlueClient,
});

try {
  await service.start();
  const agents = new Agents({ nc: callerNc });
  const found = await agents.discover({
    timeoutMs: 1000,
    filter: { agent: "flue", name },
  });
  if (found.length !== 1)
    throw new Error(`expected one flue smoke agent, found ${found.length}`);
  const agent = found[0]!;
  if (agent.metadata["agent"] !== "flue")
    throw new Error("service metadata missing agent=flue");
  if (agent.metadata["owner"] !== "smoke")
    throw new Error("service metadata missing owner=smoke");
  if (agent.metadata["session"] !== name)
    throw new Error(`service metadata missing session=${name}`);
  if (agent.metadata["protocol_version"] !== "0.3")
    throw new Error("service metadata missing protocol_version=0.3");
  if (agent.promptEndpoint.subject !== service.subject.prompt)
    throw new Error("prompt endpoint subject mismatch");
  if (agent.promptEndpoint.queueGroup !== "agents")
    throw new Error("prompt endpoint queue group mismatch");
  if (agent.promptEndpoint.attachmentsOk !== false)
    throw new Error("prompt endpoint must advertise attachments_ok=false");
  if (!agent.promptEndpoint.metadata["max_payload"])
    throw new Error("prompt endpoint missing max_payload");
  const statusEndpoint = agent.endpoints.find((e) => e.name === "status");
  if (statusEndpoint?.subject !== service.subject.status)
    throw new Error("status endpoint subject mismatch");
  if (statusEndpoint.queueGroup !== "agents")
    throw new Error("status endpoint queue group mismatch");

  const messages: StreamMessage[] = [];
  for await (const msg of await agent.prompt("hello smoke")) messages.push(msg);

  const attachmentReply = `_INBOX.flue-attachment-${Math.random().toString(36).slice(2, 8)}`;
  const attachmentSub = callerNc.subscribe(attachmentReply);
  await callerNc.flush();
  callerNc.publish(
    service.subject.prompt,
    new TextEncoder().encode(
      JSON.stringify({
        prompt: "attachment should be rejected",
        attachments: [{ filename: "note.txt", content: "QUJD" }],
      }),
    ),
    { reply: attachmentReply },
  );
  const attachmentFrames = [];
  for await (const frame of attachmentSub) {
    attachmentFrames.push(frame);
    if (
      attachmentFrames.some((m) => m.headers?.get("Nats-Service-Error-Code")) &&
      attachmentFrames.some((m) => !m.headers && m.data.length === 0)
    ) {
      attachmentSub.unsubscribe();
      break;
    }
  }
  const attachmentError = attachmentFrames.find((m) =>
    m.headers?.get("Nats-Service-Error-Code"),
  );
  if (attachmentError?.headers?.get("Nats-Service-Error-Code") !== "400") {
    throw new Error(
      `valid-but-unsupported attachment envelope returned ${attachmentError?.headers?.get("Nats-Service-Error-Code") ?? "no error"}, expected 400`,
    );
  }

  console.log(
    JSON.stringify(
      {
        subject: service.subject.prompt,
        metadata: agent.metadata,
        promptEndpoint: agent.promptEndpoint,
        messages,
      },
      null,
      2,
    ),
  );
  const first = messages[0];
  if (first?.type !== "status" || first.status !== "ack")
    throw new Error("missing leading ack status");
  if (
    !messages.some(
      (m) =>
        m.type === "status" &&
        (m as { status: string }).status.includes("connected to Flue"),
    )
  ) {
    throw new Error("missing Flue connected status");
  }
  if (
    !messages.some(
      (m) => m.type === "response" && m.text.includes("fake Flue response"),
    )
  ) {
    throw new Error("missing fake Flue response");
  }
  const last = messages.at(-1);
  if (last?.type !== "status" || last.status !== "done")
    throw new Error("missing done terminator status");
} finally {
  await service.stop();
  await nc.close();
  await callerNc.close();
}
