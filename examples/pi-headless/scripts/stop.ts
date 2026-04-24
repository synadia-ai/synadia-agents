// CLI helper: stop a pi-headless session.
//
// Usage:
//   bun run scripts/stop.ts SESSION_ID [--owner USER] [--name exec]
//                                      [--context demo | --url nats://...]

import process from "node:process";

import { openCliClient, findController, parseArgs } from "./_common.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sessionId = args.positional[0];
  if (!sessionId) {
    process.stderr.write("usage: stop.ts SESSION_ID\n");
    process.exit(2);
  }

  const cli = await openCliClient(args);
  try {
    const controller = await findController(cli.agents, args);
    const stopSubject = `${controller.promptEndpoint.subject}.stop`;
    const rep = await cli.nc.request(
      stopSubject,
      JSON.stringify({ session_id: sessionId }),
      { timeout: 5_000 },
    );
    const errCode = rep.headers?.get("Nats-Service-Error-Code");
    if (errCode) {
      const errMsg = rep.headers?.get("Nats-Service-Error") ?? "unknown error";
      process.stderr.write(`stop failed [${errCode}]: ${errMsg}\n`);
      process.exit(1);
    }
    process.stdout.write(`${rep.string()}\n`);
  } finally {
    await cli.close();
  }
}

main().catch((err) => {
  process.stderr.write(`pi-headless-cli: ${(err as Error).message}\n`);
  process.exit(1);
});
