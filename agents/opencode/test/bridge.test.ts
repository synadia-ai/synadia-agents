import { describe, expect, test } from "bun:test";
import { bridgePromptToOpenCode } from "../src/bridge.js";
import type { OpenCodeBridgeClient } from "../src/bridge.js";
import type { OpenCodeMapping } from "../src/types.js";

function mapping(): OpenCodeMapping {
  return {
    owner: "alice",
    name: "project-main",
    subjectToken: "opencode",
    opencode: {
      mode: "attached",
      baseUrl: "http://127.0.0.1:4096",
      hostname: "127.0.0.1",
      port: 4096,
      directory: "/tmp/project-main",
      permissionPolicy: "query",
      permissionTimeoutMs: 300000,
    },
  };
}

describe("OpenCode bridge", () => {
  test("empty protocol query permission replies reject instead of default-granting once", async () => {
    const decisions: string[] = [];
    const sent: unknown[] = [];
    const client: OpenCodeBridgeClient = {
      mode: "attached",
      prompt: async function* () {
        yield {
          type: "permission",
          question: "OpenCode requests permission for bash.",
          timeoutMs: 1000,
          decide: async (reply) => { decisions.push(reply ?? ""); },
        };
      },
    };

    await bridgePromptToOpenCode({
      envelope: { prompt: "run ls", attachments: [] } as never,
      response: {
        send: async (chunk: unknown) => { sent.push(chunk); },
        ask: async () => ({ prompt: "" }),
      } as never,
      mapping: mapping(),
      client,
    });

    expect(decisions).toEqual(["reject"]);
    expect(sent).toContainEqual({ type: "status", status: "Rejected by empty protocol query reply" });
  });
});
