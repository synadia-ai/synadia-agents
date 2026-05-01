import { describe, expect, it, vi } from "vitest";
import type { NatsConnection } from "@nats-io/nats-core";
import { lookupAgentInstance } from "../../src/discovery/srv-ping.js";

/**
 * Reject-before-IO guard: invalid instanceIds must short-circuit to `null`
 * without touching the NATS connection. A crafted heartbeat payload with
 * `.` / `*` / `>` in `instance_id` could otherwise either silently address
 * an unintended subject or be wildcarded by the broker — so we validate
 * the token against §2 MUST rules before assembling `$SRV.INFO.agents.<id>`.
 */
describe("lookupAgentInstance — instanceId validation", () => {
  function makeStubNc(): { nc: NatsConnection; requestSpy: ReturnType<typeof vi.fn> } {
    const requestSpy = vi.fn();
    const nc = { request: requestSpy } as unknown as NatsConnection;
    return { nc, requestSpy };
  }

  const closeSignal = new AbortController().signal;

  it.each([
    ["empty", ""],
    ["leading $", "$sys-id"],
    ["dot", "abc.def"],
    ["wildcard *", "abc*def"],
    ["tail wildcard", "abc>"],
    ["whitespace", "abc def"],
    ["NUL", "abc\0def"],
  ])("returns null without calling nc.request for %s", async (_label, badId) => {
    const { nc, requestSpy } = makeStubNc();
    const result = await lookupAgentInstance(nc, badId, 60_000, closeSignal);
    expect(result).toBeNull();
    expect(requestSpy).not.toHaveBeenCalled();
  });
});
