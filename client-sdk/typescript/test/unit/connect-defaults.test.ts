import { describe, expect, it } from "vitest";
import {
  AGENT_RECONNECT_DEFAULTS,
  withAgentReconnectDefaults,
} from "../../src/connect-defaults.js";

describe("AGENT_RECONNECT_DEFAULTS", () => {
  it("is frozen", () => {
    expect(Object.isFrozen(AGENT_RECONNECT_DEFAULTS)).toBe(true);
  });

  it("matches the documented values", () => {
    expect(AGENT_RECONNECT_DEFAULTS).toEqual({
      maxReconnectAttempts: -1,
      reconnectTimeWait: 2000,
      reconnectJitter: 200,
      waitOnFirstConnect: true,
    });
  });
});

describe("withAgentReconnectDefaults", () => {
  it("fills in every default on empty input", () => {
    const out = withAgentReconnectDefaults({});
    expect(out.maxReconnectAttempts).toBe(-1);
    expect(out.reconnectTimeWait).toBe(2000);
    expect(out.reconnectJitter).toBe(200);
    expect(out.waitOnFirstConnect).toBe(true);
  });

  it("preserves a caller-set numeric override", () => {
    const out = withAgentReconnectDefaults({ maxReconnectAttempts: 5 });
    expect(out.maxReconnectAttempts).toBe(5);
  });

  it("preserves a caller-set 0 (must not be clobbered by -1)", () => {
    // `0` is the explicit "no reconnect at all" choice — falsy check would
    // overwrite it with -1 and silently change the caller's intent.
    const out = withAgentReconnectDefaults({ maxReconnectAttempts: 0 });
    expect(out.maxReconnectAttempts).toBe(0);
  });

  it("preserves a caller-set false (must not be clobbered by true)", () => {
    const out = withAgentReconnectDefaults({ waitOnFirstConnect: false });
    expect(out.waitOnFirstConnect).toBe(false);
  });

  it("preserves caller-set reconnectTimeWait and reconnectJitter", () => {
    const out = withAgentReconnectDefaults({
      reconnectTimeWait: 500,
      reconnectJitter: 50,
    });
    expect(out.reconnectTimeWait).toBe(500);
    expect(out.reconnectJitter).toBe(50);
  });

  it("returns a fresh object — never mutates the input", () => {
    const input = {};
    const out = withAgentReconnectDefaults(input);
    expect(out).not.toBe(input);
    expect(Object.keys(input)).toEqual([]);
  });

  it("passes unrelated fields through untouched", () => {
    const input = {
      name: "pi-channel",
      servers: ["nats://example:4222"],
      token: "secret",
      inboxPrefix: "_INBOX.agents",
    };
    const out = withAgentReconnectDefaults(input);
    expect(out.name).toBe("pi-channel");
    expect(out.servers).toEqual(["nats://example:4222"]);
    expect(out.token).toBe("secret");
    expect(out.inboxPrefix).toBe("_INBOX.agents");
    // Defaults still applied alongside.
    expect(out.maxReconnectAttempts).toBe(-1);
  });

  it("mixes caller overrides with defaults", () => {
    const out = withAgentReconnectDefaults({
      maxReconnectAttempts: 10, // override
      // reconnectTimeWait left unset → default
      reconnectJitter: 0, // explicit 0 preserved
      // waitOnFirstConnect left unset → default
    });
    expect(out.maxReconnectAttempts).toBe(10);
    expect(out.reconnectTimeWait).toBe(2000);
    expect(out.reconnectJitter).toBe(0);
    expect(out.waitOnFirstConnect).toBe(true);
  });
});
