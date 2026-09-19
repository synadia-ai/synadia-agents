import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeTurn = {
  scope: unknown;
  bind: ReturnType<typeof vi.fn>;
  settle: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted(() => ({
  connectToNats: vi.fn(),
  drainConnection: vi.fn(),
  dispatch: vi.fn(),
  runWithTraceId: vi.fn(),
  serviceOptions: [] as Array<Record<string, unknown>>,
  serviceStops: [] as Array<ReturnType<typeof vi.fn>>,
  servedOptions: [] as Array<Record<string, unknown>>,
  turns: [] as Array<{
    scope: unknown;
    bind: ReturnType<typeof vi.fn>;
    settle: ReturnType<typeof vi.fn>;
  }>,
  promptHandlers: [] as Array<
    (envelope: unknown, response: unknown) => Promise<void>
  >,
  setActiveConnection: vi.fn(),
  cleanupAgentStaging: vi.fn(),
}));

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
    readonly stop = vi.fn().mockResolvedValue(undefined);

    constructor(options: Record<string, unknown>) {
      mocks.serviceOptions.push(options);
      mocks.serviceStops.push(this.stop);
      this.identity = options.identity
        ? { user: "U-connection", account: "A-connection" }
        : undefined;
    }

    onPrompt(
      handler: (envelope: unknown, response: unknown) => Promise<void>,
    ): void {
      mocks.promptHandlers.push(handler);
    }
    async start(): Promise<void> {}
  },
}));
// The publisher is observed through its turns; the real one is covered by
// served.test.ts.
vi.mock("./served.js", () => ({
  ServedPublisher: class {
    constructor(options: Record<string, unknown>) {
      mocks.servedOptions.push(options);
    }
    beginTurn(scope: unknown): FakeTurn | undefined {
      if (scope === undefined) return undefined;
      const turn = { scope, bind: vi.fn(), settle: vi.fn() };
      mocks.turns.push(turn);
      return turn;
    }
  },
}));
// The scope seeding is observed by the id it is asked to seed; the real
// runner is covered by trace-scope.test.ts.
vi.mock("./trace-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./trace-scope.js")>()),
  runWithTraceId: mocks.runWithTraceId,
}));
vi.mock("./nats/connection.js", () => ({
  connectToNats: mocks.connectToNats,
  drainConnection: mocks.drainConnection,
}));
vi.mock("./runtime.js", () => ({
  getNatsRuntime: () => ({ channel: {} }),
  setActiveConnection: mocks.setActiveConnection,
}));
vi.mock("./attachments.js", () => ({
  cleanupAgentStaging: mocks.cleanupAgentStaging,
  stageAttachmentsIntoPrompt: ({ prompt }: { prompt: string }) => prompt,
}));

import { bindActiveTrace, type TraceScope } from "@synadia-ai/agents";
import { startNatsGateway, stopNatsGateway, traceOptionsFor } from "./gateway.js";
import type { ResolvedNatsAccount } from "./types.js";

function account(
  overrides: Partial<ResolvedNatsAccount> = {},
): ResolvedNatsAccount {
  return {
    accountId: "default",
    enabled: true,
    url: "nats://127.0.0.1:4222",
    agentName: "echo",
    description: "Echo",
    connectionSource: { url: "nats://127.0.0.1:4222" },
    senderIdentity: "off",
    minSenderTrust: "any",
    tracing: "off",
    owner: "acme",
    config: { agentName: "echo" },
    ...overrides,
  };
}

const DISPATCHED = {
  route: { agentId: "main", sessionKey: "agent:main:nats:direct:remote" },
  storePath: "/tmp/openclaw/sessions.json",
  ctxPayload: {},
};

function promptResponse(): { sender: undefined; send: ReturnType<typeof vi.fn> } {
  return { sender: undefined, send: vi.fn().mockResolvedValue(undefined) };
}

function scope(): TraceScope {
  return { threadId: "a".repeat(32), rootId: "b".repeat(32), turnCountHint: 0 };
}

type CapturedLog = { warn: ReturnType<typeof vi.fn> };

function gatewayContext(
  resolved: ResolvedNatsAccount,
  abortSignal: AbortSignal,
): Record<string, unknown> {
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

describe("trace options", () => {
  it("turn tracing on for the service when on and are absent when off", () => {
    expect(traceOptionsFor({ tracing: "off" })).toBeUndefined();
    expect(traceOptionsFor({ tracing: "on" })).toEqual({});
  });
});

describe("OpenClaw AgentService wiring", () => {
  beforeEach(() => {
    mocks.connectToNats.mockReset();
    mocks.drainConnection.mockReset().mockResolvedValue(undefined);
    mocks.dispatch.mockReset().mockResolvedValue(DISPATCHED);
    mocks.runWithTraceId
      .mockReset()
      .mockImplementation((_id: unknown, fn: () => Promise<unknown>) => fn());
    mocks.setActiveConnection.mockReset();
    mocks.cleanupAgentStaging.mockReset();
    mocks.serviceOptions.length = 0;
    mocks.serviceStops.length = 0;
    mocks.servedOptions.length = 0;
    mocks.turns.length = 0;
    mocks.promptHandlers.length = 0;
  });

  afterEach(async () => {
    await stopNatsGateway({} as never);
  });

  it("keeps identity off by default while advertising permissive trust", async () => {
    const wipe = vi.fn();
    mocks.connectToNats.mockResolvedValue({
      nc: { info: { max_payload: 1_048_576 } },
      bundle: { connectionOptions: {}, wipe },
    });
    const controller = new AbortController();
    const running = startNatsGateway(
      gatewayContext(account(), controller.signal) as never,
    );

    await vi.waitFor(() => expect(mocks.serviceOptions).toHaveLength(1));
    const options = mocks.serviceOptions[0];
    expect(options).not.toHaveProperty("identity");
    expect(options.minSenderTrust).toBe("any");
    // Tracing off: an untraced service, no served publisher, no turn, and
    // the dispatch is not seeded with any trace id.
    expect(options).not.toHaveProperty("trace");
    expect(mocks.servedOptions).toHaveLength(0);
    await mocks.promptHandlers[0]!({ prompt: "hi" }, promptResponse());
    expect(mocks.dispatch).toHaveBeenCalledOnce();
    expect(mocks.turns).toHaveLength(0);
    expect(mocks.runWithTraceId).toHaveBeenCalledWith(undefined, expect.any(Function));
    controller.abort();
    await running;
    expect(wipe).toHaveBeenCalledOnce();
  });

  it("with tracing on, binds a fresh trace id at arrival and seeds the dispatch with it", async () => {
    const signer = { publicKey: "U", sign: vi.fn() };
    mocks.connectToNats.mockResolvedValue({
      nc: { info: { max_payload: 1_048_576 } },
      bundle: { connectionOptions: {}, signer, wipe: vi.fn() },
    });
    const controller = new AbortController();
    const context = gatewayContext(
      account({ senderIdentity: "signed", tracing: "on" }),
      controller.signal,
    );
    const running = startNatsGateway(context as never);

    await vi.waitFor(() => expect(mocks.serviceOptions).toHaveLength(1));
    expect(mocks.serviceOptions[0].trace).toEqual({});
    expect((context.log as CapturedLog).warn).not.toHaveBeenCalled();
    // The publisher signs with the connection's signer and the identity the
    // service registered, on the SDK's default trace subject.
    expect(mocks.servedOptions).toHaveLength(1);
    const servedOptions = mocks.servedOptions[0]!;
    expect(servedOptions.subject).toBe("TRACE.edges");
    expect(servedOptions.signer).toBe(signer);
    expect((servedOptions.identity as () => unknown)()).toEqual({
      user: "U-connection",
      account: "A-connection",
    });

    // The service binds the prompt's trace scope around the handler; the
    // turn is opened on that scope.
    const first = scope();
    await bindActiveTrace(first, () =>
      mocks.promptHandlers[0]!({ prompt: "hi" }, promptResponse()),
    );
    expect(mocks.turns).toHaveLength(1);
    const turn = mocks.turns[0]!;
    expect(turn.scope).toBe(first);
    // A fresh trace id — not the thread id — bound before dispatch, seeded
    // into the dispatch, and the turn settled after it.
    const bound = turn.bind.mock.calls[0]![0] as string;
    expect(bound).toMatch(/^[0-9a-f]{32}$/);
    expect(bound).not.toBe(first.threadId);
    expect(mocks.runWithTraceId).toHaveBeenCalledWith(bound, expect.any(Function));
    expect(turn.bind.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.dispatch.mock.invocationCallOrder[0]!,
    );
    expect(turn.settle).toHaveBeenCalledWith("ok");
    expect(mocks.dispatch.mock.invocationCallOrder[0]).toBeLessThan(
      turn.settle.mock.invocationCallOrder[0]!,
    );

    // Every prompt gets its own id.
    await bindActiveTrace(scope(), () =>
      mocks.promptHandlers[0]!({ prompt: "again" }, promptResponse()),
    );
    expect(mocks.turns[1]!.bind.mock.calls[0]![0]).not.toBe(bound);

    // A failed dispatch settles the turn as an error and still fails the
    // caller; the pair was bound at arrival, so it records the failure.
    mocks.dispatch.mockRejectedValueOnce(new Error("dispatch failed"));
    await expect(
      bindActiveTrace(scope(), () =>
        mocks.promptHandlers[0]!({ prompt: "broken" }, promptResponse()),
      ),
    ).rejects.toThrow("dispatch failed");
    expect(mocks.turns[2]!.bind).toHaveBeenCalledOnce();
    expect(mocks.turns[2]!.settle).toHaveBeenCalledWith("error");

    // A dispatch failure OpenClaw reports through onDispatchError while
    // still resolving is recorded as an error too.
    mocks.dispatch.mockImplementationOnce(
      async (params: { onDispatchError: (err: unknown, info: { kind: string }) => void }) => {
        params.onDispatchError(new Error("model unavailable"), { kind: "final" });
        return DISPATCHED;
      },
    );
    await bindActiveTrace(scope(), () =>
      mocks.promptHandlers[0]!({ prompt: "reported" }, promptResponse()),
    );
    expect(mocks.turns[3]!.settle).toHaveBeenCalledWith("error");
    controller.abort();
    await running;
  });

  it("warns when tracing is on without signed identity: nothing would be published", async () => {
    mocks.connectToNats.mockResolvedValue({
      nc: { info: { max_payload: 1_048_576 } },
      bundle: { connectionOptions: {}, wipe: vi.fn() },
    });
    const controller = new AbortController();
    const context = gatewayContext(
      account({ tracing: "on" }),
      controller.signal,
    );
    const running = startNatsGateway(context as never);
    await vi.waitFor(() => expect(mocks.serviceOptions).toHaveLength(1));
    expect((context.log as CapturedLog).warn).toHaveBeenCalledWith(
      expect.stringContaining("tracing is on but senderIdentity is off"),
    );
    // The publisher still runs: it warns once and counts the records it
    // owed as dropped.
    expect(mocks.servedOptions).toHaveLength(1);
    expect(mocks.servedOptions[0]!.signer).toBeUndefined();
    controller.abort();
    await running;
  });

  it("passes only the connection bundle signer into signed registration", async () => {
    const signer = { user: "U", account: "A", sign: vi.fn() };
    const wipe = vi.fn();
    mocks.connectToNats.mockResolvedValue({
      nc: { info: { max_payload: 1_048_576 } },
      bundle: { connectionOptions: {}, signer, wipe },
    });
    const controller = new AbortController();
    const resolved = account({
      senderIdentity: "signed",
      minSenderTrust: "signed",
      connectionSource: { context: "prod" },
    });
    const running = startNatsGateway(
      gatewayContext(resolved, controller.signal) as never,
    );

    await vi.waitFor(() => expect(mocks.serviceOptions).toHaveLength(1));
    expect(mocks.connectToNats).toHaveBeenCalledWith({
      source: { context: "prod" },
      senderIdentity: "signed",
      name: "openclaw-echo",
    });
    const options = mocks.serviceOptions[0];
    expect(options.identity).toEqual({ signer });
    expect(options.minSenderTrust).toBe("signed");
    controller.abort();
    await running;
    expect(wipe).toHaveBeenCalledOnce();
  });
});
