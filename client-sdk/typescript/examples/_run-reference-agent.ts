// Spin up a spec-compliant reference agent for local experimentation.
// Companion to the `examples/*` scripts — run this in one terminal, then
// invoke the demos in another. Also the counterparty of the Python SDK's
// cross-SDK interop test (`client-sdk/python/tests/test_interop_e2e.py`),
// which scrapes the `reference agent listening on <subject>` line.
//
// Connection resolution:
//   1. $NATS_CONTEXT — name of a NATS CLI context under ~/.config/nats/context/
//   2. $NATS_URL     — raw URL (credentials in userinfo are honored)
//   3. nats://127.0.0.1:4222
//
// Sender identity (merged into whichever path is active):
//   $NATS_NKEY_SEED_FILE — path to a user seed file (`SU…`): authenticates
//                          the connection AND signs `id_sig` / classifies
//                          senders. A file, not an env value, so spawned
//                          tool processes do not inherit the seed.
//   $NATS_CREDS          — path to a credentials file (JWT + seed); same.
//   $REFERENCE_AGENT_MIN_SENDER_TRUST — `any` (default) or `signed`.
//
// The echo appends the formatted sender only when one was classified:
//   demo agent received your prompt.
//   demo agent received your prompt. sender: $G.U… (verified user, claimed account)

import { readFile } from "node:fs/promises";
import type { ServiceMsg } from "@nats-io/services";
import { credsAuthenticator, nkeyAuthenticator } from "@nats-io/nats-core";
import { connect as natsConnect, type NodeConnectionOptions } from "@nats-io/transport-node";
import {
  formatSender,
  loadContextOptions,
  parseNatsUrl,
  selfId,
  signerFromCreds,
  signerFromSeed,
  type MinSenderTrust,
  type SenderInfo,
  type SenderSigner,
} from "@synadia-ai/agents";
import { ReferenceAgent } from "@synadia-ai/agent-service/testing";

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
  const opts: NodeConnectionOptions = process.env["NATS_CONTEXT"]
    ? await loadContextOptions(process.env["NATS_CONTEXT"])
    : process.env["NATS_URL"]
      ? parseNatsUrl(process.env["NATS_URL"])
      : { servers: "nats://127.0.0.1:4222" };

  let signer: SenderSigner | undefined;
  const seedFile = process.env["NATS_NKEY_SEED_FILE"];
  const credsFile = process.env["NATS_CREDS"];
  if (seedFile) {
    const seed = (await readFile(seedFile, "utf8")).trim();
    opts.authenticator = nkeyAuthenticator(enc.encode(seed));
    signer = signerFromSeed(seed);
  } else if (credsFile) {
    const creds = await readFile(credsFile, "utf8");
    opts.authenticator = credsAuthenticator(enc.encode(creds));
    signer = signerFromCreds(creds);
  }
  const minSenderTrust = minSenderTrustFromEnv();

  const nc = await natsConnect(opts);

  const agent = new ReferenceAgent({
    nc,
    agent: "demo-agent",
    owner: process.env["USER"] ?? "anon",
    name: "example",
    description: "reference agent for @synadia-ai/agents examples",
    maxPayload: "1MB",
    attachmentsOk: true,
    heartbeatIntervalS: 5,
    ...(signer ? { identity: { signer } } : {}),
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
  try {
    console.log(
      `identity: ${await selfId(nc, signer ? { signer } : {})} (min_sender_trust=${minSenderTrust})`,
    );
  } catch (err) {
    console.log(`identity: none (${err instanceof Error ? err.message : String(err)})`);
  }
  console.log("press Ctrl+C to stop");

  const shutdown = async (): Promise<void> => {
    console.log("\nshutting down…");
    await agent.stop();
    await nc.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main().catch((err: unknown) => {
  console.error("reference agent failed:", err);
  process.exit(1);
});
