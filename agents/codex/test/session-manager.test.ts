import { describe, expect, test } from "bun:test";
import { EndpointRegistry } from "../src/endpoint-registry.js";
import { allocateAliases } from "../src/session-manager.js";
import type { EligibleSessionRow } from "../src/session-inventory.js";
import { privateSessionKey } from "../src/identity.js";

function row(endpoint: string, rawThreadId: string): EligibleSessionRow {
  return {
    endpoint,
    endpointFingerprint: "fingerprint",
    rawThreadId,
    privateKey: privateSessionKey(endpoint, rawThreadId),
    loaded: true,
    listed: true,
    ephemeral: false,
    turnCount: 1,
    thread: { id: rawThreadId, turns: [{}] },
    eligible: true,
    readOk: true,
    resumeOk: true,
    reason: "eligible",
  };
}

describe("Codex session manager alias policy", () => {
  test("requires explicit endpoint registry and derives safe aliases without raw ids", () => {
    expect(() => new EndpointRegistry([])).toThrow("explicit endpoints");
    const endpoint = "unix:///Users/alice/private/codex.sock";
    const rows = [row(endpoint, "raw-private-thread-a"), row(endpoint, "raw-private-thread-b")];
    const aliases = allocateAliases(rows, new EndpointRegistry([{ id: "known", endpoint }]).list());
    expect(new Set(aliases.values()).size).toBe(2);
    for (const alias of aliases.values()) {
      expect(alias).toMatch(/^session-[a-f0-9]{12}$/);
      expect(alias).not.toContain("raw-private-thread");
      expect(alias).not.toContain("Users");
    }
  });

  test("fails explicit alias collisions loudly", () => {
    const endpoint = "unix:///tmp/known-codex.sock";
    const rows = [row(endpoint, "raw-a"), row(endpoint, "raw-b")];
    const registry = new EndpointRegistry([{ id: "known", endpoint, explicitAliases: { "raw-a": "same", "raw-b": "same" } }]);
    expect(() => allocateAliases(rows, registry.list())).toThrow("explicit manager alias collision");
  });
});
