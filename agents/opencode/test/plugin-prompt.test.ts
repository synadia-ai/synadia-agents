import { describe, expect, test } from "bun:test";
import { PluginOpenCodeBridgeClient } from "../src/plugin/index.js";
import type { PluginChannelState, OpenCodePluginContext } from "../src/plugin/types.js";
import type { OpenCodeChannelConfig } from "../src/types.js";

function config(permissionPolicy: "query" | "local" | "reject" = "query"): OpenCodeChannelConfig {
  return {
    nats: { url: "nats://127.0.0.1:4222" },
    agent: { owner: "team", name: "frontend", subjectToken: "opencode", heartbeatIntervalS: 30, keepaliveIntervalS: 30 },
    opencode: { mode: "plugin", hostname: "127.0.0.1", port: 4096, directory: "/tmp/project", permissionPolicy, permissionTimeoutMs: 1000 },
  };
}

function state(policy: "query" | "local" | "reject" = "query"): PluginChannelState {
  const cfg = config(policy);
  return {
    key: "key",
    config: cfg,
    identity: {
      owner: cfg.agent.owner,
      session: cfg.agent.name,
      source: "explicit",
      directoryHash: "abc",
      worktreeHash: "def",
      projectIdHash: "ghi",
      serverOrigin: "",
      metadata: { opencode_mode: "plugin" },
    },
    eventTypes: new Map(),
    activePrompts: new Map(),
    duplicateInitCount: 0,
    disposeCount: 0,
    permissionBridgeCount: 0,
    promptCount: 0,
  };
}

describe("plugin prompt bridge", () => {
  test("routes prompt through plugin client session.prompt and yields text", async () => {
    const calls: unknown[] = [];
    const ctx: OpenCodePluginContext = {
      client: {
        session: {
          prompt: async (input) => {
            calls.push(input);
            return { data: { parts: [{ type: "text", text: "hello from opencode" }] } };
          },
        },
      },
    };
    const bridge = new PluginOpenCodeBridgeClient(ctx, state());
    const events = [];
    for await (const event of bridge.prompt({ prompt: "hi", sessionId: "ses_1", directory: "/tmp/project" })) events.push(event);
    expect(calls).toHaveLength(1);
    expect(events.some((event) => event.type === "status" && event.text.includes("plugin bridge selected"))).toBe(true);
    expect(events).toContainEqual({ type: "response", text: "hello from opencode" });
  });

  test("bridges permission events into protocol permission prompts and replies through plugin API", async () => {
    const replies: unknown[] = [];
    const ctx: OpenCodePluginContext = {
      client: {
        permission: { reply: async (input) => { replies.push(input); return {}; } },
      },
      directory: "/tmp/project",
    };
    const st = state("query");
    const bridge = new PluginOpenCodeBridgeClient(ctx, st);
    const iterator = bridge.prompt({ prompt: "needs permission", sessionId: "ses_1" })[Symbol.asyncIterator]();
    expect((await iterator.next()).value.type).toBe("status");
    await bridge.handleEvent({ type: "permission.asked", properties: { id: "per_1", sessionID: "ses_1", permission: "bash" } });
    let permission = (await iterator.next()).value;
    while (permission.type === "status") permission = (await iterator.next()).value;
    expect(permission.type).toBe("permission");
    expect(permission.question).toContain("OpenCode requests permission for bash");
    await permission.decide?.("always");
    expect(replies).toEqual([{ requestID: "per_1", reply: "always", directory: "/tmp/project" }]);
    expect(st.permissionBridgeCount).toBe(1);
    await iterator.return?.();
  });
});
