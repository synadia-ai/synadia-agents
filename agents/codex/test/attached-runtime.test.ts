import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { AttachedCodexRuntime } from "../src/attached-runtime.js";
import type { CodexChannelConfig } from "../src/config.js";
import { parseCodexEndpoint, requireAttachedEndpointAuth } from "../src/endpoint.js";

function config(endpoint: string): CodexChannelConfig {
  return {
    nats: { url: "nats://127.0.0.1:4222" },
    agent: { owner: "test", session: "safe-alias", subjectToken: "codex", heartbeatIntervalS: 1, keepaliveIntervalS: 1 },
    codex: { mode: "attached", codexBin: "codex", endpoint, threadId: "private-thread", publicAlias: "safe-alias", permissionPolicy: "external-owner" },
    manager: { enabled: false, autoExposeCurrentSessions: false, autoExposeFutureSessions: false, watchMode: "event-plus-poll", watchIntervalMs: 7500, staleGraceIntervals: 3, exposeEphemeralLoadedSessions: false },
  };
}

describe("attached Codex runtime", () => {
  test("validates explicit endpoint forms and auth policy", () => {
    expect(parseCodexEndpoint("unix:///tmp/codex.sock").kind).toBe("unix");
    expect(parseCodexEndpoint("ws://127.0.0.1:5555").isLoopback).toBe(true);
    expect(() => parseCodexEndpoint("http://127.0.0.1:5555")).toThrow("attached endpoint must be explicit");
    expect(() => requireAttachedEndpointAuth("ws://192.0.2.10:5555", undefined)).toThrow("non-loopback WebSocket attached endpoints require");
    expect(requireAttachedEndpointAuth("ws://192.0.2.10:5555", "token").kind).toBe("websocket");
  });

  test("preflights endpoint + private thread and prompts through safe public alias", async () => {
    const server = await startFakeEndpoint();
    const runtime = new AttachedCodexRuntime({ config: config(`unix://${server.socketPath}`), streamPreflightPrompt: "preflight", turnTimeoutMs: 5000 });
    try {
      const preflight = await runtime.start();
      expect(preflight).toMatchObject({ initialized: true, selectedThreadFound: true, readOk: true, resumeOk: true, streamOk: true, permissionMode: "external-owner" });
      const events = [];
      for await (const event of runtime.prompt({ prompt: "hello", publicSession: "safe-alias", permissionPolicy: "external-owner" })) events.push(event);
      expect(events.filter((event) => event.type === "response").map((event) => event.text).join("")).toContain("attached response to hello");
      expect(events.some((event) => event.type === "status" && event.text.includes("permission_mode=external-owner"))).toBe(true);
    } finally {
      await runtime.close();
      await server.close();
    }
  });
});

async function startFakeEndpoint(): Promise<{ socketPath: string; close(): Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "codex-attached-test-"));
  const socketPath = join(dir, "codex.sock");
  const server = createServer((socket) => serveJsonRpcSocket(socket));
  await new Promise<void>((resolve, reject) => {
    server.listen(socketPath, resolve);
    server.once("error", reject);
  });
  return {
    socketPath,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function serveJsonRpcSocket(socket: Socket): void {
  socket.setEncoding("utf8");
  let buffer = "";
  let nextTurn = 1;
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.method === "initialize") send(socket, { id: message.id, result: { userAgent: "fake-attached/0.1", codexHome: "/tmp/fake", platformFamily: "unix", platformOs: "macos" } });
      else if (message.method === "initialized") {}
      else if (message.method === "thread/loaded/list") send(socket, { id: message.id, result: { data: ["private-thread"] } });
      else if (message.method === "thread/list") send(socket, { id: message.id, result: { data: [thread()] } });
      else if (message.method === "thread/read") send(socket, { id: message.id, result: { thread: thread() } });
      else if (message.method === "thread/resume") send(socket, { id: message.id, result: { thread: thread(), approvalPolicy: "never", approvalsReviewer: "user" } });
      else if (message.method === "turn/start") {
        const turnId = `turn-${nextTurn++}`;
        const text = message.params.input?.find((item: any) => item.type === "text")?.text ?? "";
        send(socket, { id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
        send(socket, { method: "agent/message/delta", params: { threadId: "private-thread", turnId, delta: `attached response to ${text}` } });
        send(socket, { method: "turn/completed", params: { threadId: "private-thread", turnId, turn: { id: turnId, status: "completed" } } });
      } else send(socket, { id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
    }
  });
}

function thread(): Record<string, unknown> {
  return { id: "private-thread", status: { type: "idle" }, turns: [] };
}

function send(socket: Socket, message: unknown): void {
  socket.write(`${JSON.stringify(message)}\n`);
}
