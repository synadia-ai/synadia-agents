import { describe, expect, test } from "bun:test";

import { IdentityError } from "@synadia-ai/agents";

import { resolveConnectionBundle } from "../src/nats-context.js";

describe("resolveConnectionBundle", () => {
  test("defaults to identity-free URL connection options", async () => {
    const bundle = await resolveConnectionBundle({
      natsUrl: "nats://127.0.0.1:4222",
    });

    expect(bundle.connectionOptions.servers).toEqual(["nats://127.0.0.1:4222"]);
    expect(bundle.signer).toBeUndefined();
    bundle.wipe();
  });

  test("keeps URL credentials inside the SDK-owned bundle until wipe", async () => {
    const bundle = await resolveConnectionBundle({
      natsUrl: "nats://secret-token@127.0.0.1:4222",
    });

    expect(bundle.connectionOptions.token).toBe("secret-token");
    bundle.wipe();
    expect(bundle.connectionOptions.token).toBeUndefined();
  });

  test("signed mode fails instead of inventing an identity for anonymous auth", async () => {
    await expect(
      resolveConnectionBundle({
        natsUrl: "nats://127.0.0.1:4222",
        senderIdentity: "signed",
      }),
    ).rejects.toBeInstanceOf(IdentityError);
  });
});
