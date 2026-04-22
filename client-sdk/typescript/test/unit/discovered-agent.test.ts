import { describe, expect, it } from "vitest";
import { buildDiscoveredAgent, type RawServiceInfo } from "../../src/discovery/discovered-agent.js";

function validInfo(overrides: Partial<RawServiceInfo> = {}): RawServiceInfo {
  return {
    name: "agents",
    id: "VMKS6MHK71PCPWGY38A7N5",
    version: "1.0.0",
    description: "test agent",
    metadata: {
      agent: "claude-code",
      owner: "alice",
      session: "sess-1",
      protocol_version: "0.2",
    },
    endpoints: [
      {
        name: "prompt",
        subject: "agents.ccc.alice.sess-1",
        queue_group: "agents",
        metadata: { max_payload: "1MB", attachments_ok: "true" },
      },
    ],
    ...overrides,
  };
}

describe("buildDiscoveredAgent", () => {
  it("builds a DiscoveredAgent from a valid ServiceInfo record", () => {
    const a = buildDiscoveredAgent(validInfo());
    expect(a).not.toBeNull();
    expect(a!.instanceId).toBe("VMKS6MHK71PCPWGY38A7N5");
    expect(a!.agent).toBe("claude-code");
    expect(a!.owner).toBe("alice");
    expect(a!.session).toBe("sess-1");
    expect(a!.name).toBe("sess-1"); // 4th token of the prompt subject
    expect(a!.protocolVersion).toBe("0.2");
    expect(a!.description).toBe("test agent");
    expect(a!.version).toBe("1.0.0");
    expect(a!.promptEndpoint.name).toBe("prompt");
    expect(a!.promptEndpoint.maxPayloadBytes).toBe(1024 * 1024);
    expect(a!.promptEndpoint.attachmentsOk).toBe(true);
  });

  it("rejects the pre-0.2 service names", () => {
    expect(buildDiscoveredAgent(validInfo({ name: "Synadia Agents" }))).toBeNull();
    expect(buildDiscoveredAgent(validInfo({ name: "SynadiaAgents" }))).toBeNull();
  });

  it("returns null for non-agent service names", () => {
    expect(buildDiscoveredAgent(validInfo({ name: "SomeOtherService" }))).toBeNull();
  });

  it("returns null when required metadata is missing", () => {
    expect(
      buildDiscoveredAgent(validInfo({ metadata: { owner: "alice", protocol_version: "0.2" } })),
    ).toBeNull();
    expect(
      buildDiscoveredAgent(
        validInfo({ metadata: { agent: "claude-code", protocol_version: "0.2" } }),
      ),
    ).toBeNull();
    expect(
      buildDiscoveredAgent(validInfo({ metadata: { agent: "claude-code", owner: "alice" } })),
    ).toBeNull();
  });

  it("returns null when no prompt endpoint is declared", () => {
    expect(
      buildDiscoveredAgent(
        validInfo({
          endpoints: [{ name: "other", subject: "agents.ccc.alice.sess-1.other" }],
        }),
      ),
    ).toBeNull();
  });

  it("session is undefined when metadata.session is absent or empty", () => {
    const a = buildDiscoveredAgent(
      validInfo({
        metadata: { agent: "openclaw", owner: "rene", protocol_version: "0.2" },
        endpoints: [{ name: "prompt", subject: "agents.occ.rene.default", metadata: {} }],
      }),
    );
    expect(a).not.toBeNull();
    expect(a!.session).toBeUndefined();
  });

  it("preserves unknown metadata keys (§12 forward-compat)", () => {
    const a = buildDiscoveredAgent(
      validInfo({
        metadata: {
          agent: "claude-code",
          owner: "alice",
          protocol_version: "0.2",
          type: "agent",
          custom_field: "xyz",
        },
      }),
    );
    expect(a!.metadata["type"]).toBe("agent");
    expect(a!.metadata["custom_field"]).toBe("xyz");
  });

  it("freezes the returned object and nested collections", () => {
    const a = buildDiscoveredAgent(validInfo())!;
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.metadata)).toBe(true);
    expect(Object.isFrozen(a.endpoints)).toBe(true);
  });
});
