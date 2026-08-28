// One-shot caller-side probe for cross-SDK interop tests — not a demo.
//
// Discovers ONE agent by `--agent` / `--owner`, sends `--prompt`, and writes
// NDJSON to stdout: one line per decoded chunk, then a final
// `{"type":"done","chunks":N}`. Exit status:
//
//    0  the stream ended with the §6.5 terminator (`done` was written)
//    2  no agent matched the filter
//    1  anything else — the error goes to stderr as {"type":"error","message":…}
//   64  usage error
//
//   NATS_URL=nats://127.0.0.1:4222 bun examples/_run-client-probe.ts \
//     --agent demo-agent --owner "$USER" --prompt "hello" [--timeout-s 10]
//
// The Python host SDK's reverse interop test
// (agent-sdk/python/tests/test_interop_reverse_e2e.py) runs this against a
// Python `AgentService` and asserts on the lines — bytes a different
// implementation decoded. Unsigned: it sends no identity.
//
// Mid-stream queries are printed but not answered (the stream then stalls
// until `--timeout-s`); the reference agents never ask any.
//
// Connection: $NATS_URL (credentials in the userinfo are honored), else
// nats://127.0.0.1:4222. Deliberately no $NATS_CONTEXT — a probe run from a
// test must not pick up the developer's selected context.

import { parseArgs } from "node:util";
import { connect as natsConnect } from "@nats-io/transport-node";
import { Agents, parseNatsUrl, type StreamMessage } from "@synadia-ai/agents";

const USAGE =
  "usage: _run-client-probe.ts --agent <agent> --owner <owner> --prompt <text> [--timeout-s <seconds>]";
const DEFAULT_TIMEOUT_S = "10";

interface ProbeArgs {
  readonly agent: string;
  readonly owner: string;
  readonly prompt: string;
  readonly timeoutMs: number;
}

function emit(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function fail(message: string): void {
  process.stderr.write(`${JSON.stringify({ type: "error", message })}\n`);
}

/** Parse the CLI; on a usage error, report it and return `null`. */
function parseCli(): ProbeArgs | null {
  let agent: string | undefined;
  let owner: string | undefined;
  let prompt: string | undefined;
  let timeoutS: string;
  try {
    const { values } = parseArgs({
      options: {
        agent: { type: "string" },
        owner: { type: "string" },
        prompt: { type: "string" },
        "timeout-s": { type: "string", default: DEFAULT_TIMEOUT_S },
      },
      strict: true,
    });
    ({ agent, owner, prompt } = values);
    timeoutS = values["timeout-s"];
  } catch (err) {
    fail(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    return null;
  }
  if (agent === undefined || owner === undefined || prompt === undefined) {
    fail(USAGE);
    return null;
  }
  const seconds = Number(timeoutS);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    fail(`--timeout-s must be a positive number of seconds\n${USAGE}`);
    return null;
  }
  return { agent, owner, prompt, timeoutMs: seconds * 1_000 };
}

function toLine(msg: StreamMessage): Record<string, unknown> {
  switch (msg.type) {
    case "response":
      return { type: "response", text: msg.text, attachments: msg.attachments?.length ?? 0 };
    case "status":
      return { type: "status", status: msg.status };
    case "query":
      return { type: "query", id: msg.id, prompt: msg.prompt };
  }
}

async function main(): Promise<number> {
  const args = parseCli();
  if (!args) return 64;

  const nc = await natsConnect(
    process.env["NATS_URL"]
      ? parseNatsUrl(process.env["NATS_URL"])
      : { servers: "nats://127.0.0.1:4222" },
  );
  const agents = new Agents({ nc });
  try {
    const [agent] = await agents.discover({ filter: { agent: args.agent, owner: args.owner } });
    if (!agent) {
      fail(`no agent matched agent=${args.agent} owner=${args.owner}`);
      return 2;
    }
    let chunks = 0;
    for await (const msg of await agent.prompt(args.prompt, {
      maxWaitMs: args.timeoutMs,
      inactivityTimeoutMs: args.timeoutMs,
    })) {
      chunks += 1;
      emit(toLine(msg));
    }
    emit({ type: "done", chunks });
    return 0;
  } finally {
    await agents.close();
    await nc.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    fail(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
