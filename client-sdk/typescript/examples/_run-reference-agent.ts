// Spin up a spec-compliant reference agent for local experimentation.
// Companion to the `examples/*` scripts — run this in one terminal, then
// invoke the demos in another. Also the counterparty of the Python SDK's
// cross-SDK interop test (`client-sdk/python/tests/test_interop_e2e.py`),
// which scrapes the `reference agent listening on <subject>` line.
//
// Connection resolution:
//   1. $NATS_CONTEXT — name of a NATS CLI context under ~/.config/nats/context/
//   2. $NATS_URL plus the direct nkey/creds variable below
//   3. nats://127.0.0.1:4222
// Context and direct settings are complete, mutually exclusive sources.
//
// Direct connection credentials (one atomic source with $NATS_URL):
//   $NATS_NKEY_SEED_FILE — path to a user seed file (`SU…`): authenticates
//                          the connection; signed mode also uses that snapshot
//                          for `id_sig`. A file, not an env value, so spawned
//                          tool processes do not inherit the seed.
//   $NATS_CREDS / $NATS_CREDENTIALS — credentials file (JWT + seed); same.
//   $NATS_SENDER_IDENTITY — `off` or `signed`; defaults to off. Credentials
//                           authenticate either mode; signed opts into id_sig.
//   $REFERENCE_AGENT_MIN_SENDER_TRUST — `any` (default) or `signed`.
//
// The echo appends the formatted sender only when one was classified:
//   demo agent received your prompt.
//   demo agent received your prompt. sender: $G.U… (verified user, claimed account)

import type { ServiceMsg } from "@nats-io/services";
import { formatSender, selfId, type MinSenderTrust, type SenderInfo } from "@synadia-ai/agents";
import { ReferenceAgent } from "@synadia-ai/agent-service/testing";
import {
  exampleConnectionSource,
  exampleIdentityMode,
  openExampleNatsConnection,
  waitForTermination,
} from "./_connection";

const enc = new TextEncoder();

function minSenderTrustFromEnv(): MinSenderTrust {
  const raw = process.env["REFERENCE_AGENT_MIN_SENDER_TRUST"];
  if (raw === undefined || raw === "" || raw === "any") return "any";
  if (raw === "signed") return "signed";
  throw new Error(
    `REFERENCE_AGENT_MIN_SENDER_TRUST must be "any" or "signed", got ${JSON.stringify(raw)}`,
  );
}

async function main(): Promise<void> {
  const source = exampleConnectionSource();
  const identity = exampleIdentityMode();
  const minSenderTrust = minSenderTrustFromEnv();
  const connection = await openExampleNatsConnection({ source, identity });
  const { nc } = connection;
  let agent: ReferenceAgent | undefined;

  try {
    agent = new ReferenceAgent({
      nc,
      agent: "demo-agent",
      owner: process.env["USER"] ?? "anon",
      name: "example",
      description: "reference agent for @synadia-ai/agents examples",
      maxPayload: "1MB",
      attachmentsOk: true,
      heartbeatIntervalS: 5,
      ...(connection.signer ? { identity: { signer: connection.signer } } : {}),
      minSenderTrust,
      promptHandler: (msg: ServiceMsg, sender: SenderInfo | undefined) => {
        // Echo a tiny acknowledgement. Real agents produce actual inference.
        const text =
          sender === undefined
            ? "demo agent received your prompt."
            : `demo agent received your prompt. sender: ${formatSender(sender)}`;
        msg.respond(enc.encode(JSON.stringify({ type: "response", data: text })));
        msg.respond(""); // terminator
      },
    });
    await agent.start();
    console.log(`reference agent listening on ${agent.promptSubject}`);
    // Identity on its own line, after the ready marker (tests scrape the marker).
    if (connection.signer) {
      console.log(
        `identity: ${await selfId(nc, { signer: connection.signer })} ` +
          `(min_sender_trust=${minSenderTrust})`,
      );
    } else {
      console.log(`identity: off (min_sender_trust=${minSenderTrust})`);
    }
    console.log("press Ctrl+C to stop");
    await waitForTermination();
    console.log("\nshutting down…");
  } finally {
    try {
      await agent?.stop();
    } finally {
      await connection.close();
    }
  }
}

void main().catch((err: unknown) => {
  console.error("reference agent failed:", err);
  process.exit(1);
});
