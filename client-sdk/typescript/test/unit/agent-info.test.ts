import { describe, expect, it } from "vitest";
import { buildAgentInfo, type RawServiceInfo } from "../../src/discovery/agent-info.js";

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
      protocol_version: "0.3",
    },
    endpoints: [
      {
        name: "prompt",
        subject: "agents.prompt.cc.alice.sess-1",
        queue_group: "agents",
        metadata: { max_payload: "1MB", attachments_ok: "true" },
      },
    ],
    ...overrides,
  };
}

describe("buildAgentInfo", () => {
  it("builds an AgentInfo from a valid ServiceInfo record", () => {
    const a = buildAgentInfo(validInfo());
    expect(a).not.toBeNull();
    expect(a!.instanceId).toBe("VMKS6MHK71PCPWGY38A7N5");
    expect(a!.agent).toBe("claude-code");
    expect(a!.owner).toBe("alice");
    expect(a!.session).toBe("sess-1");
    expect(a!.name).toBe("sess-1"); // 5th token of the v0.3 prompt subject
    expect(a!.protocolVersion).toBe("0.3");
    expect(a!.description).toBe("test agent");
    expect(a!.version).toBe("1.0.0");
    expect(a!.promptEndpoint.name).toBe("prompt");
    expect(a!.promptEndpoint.maxPayloadBytes).toBe(1024 * 1024);
    expect(a!.promptEndpoint.attachmentsOk).toBe(true);
  });

  it("rejects the pre-0.2 service names", () => {
    expect(buildAgentInfo(validInfo({ name: "Synadia Agents" }))).toBeNull();
    expect(buildAgentInfo(validInfo({ name: "SynadiaAgents" }))).toBeNull();
  });

  it("returns null for non-agent service names", () => {
    expect(buildAgentInfo(validInfo({ name: "SomeOtherService" }))).toBeNull();
  });

  it("returns null when required metadata is missing", () => {
    expect(
      buildAgentInfo(validInfo({ metadata: { owner: "alice", protocol_version: "0.3" } })),
    ).toBeNull();
    expect(
      buildAgentInfo(validInfo({ metadata: { agent: "claude-code", protocol_version: "0.3" } })),
    ).toBeNull();
    expect(
      buildAgentInfo(validInfo({ metadata: { agent: "claude-code", owner: "alice" } })),
    ).toBeNull();
  });

  it("returns null when no prompt endpoint is declared", () => {
    expect(
      buildAgentInfo(
        validInfo({
          endpoints: [{ name: "other", subject: "agents.prompt.cc.alice.sess-1.other" }],
        }),
      ),
    ).toBeNull();
  });

  it("session is undefined when metadata.session is absent or empty", () => {
    const a = buildAgentInfo(
      validInfo({
        metadata: { agent: "openclaw", owner: "rene", protocol_version: "0.3" },
        endpoints: [{ name: "prompt", subject: "agents.prompt.oc.rene.default", metadata: {} }],
      }),
    );
    expect(a).not.toBeNull();
    expect(a!.session).toBeUndefined();
  });

  it("preserves unknown metadata keys (§12 forward-compat)", () => {
    const a = buildAgentInfo(
      validInfo({
        metadata: {
          agent: "claude-code",
          owner: "alice",
          protocol_version: "0.3",
          type: "agent",
          custom_field: "xyz",
        },
      }),
    );
    expect(a!.metadata["type"]).toBe("agent");
    expect(a!.metadata["custom_field"]).toBe("xyz");
  });

  it("freezes the returned object and nested collections", () => {
    const a = buildAgentInfo(validInfo())!;
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.metadata)).toBe(true);
    expect(Object.isFrozen(a.endpoints)).toBe(true);
  });
});
