import { describe, expect, it } from "vitest";
import type { NatsConnection } from "@nats-io/nats-core";
import { Agent, Agents, assertValidTraceOptions, NatsAgentError } from "../../src/index.js";
import { buildAgentInfo } from "../../src/discovery/agent-info.js";

/**
 * Edge publishing is fail-open, so a subject that can never be published
 * to would otherwise surface only as a warning on every prompt. The
 * options are checked wherever they are accepted, so the misconfiguration
 * fails at construction.
 */
describe("assertValidTraceOptions", () => {
  it.each([
    ["omitted", undefined],
    ["empty (all defaults)", {}],
    ["propagate-only", { edgeSubject: null }],
    ["a plain subject", { edgeSubject: "TRACE.edges" }],
    ["a deeper subject", { edgeSubject: "acme.TRACE.edges.v2" }],
  ])("accepts %s", (_label, options) => {
    expect(() => assertValidTraceOptions(options)).not.toThrow();
  });

  it.each([
    ["an empty subject", ""],
    ["an empty token", "TRACE..edges"],
    ["a trailing dot", "TRACE.edges."],
    ["whitespace", "TRACE edges"],
    ["a NUL", "TRACE\0edges"],
    ["a star wildcard", "TRACE.*"],
    ["a full wildcard", "TRACE.>"],
    ["a wildcard inside a token", "TRACE.ed>ges"],
  ])("rejects %s", (_label, edgeSubject) => {
    expect(() => assertValidTraceOptions({ edgeSubject })).toThrow(NatsAgentError);
  });
});

describe("trace options are checked at construction", () => {
  const nc = {} as unknown as NatsConnection;
  const info = buildAgentInfo({
    name: "agents",
    id: "i",
    version: "0.1.0",
    description: "",
    metadata: { agent: "a", owner: "o", session: "s", protocol_version: "0.3" },
    endpoints: [{ name: "prompt", subject: "agents.prompt.a.o.s", queue_group: "agents" }],
  })!;

  it("by Agents", () => {
    expect(() => new Agents({ nc, trace: { edgeSubject: "TRACE.*" } })).toThrow(NatsAgentError);
    expect(() => new Agents({ nc, trace: {} })).not.toThrow();
  });

  it("by Agent", () => {
    expect(() => new Agent(nc, info, 60_000, undefined, undefined, { edgeSubject: "" })).toThrow(
      NatsAgentError,
    );
    expect(() => new Agent(nc, info, 60_000, undefined, undefined, {})).not.toThrow();
  });
});
