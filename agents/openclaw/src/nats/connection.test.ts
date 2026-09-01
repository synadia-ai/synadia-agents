import { beforeEach, describe, expect, it, vi } from "vitest";

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

    await expect(drainConnection(nc as never)).resolves.toBeUndefined();
    expect(nc.close).toHaveBeenCalledOnce();
  });

  it("does not hide a failure to close after a drain error", async () => {
    const nc = {
      drain: vi.fn().mockRejectedValue(new Error("drain failed")),
      close: vi.fn().mockRejectedValue(new Error("close failed")),
    };

    await expect(drainConnection(nc as never)).rejects.toThrow("close failed");
  });
});
