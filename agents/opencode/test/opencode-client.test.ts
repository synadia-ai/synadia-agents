import { describe, expect, test } from "bun:test";
import { createOpenCodeClient, managedServerPermissionConfig } from "../src/opencode-client.js";
import type { OpenCodeChannelConfig } from "../src/config.js";
import type { OpenCodeBridgeEvent } from "../src/bridge.js";

function cfg(mode: "managed" | "attached", overrides: Partial<OpenCodeChannelConfig["opencode"]> = {}): OpenCodeChannelConfig {
  return {
    nats: {},
    agent: { owner: "alice", name: "project-main", subjectToken: "opencode", heartbeatIntervalS: 30, keepaliveIntervalS: 30 },
    opencode: {
      mode,
      ...(mode === "attached" ? { baseUrl: "http://127.0.0.1:4096" } : {}),
      hostname: "127.0.0.1",
      port: 4096,
      permissionPolicy: "query",
      permissionTimeoutMs: 300000,
      ...overrides,
    },
  };
}

function fakeSdkClient(overrides: Record<string, unknown> = {}) {
  return {
    event: { subscribe: async () => ({ stream: (async function* () { /* empty */ })() }) },
    session: {
      create: async () => ({ data: { id: "ses_test" } }),
      prompt: async () => ({ data: { parts: [{ type: "text", text: "ok" }] } }),
    },
    postSessionIdPermissionsPermissionId: async () => ({ data: true }),
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<OpenCodeBridgeEvent>): Promise<OpenCodeBridgeEvent[]> {
  const events: OpenCodeBridgeEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("opencode client factory", () => {
  test("managed permission policies configure OpenCode to ask so adapter policy can answer", () => {
    expect(managedServerPermissionConfig("query")?.permission).toEqual({
      bash: "ask",
      edit: "ask",
      external_directory: "ask",
      webfetch: "ask",
    });
    expect(managedServerPermissionConfig("reject")?.permission?.bash).toBe("ask");
    expect(managedServerPermissionConfig("local")).toBeUndefined();
  });

  test("attached mode never starts a managed server", async () => {
    let started = false;
    let attached = false;
    const client = await createOpenCodeClient(cfg("attached"), {
      createSdkClient: () => fakeSdkClient() as never,
      createManagedServer: async () => { started = true; return { url: "http://127.0.0.1:4097", close() {} }; },
      attachToServer: async () => { attached = true; },
    });
    expect(client.mode).toBe("attached");
    expect(started).toBe(false);
    expect(attached).toBe(true);
  });

  test("managed mode starts managed server seam", async () => {
    let started = false;
    const client = await createOpenCodeClient(cfg("managed"), {
      createSdkClient: () => fakeSdkClient() as never,
      createManagedServer: async () => { started = true; return { url: "http://127.0.0.1:4097", close() {} }; },
    });
    expect(client.mode).toBe("managed");
    expect(started).toBe(true);
  });

  test("prompt creates a session and falls back to returned text when no SSE text arrives", async () => {
    const client = await createOpenCodeClient(cfg("attached"), {
      createSdkClient: () => fakeSdkClient() as never,
    });
    const events = await collect(client.prompt({ prompt: "hello" }));
    expect(events).toContainEqual({ type: "response", text: "ok" });
  });

  test("concurrent prompts share one lazily-created OpenCode session", async () => {
    let createCalls = 0;
    const promptCalls: Record<string, unknown>[] = [];
    let releaseCreate: (() => void) | undefined;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const client = await createOpenCodeClient(cfg("attached"), {
      createSdkClient: () => fakeSdkClient({
        session: {
          create: async () => {
            createCalls += 1;
            await createGate;
            return { data: { id: "ses_shared" } };
          },
          prompt: async (options: Record<string, unknown>) => {
            promptCalls.push(options);
            return { data: { parts: [{ type: "text", text: "ok" }] } };
          },
        },
      }) as never,
    });

    const first = collect(client.prompt({ prompt: "one" }));
    const second = collect(client.prompt({ prompt: "two" }));
    await Bun.sleep(1);
    expect(createCalls).toBe(1);
    releaseCreate?.();
    await Promise.all([first, second]);
    expect(createCalls).toBe(1);
    expect(promptCalls).toHaveLength(2);
    expect(promptCalls.every((call) => JSON.stringify(call).includes("ses_shared"))).toBe(true);
  });

  test("serializes concurrent prompts for the same managed/attached OpenCode session", async () => {
    const promptCalls: Record<string, unknown>[] = [];
    let releaseFirstPrompt!: () => void;
    const firstPromptGate = new Promise<void>((resolve) => { releaseFirstPrompt = resolve; });
    const client = await createOpenCodeClient(cfg("attached", { sessionId: "ses_existing" }), {
      createSdkClient: () => fakeSdkClient({
        session: {
          create: async () => { throw new Error("existing session should not create a new session"); },
          prompt: async (options: Record<string, unknown>) => {
            promptCalls.push(options);
            if (promptCalls.length === 1) await firstPromptGate;
            return { data: { parts: [{ type: "text", text: `ok-${promptCalls.length}` }] } };
          },
        },
      }) as never,
    });

    const first = collect(client.prompt({ prompt: "one" }));
    const second = collect(client.prompt({ prompt: "two" }));
    await waitFor(() => promptCalls.length === 1);
    await Bun.sleep(20);
    expect(promptCalls).toHaveLength(1);
    releaseFirstPrompt();
    await Promise.all([first, second]);
    expect(promptCalls).toHaveLength(2);
    expect(promptCalls.map((call) => (call as { path?: { id?: string } }).path?.id)).toEqual(["ses_existing", "ses_existing"]);
  });

  test("prompt propagates OpenCode prompt errors instead of ending silently", async () => {
    const client = await createOpenCodeClient(cfg("attached", { sessionId: "ses_existing" }), {
      createSdkClient: () => fakeSdkClient({
        session: {
          create: async () => { throw new Error("existing session should not create a new session"); },
          prompt: async () => ({ error: { message: "provider exploded" } }),
        },
      }) as never,
    });
    await expect(collect(client.prompt({ prompt: "hello" }))).rejects.toThrow("provider exploded");
  });

  test("prompt forwards configured model and agent, and streams SSE deltas instead of fallback text", async () => {
    const promptCalls: Record<string, unknown>[] = [];
    const client = await createOpenCodeClient(cfg("attached", { sessionId: "ses_existing", model: "openrouter/anthropic/claude-3.5-haiku", agent: "build" }), {
      createSdkClient: () => fakeSdkClient({
        event: {
          subscribe: async () => ({
            stream: (async function* () {
              yield { type: "server.connected", properties: {} };
              yield { type: "message.part.delta", data: { sessionID: "ses_existing", text: "streamed" } };
              yield { type: "session.idle", data: { sessionID: "ses_existing" } };
            })(),
          }),
        },
        session: {
          create: async () => { throw new Error("existing session should not create a new session"); },
          prompt: async (options: Record<string, unknown>) => {
            promptCalls.push(options);
            await Bun.sleep(1);
            return { data: { parts: [{ type: "text", text: "fallback" }] } };
          },
        },
      }) as never,
    });
    const events = await collect(client.prompt({ prompt: "hello" }));
    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0]).toEqual({
      path: { id: "ses_existing" },
      body: {
        model: { providerID: "openrouter", modelID: "anthropic/claude-3.5-haiku" },
        agent: "build",
        parts: [{ type: "text", text: "hello" }],
      },
    });
    expect(events).toContainEqual({ type: "response", text: "streamed" });
    expect(events).not.toContainEqual({ type: "response", text: "fallback" });
  });

  test("permission events surface as bridge permission requests and post decisions", async () => {
    const replies: Record<string, unknown>[] = [];
    let releasePrompt: (() => void) | undefined;
    const permissionAnswered = new Promise<void>((resolve) => { releasePrompt = resolve; });
    const client = await createOpenCodeClient(cfg("attached", { sessionId: "ses_existing", permissionPolicy: "query" }), {
      createSdkClient: () => fakeSdkClient({
        event: {
          subscribe: async () => ({
            stream: (async function* () {
              yield { type: "permission.asked", data: { sessionID: "ses_existing", id: "perm_1", type: "bash", title: "run command" } };
              yield { type: "session.idle", data: { sessionID: "ses_existing" } };
            })(),
          }),
        },
        session: {
          create: async () => { throw new Error("existing session should not create a new session"); },
          prompt: async () => {
            await permissionAnswered;
            return { data: {} };
          },
        },
        postSessionIdPermissionsPermissionId: async (options: Record<string, unknown>) => {
          replies.push(options);
          releasePrompt?.();
          return { data: true };
        },
      }) as never,
    });
    const events: OpenCodeBridgeEvent[] = [];
    for await (const event of client.prompt({ prompt: "hello" })) {
      events.push(event);
      if (event.type === "permission") await event.decide("reject");
    }
    expect(events.some((event) => event.type === "permission" && event.question.includes("bash"))).toBe(true);
    expect(replies).toEqual([{ path: { id: "ses_existing", permissionID: "perm_1" }, body: { response: "reject" } }]);
  });

  test("session-scoped prompts ignore cross-session SSE/permission events while preserving unscoped status/text events", async () => {
    const replies: Record<string, unknown>[] = [];
    const client = await createOpenCodeClient(cfg("attached", { sessionId: "ses_a", permissionPolicy: "query" }), {
      createSdkClient: () => fakeSdkClient({
        event: {
          subscribe: async () => ({
            stream: (async function* () {
              yield { type: "permission.asked", data: { sessionID: "ses_b", id: "perm_b", type: "bash" } };
              yield { type: "message.part.delta", data: { text: "unscoped leak" } };
              yield { type: "message.part.delta", data: { sessionID: "ses_b", text: "cross leak" } };
              yield { type: "message.part.delta", data: { sessionID: "ses_a", text: "safe" } };
              yield { type: "session.idle", data: { sessionID: "ses_a" } };
            })(),
          }),
        },
        session: {
          create: async () => { throw new Error("existing session should not create a new session"); },
          prompt: async () => {
            await Bun.sleep(1);
            return { data: { parts: [{ type: "text", text: "fallback" }] } };
          },
        },
        postSessionIdPermissionsPermissionId: async (options: Record<string, unknown>) => {
          replies.push(options);
          return { data: true };
        },
      }) as never,
    });
    const events = await collect(client.prompt({ prompt: "hello" }));
    expect(events).toContainEqual({ type: "response", text: "safe" });
    expect(events).toContainEqual({ type: "response", text: "unscoped leak" });
    expect(events).not.toContainEqual({ type: "response", text: "cross leak" });
    expect(events.some((event) => event.type === "permission")).toBe(false);
    expect(replies).toEqual([]);
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await Bun.sleep(5);
  }
}
