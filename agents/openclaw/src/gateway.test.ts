// The gateway's wiring: identity and trust on the host service (as before),
// and the agent tools and extensions: one `Agents` client with the same
// signer and the extensions' prompt interceptors, the interceptor order on
// the service, the tools registered by mode, the events around a served
// prompt, the request a tool call belongs to, and the lifecycle hooks.
// OpenClaw's dispatch and the host service are mocked; the SDK's client
// and tools helper are real, over a connection that is never used.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AsyncLocalStorage } from "node:async_hooks";
import type { AnyAgentTool } from "openclaw/plugin-sdk/core";
import type { ServedRequest } from "./extensions.js";

const mocks = vi.hoisted(() => ({
  connectToNats: vi.fn(),
  drainConnection: vi.fn(),
  dispatch: vi.fn(),
  serviceOptions: [] as Array<Record<string, unknown>>,
  serviceStops: [] as Array<ReturnType<typeof vi.fn>>,
  services: [] as Array<{ handler: PromptHandler | undefined }>,
  startError: undefined as Error | undefined,
  agentsOptions: [] as Array<Record<string, unknown>>,
  agentsClosed: 0,
  order: [] as string[],
  setActiveConnection: vi.fn(),
  setActiveAgentTools: vi.fn(),
  setActiveExtensionNames: vi.fn(),
  cleanupAgentStaging: vi.fn(),
}));

type PromptHandler = (envelope: unknown, response: unknown) => Promise<void>;

vi.mock("openclaw/plugin-sdk/channel-inbound", () => ({
  dispatchInboundDirectDmWithRuntime: mocks.dispatch,
}));
vi.mock("openclaw/plugin-sdk/state-paths", () => ({
  resolveStateDir: () => "/tmp/openclaw-gateway-test",
}));
vi.mock("@synadia-ai/agent-service", () => ({
  DEFAULT_ATTACHMENTS_OK: true,
  splitResponseText: (text: string) => [text],
  AgentService: class {
    readonly subject = { prompt: "agents.prompt.oc.acme.echo" };
    readonly instanceId = "instance-1";
    readonly identity: { user: string; account: string } | undefined;
    readonly stop = vi.fn(async () => {
      mocks.order.push("service.stop");
    });
    handler: PromptHandler | undefined;

    constructor(options: Record<string, unknown>) {
      mocks.serviceOptions.push(options);
      mocks.serviceStops.push(this.stop);
      mocks.services.push(this);
      this.identity = options.identity
        ? { user: "U-connection", account: "A-connection" }
        : undefined;
    }

    onPrompt(handler: PromptHandler): void {
      this.handler = handler;
    }
    async start(): Promise<void> {
      if (mocks.startError) throw mocks.startError;
    }
  },
}));
vi.mock("@synadia-ai/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synadia-ai/agents")>();
  class RecordingAgents extends actual.Agents {
    constructor(options: ConstructorParameters<typeof actual.Agents>[0]) {
      super(options);
      mocks.agentsOptions.push(options as unknown as Record<string, unknown>);
    }
    override async close(): Promise<void> {
      mocks.agentsClosed++;
      mocks.order.push("agents.close");
      await super.close();
    }
  }
  return { ...actual, Agents: RecordingAgents };
});
vi.mock("./nats/connection.js", () => ({
  connectToNats: mocks.connectToNats,
  drainConnection: mocks.drainConnection,
}));
vi.mock("./runtime.js", () => ({
  getNatsRuntime: () => ({ channel: {} }),
  setActiveConnection: mocks.setActiveConnection,
  setActiveAgentTools: mocks.setActiveAgentTools,
  setActiveExtensionNames: mocks.setActiveExtensionNames,
}));
vi.mock("./attachments.js", () => ({
  cleanupAgentStaging: mocks.cleanupAgentStaging,
  stageAttachmentsIntoPrompt: (params: { prompt: string }) => params.prompt,
}));

import { AGENT_TOOL_NAMES, Agents } from "@synadia-ai/agents";
import { startNatsGateway, stopNatsGateway } from "./gateway.js";
import type { ResolvedNatsAccount } from "./types.js";

/** What the counting extension (see `beforeAll`) records on `globalThis`. */
interface CounterState {
  ctx: Record<string, unknown>;
  handles: { agents: unknown; service: unknown } | null;
  started: number;
  stopping: number;
  accepted: ServedRequest[];
  acceptedIn: Array<string | null>;
  ended: Array<{ id: string; outcome: string; at: number }>;
  dispatches: string[];
  toolCalls: Array<{ id: string | null; name: string; store: string | null }>;
  order: string[];
  als: AsyncLocalStorage<string>;
  requestInterceptor: { aroundRequest: unknown };
  promptInterceptor: { beforePrompt: unknown };
}

function counter(): CounterState {
  return (globalThis as unknown as { __ocGatewayTestExtension: CounterState })
    .__ocGatewayTestExtension;
}

let fixtures: string;
let counterModule: string;

beforeAll(() => {
  fixtures = mkdtempSync(join(tmpdir(), "openclaw-gateway-ext-"));
  counterModule = join(fixtures, "counter.mjs");
  writeFileSync(
    counterModule,
    `import { AsyncLocalStorage } from "node:async_hooks";
     const als = new AsyncLocalStorage();
     export default function createExtension(ctx) {
       const requestInterceptor = { aroundRequest: (_c, next) => next() };
       const promptInterceptor = { beforePrompt: () => undefined };
       const state = {
         ctx, handles: null, started: 0, stopping: 0, accepted: [], acceptedIn: [],
         ended: [], dispatches: [], toolCalls: [], order: [], als,
         requestInterceptor, promptInterceptor,
       };
       globalThis.__ocGatewayTestExtension = state;
       return {
         name: "counter",
         requestInterceptors: [requestInterceptor],
         promptInterceptors: [promptInterceptor],
         heartbeatExtras: () => ({ counter: "loaded" }),
         toolExtensions: [{ discoveryFields: () => ({ counter: true }) }],
         async started(handles) { state.started++; state.handles = handles; state.order.push("started"); },
         async stopping() { state.stopping++; state.order.push("stopping"); },
         events: {
           promptAccepted(request) { state.accepted.push(request); state.acceptedIn.push(als.getStore() ?? null); },
           promptEnded(request, outcome, at) { state.ended.push({ id: request.id, outcome, at }); },
           aroundDispatch(request, run) { state.dispatches.push(request.id); return als.run("dispatch:" + request.id, run); },
           aroundToolCall(request, name, run) {
             state.toolCalls.push({ id: request?.id ?? null, name, store: als.getStore() ?? null });
             return run();
           },
         },
       };
     }`,
  );
  writeFileSync(join(fixtures, "broken.mjs"), `export default function () { throw new Error("no"); }`);
});

afterAll(() => {
  rmSync(fixtures, { recursive: true, force: true });
});

function account(overrides: Partial<ResolvedNatsAccount> = {}): ResolvedNatsAccount {
  return {
    accountId: "default",
    enabled: true,
    url: "nats://127.0.0.1:4222",
    agentName: "echo",
    description: "Echo",
    connectionSource: { url: "nats://127.0.0.1:4222" },
    senderIdentity: "off",
    minSenderTrust: "any",
    owner: "acme",
    agentTools: "blocking",
    extensions: { source: "none", entries: [] },
    config: { agentName: "echo" },
    ...overrides,
  };
}

function withCounter(overrides: Partial<ResolvedNatsAccount> = {}): ResolvedNatsAccount {
  return account({
    extensions: {
      source: "config",
      entries: [{ module: counterModule, options: { level: 2 } }],
    },
    config: { agentName: "echo", extensions: [{ module: counterModule, options: { level: 2 } }] },
    ...overrides,
  });
}

function gatewayContext(resolved: ResolvedNatsAccount, abortSignal: AbortSignal) {
  const status = {};
  return {
    account: resolved,
    cfg: {},
    abortSignal,
    channelRuntime: { reply: {} },
    getStatus: () => status,
    setStatus: vi.fn(),
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

function connected(signer?: { user: string; account: string; sign: unknown }) {
  const wipe = vi.fn();
  mocks.connectToNats.mockResolvedValue({
    nc: { info: { max_payload: 1_048_576 } },
    bundle: { connectionOptions: {}, ...(signer ? { signer } : {}), wipe },
  });
  return wipe;
}

/** Start the gateway and wait until it is on the bus. */
async function started(resolved: ResolvedNatsAccount) {
  const controller = new AbortController();
  const ctx = gatewayContext(resolved, controller.signal);
  const running = startNatsGateway(ctx as never);
  // The cleanup at the start of every gateway start also calls this, with
  // nulls; the live connection is set once the service is on the bus.
  await vi.waitFor(() =>
    expect(mocks.setActiveConnection.mock.calls.some((c) => c[0] !== null)).toBe(true),
  );
  const service = mocks.services[mocks.services.length - 1]!;
  return { controller, ctx, running, handler: service.handler!, service };
}

/** The tools the running gateway registered (the cleanup at start records a null first). */
function registeredTools(): AnyAgentTool[] {
  const calls = mocks.setActiveAgentTools.mock.calls.filter((c) => c[0] !== null);
  expect(calls).toHaveLength(1);
  return calls[0]![0] as AnyAgentTool[];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const envelope = { prompt: "hi", extras: { trace: "t" } };
const verifiedResponse = { sender: { trust: "verified", id: "A.U" }, send: vi.fn() };
const unsignedResponse = { sender: undefined, send: vi.fn() };

function resetMocks(): void {
  mocks.connectToNats.mockReset();
  mocks.drainConnection.mockReset().mockResolvedValue(undefined);
  mocks.dispatch.mockReset();
  mocks.setActiveConnection.mockReset();
  mocks.setActiveAgentTools.mockReset();
  mocks.setActiveExtensionNames.mockReset();
  mocks.cleanupAgentStaging.mockReset();
  mocks.serviceOptions.length = 0;
  mocks.serviceStops.length = 0;
  mocks.services.length = 0;
  mocks.agentsOptions.length = 0;
  mocks.agentsClosed = 0;
  mocks.order.length = 0;
  mocks.startError = undefined;
  delete (globalThis as { __ocGatewayTestExtension?: unknown }).__ocGatewayTestExtension;
}

describe("OpenClaw AgentService wiring", () => {
  beforeEach(resetMocks);

  afterEach(async () => {
    await stopNatsGateway({} as never);
  });

  it("keeps identity off by default while advertising permissive trust", async () => {
    const wipe = connected();
    const { controller, running } = await started(account());
    const options = mocks.serviceOptions[0]!;
    expect(options).not.toHaveProperty("identity");
    expect(options.minSenderTrust).toBe("any");
    controller.abort();
    await running;
    expect(wipe).toHaveBeenCalledOnce();
  });

  it("passes only the connection bundle signer into signed registration", async () => {
    const signer = { user: "U", account: "A", sign: vi.fn() };
    const wipe = connected(signer);
    const { controller, running } = await started(
      account({
        senderIdentity: "signed",
        minSenderTrust: "signed",
        connectionSource: { context: "prod" },
      }),
    );
    expect(mocks.connectToNats).toHaveBeenCalledWith({
      source: { context: "prod" },
      senderIdentity: "signed",
      name: "openclaw-echo",
    });
    const options = mocks.serviceOptions[0]!;
    expect(options.identity).toEqual({ signer });
    expect(options.minSenderTrust).toBe("signed");
    controller.abort();
    await running;
    expect(wipe).toHaveBeenCalledOnce();
  });
});

describe("the agent tools", () => {
  beforeEach(resetMocks);

  afterEach(async () => {
    await stopNatsGateway({} as never);
  });

  it("one client with the service's signer prompts for the tools; the blocking three are registered by default and go at stop", async () => {
    const signer = { user: "U", account: "A", sign: vi.fn() };
    connected(signer);
    const { controller, running, ctx } = await started(account({ senderIdentity: "signed" }));
    expect(mocks.agentsOptions).toHaveLength(1);
    expect(mocks.agentsOptions[0]!.identity).toEqual({ signer });
    expect(mocks.agentsOptions[0]!.interceptors).toEqual([]);
    // The service's one interceptor is the tools' scope.
    const interceptors = mocks.serviceOptions[0]!.interceptors as Array<{ aroundRequest: unknown }>;
    expect(interceptors).toHaveLength(1);
    expect(typeof interceptors[0]!.aroundRequest).toBe("function");
    expect(mocks.serviceOptions[0]).not.toHaveProperty("heartbeatExtras");
    // Registered once the agent is on the bus, as OpenClaw tools.
    const tools = registeredTools();
    expect(tools.map((t) => t.name)).toEqual(["discover_agents", "prompt_agent", "answer_agent"]);
    const registeredLine = (ctx.log.info.mock.calls as string[][])
      .map((c) => c[0]!)
      .find((line) => line.includes("registered at"));
    expect(registeredLine).toContain(
      "agent_tools=discover_agents, prompt_agent, answer_agent, extensions=none",
    );
    controller.abort();
    await running;
    // Gone with the gateway; the client closed after the service.
    expect(mocks.setActiveAgentTools).toHaveBeenLastCalledWith(null);
    expect(mocks.agentsClosed).toBe(1);
    expect(mocks.order).toEqual(["service.stop", "agents.close"]);
  });

  it("`all` registers the six; `off` registers none and keeps the client", async () => {
    connected();
    const all = await started(account({ agentTools: "all" }));
    const six = registeredTools();
    expect(six.map((t) => t.name)).toEqual([...AGENT_TOOL_NAMES]);
    all.controller.abort();
    await all.running;

    mocks.setActiveAgentTools.mockReset();
    mocks.setActiveConnection.mockReset();
    mocks.agentsOptions.length = 0;
    mocks.serviceOptions.length = 0;
    connected();
    const off = await started(account({ agentTools: "off" }));
    expect(mocks.setActiveAgentTools.mock.calls.every((c) => c[0] === null)).toBe(true);
    expect(mocks.agentsOptions).toHaveLength(1);
    expect(mocks.serviceOptions[0]!.interceptors).toEqual([]);
    off.controller.abort();
    await off.running;
  });

  it("the model cannot prompt the OpenClaw it runs in", async () => {
    connected();
    const { controller, running } = await started(account());
    const result = await registeredTools()
      .find((t) => t.name === "prompt_agent")!
      .execute("call-1", { address: "agents.prompt.oc.acme.echo", prompt: "hi" });
    const text = (result.content[0] as { text: string }).text;
    expect(JSON.parse(text).error).toMatch(/your own address/);
    controller.abort();
    await running;
  });
});

describe("the extensions", () => {
  beforeEach(resetMocks);

  afterEach(async () => {
    await stopNatsGateway({} as never);
  });

  it("loads the module before the connection with the plugin's context, and names it on the start line", async () => {
    connected();
    const resolved = withCounter({ senderIdentity: "off", minSenderTrust: "signed" });
    const { controller, running, ctx } = await started(resolved);
    const state = counter();
    expect(state.ctx.harness).toBe("openclaw");
    expect(state.ctx.plugin).toEqual({ name: "@synadia-ai/nats-channel", version: "0.5.6" });
    expect(state.ctx.settings).toEqual({
      owner: "acme",
      name: "echo",
      senderIdentity: "off",
      minSenderTrust: "signed",
      stateDir: "/tmp/openclaw-gateway-test",
      config: resolved.config,
    });
    expect(state.ctx.options).toEqual({ level: 2 });
    expect(typeof (state.ctx.logger as { warn: unknown }).warn).toBe("function");
    // Loaded before connecting: the factory ran first.
    expect(mocks.connectToNats.mock.invocationCallOrder[0]).toBeGreaterThan(0);
    expect(mocks.setActiveExtensionNames).toHaveBeenCalledWith(["counter"]);
    const startLine = (ctx.log.info.mock.calls as string[][])
      .map((c) => c[0]!)
      .find((line) => line.includes("gateway starting"));
    expect(startLine).toContain("agentTools: blocking, extensions: counter)");
    controller.abort();
    await running;
    expect(mocks.setActiveExtensionNames).toHaveBeenLastCalledWith(null);
  });

  it("a module that fails is logged once and skipped; the gateway starts plain with the rest", async () => {
    connected();
    const broken = join(fixtures, "broken.mjs");
    const { controller, running, ctx } = await started(
      account({
        extensions: {
          source: "config",
          entries: [
            { module: broken, options: {} },
            { module: counterModule, options: {} },
          ],
        },
      }),
    );
    const errors = (ctx.log.error.mock.calls as string[][]).map((c) => c[0]!);
    expect(errors).toEqual([`nats: extension "${broken}" not loaded: no`]);
    expect(mocks.setActiveExtensionNames).toHaveBeenCalledWith(["counter"]);
    controller.abort();
    await running;
  });

  it("gives the client its prompt interceptors, the service its request interceptors before the tools' scope, and the heartbeat its extras", async () => {
    connected();
    const { controller, running } = await started(withCounter());
    const state = counter();
    expect(mocks.agentsOptions[0]!.interceptors).toEqual([state.promptInterceptor]);
    const interceptors = mocks.serviceOptions[0]!.interceptors as Array<{ aroundRequest: unknown }>;
    expect(interceptors).toHaveLength(2);
    expect(interceptors[0]).toBe(state.requestInterceptor);
    expect(typeof interceptors[1]!.aroundRequest).toBe("function");
    const extras = mocks.serviceOptions[0]!.heartbeatExtras as () => Record<string, unknown>;
    expect(extras()).toEqual({ counter: "loaded" });
    controller.abort();
    await running;
  });

  it("started gets the live handles after the service started; stopping runs before the service stops", async () => {
    connected();
    const { controller, running, service } = await started(withCounter());
    const state = counter();
    expect(state.started).toBe(1);
    expect(state.handles!.agents).toBeInstanceOf(Agents);
    expect(state.handles!.service).toBe(service);
    expect(state.stopping).toBe(0);
    controller.abort();
    await running;
    expect(state.stopping).toBe(1);
    expect(mocks.order).toEqual(["service.stop", "agents.close"]);
    expect(state.order).toEqual(["started", "stopping"]);
  });

  it("a service that fails to start owes the extensions no stopping()", async () => {
    connected();
    mocks.startError = new Error("bus refused");
    const controller = new AbortController();
    await expect(
      startNatsGateway(gatewayContext(withCounter(), controller.signal) as never),
    ).rejects.toThrow("bus refused");
    const state = counter();
    expect(state.started).toBe(0);
    expect(state.stopping).toBe(0);
    expect(mocks.serviceStops.at(-1)).toHaveBeenCalled();
    expect(mocks.setActiveExtensionNames).toHaveBeenLastCalledWith(null);
  });

  it("promptAccepted is synchronous in the handler with the request; aroundDispatch wraps OpenClaw's dispatch; promptEnded reports ok", async () => {
    connected();
    const { controller, running, handler } = await started(withCounter());
    const state = counter();
    const pending = deferred<void>();
    let seenInDispatch: string | null = null;
    mocks.dispatch.mockImplementation(() => {
      seenInDispatch = state.als.getStore() ?? null;
      return pending.promise;
    });
    const settled = handler(envelope, verifiedResponse);
    // Before any await: the request as the events name it.
    expect(state.accepted).toHaveLength(1);
    const request = state.accepted[0]!;
    expect(request).toEqual({ id: expect.any(String), extras: { trace: "t" }, caller: "A.U" });
    expect(Object.isFrozen(request)).toBe(true);
    expect(state.dispatches).toEqual([request.id]);
    expect(seenInDispatch).toBe(`dispatch:${request.id}`);
    expect(state.ended).toEqual([]);
    const before = Date.now();
    pending.resolve();
    await settled;
    expect(state.ended).toEqual([{ id: request.id, outcome: "ok", at: expect.any(Number) }]);
    expect(state.ended[0]!.at).toBeGreaterThanOrEqual(before);
    // An unsigned caller has no `caller`.
    mocks.dispatch.mockResolvedValue(undefined);
    await handler(envelope, unsignedResponse);
    expect(state.accepted[1]).toEqual({ id: expect.any(String), extras: { trace: "t" } });
    expect(state.accepted[1]!.id).not.toBe(request.id);
    controller.abort();
    await running;
  });

  it("promptEnded reports error when the dispatch threw, and when OpenClaw reported a dispatch error and resolved", async () => {
    connected();
    const { controller, running, handler } = await started(withCounter());
    const state = counter();
    mocks.dispatch.mockRejectedValueOnce(new Error("OpenClaw down"));
    await expect(handler(envelope, unsignedResponse)).rejects.toThrow("OpenClaw down");
    expect(state.ended.at(-1)).toEqual({
      id: state.accepted.at(-1)!.id,
      outcome: "error",
      at: expect.any(Number),
    });
    mocks.dispatch.mockImplementationOnce(async (params: { onDispatchError: (e: unknown, i: { kind: string }) => void }) => {
      params.onDispatchError(new Error("agent failed"), { kind: "agent" });
    });
    await handler(envelope, unsignedResponse);
    expect(state.ended.at(-1)).toEqual({
      id: state.accepted.at(-1)!.id,
      outcome: "error",
      at: expect.any(Number),
    });
    expect(state.ended).toHaveLength(2);
    controller.abort();
    await running;
  });

  it("a tool call belongs to the oldest turn still dispatching, and runs in that request's async context", async () => {
    connected();
    const { controller, running, handler } = await started(withCounter());
    const state = counter();
    const tools = registeredTools();
    // `answer_agent` with an unknown call answers in words without the bus.
    const answer = tools.find((t) => t.name === "answer_agent")!;
    const first = deferred<void>();
    const second = deferred<void>();
    mocks.dispatch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    // The handler runs in the context the interceptors bound; here the
    // test binds it, so the snapshot has something to show.
    const one = state.als.run("request:one", () => handler(envelope, unsignedResponse));
    const two = state.als.run("request:two", () => handler(envelope, unsignedResponse));
    const [idOne, idTwo] = state.accepted.slice(-2).map((r) => r.id);
    // From outside any request's context, as OpenClaw's tool runner calls
    // it on releases that do not carry the context through their lane.
    await answer.execute("call-1", { call_id: "nope", answer: "x" });
    expect(state.toolCalls.at(-1)).toEqual({ id: idOne, name: "answer_agent", store: "request:one" });
    first.resolve();
    await one;
    await answer.execute("call-2", { call_id: "nope", answer: "x" });
    expect(state.toolCalls.at(-1)).toEqual({ id: idTwo, name: "answer_agent", store: "request:two" });
    // From inside a turn's own context, as on releases that carry it: the
    // bound request wins over the queue's head, and nothing is re-entered.
    const third = deferred<void>();
    mocks.dispatch.mockReturnValueOnce(third.promise);
    const three = state.als.run("request:three", () => handler(envelope, unsignedResponse));
    const idThree = state.accepted.at(-1)!.id;
    expect(idThree).not.toBe(idTwo);
    await state.als.run("request:three", async () => {
      // Not the handler's context, so the queue's head — request two — is used.
      await answer.execute("call-3", { call_id: "nope", answer: "x" });
    });
    expect(state.toolCalls.at(-1)).toEqual({ id: idTwo, name: "answer_agent", store: "request:two" });
    second.resolve();
    await two;
    third.resolve();
    await three;
    // No turn pending: no request, and the call runs where it is.
    await answer.execute("call-4", { call_id: "nope", answer: "x" });
    expect(state.toolCalls.at(-1)).toEqual({ id: null, name: "answer_agent", store: null });
    controller.abort();
    await running;
  });

  it("a tool call made inside a dispatching turn's context names that turn, even when an older one is pending", async () => {
    connected();
    const { controller, running, handler } = await started(withCounter());
    const state = counter();
    const tools = registeredTools();
    const answer = tools.find((t) => t.name === "answer_agent")!;
    const first = deferred<void>();
    mocks.dispatch.mockReturnValueOnce(first.promise);
    const one = handler(envelope, unsignedResponse);
    const idOne = state.accepted.at(-1)!.id;
    let insideResult: unknown;
    mocks.dispatch.mockImplementationOnce(async () => {
      // OpenClaw's turn, in the handler's own async context.
      insideResult = await answer.execute("call-in", { call_id: "nope", answer: "x" });
    });
    const two = handler(envelope, unsignedResponse);
    const idTwo = state.accepted.at(-1)!.id;
    await two;
    expect(insideResult).toBeDefined();
    expect(state.toolCalls.at(-1)).toEqual({ id: idTwo, name: "answer_agent", store: `dispatch:${idTwo}` });
    expect(idTwo).not.toBe(idOne);
    first.resolve();
    await one;
    controller.abort();
    await running;
  });
});
