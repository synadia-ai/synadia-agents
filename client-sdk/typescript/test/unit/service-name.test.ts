import { describe, expect, it } from "vitest";
import {
  isAgentServiceName,
  PROMPT_QUEUE_GROUP,
  SERVICE_NAME,
} from "../../src/internal/service-name.js";

describe("service name (spec §3.1)", () => {
  it("is the bare token `agents`", () => {
    expect(SERVICE_NAME).toBe("agents");
  });

  it("accepts the spec value", () => {
    expect(isAgentServiceName(SERVICE_NAME)).toBe(true);
  });

  it("rejects the pre-0.2 names", () => {
    expect(isAgentServiceName("Synadia Agents")).toBe(false);
    expect(isAgentServiceName("SynadiaAgents")).toBe(false);
  });

  it("rejects unrelated names", () => {
    expect(isAgentServiceName("SomeOtherService")).toBe(false);
    expect(isAgentServiceName("Agents")).toBe(false); // case-sensitive
    expect(isAgentServiceName("")).toBe(false);
  });

  it("registration name is subject-safe (no spaces)", () => {
    expect(SERVICE_NAME).not.toMatch(/\s/);
  });
});

describe("prompt endpoint queue group (spec §3.3)", () => {
  it("is the bare token `agents`", () => {
    expect(PROMPT_QUEUE_GROUP).toBe("agents");
  });
});
