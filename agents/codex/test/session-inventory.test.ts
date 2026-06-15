import { describe, expect, test } from "bun:test";
import { endpointFingerprint, privateSessionKey } from "../src/identity.js";
import { reconcileThreadInventory } from "../src/session-inventory.js";

const endpoint = "unix:///private/codex.sock";

describe("session inventory", () => {
  test("reconciles thread/loaded/list union thread/list with private endpoint+thread key", () => {
    const rows = reconcileThreadInventory({
      endpoint,
      loaded: [
        { id: "thread-a", ephemeral: false, turns: [{ id: "turn-a" }] },
        { id: "thread-b", ephemeral: true, turns: [] },
      ],
      listed: [
        { id: "thread-a", ephemeral: false, turns: [{ id: "turn-a" }, { id: "turn-b" }] },
        { threadId: "thread-c", ephemeral: false, turns: [{ id: "turn-c" }] },
      ],
    });
    expect(rows).toHaveLength(3);
    const a = rows.find((row) => row.rawThreadId === "thread-a")!;
    expect(a.loaded).toBe(true);
    expect(a.listed).toBe(true);
    expect(a.turnCount).toBe(2);
    expect(a.privateKey).toBe(privateSessionKey(endpoint, "thread-a"));
    expect(a.endpointFingerprint).toBe(endpointFingerprint(endpoint));
  });
});
