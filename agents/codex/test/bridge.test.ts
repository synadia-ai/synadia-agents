import { describe, expect, test } from "bun:test";
import { FakeCodexBridgeClient } from "../src/bridge.js";

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
});
