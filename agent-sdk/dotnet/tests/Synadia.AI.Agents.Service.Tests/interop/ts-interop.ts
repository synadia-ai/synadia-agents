// Cross-SDK interop helper driven by InteropTests.cs. Not a demo.
//
// The test copies this file into client-sdk/typescript/node_modules/.dotnet-interop/
// so bare imports resolve against the TS SDK's installed packages, then runs:
//
//   bun ts-interop.ts agent  <owner>
//       Hosts a TS AgentService `ts-interop` that answers `ask <q>` with a
//       mid-stream query ("you answered: <answer>") and otherwise echoes
//       "ts echo: <prompt> [n attachment(s): name:size,…]" plus the
//       attachments back. Prints `listening on <subject>` when ready and
//       stops when stdin closes.
//
//   bun ts-interop.ts caller <agent> <owner> <prompt> [answer]
//       Discovers the agent, prompts it (one attachment `note.txt` = "hi"),
//       answers any query with [answer], and writes one NDJSON line per chunk,
//       then {"type":"done"}. Errors are written as
//       {"type":"error","code":N,"message":…} with exit code 1.

import { connect } from "@nats-io/transport-node";
import { Agents, ServiceError } from "@synadia-ai/agents";
import { AgentService } from "@synadia-ai/agent-service";

const url = process.env["NATS_URL"] ?? "nats://127.0.0.1:4222";
const [mode, ...args] = process.argv.slice(2);
const emit = (o: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(o)}\n`);
// Response/query attachments are DecodedAttachment ({filename, content: base64 string}) on both ends.
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const wire = (atts: ReadonlyArray<{ filename: string; content: Uint8Array }>) =>
  atts.map((a) => ({ filename: a.filename, content: b64(a.content) }));
const describe = (atts: ReadonlyArray<{ filename: string; content: Uint8Array }>) =>
  atts.map((a) => `${a.filename}:${a.content.length}`);
const describeWire = (atts: ReadonlyArray<{ filename: string; content: string }>) =>
  atts.map((a) => `${a.filename}:${Buffer.from(a.content, "base64").length}`);

async function agent(owner: string): Promise<void> {
  const nc = await connect({ servers: url });
  const service = new AgentService({ nc, agent: "ts-interop", owner, name: "main", heartbeatIntervalS: 1 });
  service.onPrompt(async (env, res) => {
    if (env.prompt.startsWith("ask ")) {
      const reply = await res.ask(env.prompt.slice(4), { timeoutMs: 10_000 });
      await res.send({
        type: "response",
        text: `you answered: ${reply.prompt}`,
        ...(reply.attachments ? { attachments: wire(reply.attachments) } : {}),
      });
      return;
    }
    const atts = env.attachments ?? [];
    const recap = atts.length ? ` [${atts.length} attachment(s): ${describe(atts).join(",")}]` : "";
    await res.send({
      type: "response",
      text: `ts echo: ${env.prompt}${recap}`,
      ...(atts.length ? { attachments: wire(atts) } : {}),
    });
  });
  await service.start();
  console.log(`listening on ${service.subject.prompt}`);
  await new Promise<void>((resolve) => process.stdin.on("close", resolve).on("end", resolve).resume());
  await service.stop();
  await nc.close();
}

async function caller(agentName: string, owner: string, prompt: string, answer: string | undefined): Promise<number> {
  const nc = await connect({ servers: url });
  const agents = new Agents({ nc });
  try {
    const [found] = await agents.discover({ filter: { agent: agentName, owner } });
    if (!found) {
      emit({ type: "error", message: "no agent" });
      return 2;
    }
    emit({ type: "info", protocol_version: found.protocolVersion, attachments_ok: found.promptEndpoint.attachmentsOk });
    const stream = await found.prompt(prompt, {
      attachments: [{ filename: "note.txt", content: new TextEncoder().encode("hi") }],
      inactivityTimeoutMs: 10_000,
    });
    for await (const msg of stream) {
      switch (msg.type) {
        case "response":
          emit({ type: "response", text: msg.text, attachments: describeWire(msg.attachments ?? []) });
          break;
        case "status":
          emit({ type: "status", status: msg.status });
          break;
        case "query":
          emit({ type: "query", prompt: msg.prompt });
          await msg.reply(answer ?? "");
          break;
      }
    }
    emit({ type: "done" });
    return 0;
  } catch (err) {
    emit({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
      ...(err instanceof ServiceError ? { code: err.code } : {}),
    });
    return 1;
  } finally {
    await agents.close();
    await nc.close();
  }
}

if (mode === "agent") await agent(args[0]!);
else if (mode === "caller") process.exit(await caller(args[0]!, args[1]!, args[2]!, args[3]));
else {
  console.error("usage: ts-interop.ts agent <owner> | caller <agent> <owner> <prompt> [answer]");
  process.exit(64);
}
