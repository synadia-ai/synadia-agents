import { describe, expect, it } from "vitest";
import type { NatsConnection } from "@nats-io/nats-core";
import { AgentService } from "../../src/service.js";

/**
 * The service hands its trace options to every client used inside a
 * handler, where edge publishing is fail-open. A subject that can never be
 * published to fails at construction, not as a warning on every prompt.
 */
describe("AgentService checks trace options at construction", () => {
  const base = {
    nc: {} as unknown as NatsConnection,
    agent: "a",
    owner: "o",
    name: "n",
  };

  it.each([
    ["an empty subject", ""],
    ["a wildcard", "TRACE.>"],
    ["whitespace", "TRACE edges"],
  ])("rejects %s", (_label, edgeSubject) => {
    expect(() => new AgentService({ ...base, trace: { edgeSubject } })).toThrow(/edgeSubject/);
  });

  it("accepts the defaults and propagate-only mode", () => {
    expect(() => new AgentService({ ...base, trace: {} })).not.toThrow();
    expect(() => new AgentService({ ...base, trace: { edgeSubject: null } })).not.toThrow();
  });
});
