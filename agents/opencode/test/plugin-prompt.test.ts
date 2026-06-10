import { describe, expect, test } from "bun:test";
import { PluginOpenCodeBridgeClient } from "../src/plugin/index.js";
import type { OpenCodeBridgeEvent } from "../src/bridge.js";
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

  test("creates and reuses a real OpenCode session when OPENCODE_SESSION_ID is not configured", async () => {
    const createCalls: unknown[] = [];
    const promptCalls: unknown[] = [];
    const ctx: OpenCodePluginContext = {
      client: {
        session: {
          create: async (input) => {
            createCalls.push(input);
            return { data: { id: "ses_created" } };
          },
          prompt: async (input) => {
            promptCalls.push(input);
            return { data: { parts: [{ type: "text", text: "hello from created session" }] } };
          },
        },
      },
    };
    const bridge = new PluginOpenCodeBridgeClient(ctx, state());

    const firstEvents = [];
    for await (const event of bridge.prompt({ prompt: "first", directory: "/tmp/project" })) firstEvents.push(event);
    const secondEvents = [];
    for await (const event of bridge.prompt({ prompt: "second", directory: "/tmp/project" })) secondEvents.push(event);

    expect(createCalls).toHaveLength(1);
    expect(promptCalls).toHaveLength(2);
    expect(promptCalls.map((call) => (call as { path?: { id?: string } }).path?.id)).toEqual(["ses_created", "ses_created"]);
    expect(promptCalls.map((call) => (call as { path?: { id?: string } }).path?.id)).not.toContain("default");
    expect(firstEvents).toContainEqual({ type: "response", text: "hello from created session" });
    expect(secondEvents).toContainEqual({ type: "response", text: "hello from created session" });
  });

  test("keeps concurrent no-env prompts on a lazily-created same session permission-safe", async () => {
    const createCalls: unknown[] = [];
    const promptCalls: unknown[] = [];
    let releaseSecondPrompt!: () => void;
    const secondPromptDone = new Promise<void>((resolve) => { releaseSecondPrompt = resolve; });
    const ctx: OpenCodePluginContext = {
      client: {
        session: {
          create: async (input) => {
            createCalls.push(input);
            return { data: { id: "ses_created" } };
          },
          prompt: async (input) => {
            promptCalls.push(input);
            if (promptCalls.length === 1) {
              await delay(10);
              return { data: { parts: [{ type: "text", text: "done-1" }] } };
            }
            await secondPromptDone;
            return { data: { parts: [{ type: "text", text: "done-2" }] } };
          },
        },
        permission: { reply: async () => ({}) },
      },
    };
    const bridge = new PluginOpenCodeBridgeClient(ctx, state("query"));
    const firstEvents: unknown[] = [];
    const secondEvents: unknown[] = [];
    let sawSecondPermission = false;
    const firstDone = collectEvents(bridge.prompt({ prompt: "first", directory: "/tmp/project" }), firstEvents);
    const secondDone = collectEvents(bridge.prompt({ prompt: "second", directory: "/tmp/project" }), secondEvents, async (event) => {
      if (event.type !== "permission") return;
      sawSecondPermission = true;
      await event.decide?.("once");
      releaseSecondPrompt();
    });

    await firstDone;
    await waitFor(() => promptCalls.length === 2);
    await bridge.handleEvent({ type: "permission.asked", properties: { id: "per_2", sessionID: "ses_created", permission: "bash" } });
    const deliveredPermission = await Promise.race([
      waitFor(() => sawSecondPermission, 100).then(() => true, () => false),
      delay(150).then(() => false),
    ]);
    if (!deliveredPermission) releaseSecondPrompt();
    await secondDone;

    expect(deliveredPermission).toBe(true);
    expect(createCalls).toHaveLength(1);
    expect(promptCalls).toHaveLength(2);
    expect(promptCalls.map((call) => (call as { path?: { id?: string } }).path?.id)).toEqual(["ses_created", "ses_created"]);
    expect(promptCalls.map((call) => (call as { path?: { id?: string } }).path?.id)).not.toContain("default");
    expect(firstEvents).toContainEqual({ type: "response", text: "done-1" });
    expect(secondEvents).toContainEqual({ type: "response", text: "done-2" });
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

async function collectEvents(
  iterable: AsyncIterable<OpenCodeBridgeEvent>,
  events: unknown[],
  onEvent?: (event: OpenCodeBridgeEvent) => Promise<void> | void,
): Promise<void> {
  for await (const event of iterable) {
    events.push(event);
    await onEvent?.(event);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await delay(5);
  }
}
