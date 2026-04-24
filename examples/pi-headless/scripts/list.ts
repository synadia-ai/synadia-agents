// CLI helper: list active pi-headless sessions on every reachable controller.
//
// Usage:
//   bun run scripts/list.ts [--owner USER] [--name exec]
//                           [--context demo | --url nats://...]

import process from "node:process";

import { openCliClient, parseArgs, ownerFilter, nameFilter } from "./_common.js";

interface SessionSummary {
  session_id: string;
  subject: string;
  cwd: string;
  model?: string;
  thinking_level?: string;
  max_lifetime_s: number;
  remaining_lifetime_s: number;
  active_request: boolean;
  queued_requests: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cli = await openCliClient(args);
  try {
    const agents = await cli.agents.discover();
    const owner = ownerFilter(args);
    const name = nameFilter(args);
    const controllers = agents.filter(
      (a) =>
        a.agent === "pi" &&
        a.metadata["role"] === "pi-headless-controller" &&
        (!owner || a.owner === owner) &&
        (!name || a.name === name),
    );
    if (controllers.length === 0) {
      process.stderr.write("no pi-headless controllers found\n");
      process.exit(0);
    }
    for (const controller of controllers) {
      const listSubject = `${controller.promptEndpoint.subject}.list`;
      const rep = await cli.nc.request(listSubject, "", { timeout: 5_000 });
      const body = JSON.parse(rep.string()) as { sessions: SessionSummary[] };
      process.stdout.write(
        `# ${controller.promptEndpoint.subject} (instance ${controller.instanceId})\n`,
      );
      if (body.sessions.length === 0) {
        process.stdout.write("  (no sessions)\n");
        continue;
      }
      for (const s of body.sessions) {
        const busy = s.active_request ? "*" : " ";
        const rem = s.max_lifetime_s === 0 ? "∞" : `${s.remaining_lifetime_s}s`;
        process.stdout.write(
          `  ${busy} ${s.session_id}  cwd=${s.cwd}  model=${s.model ?? "-"}  ttl=${rem}  queued=${s.queued_requests}\n`,
        );
      }
    }
  } finally {
    await cli.close();
  }
}

main().catch((err) => {
  process.stderr.write(`pi-headless-cli: ${(err as Error).message}\n`);
  process.exit(1);
});
