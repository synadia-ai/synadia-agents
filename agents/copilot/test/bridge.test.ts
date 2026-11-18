import { describe, expect, test } from "bun:test";

import { InboundBridge, QueueFullError, BridgeClosedError, type BridgeEvent, type BridgeSession } from "../src/bridge.js";

type Chunk = string | { type: "status"; status: string };

class FakeSession implements BridgeSession {
  handlers = new Set<(e: BridgeEvent) => void>();
  sent: Array<{ prompt: string; id: string }> = [];
  #n = 0;
  refuse = false;

  on(handler: (e: BridgeEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async send(options: { prompt: string }): Promise<string> {
    if (this.refuse) throw new Error("nope");
    const id = `m${++this.#n}`;
    this.sent.push({ prompt: options.prompt, id });
    return id;
  }

  emit(type: string, data: Record<string, unknown> = {}, agentId?: string): void {
    for (const h of this.handlers) h({ type, data, ...(agentId ? { agentId } : {}) });
  }

  /** Play a full turn for the n-th sent prompt. */
  turn(index: number, parts: { deltas?: string[]; message?: string; tools?: string[] } = {}): void {
    const s = this.sent[index]!;
    this.emit("user.message", { content: s.prompt, messageId: s.id });
    this.emit("assistant.turn_start", {});
    for (const [i, tool] of (parts.tools ?? []).entries()) {
      this.emit("tool.execution_start", { toolCallId: `t${i}`, toolName: tool });
      this.emit("tool.execution_complete", { toolCallId: `t${i}`, success: true });
    }
    for (const d of parts.deltas ?? []) this.emit("assistant.message_delta", { deltaContent: d, messageId: "a1" });
    if (parts.message !== undefined) {
      this.emit("assistant.message", { content: parts.message, messageId: parts.deltas ? "a1" : "a2" });
    }
    this.emit("session.idle", {});
  }
}

function recorder() {
  const chunks: Chunk[] = [];
  return { chunks, response: { send: async (c: Chunk) => void chunks.push(c) } };
}

const text = (chunks: Chunk[]) => chunks.filter((c): c is string => typeof c === "string").join("");
const statuses = (chunks: Chunk[]) =>
  chunks.filter((c): c is { type: "status"; status: string } => typeof c !== "string").map((c) => c.status);
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("InboundBridge", () => {
  test("sends the prompt, streams deltas and tool status, ends at idle", async () => {
    const session = new FakeSession();
    const bridge = new InboundBridge(session);
    const r = recorder();
    const done = bridge.serve({ prompt: "hello", response: r.response });
    await tick();
    expect(session.sent.map((s) => s.prompt)).toEqual(["hello"]);
    session.turn(0, { deltas: ["Hi ", "there"], message: "Hi there", tools: ["view"] });
    await done;
    expect(text(r.chunks)).toBe("Hi there");
    expect(statuses(r.chunks)).toEqual(["copilot: turn started", "tool: view", "tool done: view"]);
  });

  test("falls back to the final message when nothing streamed", async () => {
    const session = new FakeSession();
    const bridge = new InboundBridge(session);
    const r = recorder();
    const done = bridge.serve({ prompt: "p", response: r.response });
    await tick();
    session.turn(0, { message: "whole answer" });
    await done;
    expect(text(r.chunks)).toBe("whole answer");
  });

  test("separates distinct assistant messages", async () => {
    const session = new FakeSession();
    const bridge = new InboundBridge(session);
    const r = recorder();
    const done = bridge.serve({ prompt: "p", response: r.response });
    await tick();
    session.emit("user.message", { content: "p", messageId: "m1" });
    session.emit("assistant.message_delta", { deltaContent: "one", messageId: "x" });
    session.emit("assistant.message_delta", { deltaContent: "two", messageId: "y" });
    session.emit("session.idle", {});
    await done;
    expect(text(r.chunks)).toBe("one\n\ntwo");
  });

  test("ignores sub-agent events", async () => {
    const session = new FakeSession();
    const bridge = new InboundBridge(session);
    const r = recorder();
    const done = bridge.serve({ prompt: "p", response: r.response });
    await tick();
    session.emit("user.message", { content: "p", messageId: "m1" });
    session.emit("assistant.message_delta", { deltaContent: "inner", messageId: "s" }, "sub-1");
    session.emit("session.idle", {}, "sub-1");
    session.emit("assistant.message_delta", { deltaContent: "outer", messageId: "o" });
    session.emit("session.idle", {});
    await done;
    expect(text(r.chunks)).toBe("outer");
  });

  test("waits while the human's turn runs, then serves in order", async () => {
    const session = new FakeSession();
    const bridge = new InboundBridge(session);
    session.emit("user.message", { content: "human", messageId: "h" });
    session.emit("assistant.turn_start", {});
    expect(bridge.busy).toBe(true);
    const a = recorder();
    const b = recorder();
    const da = bridge.serve({ prompt: "A", response: a.response });
    const db = bridge.serve({ prompt: "B", response: b.response });
    await tick();
    expect(session.sent).toEqual([]);
    expect(statuses(a.chunks)[0]).toBe("queued: Copilot session is busy (position 1)");
    expect(bridge.queued).toBe(2);
    session.emit("session.idle", {});
    await tick();
    expect(session.sent.map((s) => s.prompt)).toEqual(["A"]);
    expect(bridge.current()).toBeUndefined();
    session.turn(0, { deltas: ["ra"] });
    await da;
    await tick();
    expect(session.sent.map((s) => s.prompt)).toEqual(["A", "B"]);
    session.turn(1, { deltas: ["rb"] });
    await db;
    expect([text(a.chunks), text(b.chunks)]).toEqual(["ra", "rb"]);
  });

  test("current() is the served request only while its turn runs", async () => {
    const session = new FakeSession();
    const bridge = new InboundBridge(session);
    const r = recorder();
    const req = { prompt: "p", response: r.response, context: "ctx" };
    const done = bridge.serve(req);
    await tick();
    expect(bridge.current()).toBeUndefined();
    session.emit("user.message", { content: "p", messageId: "m1" });
    expect(bridge.current()?.context).toBe("ctx");
    session.emit("session.idle", {});
    await done;
    expect(bridge.current()).toBeUndefined();
  });

  test("a human message mid-turn ends the served request", async () => {
    const session = new FakeSession();
    const bridge = new InboundBridge(session);
    const r = recorder();
    const done = bridge.serve({ prompt: "p", response: r.response });
    await tick();
    session.emit("user.message", { content: "p", messageId: "m1" });
    session.emit("assistant.message_delta", { deltaContent: "part", messageId: "a" });
    session.emit("user.message", { content: "human interjects", messageId: "h" });
    session.emit("assistant.message_delta", { deltaContent: "not yours", messageId: "b" });
    await done;
    expect(text(r.chunks)).toBe("part");
    expect(bridge.busy).toBe(true);
  });

  test("autopilot continuations stay in the served turn", async () => {
    const session = new FakeSession();
    const bridge = new InboundBridge(session);
    const r = recorder();
    const done = bridge.serve({ prompt: "p", response: r.response });
    await tick();
    session.emit("user.message", { content: "p", messageId: "m1" });
    session.emit("user.message", { content: "continue", isAutopilotContinuation: true });
    session.emit("assistant.message_delta", { deltaContent: "still mine", messageId: "a" });
    session.emit("session.idle", {});
    await done;
    expect(text(r.chunks)).toBe("still mine");
  });

  test("matches a decorated user message by its leading text", async () => {
    const session = new FakeSession();
    const bridge = new InboundBridge(session);
    const r = recorder();
    const done = bridge.serve({ prompt: "hello", response: r.response });
    await tick();
    session.emit("user.message", { content: "hello\n\n<attachments/>", messageId: "other-id" });
    session.emit("assistant.message", { content: "ok", messageId: "a" });
    session.emit("session.idle", {});
    await done;
    expect(text(r.chunks)).toBe("ok");
  });

  test("rejects past the queue limit", async () => {
    const session = new FakeSession();
    const bridge = new InboundBridge(session, { queueLimit: 1 });
    const r = recorder();
    void bridge.serve({ prompt: "1", response: r.response }).catch(() => undefined);
    void bridge.serve({ prompt: "2", response: r.response }).catch(() => undefined);
    await expect(bridge.serve({ prompt: "3", response: r.response })).rejects.toBeInstanceOf(QueueFullError);
    bridge.close();
  });

  test("fails when the session refuses the prompt", async () => {
    const session = new FakeSession();
    session.refuse = true;
    const bridge = new InboundBridge(session);
    await expect(bridge.serve({ prompt: "p", response: recorder().response })).rejects.toThrow(/refused/);
  });

  test("fails when the prompt is never picked up", async () => {
    const session = new FakeSession();
    const bridge = new InboundBridge(session, { pickupTimeoutMs: 20 });
    await expect(bridge.serve({ prompt: "p", response: recorder().response })).rejects.toThrow(/did not pick up/);
  });

  test("close() fails active and queued prompts", async () => {
    const session = new FakeSession();
    const bridge = new InboundBridge(session);
    const a = bridge.serve({ prompt: "a", response: recorder().response }).catch((e: unknown) => e);
    const b = bridge.serve({ prompt: "b", response: recorder().response }).catch((e: unknown) => e);
    session.emit("session.shutdown", {});
    expect(await a).toBeInstanceOf(BridgeClosedError);
    expect(await b).toBeInstanceOf(BridgeClosedError);
    await expect(bridge.serve({ prompt: "c", response: recorder().response })).rejects.toBeInstanceOf(BridgeClosedError);
  });
});
