import { describe, expect, test } from "bun:test";

import {
  natsConnectionSource,
  parseCliOverrides,
  resolveConfig,
} from "../src/config.ts";

describe("pi-headless config", () => {
  test("identity-free and permissive are independent defaults", () => {
    expect(resolveConfig({ context: "demo" }, {}, {}, "tester")).toMatchObject({
      context: "demo",
      senderIdentity: "off",
      minSenderTrust: "any",
    });
  });

  test("signed self identity does not imply signed-only admission", () => {
    expect(
      resolveConfig(
        { context: "demo", senderIdentity: "signed" },
        {},
        {},
        "tester",
      ),
    ).toMatchObject({ senderIdentity: "signed", minSenderTrust: "any" });
  });

  test("signed-only admission does not require host self identity", () => {
    expect(
      resolveConfig(
        { context: "demo", minSenderTrust: "signed" },
        {},
        {},
        "tester",
      ),
    ).toMatchObject({ senderIdentity: "off", minSenderTrust: "signed" });
  });

  test("standard environment variables override config modes", () => {
    expect(
      resolveConfig(
        { context: "demo", senderIdentity: "off", minSenderTrust: "any" },
        {},
        { NATS_SENDER_IDENTITY: "signed", NATS_MIN_SENDER_TRUST: "signed" },
        "tester",
      ),
    ).toMatchObject({ senderIdentity: "signed", minSenderTrust: "signed" });
  });

  test("invalid identity and trust modes fail before connection", () => {
    expect(() =>
      resolveConfig(
        { context: "demo" },
        {},
        { NATS_SENDER_IDENTITY: "maybe" },
        "tester",
      ),
    ).toThrow(/NATS_SENDER_IDENTITY/);
    expect(() =>
      resolveConfig(
        { context: "demo" },
        {},
        { NATS_MIN_SENDER_TRUST: "verified" },
        "tester",
      ),
    ).toThrow(/NATS_MIN_SENDER_TRUST/);
  });

  test("CLI context wins and is translated without reading credentials", () => {
    const cli = parseCliOverrides([
      "--context",
      "cli",
      "--url",
      "nats://ignored:4222",
    ]);
    const config = resolveConfig(
      { context: "file" },
      cli,
      { NATS_CONTEXT: "env" },
      "tester",
    );
    expect(config.context).toBe("cli");
    expect(natsConnectionSource(config.context, config.natsUrl)).toEqual({
      context: "cli",
    });
  });

  test("help is parsed without requiring a value", () => {
    expect(parseCliOverrides(["--help"])).toEqual({ help: true });
    expect(parseCliOverrides(["-h"])).toEqual({ help: true });
  });
});
