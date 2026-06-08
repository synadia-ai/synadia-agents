// Interactive multi-turn chat REPL against the first discovered agent.
//
// A thin REPL: ONE NATS connection and ONE agent, many prompt() calls. Each turn
// is still an independent protocol request — but because one chat = one session =
// one subject (under v0.3 the 5th subject token IS the session), repeated prompts
// to the same agent read as a conversation. Point it at a *stateful* agent —
// one that keys memory off the session — and the turns build on each other. The
// bundled reference agent (`_run-reference-agent.ts`) is stateless, so it answers
// each turn independently; it's still the simplest target to try the REPL on.
//
// Dependency-light: only the SDK + Node's built-in readline. No UI libraries.
// (The Python counterpart, examples/06-chat.py, wraps the same model in a
// rich-powered TUI.)
//
// Commands:  /help · /clear · /quit  (also /q, /exit, or Ctrl-D)
//
// Connection resolution:
//   1. $NATS_CONTEXT — name of a NATS CLI context under ~/.config/nats/context/
//   2. $NATS_URL     — raw URL (credentials in userinfo are honored)
//   3. nats://127.0.0.1:4222

import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { connect as natsConnect } from "@nats-io/transport-node";
import { Agents, loadContextOptions, parseNatsUrl } from "@synadia-ai/agents";

const HELP = "commands:  /help · /clear · /quit  (also /q, /exit, or Ctrl-D)";

async function main(): Promise<void> {
  const opts = process.env["NATS_CONTEXT"]
    ? await loadContextOptions(process.env["NATS_CONTEXT"])
    : process.env["NATS_URL"]
      ? parseNatsUrl(process.env["NATS_URL"])
      : { servers: "nats://127.0.0.1:4222" };
  const nc = await natsConnect(opts);
  const agents = new Agents({ nc });

  try {
    const [agent] = await agents.discover();
    if (!agent) {
      console.error("no agents found — start an agent first (e.g. _run-reference-agent.ts).");
      process.exit(2);
    }
    console.log(`chatting with ${agent.agent}/${agent.owner}/${agent.name}`);
    console.log(`${HELP}\n`);

    // Create the interface only now (after discovery), and read it as an async
    // iterator: that buffers input with proper backpressure, so it works the same
    // whether you type interactively or pipe lines in — and ends cleanly at EOF.
    const rl = createInterface({ input: stdin, output: stdout });
    rl.on("SIGINT", () => rl.close()); // Ctrl-C ends the loop

    let turns = 0;
    stdout.write("❯ ");
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) {
        stdout.write("❯ ");
        continue;
      }
      if (line.startsWith("/")) {
        const cmd = line.replace(/^\/+/, "").toLowerCase();
        if (cmd === "quit" || cmd === "q" || cmd === "exit") break;
        if (cmd === "clear")
          stdout.write("\x1b[2J\x1b[H"); // ANSI clear; harmless if unsupported
        else console.log(HELP); // /help and any unknown command
        stdout.write("❯ ");
        continue;
      }

      let printed = false;
      for await (const msg of await agent.prompt(line)) {
        switch (msg.type) {
          case "response":
            stdout.write(msg.text);
            printed = true;
            break;
          case "query":
            // A chat REPL isn't the place for interactive queries — send a safe
            // default so the agent's stream can finish. See 04-query-reply.ts.
            stdout.write(`\n[agent asked: ${msg.prompt}; replying 'ok']\n`);
            await msg.reply("ok");
            break;
          case "status":
            break; // informational (leading ack / keep-alive / done)
        }
      }
      if (printed) stdout.write("\n");
      turns++;
      stdout.write("❯ ");
    }
    rl.close();
    console.log(`\nchat ended — ${turns} turn(s).`);
  } finally {
    await agents.close();
    await nc.close();
  }
}

void main().catch((err: unknown) => {
  console.error("chat failed:", err);
  process.exit(1);
});
