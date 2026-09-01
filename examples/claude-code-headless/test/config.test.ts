import { afterEach, describe, expect, test } from "bun:test";

import { loadConfig, parseCliOverrides } from "../src/config.js";

const KEYS = [
  "NATS_CONTEXT",
  "NATS_URL",
  "NATS_SENDER_IDENTITY",
  "NATS_MIN_SENDER_TRUST",
  "SYNADIA_CLAUDE_CODE_HEADLESS_OWNER",
  "SYNADIA_CLAUDE_CODE_HEADLESS_NAME",
] as const;
const original = new Map(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of KEYS) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function cleanEnv(): void {
  for (const key of KEYS) delete process.env[key];
  process.env.NATS_URL = "nats://127.0.0.1:4222";
  process.env.SYNADIA_CLAUDE_CODE_HEADLESS_OWNER = "test-owner";
  process.env.SYNADIA_CLAUDE_CODE_HEADLESS_NAME = "control";
}

describe("claude-code-headless config", () => {
  test("identity defaults off and inbound trust defaults any", () => {
    cleanEnv();
    expect(loadConfig()).toMatchObject({
      connectionSource: { url: "nats://127.0.0.1:4222" },
      connectionLabel: "$NATS_URL",
      senderIdentity: "off",
      minSenderTrust: "any",
    });
  });

  test("identity and inbound trust remain independent", () => {
    cleanEnv();
    process.env.NATS_SENDER_IDENTITY = "signed";
    expect(loadConfig()).toMatchObject({ senderIdentity: "signed", minSenderTrust: "any" });
    process.env.NATS_SENDER_IDENTITY = "off";
    process.env.NATS_MIN_SENDER_TRUST = "signed";
    expect(loadConfig()).toMatchObject({ senderIdentity: "off", minSenderTrust: "signed" });
  });

  test("an explicit CLI URL overrides an environment context", () => {
    cleanEnv();
    process.env.NATS_CONTEXT = "ignored";
    const cli = parseCliOverrides(["--url", "nats://cli.example:4222"]);
    expect(loadConfig(cli)).toMatchObject({
      connectionSource: { url: "nats://cli.example:4222" },
      connectionLabel: "--url",
    });
  });

  test("help is parsed without requiring a value", () => {
    expect(parseCliOverrides(["--help"])).toEqual({ help: true });
    expect(parseCliOverrides(["-h"])).toEqual({ help: true });
  });

  test("invalid modes fail instead of silently downgrading", () => {
    cleanEnv();
    process.env.NATS_SENDER_IDENTITY = "auto";
    expect(() => loadConfig()).toThrow("invalid NATS_SENDER_IDENTITY");
    process.env.NATS_SENDER_IDENTITY = "off";
    process.env.NATS_MIN_SENDER_TRUST = "verified";
    expect(() => loadConfig()).toThrow("invalid NATS_MIN_SENDER_TRUST");
  });
});
