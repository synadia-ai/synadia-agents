import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  resolveBundle: vi.fn(),
}));

vi.mock("@nats-io/transport-node", () => ({ connect: mocks.connect }));
vi.mock("@synadia-ai/agents", async (importOriginal) => {
  const original = await importOriginal<typeof import("@synadia-ai/agents")>();
  return { ...original, resolveNatsConnectionBundle: mocks.resolveBundle };
});

import { connectToNats, drainConnection } from "./connection.js";

describe("connectToNats", () => {
  beforeEach(() => {
    mocks.connect.mockReset();
    mocks.resolveBundle.mockReset();
  });

  it("uses the shared bundle as the only auth/signer resolver", async () => {
    const source = { context: "prod" } as const;
    const wipe = vi.fn();
    const signer = { user: "U", account: "A", sign: vi.fn() };
    const bundle = {
      connectionOptions: { servers: "tls://connect.example" },
      signer,
      wipe,
    };
    const nc = {
      status: async function* () {},
    };
    mocks.resolveBundle.mockResolvedValue(bundle);
    mocks.connect.mockResolvedValue(nc);

    const connected = await connectToNats({
      source,
      senderIdentity: "signed",
      name: "openclaw-echo",
    });

    expect(mocks.resolveBundle).toHaveBeenCalledWith(source, {
      identity: "signed",
    });
    expect(mocks.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        servers: "tls://connect.example",
        name: "openclaw-echo",
        maxReconnectAttempts: -1,
        waitOnFirstConnect: true,
      }),
    );
    expect(connected).toEqual({ nc, bundle });
    expect(wipe).not.toHaveBeenCalled();
  });

  it("wipes the retained snapshot when connect fails", async () => {
    const wipe = vi.fn();
    mocks.resolveBundle.mockResolvedValue({
      connectionOptions: { servers: "nats://127.0.0.1:4222" },
      wipe,
    });
    mocks.connect.mockRejectedValue(new Error("connect failed"));

    await expect(
      connectToNats({
        source: { url: "nats://127.0.0.1:4222" },
        senderIdentity: "off",
      }),
    ).rejects.toThrow("connect failed");
    expect(wipe).toHaveBeenCalledOnce();
  });

  it("forces the connection closed when graceful drain fails", async () => {
    const nc = {
      drain: vi.fn().mockRejectedValue(new Error("drain failed")),
      close: vi.fn().mockResolvedValue(undefined),
    };

    await expect(drainConnection(nc as never, 2_000)).resolves.toBeUndefined();
    expect(nc.close).toHaveBeenCalledOnce();
  });

  it("does not hide a failure to close after a drain error", async () => {
    const nc = {
      drain: vi.fn().mockRejectedValue(new Error("drain failed")),
      close: vi.fn().mockRejectedValue(new Error("close failed")),
    };

    await expect(drainConnection(nc as never, 2_000)).rejects.toThrow("close failed");
  });
});

/**
 * A connection whose drain waits for a server that never answers, as
 * nats-core 3.4.0's does while the connection is down: `drain()` never
 * settles, and `close()` resolves and leaves it pending.
 */
function unansweredDrain() {
  let closed = false;
  return {
    drain: vi.fn(() => new Promise<void>(() => undefined)),
    close: vi.fn(async () => {
      closed = true;
    }),
    get closed() {
      return closed;
    },
  };
}

describe("drainConnection: bounded", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a drain that settles in time is not followed by a close", async () => {
    const nc = { drain: vi.fn().mockResolvedValue(undefined), close: vi.fn() };
    await expect(drainConnection(nc as never, 2_000)).resolves.toBeUndefined();
    expect(nc.drain).toHaveBeenCalledOnce();
    expect(nc.close).not.toHaveBeenCalled();
  });

  it("a drain that never settles is force-closed at the bound", async () => {
    vi.useFakeTimers();
    const nc = unansweredDrain();
    let done = false;
    const draining = drainConnection(nc as never, 2_000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(nc.close).not.toHaveBeenCalled();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(nc.close).toHaveBeenCalledOnce();
    await draining;
    expect(done).toBe(true);
    expect(nc.closed).toBe(true);
    expect(nc.drain).toHaveBeenCalledOnce();
  });

  it("a drain that rejects after the bound is observed, never unhandled", async () => {
    vi.useFakeTimers();
    let rejectDrain!: (error: Error) => void;
    const nc = {
      drain: vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectDrain = reject;
          }),
      ),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const draining = drainConnection(nc as never, 100);
    await vi.advanceTimersByTimeAsync(100);
    await draining;
    expect(nc.close).toHaveBeenCalledOnce();
    vi.useRealTimers();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      rejectDrain(new Error("closed while draining"));
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off("unhandledRejection", unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
  });
});
