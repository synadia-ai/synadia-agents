import { describe, expect, test } from "bun:test";
import { endpointFingerprint, privateSessionKey } from "../src/identity.js";
import { reconcileThreadInventory, discoverEndpointSessions } from "../src/session-inventory.js";

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

  test("discovers only currently loaded sessions and ignores durable history", async () => {
    const client = {
      initialize: async () => ({ userAgent: "fake", codexHome: "/tmp/fake", platformFamily: "unix", platformOs: "macos" }),
      listLoadedThreads: async () => [{ id: "loaded-current" }],
      listThreads: async () => [
        { id: "loaded-current", ephemeral: false, status: { type: "idle" }, turns: [] },
        { id: "old-history", ephemeral: false, status: { type: "notLoaded" }, turns: [] },
      ],
      readThread: async (_threadId: string) => ({}),
      resumeThread: async (_threadId: string) => ({}),
    };
    const rows = await discoverEndpointSessions({
      client: client as never,
      endpoint,
      manager: { enabled: true, autoExposeCurrentSessions: true, autoExposeFutureSessions: false, watchMode: "event-plus-poll", watchIntervalMs: 7500, staleGraceIntervals: 3, exposeEphemeralLoadedSessions: false },
    });
    expect(rows.find((row) => row.rawThreadId === "loaded-current")?.reason).toBe("eligible");
    expect(rows.find((row) => row.rawThreadId === "old-history")?.reason).toBe("not-loaded");
    expect(rows.filter((row) => row.eligible).map((row) => row.rawThreadId)).toEqual(["loaded-current"]);
  });
});
