// CLI helper: spawn a pi-headless session, optionally send an initial prompt,
// optionally stop the session after the prompt finishes.
//
// Usage:
//   bun run scripts/spawn.ts --cwd /path [--prompt "..."] [--model provider/id]
//                            [--thinking-level medium] [--max-lifetime-s 1800]
//                            [--session-id name] [--stop-after]
//                            [--context demo | --url nats://...]

import process from "node:process";

import { openCliClient, findController, parseArgs, waitForSession } from "./_common.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cwd = args.rest.get("cwd");
  if (!cwd) {
    process.stderr.write("usage: spawn.ts --cwd PATH [--prompt TEXT] [--stop-after]\n");
    process.exit(2);
  }

  const prompt = args.rest.get("prompt");
  const stopAfter = args.rest.get("stop-after") === "true";

  const spec: Record<string, unknown> = { cwd };
  const sessionIdArg = args.rest.get("session-id");
  if (sessionIdArg) spec["session_id"] = sessionIdArg;
  const model = args.rest.get("model");
  if (model) spec["model"] = model;
  const thinking = args.rest.get("thinking-level");
  if (thinking) spec["thinking_level"] = thinking;
  const maxLifetime = args.rest.get("max-lifetime-s");
  if (maxLifetime) spec["max_lifetime_s"] = Number(maxLifetime);

  const cli = await openCliClient(args);
  try {
    const controller = await findController(cli.agents, args);
    const spawnSubject = `${controller.promptEndpoint.subject}.spawn`;
    process.stderr.write(`pi-headless-cli: calling ${spawnSubject}\n`);

    const rep = await cli.nc.request(spawnSubject, JSON.stringify(spec), { timeout: 15_000 });
    const errCode = rep.headers?.get("Nats-Service-Error-Code");
    if (errCode) {
      const errMsg = rep.headers?.get("Nats-Service-Error") ?? "unknown error";
      process.stderr.write(`spawn failed [${errCode}]: ${errMsg}\n`);
      process.exit(1);
    }
    const descriptor = JSON.parse(rep.string()) as {
      session_id: string;
      subject: string;
      instance_id: string;
    };
    process.stderr.write(`pi-headless-cli: spawned ${descriptor.session_id} @ ${descriptor.subject}\n`);
    process.stdout.write(`${JSON.stringify(descriptor, null, 2)}\n`);

    if (prompt) {
      const session = await waitForSession(cli.agents, descriptor.instance_id);
      process.stderr.write(`pi-headless-cli: prompting ${session.promptEndpoint.subject}\n`);
      const stream = await session.prompt(prompt);
      for await (const ev of stream) {
        if (ev.type === "response") {
          process.stdout.write(ev.text);
        } else if (ev.type === "status") {
          process.stderr.write(`[status] ${ev.status}\n`);
        }
      }
      process.stdout.write("\n");

      if (stopAfter) {
        const stopSubject = `${controller.promptEndpoint.subject}.stop`;
        await cli.nc.request(
          stopSubject,
          JSON.stringify({ session_id: descriptor.session_id }),
          { timeout: 5_000 },
        );
        process.stderr.write(`pi-headless-cli: stopped ${descriptor.session_id}\n`);
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
