// The boss's demo scenario:
//
//     response, error := agent.prompt("describe this photo", WithAttachment("vacation.jpg"));
//
// If the agent declared `attachments_ok: false`, this fails *locally* with
// `AttachmentsNotSupportedError` — no NATS traffic.
// If the prompt + attachment bytes exceed `max_payload`, this fails *locally*
// with `PayloadTooLargeError` — no NATS traffic.
// Otherwise, the prompt is JSON-encoded with a base64 attachment and
// streamed to the agent; the response arrives as typed chunks.
//
// Usage (run the reference agent in one terminal first):
//
//     bun run examples/_run-reference-agent.ts
//     bun run examples/03-prompt-attachment.ts ./vacation.jpg
//
// Or with npm: swap `bun run` for `npx tsx`.

import { argv, exit, stdout } from "node:process";
import { connect as natsConnect } from "@nats-io/transport-node";
import {
  Agents,
  AttachmentsNotSupportedError,
  loadContextOptions,
  NatsAgentError,
  parseNatsUrl,
  PayloadTooLargeError,
  type ResponseAttachment,
} from "@synadia-ai/agents";

async function main(): Promise<void> {
  const attachmentPath = argv[2];
  if (!attachmentPath) {
    console.error("usage: 03-prompt-attachment.ts <path-to-photo>");
    exit(1);
  }

  const opts = process.env["NATS_CONTEXT"]
    ? await loadContextOptions(process.env["NATS_CONTEXT"])
    : process.env["NATS_URL"]
      ? parseNatsUrl(process.env["NATS_URL"])
      : { servers: "nats://127.0.0.1:4222" };
  const nc = await natsConnect(opts);
  const agents = new Agents({ nc });

  try {
    const found = await agents.discover();
    if (found.length === 0) {
      console.error("no agents reachable — start the reference agent first");
      exit(2);
    }

    const chosen = found[0]!;
    console.log(
      `prompting ${chosen.agent}/${chosen.owner}/${chosen.name} (max_payload=${
        chosen.promptEndpoint.maxPayloadBytes ?? "unspecified"
      }, attachments_ok=${chosen.promptEndpoint.attachmentsOk ?? "unspecified"})`,
    );

    try {
      const stream = await chosen.prompt("describe this photo", { attachments: [attachmentPath] });
      for await (const msg of stream) {
        switch (msg.type) {
          case "response":
            stdout.write(msg.text);
            if (msg.attachments) {
              const names = msg.attachments.map((a: ResponseAttachment) => a.filename).join(", ");
              console.log(`\n  [agent returned ${msg.attachments.length} attachment(s): ${names}]`);
            }
            break;
          case "status":
            if (msg.status === "done") console.log("\n[done]");
            break;
          case "query":
            console.log(`\n[agent asks: ${msg.prompt}]`);
            await msg.reply("ok");
            break;
        }
      }
    } catch (err) {
      if (err instanceof AttachmentsNotSupportedError) {
        console.error("\nthis agent does not accept attachments (attachments_ok=false)");
        exit(3);
      }
      if (err instanceof PayloadTooLargeError) {
        console.error(
          `\npayload is too large: ${err.actual} bytes > agent's ${err.limit} byte limit`,
        );
        exit(4);
      }
      throw err;
    }
  } finally {
    await agents.close();
    await nc.close();
  }
}

void main().catch((err: unknown) => {
  if (err instanceof NatsAgentError) {
    console.error("demo failed:", err.name, err.message);
  } else {
    console.error("demo failed:", err);
  }
  exit(99);
});
