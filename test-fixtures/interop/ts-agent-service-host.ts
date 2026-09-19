// A minimal `AgentService` host for cross-language and cross-version
// tracing interop tests. Fed to `bun run -` on stdin, so `@synadia-ai/*`
// resolve from the working directory: the in-repo packages when run from
// `client-sdk/typescript`, or the last published (pre-tracing) release when
// run from a scratch directory holding it — the script uses only API that
// exists in both, and probes for `traceHeaders()` at runtime.
//
// Environment:
//   NATS_URL             server to connect to (required)
//   AGENT                `agent` token (default `interop-host`)
//   TRACE=1              opt the service into tracing (ignored by a host
//                        that predates it — its options are not validated)
//   NATS_NKEY_SEED_FILE  authenticate the connection with this user seed
//
// Echo: `echo: <prompt>` plus ` thread=<id> root=<id>` when the execution
// was traced, so a caller can see what the host adopted or minted.

import { readFileSync } from "node:fs";
import { connect, nkeyAuthenticator } from "@nats-io/transport-node";
import { AgentService } from "@synadia-ai/agent-service";

const url = process.env["NATS_URL"];
if (!url) throw new Error("NATS_URL is required");
const agent = process.env["AGENT"] ?? "interop-host";
const seedFile = process.env["NATS_NKEY_SEED_FILE"];
const traced = process.env["TRACE"] === "1";

const nc = await connect({
  servers: url,
  reconnect: false,
  ...(seedFile
    ? {
        authenticator: nkeyAuthenticator(
          new TextEncoder().encode(readFileSync(seedFile, "utf8").trim()),
        ),
      }
    : {}),
});

const svc = new AgentService({
  nc,
  agent,
  owner: "interop",
  name: "host",
  heartbeatIntervalS: 5,
  keepaliveIntervalS: null,
  ...(traced ? { trace: {} } : {}),
} as ConstructorParameters<typeof AgentService>[0]);

svc.onPrompt(async (envelope, response) => {
  // `traceHeaders()` does not exist on a pre-tracing host.
  const probe = response as unknown as { traceHeaders?: () => Record<string, string> };
  const headers = typeof probe.traceHeaders === "function" ? probe.traceHeaders() : {};
  let text = `echo: ${envelope.prompt}`;
  const thread = headers["X-Synadia-Thread-ID"];
  const root = headers["X-Synadia-Root-ID"];
  if (thread !== undefined) text += ` thread=${thread} root=${root ?? ""}`;
  await response.send(text);
});

await svc.start();
console.log(`agent service listening on ${svc.subject.prompt}`);

const shutdown = async (): Promise<void> => {
  try {
    await svc.stop();
  } finally {
    await nc.close();
    process.exit(0);
  }
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
await new Promise(() => {});
