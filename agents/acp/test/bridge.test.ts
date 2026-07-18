import { describe, expect, test } from "bun:test";
import { FakeAcpBridgeClient, bridgePromptToAcp, type AcpBridgeClient } from "../src/bridge.js";
import type { AcpMapping } from "../src/types.js";

const mapping = (permissionPolicy: "reject" | "query" | "allow"): AcpMapping => ({
  owner: "local",
  session: "main",
  subjectToken: "grok",
  acp: {
    mode: "managed",
    preset: "grok",
    agentId: "grok",
    bin: "grok",
    args: ["agent", "stdio"],
    homeEnvVar: "GROK_HOME",
    cwd: "/tmp",
    permissionPolicy,
  },
});

describe("fake ACP bridge", () => {
  test("emits deterministic status and response events", async () => {
    const client = new FakeAcpBridgeClient();
    const events = [];
    for await (const event of client.prompt({ prompt: "hello", publicSession: "main", permissionPolicy: "reject" })) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "status", text: "fake ACP session main ready" },
      { type: "response", text: "fake ACP response to hello" },
      { type: "done" },
    ]);
  });

  test("surfaces fake upstream failures for handler 500 coverage", async () => {
    const client = new FakeAcpBridgeClient();
    await expect(async () => {
      for await (const _event of client.prompt({ prompt: "explode", publicSession: "main", permissionPolicy: "reject" })) {
        // drain
      }
    }).toThrow("fake ACP bridge exploded");
  });

  test("maps query permission policy to a protocol ask callback", async () => {
    const sent: unknown[] = [];
    const client: AcpBridgeClient = {
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
    await bridgePromptToAcp({
      envelope: { prompt: "needs permission", attachments: [] },
      response: response as never,
      client,
      mapping: mapping("query"),
    });
    expect(sent).toContainEqual({ ask: "approve command?" });
    expect(sent).toContain("decision:approve");
  });

  test("reject policy does not wire an ask callback", async () => {
    let sawAsk: unknown = "unset";
    const client: AcpBridgeClient = {
      mode: "managed",
      async *prompt(input) {
        sawAsk = input.askPermission;
        yield { type: "done" };
      },
    };
    await bridgePromptToAcp({
      envelope: { prompt: "hello", attachments: [] },
      response: { send: async () => {} } as never,
      client,
      mapping: mapping("reject"),
    });
    expect(sawAsk).toBeUndefined();
  });
});
