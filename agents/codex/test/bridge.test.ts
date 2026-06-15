import { describe, expect, test } from "bun:test";
import { FakeCodexBridgeClient, bridgePromptToCodex, type CodexBridgeClient } from "../src/bridge.js";

describe("fake Codex bridge", () => {
  test("emits deterministic status and response events", async () => {
    const client = new FakeCodexBridgeClient();
    const events = [];
    for await (const event of client.prompt({ prompt: "hello", publicSession: "main", permissionPolicy: "reject" })) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "status", text: "fake Codex session main ready" },
      { type: "response", text: "fake Codex response to hello" },
      { type: "done" },
    ]);
  });

  test("surfaces fake upstream failures for handler 500 coverage", async () => {
    const client = new FakeCodexBridgeClient();
    await expect(async () => {
      for await (const _event of client.prompt({ prompt: "explode", publicSession: "main", permissionPolicy: "reject" })) {
        // drain
      }
    }).toThrow("fake Codex bridge exploded");
  });

  test("maps query permission policy to a protocol ask callback", async () => {
    const sent: unknown[] = [];
    const client: CodexBridgeClient = {
      mode: "managed",
      async *prompt(input) {
        const decision = await input.askPermission?.("approve command?");
        yield { type: "response", text: `decision:${decision}` };
      },
    };
    const response = {
      send: async (chunk: unknown) => { sent.push(chunk); },
      ask: async (prompt: string) => {
        sent.push({ ask: prompt });
        return { prompt: "approve", attachments: [] };
      },
    };
    await bridgePromptToCodex({
      envelope: { prompt: "needs permission", attachments: [] },
      response: response as never,
      client,
      mapping: {
        owner: "local",
        session: "main",
        subjectToken: "codex",
        codex: { mode: "managed", codexBin: "codex", permissionPolicy: "query" },
        manager: { enabled: false, autoExposeCurrentSessions: false, autoExposeFutureSessions: false, watchMode: "event-plus-poll", watchIntervalMs: 7500, staleGraceIntervals: 3, exposeEphemeralLoadedSessions: false },
      },
    });
    expect(sent).toContainEqual({ ask: "approve command?" });
    expect(sent).toContain("decision:approve");
  });
});
