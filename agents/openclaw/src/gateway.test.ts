import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectToNats: vi.fn(),
  drainConnection: vi.fn(),
  serviceOptions: [] as Array<Record<string, unknown>>,
  serviceStops: [] as Array<ReturnType<typeof vi.fn>>,
  setActiveConnection: vi.fn(),
  cleanupAgentStaging: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", () => ({
  dispatchInboundDirectDmWithRuntime: vi.fn(),
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

    onPrompt(): void {}
    async start(): Promise<void> {}
  },
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
  stageAttachmentsIntoPrompt: vi.fn(),
}));

import { startNatsGateway, stopNatsGateway } from "./gateway.js";
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
    owner: "acme",
    config: { agentName: "echo" },
    ...overrides,
  };
}

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

describe("OpenClaw AgentService wiring", () => {
  beforeEach(() => {
    mocks.connectToNats.mockReset();
    mocks.drainConnection.mockReset().mockResolvedValue(undefined);
    mocks.setActiveConnection.mockReset();
    mocks.cleanupAgentStaging.mockReset();
    mocks.serviceOptions.length = 0;
    mocks.serviceStops.length = 0;
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
    controller.abort();
    await running;
    expect(wipe).toHaveBeenCalledOnce();
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
