import { describe, expect, it } from "vitest";
import { buildHeartbeatPayload, encodeHeartbeatPayload } from "../../src/heartbeat/payload.js";
import { AgentSubject, decodeHeartbeatPayload, type HeartbeatPayload } from "@synadia-ai/agents";

describe("buildHeartbeatPayload (§8.3)", () => {
  it("populates the required fields from the subject + arguments", () => {
    const subject = AgentSubject.new("claude-code", "alice", "session-1");
    const hb = buildHeartbeatPayload(subject, 30, "INSTANCE-XYZ");
    expect(hb.agent).toBe("claude-code");
    expect(hb.owner).toBe("alice");
    expect(hb.instanceId).toBe("INSTANCE-XYZ");
    expect(hb.intervalS).toBe(30);
    expect(hb.session).toBeUndefined();
    expect(hb.extras).toEqual({});
    expect(hb.ts).toMatch(/Z$/);
  });

  it("carries the optional §5.6 envelope-level session label when provided", () => {
    const subject = AgentSubject.new("hermes", "rene", "gateway");
    const hb = buildHeartbeatPayload(subject, 30, "X", { session: "alice" });
    expect(hb.session).toBe("alice");
  });

  it("carries forward-compat extras when provided", () => {
    const subject = AgentSubject.new("pi", "owner", "name");
    const hb = buildHeartbeatPayload(subject, 30, "X", { extras: { region: "eu-west-1" } });
    expect(hb.extras["region"]).toBe("eu-west-1");
  });

  it("returns a frozen payload (callers can't mutate)", () => {
    const subject = AgentSubject.new("pi", "owner", "name");
    const hb = buildHeartbeatPayload(subject, 30, "X");
    expect(Object.isFrozen(hb)).toBe(true);
    expect(Object.isFrozen(hb.extras)).toBe(true);
  });
});

describe("encodeHeartbeatPayload → decodeHeartbeatPayload round-trip", () => {
  it("preserves the §8.3 known fields with snake_case wire keys", () => {
    const original: HeartbeatPayload = Object.freeze({
      agent: "claude-code",
      owner: "alice",
      instanceId: "ID-1",
      ts: "2026-04-28T10:00:00Z",
      intervalS: 30,
      extras: Object.freeze({}),
    });
    const wire = encodeHeartbeatPayload(original);
    // Wire form uses snake_case per §8.3.
    expect(JSON.parse(new TextDecoder().decode(wire))).toEqual({
      agent: "claude-code",
      owner: "alice",
      instance_id: "ID-1",
      ts: "2026-04-28T10:00:00Z",
      interval_s: 30,
    });
    const decoded = decodeHeartbeatPayload(JSON.parse(new TextDecoder().decode(wire)));
    expect(decoded).toEqual(original);
  });

  it("preserves the optional session field", () => {
    const original: HeartbeatPayload = Object.freeze({
      agent: "hermes",
      owner: "rene",
      session: "alice",
      instanceId: "ID-2",
      ts: "2026-04-28T10:00:00Z",
      intervalS: 30,
      extras: Object.freeze({}),
    });
    const wire = encodeHeartbeatPayload(original);
    const wireObj = JSON.parse(new TextDecoder().decode(wire)) as Record<string, unknown>;
    expect(wireObj["session"]).toBe("alice");
    const decoded = decodeHeartbeatPayload(wireObj);
    expect(decoded?.session).toBe("alice");
  });

  it("preserves forward-compat extras through encode → decode", () => {
    const original: HeartbeatPayload = Object.freeze({
      agent: "pi",
      owner: "owner",
      instanceId: "ID-3",
      ts: "2026-04-28T10:00:00Z",
      intervalS: 30,
      extras: Object.freeze({ region: "eu-west-1", x_trace: "abc" }),
    });
    const wire = encodeHeartbeatPayload(original);
    const wireObj = JSON.parse(new TextDecoder().decode(wire)) as Record<string, unknown>;
    expect(wireObj["region"]).toBe("eu-west-1");
    expect(wireObj["x_trace"]).toBe("abc");
    const decoded = decodeHeartbeatPayload(wireObj);
    expect(decoded?.extras).toEqual({ region: "eu-west-1", x_trace: "abc" });
  });

  it("declares the protocol version and the prompt endpoint, after the extras so none can shadow them", () => {
    const subject = AgentSubject.new("pi", "owner", "name");
    const hb = buildHeartbeatPayload(subject, 30, "X", {
      extras: { endpoints: "forged", protocol_version: "9.9", region: "eu" },
      protocolVersion: "0.3",
      endpoints: {
        prompt: {
          subject: subject.prompt,
          metadata: { min_sender_trust: "signed", max_payload: "1MB" },
        },
      },
    });
    const wire = JSON.parse(new TextDecoder().decode(encodeHeartbeatPayload(hb))) as Record<
      string,
      unknown
    >;
    expect(wire["protocol_version"]).toBe("0.3");
    expect(wire["endpoints"]).toEqual({
      prompt: {
        subject: subject.prompt,
        metadata: { min_sender_trust: "signed", max_payload: "1MB" },
      },
    });
    expect(wire["region"]).toBe("eu");
    const decoded = decodeHeartbeatPayload(wire);
    expect(decoded?.protocolVersion).toBe("0.3");
    expect(decoded?.endpoints?.["prompt"]?.metadata["min_sender_trust"]).toBe("signed");
    expect(decoded?.extras).toEqual({ region: "eu" });
  });

  it("omits the declarations when none are given: a plain 0.3 beat", () => {
    const subject = AgentSubject.new("pi", "owner", "name");
    const wire = JSON.parse(
      new TextDecoder().decode(encodeHeartbeatPayload(buildHeartbeatPayload(subject, 30, "X"))),
    ) as Record<string, unknown>;
    expect(wire).not.toHaveProperty("protocol_version");
    expect(wire).not.toHaveProperty("endpoints");
  });
});
