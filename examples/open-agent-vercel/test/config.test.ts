import { describe, expect, test } from "bun:test";

import { resolveVercelNatsSettings } from "../src/config.ts";

describe("open-agent-vercel NATS settings", () => {
  test("defaults to identity-free and permissive independently", () => {
    expect(resolveVercelNatsSettings([], {})).toEqual({
      senderIdentity: "off",
      minSenderTrust: "any",
    });
  });

  test("signed host identity does not imply strict inbound policy", () => {
    expect(
      resolveVercelNatsSettings([], { NATS_SENDER_IDENTITY: "signed" }),
    ).toMatchObject({
      senderIdentity: "signed",
      minSenderTrust: "any",
    });
  });

  test("strict inbound policy does not enable host identity", () => {
    expect(
      resolveVercelNatsSettings([], { NATS_MIN_SENDER_TRUST: "signed" }),
    ).toMatchObject({
      senderIdentity: "off",
      minSenderTrust: "signed",
    });
  });

  test("flag context wins over env context and URL", () => {
    expect(
      resolveVercelNatsSettings(["--nats-context", "flag"], {
        NATS_CONTEXT: "env",
        NATS_URL: "nats://ignored:4222",
      }),
    ).toMatchObject({ natsContext: "flag" });
  });

  test("environment context wins over URL", () => {
    expect(
      resolveVercelNatsSettings([], {
        NATS_CONTEXT: "env",
        NATS_URL: "nats://ignored:4222",
      }),
    ).toEqual({
      natsContext: "env",
      senderIdentity: "off",
      minSenderTrust: "any",
    });
  });

  test("invalid modes fail before connection", () => {
    expect(() =>
      resolveVercelNatsSettings([], { NATS_SENDER_IDENTITY: "maybe" }),
    ).toThrow(/NATS_SENDER_IDENTITY/);
    expect(() =>
      resolveVercelNatsSettings([], { NATS_MIN_SENDER_TRUST: "verified" }),
    ).toThrow(/NATS_MIN_SENDER_TRUST/);
  });
});
