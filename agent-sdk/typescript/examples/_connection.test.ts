import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  resolveBundle: vi.fn(),
}));

vi.mock("@nats-io/transport-node", () => ({ connect: mocks.connect }));
vi.mock("@synadia-ai/agents", () => ({
  resolveNatsConnectionBundle: mocks.resolveBundle,
}));

import {
  exampleConnectionSource,
  exampleIdentityMode,
  openExampleNatsConnection,
} from "./_connection";

const ENV_NAMES = [
  "NATS_CONTEXT",
  "NATS_URL",
  "NATS_NKEY_SEED_FILE",
  "NATS_CREDS",
  "NATS_CREDENTIALS",
  "NATS_SENDER_IDENTITY",
] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const name of ENV_NAMES) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  mocks.connect.mockReset();
  mocks.resolveBundle.mockReset();
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

describe("host example connection source", () => {
  it("defaults to localhost with identity off", () => {
    expect(exampleConnectionSource()).toEqual({
      url: "nats://127.0.0.1:4222",
    });
    expect(exampleIdentityMode()).toBe("off");
  });

  it("treats context as a complete highest-precedence source", () => {
    process.env.NATS_CONTEXT = "prod";
    process.env.NATS_URL = "nats://ignored:4222";
    process.env.NATS_CREDS = "/ignored.creds";
    expect(exampleConnectionSource()).toEqual({ context: "prod" });
  });

  it("preserves direct nkey and creds precedence", () => {
    process.env.NATS_URL = "tls://connect.example";
    process.env.NATS_CREDS = "/user.creds";
    process.env.NATS_NKEY_SEED_FILE = "/user.nkey";
    expect(exampleConnectionSource()).toEqual({
      url: "tls://connect.example",
      nkey: "/user.nkey",
    });
    delete process.env.NATS_NKEY_SEED_FILE;
    process.env.NATS_CREDS = "";
    process.env.NATS_CREDENTIALS = "/alias.creds";
    expect(exampleConnectionSource()).toEqual({
      url: "tls://connect.example",
      creds: "/alias.creds",
    });
  });

  it("validates the signed opt-in", () => {
    process.env.NATS_SENDER_IDENTITY = "signed";
    expect(exampleIdentityMode()).toBe("signed");
    process.env.NATS_SENDER_IDENTITY = "maybe";
    expect(() => exampleIdentityMode()).toThrow('NATS_SENDER_IDENTITY must be "off" or "signed"');
  });
});

describe("host example connection lifecycle", () => {
  it("returns only the bundle signer and wipes only after NATS closes", async () => {
    const order: string[] = [];
    const signer = { user: "U", account: "A", sign: vi.fn() };
    mocks.resolveBundle.mockResolvedValue({
      connectionOptions: { servers: "tls://connect.example" },
      signer,
      wipe: () => order.push("wipe"),
    });
    mocks.connect.mockResolvedValue({
      close: () => {
        order.push("close");
        return Promise.resolve();
      },
    });

    const connection = await openExampleNatsConnection({
      identity: "signed",
    });
    expect(connection.signer).toBe(signer);
    expect(mocks.resolveBundle).toHaveBeenCalledWith(
      { url: "nats://127.0.0.1:4222" },
      { identity: "signed" },
    );
    await connection.close();
    expect(order).toEqual(["close", "wipe"]);
  });

  it("wipes immediately when no connection was opened", async () => {
    const wipe = vi.fn();
    mocks.resolveBundle.mockResolvedValue({
      connectionOptions: {},
      wipe,
    });
    mocks.connect.mockRejectedValue(new Error("connect failed"));
    await expect(openExampleNatsConnection()).rejects.toThrow("connect failed");
    expect(wipe).toHaveBeenCalledOnce();
  });

  it("retains the snapshot when close fails and permits a retry", async () => {
    const wipe = vi.fn();
    const close = vi
      .fn()
      .mockRejectedValueOnce(new Error("close failed"))
      .mockResolvedValueOnce(undefined);
    mocks.resolveBundle.mockResolvedValue({ connectionOptions: {}, wipe });
    mocks.connect.mockResolvedValue({ close });
    const connection = await openExampleNatsConnection();

    await expect(connection.close()).rejects.toThrow("close failed");
    expect(wipe).not.toHaveBeenCalled();
    await connection.close();
    expect(wipe).toHaveBeenCalledOnce();
  });
});
