// The agent tools (docs/agent-tools.md), end to end against real agents on a
// nats-server: blocking and detached calls, questions, waiting, cancelling,
// limits, the served-prompt scope, files, the loop guards, errors as
// results, the tool-call ID and the extension hooks.
//
// One worker agent does what its prompt says (`echo:`, `sleep:<ms>:`,
// `ask:`, `gate:<key>`, `files:`, ...), so each test drives it through the
// tools alone. Every result is checked against the shape the fixtures in
// `test-fixtures/agent-tools/` define.

import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, nkeyAuthenticator } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AgentService, type PromptResponse } from "@synadia-ai/agent-service";
import {
  AGENT_TOOLS_QUESTION_REFUSAL,
  Agents,
  AgentTools,
  signerFromSeed,
  type AgentCallResult,
  type AgentToolResult,
  type AgentToolsExtension,
  type AgentToolsOptions,
  type Logger,
  type PromptInterceptor,
  type RequestEnvelope,
  type SettledInfo,
} from "../../src/index.js";
import {
  findNatsServerBinary,
  identityFixture,
  NatsServerProcess,
} from "../harness/nats-server.js";

interface KeysFile {
  readonly users: Record<string, { readonly public: string; readonly seed: string }>;
}
const bin = await findNatsServerBinary();
const keys = JSON.parse(await readFile(identityFixture("keys.json"), "utf8")) as KeysFile;
const ALICE = keys.users["alice"]!;
const enc = new TextEncoder();
const FIXTURES_DIR = fileURLToPath(
  new URL("../../../../test-fixtures/agent-tools/", import.meta.url),
);

const b64 = (text: string): string => Buffer.from(text).toString("base64");
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(10);
  }
}

// --- the result shapes the fixtures define ---------------------------------

const STATES = ["running", "input_required", "completed", "failed", "cancelled", "expired"];
const callSchema = JSON.parse(
  await readFile(join(FIXTURES_DIR, "prompt_agent.result.json"), "utf8"),
) as { properties: Record<string, unknown> };
const CALL_FIELDS = Object.keys(callSchema.properties);

/** A result conforms to `prompt_agent.result.json`: a call, a refusal, or wait_agent's timeout. */
function conforms(result: AgentToolResult, extensionFields: string[] = []): void {
  for (const key of Object.keys(result)) {
    expect([...CALL_FIELDS, ...extensionFields], `unexpected field "${key}"`).toContain(key);
  }
  expect("open_calls" in result).toBe("open_calls_note" in result);
  if (!("call_id" in result)) {
    if ("call_ids" in result) {
      expect(result["state"]).toBe("running");
    } else {
      // A refusal: the error alone.
      expect(typeof result["error"]).toBe("string");
      expect(result["state"]).toBeUndefined();
    }
    return;
  }
  expect(STATES).toContain(result["state"]);
  const has = (key: string): boolean => key in result;
  switch (result["state"]) {
    case "completed":
      expect(typeof result["reply"]).toBe("string");
      expect(has("question") || has("error") || has("partial_reply")).toBe(false);
      break;
    case "input_required":
      expect(typeof result["question"]).toBe("string");
      expect(has("reply") || has("error") || has("partial_reply")).toBe(false);
      break;
    case "failed":
    case "expired":
      expect(typeof result["error"]).toBe("string");
      expect(has("reply") || has("question")).toBe(false);
      break;
    case "cancelled":
    case "running":
      expect(has("reply") || has("question") || has("error")).toBe(false);
      break;
  }
}

function call(result: AgentToolResult): AgentCallResult {
  conforms(result);
  return result as AgentCallResult;
}

type ErrorLine = [msg: string, ctx: Record<string, unknown> | undefined];

/** A logger that keeps its error lines. */
function errorLog(): { logger: Logger; errors: ErrorLine[] } {
  const errors: ErrorLine[] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (msg, ctx) => void errors.push([msg, ctx]),
  };
  return { logger, errors };
}

// --- the gates the worker waits on ---------------------------------------------

interface Gate {
  readonly opened: Promise<void>;
  open(): void;
  reached: boolean;
}
const gates = new Map<string, Gate>();
function gate(key: string): Gate {
  let entry = gates.get(key);
  if (entry === undefined) {
    let open!: () => void;
    const opened = new Promise<void>((r) => (open = r));
    entry = { opened, open, reached: false };
    gates.set(key, entry);
  }
  return entry;
}

describe.skipIf(!bin)("agent tools", () => {
  const server = new NatsServerProcess();
  let nc: NatsConnection;
  const signer = signerFromSeed(ALICE.seed);
  let worker: AgentService;
  let workerAddress: string;
  /** What the worker's questions were answered with, in order. */
  const answers: string[] = [];
  /** What the worker received, per prompt. */
  const received: RequestEnvelope[] = [];
  const services: AgentService[] = [];
  const open: Array<AgentTools | Agents> = [];

  async function work(envelope: RequestEnvelope, response: PromptResponse): Promise<void> {
    received.push(envelope);
    const [command = "", ...rest] = envelope.prompt.split(":");
    const arg = rest.join(":");
    switch (command) {
      case "echo":
        await response.send(`echo:${arg}`);
        return;
      case "sleep": {
        const [ms = "0", ...text] = arg.split(":");
        await delay(Number(ms));
        await response.send(text.join(":"));
        return;
      }
      case "ask": {
        const answer = await response.ask(arg, { timeoutMs: 10_000 });
        answers.push(answer.prompt);
        await response.send(`answered:${answer.prompt}`);
        return;
      }
      case "ask-twice": {
        const first = await response.ask("first?", { timeoutMs: 10_000 });
        const second = await response.ask("second?", { timeoutMs: 10_000 });
        await response.send(`${first.prompt}+${second.prompt}`);
        return;
      }
      case "ask-file": {
        const answer = await response.ask("look at this", {
          timeoutMs: 10_000,
          attachments: [{ filename: "q.txt", content: enc.encode("question file") }],
        });
        await response.send(`answered:${answer.prompt}`);
        return;
      }
      case "gate": {
        await response.send("partial ");
        const g = gate(arg);
        g.reached = true;
        await g.opened;
        await response.send("rest");
        return;
      }
      case "files":
        await response.send({
          type: "response",
          text: "here",
          attachments: [
            { filename: "report.txt", content: b64("hello") },
            { filename: "../escape.txt", content: b64("x") },
            { filename: "bad.bin", content: "!!not base64" },
          ],
        });
        return;
      case "big":
        await response.send({
          type: "response",
          text: "big",
          attachments: [
            { filename: "a.txt", content: b64("hello") },
            { filename: "b.txt", content: b64("world!") },
          ],
        });
        return;
      case "attach":
        await response.send(
          `got:${(envelope.attachments ?? []).map((a) => `${a.filename}=${new TextDecoder().decode(a.content)}`).join(",")}`,
        );
        return;
      default:
        await response.send(`unknown:${envelope.prompt}`);
    }
  }

  async function service(
    name: string,
    handler: (envelope: RequestEnvelope, response: PromptResponse) => Promise<void>,
    extra: Partial<ConstructorParameters<typeof AgentService>[0]> = {},
  ): Promise<AgentService> {
    const svc = new AgentService({ nc, agent: "tools-test", owner: "o", name, ...extra });
    svc.onPrompt(handler);
    await svc.start();
    services.push(svc);
    return svc;
  }

  function client(extra: Partial<ConstructorParameters<typeof Agents>[0]> = {}): Agents {
    const agents = new Agents({ nc, identity: { signer }, ...extra });
    open.push(agents);
    return agents;
  }

  function tools(options: Partial<AgentToolsOptions> = {}): AgentTools {
    const t = new AgentTools({ agents: client(), discoverTimeoutMs: 250, ...options });
    open.push(t);
    return t;
  }

  beforeAll(async () => {
    await server.start({ configPath: identityFixture("nkey-noaccounts.conf") });
    nc = await connect({
      servers: server.url,
      authenticator: nkeyAuthenticator(enc.encode(ALICE.seed)),
      reconnect: false,
    });
    worker = await service("worker", work, { identity: { signer } });
    workerAddress = worker.subject.prompt;
  });

  afterEach(async () => {
    for (const g of gates.values()) g.open();
    for (const item of open.splice(0).reverse()) await item.close();
  });

  afterAll(async () => {
    for (const svc of services) await svc.stop();
    await nc.close();
    await server.stop();
  });

  // --- blocking ------------------------------------------------------------

  it("discovers one entry per address, with its instances, showing one whose identity verifies", async () => {
    const second = await service("worker", work);
    const t = tools();
    const result = await t.execute("discover_agents", { name: "worker" });
    expect(result).toEqual({
      agents: [
        {
          address: workerAddress,
          agent: "tools-test",
          owner: "o",
          name: "worker",
          description: expect.any(String) as string,
          identity: expect.stringMatching(/^\$G\.U/) as string,
          identity_verified: true,
          requires_signed_prompts: false,
          accepts_attachments: true,
          instances: 2,
        },
      ],
    });
    await second.stop();
    services.splice(services.indexOf(second), 1);
  });

  it("prompt_agent waits for the reply by default", async () => {
    const t = tools();
    const result = call(
      await t.execute("prompt_agent", { address: workerAddress, prompt: "echo:hi" }),
    );
    expect(result).toEqual({
      call_id: expect.stringMatching(/^call_[0-9a-f]{12}$/) as string,
      state: "completed",
      reply: "echo:hi",
    });
  });

  it("a blocking question goes to the model, and answer_agent waits for the reply", async () => {
    const t = tools();
    const asked = call(
      await t.execute("prompt_agent", { address: workerAddress, prompt: "ask:may I?" }),
    );
    expect(asked).toMatchObject({ state: "input_required", question: "may I?" });
    // The question keeps the call open, and every result says so.
    expect(asked["open_calls"]).toBe(1);
    const done = call(await t.execute("answer_agent", { call_id: asked.call_id, answer: "yes" }));
    expect(done).toEqual({ call_id: asked.call_id, state: "completed", reply: "answered:yes" });
    expect(answers.at(-1)).toBe("yes");
  });

  it("several questions in one stream come one after another", async () => {
    const t = tools();
    const first = call(
      await t.execute("prompt_agent", { address: workerAddress, prompt: "ask-twice" }),
    );
    expect(first.question).toBe("first?");
    const second = call(await t.execute("answer_agent", { call_id: first.call_id, answer: "a" }));
    expect(second).toMatchObject({ state: "input_required", question: "second?" });
    const done = call(await t.execute("answer_agent", { call_id: first.call_id, answer: "b" }));
    expect(done.reply).toBe("a+b");
  });

  it("answer_agent refuses a call with no open question", async () => {
    const t = tools();
    const done = call(
      await t.execute("prompt_agent", { address: workerAddress, prompt: "echo:x" }),
    );
    const result = await t.execute("answer_agent", { call_id: done.call_id, answer: "yes" });
    conforms(result);
    expect(result["error"]).toMatch(/has no open question: it is completed/);
  });

  // --- detached calls and wait_agent ------------------------------------------

  it("wait: false returns at once; wait_agent returns the earliest, with remaining, polls and times out", async () => {
    const t = tools();
    const slow = call(
      await t.execute("prompt_agent", {
        address: workerAddress,
        prompt: "sleep:600:slow",
        wait: false,
        label: "the slow one",
      }),
    );
    expect(slow).toMatchObject({ state: "running", label: "the slow one", open_calls: 1 });
    const fast = call(
      await t.execute("prompt_agent", {
        address: workerAddress,
        prompt: "sleep:150:fast",
        wait: false,
      }),
    );
    expect(fast["open_calls"]).toBe(2);
    const ids = [slow.call_id, fast.call_id];

    const poll = await t.execute("wait_agent", { call_ids: ids, timeout_ms: 0 });
    conforms(poll);
    expect(poll).toMatchObject({ state: "running", call_ids: ids, open_calls: 2 });
    const timedOut = await t.execute("wait_agent", { call_ids: ids, timeout_ms: 20 });
    expect(timedOut).toMatchObject({ state: "running", call_ids: ids });

    const first = call(await t.execute("wait_agent", { call_ids: ids }));
    expect(first).toMatchObject({
      call_id: fast.call_id,
      state: "completed",
      reply: "fast",
      remaining: [slow.call_id],
      open_calls: 1,
    });
    const second = call(await t.execute("wait_agent", { call_ids: [slow.call_id] }));
    expect(second).toEqual({
      call_id: slow.call_id,
      state: "completed",
      label: "the slow one",
      reply: "slow",
      remaining: [],
    });
  });

  it("wait_agent returns the call that finished first, whatever the order given", async () => {
    const t = tools();
    const a = call(
      await t.execute("prompt_agent", {
        address: workerAddress,
        prompt: "sleep:50:a",
        wait: false,
      }),
    );
    const b = call(
      await t.execute("prompt_agent", {
        address: workerAddress,
        prompt: "sleep:250:b",
        wait: false,
      }),
    );
    // Both finish before anyone asks.
    await t.execute("wait_agent", { call_ids: [b.call_id] });
    const first = call(await t.execute("wait_agent", { call_ids: [b.call_id, a.call_id] }));
    expect(first).toMatchObject({ call_id: a.call_id, reply: "a", remaining: [] });
  });

  it("fetching a finished call is idempotent", async () => {
    const t = tools();
    const c = call(
      await t.execute("prompt_agent", { address: workerAddress, prompt: "echo:same", wait: false }),
    );
    const once = await t.execute("wait_agent", { call_ids: [c.call_id] });
    const twice = await t.execute("wait_agent", { call_ids: [c.call_id] });
    expect(twice).toEqual(once);
    const cancelled = await t.execute("cancel_agent", { call_ids: [c.call_id] });
    expect(cancelled).toEqual({
      calls: [{ call_id: c.call_id, state: "completed", reply: "echo:same" }],
    });
  });

  it("an answer to a detached call returns running, and the reply comes through wait_agent", async () => {
    const t = tools();
    const c = call(
      await t.execute("prompt_agent", { address: workerAddress, prompt: "ask:go?", wait: false }),
    );
    const asked = call(await t.execute("wait_agent", { call_ids: [c.call_id] }));
    expect(asked).toMatchObject({ state: "input_required", question: "go?", remaining: [] });
    // Asked again, the same open question.
    expect(await t.execute("wait_agent", { call_ids: [c.call_id], timeout_ms: 0 })).toEqual(asked);
    const answered = call(await t.execute("answer_agent", { call_id: c.call_id, answer: "go" }));
    expect(answered).toMatchObject({ state: "running", open_calls: 1 });
    const done = call(await t.execute("wait_agent", { call_ids: [c.call_id] }));
    expect(done).toMatchObject({ state: "completed", reply: "answered:go" });
  });

  it("answer_agent's wait overrides the mode the call was started in", async () => {
    const t = tools();
    const c = call(
      await t.execute("prompt_agent", { address: workerAddress, prompt: "ask:now?", wait: false }),
    );
    await t.execute("wait_agent", { call_ids: [c.call_id] });
    const done = call(
      await t.execute("answer_agent", { call_id: c.call_id, answer: "ok", wait: true }),
    );
    expect(done).toMatchObject({ state: "completed", reply: "answered:ok" });
  });

  // --- cancel, expired, list ------------------------------------------------------

  it("cancel_agent returns the text so far, and refuses an open question", async () => {
    const t = tools();
    const running = call(
      await t.execute("prompt_agent", {
        address: workerAddress,
        prompt: "gate:cancel",
        wait: false,
      }),
    );
    await until(() => gate("cancel").reached, "the worker to send its first chunk");
    await delay(50);
    const asking = call(
      await t.execute("prompt_agent", { address: workerAddress, prompt: "ask:cancel me?" }),
    );
    expect(asking.state).toBe("input_required");

    const result = await t.execute("cancel_agent", {
      call_ids: [running.call_id, asking.call_id, "call_nope"],
    });
    expect(result).toEqual({
      calls: [
        { call_id: running.call_id, state: "cancelled", partial_reply: "partial " },
        { call_id: asking.call_id, state: "cancelled" },
        { call_id: "call_nope", error: expect.stringMatching(/no such call/) as string },
      ],
    });
    await until(() => answers.includes(AGENT_TOOLS_QUESTION_REFUSAL), "the refusal");
    // Cancelled is final: what the worker sends later is discarded.
    gate("cancel").open();
    await delay(100);
    expect(await t.execute("wait_agent", { call_ids: [running.call_id] })).toMatchObject({
      state: "cancelled",
      partial_reply: "partial ",
    });
  });

  it("the host's abort cancels a blocking call, and only stops a wait", async () => {
    const t = tools();
    const abort = new AbortController();
    const pending = t.execute(
      "prompt_agent",
      { address: workerAddress, prompt: "gate:abort" },
      { signal: abort.signal },
    );
    await until(() => gate("abort").reached, "the worker to start");
    await delay(50);
    abort.abort();
    expect(call(await pending)).toMatchObject({ state: "cancelled", partial_reply: "partial " });

    const c = call(
      await t.execute("prompt_agent", {
        address: workerAddress,
        prompt: "sleep:200:later",
        wait: false,
      }),
    );
    const stop = new AbortController();
    const waiting = t.execute("wait_agent", { call_ids: [c.call_id] }, { signal: stop.signal });
    stop.abort();
    expect(await waiting).toMatchObject({ state: "running", call_ids: [c.call_id] });
    expect(call(await t.execute("wait_agent", { call_ids: [c.call_id] })).reply).toBe("later");
  });

  it("a call past its runtime limit is expired", async () => {
    const t = tools({ maxWaitMs: 300 });
    const result = call(
      await t.execute("prompt_agent", { address: workerAddress, prompt: "gate:expire" }),
    );
    expect(result).toMatchObject({ state: "expired", partial_reply: "partial " });
    expect(result.error).toMatch(/runtime limit of 300 ms/);
  });

  it("wait_agent's timeout is capped by configuration", async () => {
    const t = tools({ maxWaitAgentMs: 100 });
    const c = call(
      await t.execute("prompt_agent", { address: workerAddress, prompt: "gate:cap", wait: false }),
    );
    const started = Date.now();
    const result = await t.execute("wait_agent", { call_ids: [c.call_id], timeout_ms: 60_000 });
    expect(result).toMatchObject({ state: "running", call_ids: [c.call_id] });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("list_agent_calls lists the calls with their label, address, state and times", async () => {
    const t = tools();
    const done = call(
      await t.execute("prompt_agent", { address: workerAddress, prompt: "echo:l", label: "first" }),
    );
    const running = call(
      await t.execute("prompt_agent", { address: workerAddress, prompt: "gate:list", wait: false }),
    );
    const result = await t.execute("list_agent_calls", {});
    expect(result).toEqual({
      calls: [
        {
          call_id: done.call_id,
          label: "first",
          address: workerAddress,
          state: "completed",
          started_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/) as string,
          ended_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/) as string,
        },
        {
          call_id: running.call_id,
          address: workerAddress,
          state: "running",
          started_at: expect.any(String) as string,
        },
      ],
      open_calls: 1,
      open_calls_note: expect.stringMatching(/1 call you started is still open/) as string,
    });
  });

  it("drops the call that finished longest ago, and refuses when every tracked call is open", async () => {
    const t = tools({ maxCalls: 2 });
    const a = call(
      await t.execute("prompt_agent", { address: workerAddress, prompt: "gate:ev-a", wait: false }),
    );
    const b = call(
      await t.execute("prompt_agent", { address: workerAddress, prompt: "gate:ev-b", wait: false }),
    );
    const refused = await t.execute("prompt_agent", { address: workerAddress, prompt: "echo:c" });
    conforms(refused);
    expect(refused["error"]).toMatch(/all 2 tracked calls are still open/);

    gate("ev-a").open();
    expect(call(await t.execute("wait_agent", { call_ids: [a.call_id] })).state).toBe("completed");
    const c = call(await t.execute("prompt_agent", { address: workerAddress, prompt: "echo:c" }));
    expect(c.reply).toBe("echo:c");
    const gone = await t.execute("wait_agent", { call_ids: [a.call_id] });
    expect(gone["error"]).toMatch(/no such call/);
    const listed = (await t.execute("list_agent_calls")) as { calls: Array<{ call_id: string }> };
    expect(listed.calls.map((x) => x.call_id)).toEqual([b.call_id, c.call_id]);
  });

  // --- scopes --------------------------------------------------------------------

  it("a served prompt's calls end with it: open calls cancelled, the open question refused", async () => {
    const t = tools();
    let inside: AgentToolResult[] = [];
    let pendingWait: Promise<AgentToolResult> | undefined;
    const host = await service(
      "host-scope",
      async (_envelope, response) => {
        const asking = call(
          await t.execute("prompt_agent", {
            address: workerAddress,
            prompt: "ask:still there?",
            wait: false,
          }),
        );
        const question = await t.execute("wait_agent", { call_ids: [asking.call_id] });
        const running = call(
          await t.execute("prompt_agent", {
            address: workerAddress,
            prompt: "gate:scope",
            wait: false,
          }),
        );
        await until(() => gate("scope").reached, "the worker to start");
        await delay(50);
        const listed = await t.execute("list_agent_calls");
        inside = [asking, question, running, listed];
        // A wait still pending when the prompt ends.
        pendingWait = t.execute("wait_agent", { call_ids: [running.call_id] });
        await response.send("done");
      },
      { interceptors: [t.requestInterceptor] },
    );
    // Unsigned: this test's caller and the worker share a NATS user, so a
    // signed prompt would meet the caller guard.
    const agents = new Agents({ nc });
    open.push(agents);
    const [handle] = await agents.discover({ filter: { name: "host-scope" }, timeoutMs: 250 });
    let reply = "";
    for await (const msg of await handle!.prompt("go"))
      if (msg.type === "response") reply += msg.text;
    expect(reply).toBe("done");

    const [asking, question, running, listed] = inside;
    expect(asking).toMatchObject({ state: "running", open_calls: 1 });
    expect(asking!["open_calls_note"]).toMatch(/end with the prompt you are answering/);
    expect(question).toMatchObject({ state: "input_required", open_calls: 1 });
    expect(running).toMatchObject({ open_calls: 2 });
    expect(listed).toMatchObject({ open_calls: 2 });
    expect((listed!["calls"] as unknown[]).length).toBe(2);

    // The pending wait saw its call cancelled when the prompt ended.
    expect(await pendingWait).toMatchObject({ state: "cancelled", partial_reply: "partial " });
    await until(() => answers.at(-1) === AGENT_TOOLS_QUESTION_REFUSAL, "the refusal");
    // Outside that prompt, its calls are unknown.
    const outside = await t.execute("wait_agent", { call_ids: [running!["call_id"] as string] });
    expect(outside["error"]).toMatch(/no such call/);
    await host.stop();
  });

  it("runInPromptScope is the same scope for hosts without AgentService", async () => {
    const t = tools();
    let id = "";
    const result = await t.runInPromptScope(async () => {
      const c = call(
        await t.execute("prompt_agent", {
          address: workerAddress,
          prompt: "gate:run",
          wait: false,
        }),
      );
      id = c.call_id;
      return c;
    });
    expect(result.state).toBe("running");
    expect((await t.execute("wait_agent", { call_ids: [id] }))["error"]).toMatch(/no such call/);
    await expect(
      t.runInPromptScope(() =>
        t.execute("prompt_agent", { address: workerAddress, prompt: "echo:x" }),
      ),
    ).resolves.toMatchObject({ state: "completed" });
  });

  it("outside a served prompt, onSettled reports each call that finishes", async () => {
    const settled: Array<[AgentCallResult, SettledInfo]> = [];
    const t = tools({ onSettled: (result, info) => void settled.push([result, info]) });
    const detached = call(
      await t.execute("prompt_agent", { address: workerAddress, prompt: "echo:bg", wait: false }),
    );
    await until(() => settled.length === 1, "the first report");
    expect(settled[0]).toEqual([
      { call_id: detached.call_id, state: "completed", reply: "echo:bg" },
      { awaited: false },
    ]);
    const blocking = call(
      await t.execute("prompt_agent", { address: workerAddress, prompt: "echo:fg" }),
    );
    await until(() => settled.length === 2, "the second report");
    expect(settled[1]).toEqual([blocking, { awaited: true }]);
    // Calls in a served prompt are not reported.
    await t.runInPromptScope(() =>
      t.execute("prompt_agent", { address: workerAddress, prompt: "echo:scoped" }),
    );
    await delay(50);
    expect(settled).toHaveLength(2);
  });

  it("close() cancels open calls and removes the staging directory it created", async () => {
    const t = new AgentTools({ agents: client(), discoverTimeoutMs: 250 });
    const files = call(
      await t.execute("prompt_agent", { address: workerAddress, prompt: "files:" }),
    );
    const saved = files.attachments![0]!.path!;
    const staging = dirname(dirname(saved));
    const c = call(
      await t.execute("prompt_agent", {
        address: workerAddress,
        prompt: "gate:close",
        wait: false,
      }),
    );
    await t.close();
    await expect(stat(staging)).rejects.toThrow();
    await expect(t.execute("wait_agent", { call_ids: [c.call_id] })).rejects.toThrow(/closed/);
  });

  // --- files -------------------------------------------------------------------------

  describe("files", () => {
    let dir: string;
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "agent-tools-test-"));
      await mkdir(join(dir, "root"));
      await mkdir(join(dir, "elsewhere"));
      await writeFile(join(dir, "root", "ok.txt"), "fine!");
      await writeFile(join(dir, "elsewhere", "secret.txt"), "nope");
      await symlink(join(dir, "elsewhere", "secret.txt"), join(dir, "root", "link.txt"));
    });
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("sends files only from under the configured roots", async () => {
      const t = tools({ attachmentRoots: [join(dir, "root")] });
      const sent = call(
        await t.execute("prompt_agent", {
          address: workerAddress,
          prompt: "attach:",
          attachments: [join(dir, "root", "ok.txt")],
        }),
      );
      expect(sent.reply).toBe("got:ok.txt=fine!");
      for (const [path, words] of [
        [join(dir, "elsewhere", "secret.txt"), /outside the directories you may send files from/],
        [join(dir, "root", "link.txt"), /outside the directories you may send files from/],
        [join(dir, "root", "missing.txt"), /does not exist/],
        [join(dir, "root"), /is not a file/],
      ] as const) {
        const refused = await t.execute("prompt_agent", {
          address: workerAddress,
          prompt: "attach:",
          attachments: [path],
        });
        conforms(refused);
        expect(refused["error"]).toMatch(words);
      }
    });

    it("saves returned files, one directory per call, and lists each", async () => {
      const staging = join(dir, "staging");
      const t = tools({ stagingDir: staging });
      const result = call(
        await t.execute("prompt_agent", { address: workerAddress, prompt: "files:" }),
      );
      const callDir = join(staging, result.call_id);
      expect(result.attachments).toEqual([
        { filename: "report.txt", size_bytes: 5, path: join(callDir, "report.txt") },
        { filename: "../escape.txt", size_bytes: 1, path: join(callDir, "escape.txt") },
        { filename: "bad.bin", size_bytes: 0, path: null, skipped: "invalid_content" },
      ]);
      expect(await readFile(join(callDir, "report.txt"), "utf8")).toBe("hello");
      // A directory the host gave is the host's: close() keeps it.
      await t.close();
      expect((await stat(staging)).isDirectory()).toBe(true);
    });

    it("stops at the total per call", async () => {
      const t = tools({ maxSavedBytesPerCall: 6 });
      const result = call(
        await t.execute("prompt_agent", { address: workerAddress, prompt: "big:" }),
      );
      expect(result.attachments).toEqual([
        { filename: "a.txt", size_bytes: 5, path: expect.stringMatching(/a\.txt$/) as string },
        { filename: "b.txt", size_bytes: 6, path: null, skipped: "over_limit" },
      ]);
    });

    it("saves a question's files, and a saved file can be sent on from the staging directory", async () => {
      const t = tools();
      const asked = call(
        await t.execute("prompt_agent", { address: workerAddress, prompt: "ask-file:" }),
      );
      expect(asked).toMatchObject({ state: "input_required", question: "look at this" });
      const [file] = asked.attachments!;
      expect(file).toMatchObject({ filename: "q.txt", size_bytes: 13 });
      expect(await readFile(file!.path!, "utf8")).toBe("question file");
      expect(
        call(await t.execute("answer_agent", { call_id: asked.call_id, answer: "seen" })).reply,
      ).toBe("answered:seen");
      // The staging directory is a default root.
      const forwarded = call(
        await t.execute("prompt_agent", {
          address: workerAddress,
          prompt: "attach:",
          attachments: [file!.path!],
        }),
      );
      expect(forwarded.reply).toBe(`got:${basename(file!.path!)}=question file`);
    });
  });

  // --- loop guards ---------------------------------------------------------------------

  it("refuses the agent's own address, and leaves it out of discovery", async () => {
    const t = tools({ selfAddress: workerAddress });
    const refused = await t.execute("prompt_agent", { address: workerAddress, prompt: "echo:me" });
    conforms(refused);
    expect(refused["error"]).toMatch(/your own address/);
    const found = (await t.execute("discover_agents", { name: "worker" })) as { agents: unknown[] };
    expect(found.agents).toEqual([]);
  });

  it("refuses the agent whose signed prompt is being served, and only that one", async () => {
    const t = tools();
    let inside: AgentToolResult | undefined;
    await service(
      "host-guard",
      async (_envelope, response) => {
        inside = await t.execute("prompt_agent", { address: workerAddress, prompt: "echo:back" });
        await response.send("ok");
      },
      { interceptors: [t.requestInterceptor] },
    );
    const serve = async (agents: Agents): Promise<AgentToolResult> => {
      const [handle] = await agents.discover({ filter: { name: "host-guard" }, timeoutMs: 250 });
      for await (const _msg of await handle!.prompt("go")) {
        /* drain */
      }
      return inside!;
    };
    // The worker registered alice's identity, and alice signed this prompt.
    const refused = await serve(client());
    conforms(refused);
    expect(refused["error"]).toMatch(/sent the prompt you are answering/);
    // An unsigned sender cannot be matched: the guard does not apply.
    const unsigned = new Agents({ nc });
    open.push(unsigned);
    expect(await serve(unsigned)).toMatchObject({ state: "completed", reply: "echo:back" });
  });

  // --- errors as results -------------------------------------------------------------

  it("an unknown address, a refused prompt and a stalled stream come back in words", async () => {
    const t = tools();
    const unknown = await t.execute("prompt_agent", {
      address: "agents.prompt.nobody.o.x",
      prompt: "hi",
    });
    conforms(unknown);
    expect(unknown["error"]).toMatch(/no agent answers at "agents.prompt.nobody.o.x"/);

    const picky = await service("picky", work, { acceptSender: () => false });
    const forbidden = call(
      await t.execute("prompt_agent", { address: picky.subject.prompt, prompt: "echo:x" }),
    );
    expect(forbidden).toMatchObject({ state: "failed" });
    expect(forbidden.error).toMatch(/answered with an error: 403/);
    const unsigned = new AgentTools({ agents: new Agents({ nc }), discoverTimeoutMs: 250 });
    open.push(unsigned);
    const unauthorized = call(
      await unsigned.execute("prompt_agent", { address: picky.subject.prompt, prompt: "echo:x" }),
    );
    expect(unauthorized.error).toMatch(/answered with an error: 401/);

    const mute = await service(
      "mute",
      async (_envelope, response) => {
        await gate("mute").opened;
        await response.send("late");
      },
      { keepaliveIntervalS: null },
    );
    const impatient = new AgentTools({
      agents: new Agents({ nc, streamInactivityTimeoutMs: 300 }),
      discoverTimeoutMs: 250,
    });
    open.push(impatient);
    const stalled = call(
      await impatient.execute("prompt_agent", { address: mute.subject.prompt, prompt: "hi" }),
    );
    expect(stalled).toMatchObject({ state: "failed" });
    expect(stalled.error).toMatch(/sent nothing for 300 ms/);

    // A tool the helper does not have, and bad arguments.
    expect(await t.execute("summon_agent", {})).toEqual({ error: 'unknown tool "summon_agent"' });
    expect((await t.execute("prompt_agent", "{oops"))["error"]).toMatch(/not valid JSON/);
  });

  // --- the tool-call ID and the extension hooks -----------------------------------

  it("puts the tool-call ID into the prompt context a prompt interceptor reads", async () => {
    const contexts: Array<Readonly<Record<string, unknown>>> = [];
    const recorder: PromptInterceptor = {
      beforePrompt(ctx) {
        contexts.push(ctx.context);
      },
    };
    const t = new AgentTools({
      agents: client({ interceptors: [recorder] }),
      discoverTimeoutMs: 250,
    });
    open.push(t);
    await t.execute(
      "prompt_agent",
      { address: workerAddress, prompt: "echo:id" },
      { toolCallId: "toolu_1" },
    );
    expect(contexts).toEqual([{ toolCallId: "toolu_1" }]);
    // Never on the wire: the worker got the prompt alone.
    expect(received.at(-1)).toEqual({ prompt: "echo:id" });
  });

  it("runs an extension's three hooks: discovery fields, a prompt rewrite, a look at the reply", async () => {
    const contexts: Array<Readonly<Record<string, unknown>>> = [];
    const seen: string[] = [];
    const extension: AgentToolsExtension = {
      discoveryFields: (agent) => ({ x_kind: `kind:${agent.agent}` }),
      beforePrompt(ctx) {
        if (ctx.prompt.includes("forbidden")) return { error: "that prompt may not go out" };
        return {
          prompt: `echo:rewritten ${ctx.prompt}`,
          context: { x_marker: ctx.callId },
          fields: { x_rewritten: true },
        };
      },
      afterReply(ctx) {
        seen.push(`${ctx.kind}:${ctx.text}`);
        return { x_length: ctx.text.length };
      },
    };
    const t = new AgentTools({
      agents: client({
        interceptors: [{ beforePrompt: (ctx) => void contexts.push(ctx.context) }],
      }),
      discoverTimeoutMs: 250,
      extensions: [extension],
    });
    open.push(t);

    const found = (await t.execute("discover_agents", { name: "worker" })) as {
      agents: Array<Record<string, unknown>>;
    };
    expect(found.agents[0]).toMatchObject({ address: workerAddress, x_kind: "kind:tools-test" });

    const result = await t.execute(
      "prompt_agent",
      { address: workerAddress, prompt: "hello" },
      { toolCallId: "toolu_2" },
    );
    conforms(result, ["x_rewritten", "x_length"]);
    expect(result).toEqual({
      call_id: expect.any(String) as string,
      state: "completed",
      reply: "echo:rewritten hello",
      x_rewritten: true,
      x_length: "echo:rewritten hello".length,
    });
    expect(contexts).toEqual([{ x_marker: result["call_id"], toolCallId: "toolu_2" }]);
    expect(seen).toEqual(["reply:echo:rewritten hello"]);

    const refused = await t.execute("prompt_agent", {
      address: workerAddress,
      prompt: "forbidden",
    });
    expect(refused).toEqual({ error: "that prompt may not go out" });

    // An extension that sets a field the contract defines is a bug.
    const broken = new AgentTools({
      agents: client(),
      discoverTimeoutMs: 250,
      extensions: [{ beforePrompt: () => ({ fields: { state: "mine" } }) }],
    });
    open.push(broken);
    await expect(
      broken.execute("prompt_agent", { address: workerAddress, prompt: "echo:x" }),
    ).rejects.toThrow(/may not set "state"/);
  });

  it("a reply look that throws fails the call", async () => {
    const { logger, errors } = errorLog();
    const t = new AgentTools({
      agents: client(),
      discoverTimeoutMs: 250,
      logger,
      extensions: [
        {
          afterReply: () => {
            throw new Error("boom");
          },
        },
      ],
    });
    open.push(t);
    const result = call(
      await t.execute("prompt_agent", { address: workerAddress, prompt: "echo:x" }),
    );
    expect(result).toMatchObject({ state: "failed", partial_reply: "echo:x" });
    expect(result.error).toMatch(/an extension failed on the reply: boom/);
    // The extension's own failure, not a bug the helper names.
    expect(errors).toEqual([]);
  });

  it("a reply look that sets a field the contract defines fails the call and logs the bug", async () => {
    // Asks, and nobody answers: the call fails on the question.
    const asker = await service("asker", async (_envelope, response) => {
      await response.ask("may I?", { timeoutMs: 500 }).catch(() => undefined);
    });
    const { logger, errors } = errorLog();
    const t = new AgentTools({
      agents: client(),
      discoverTimeoutMs: 250,
      logger,
      extensions: [{ afterReply: () => ({ state: "mine" }) }],
    });
    open.push(t);
    const bug = (kind: string, address: string): string =>
      `an extension of these tools has a bug (it set "state" on the ${kind}, ` +
      `a field the tools define); the agent at "${address}" is not at fault`;

    const reply = call(
      await t.execute("prompt_agent", { address: workerAddress, prompt: "echo:x" }),
    );
    expect(reply).toMatchObject({ state: "failed", partial_reply: "echo:x" });
    expect(reply.error).toBe(bug("reply", workerAddress));

    const question = call(
      await t.execute("prompt_agent", { address: asker.subject.prompt, prompt: "go" }),
    );
    expect(question.state).toBe("failed");
    expect(question.error).toBe(bug("question", asker.subject.prompt));

    const line =
      'AgentTools: an extension bug: afterReply set "state", a field the contract defines; the call fails';
    expect(errors).toEqual([
      [line, { call_id: reply.call_id, kind: "reply", field: "state" }],
      [line, { call_id: question.call_id, kind: "question", field: "state" }],
    ]);
    await asker.stop();
  });
});
