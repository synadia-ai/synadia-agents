#!/usr/bin/env bun
const decoder = new TextDecoder();
let buffer = "";
let nextThread = 1;
let nextTurn = 1;
const threads = new Map<string, any>();

process.stdin.on("data", (chunk) => {
  buffer += decoder.decode(chunk);
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    void handle(JSON.parse(line));
  }
});

async function handle(message: any): Promise<void> {
  if (!message.method && ("result" in message || "error" in message)) return;
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex-app-server/0.1", codexHome: process.env.CODEX_HOME ?? "/tmp/fake-codex", platformFamily: "unix", platformOs: "macos" } });
    notify("remoteControl/status/changed", { status: "disabled", serverName: "fake", installationId: "fake-installation", environmentId: null });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    const id = `thread-${nextThread++}`;
    const thread = makeThread(id, message.params?.cwd ?? process.cwd(), true);
    threads.set(id, thread);
    send({ id: message.id, result: { thread, model: "fake", modelProvider: "fake", serviceTier: null, cwd: message.params?.cwd ?? process.cwd(), instructionSources: [], approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: false }, reasoningEffort: null } });
    notify("thread/started", { thread: { id, status: { type: "idle" } } });
    return;
  }
  if (message.method === "thread/loaded/list" || message.method === "thread/list") {
    seedDefaultThread();
    send({ id: message.id, result: { threads: [...threads.values()] } });
    return;
  }
  if (message.method === "thread/read") {
    seedDefaultThread();
    const thread = threads.get(message.params?.threadId);
    if (!thread) { send({ id: message.id, error: { code: -32004, message: "thread not found" } }); return; }
    send({ id: message.id, result: { thread } });
    return;
  }
  if (message.method === "thread/resume") {
    seedDefaultThread();
    const thread = threads.get(message.params?.threadId);
    if (!thread) { send({ id: message.id, error: { code: -32004, message: "thread not found" } }); return; }
    send({ id: message.id, result: { thread, approvalPolicy: "never", approvalsReviewer: "user" } });
    return;
  }
  if (message.method === "turn/start") {
    const turnId = `turn-${nextTurn++}`;
    const threadId = message.params.threadId;
    const text = message.params.input?.find((i: any) => i.type === "text")?.text ?? "";
    send({ id: message.id, result: { turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: Date.now(), completedAt: null, durationMs: null } } });
    notify("thread/status/changed", { threadId, status: { type: "active", activeFlags: [] } });
    notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
    if (text.includes("permission")) {
      const approval = await request("item/commandExecution/requestApproval", { threadId, turnId, command: "touch /tmp/should-not-happen", cwd: process.cwd() });
      notify("agent/message/delta", { threadId, turnId, itemId: "agent-1", delta: `permission:${approval?.decision ?? "unknown"}` });
    } else {
      notify("agent/message/delta", { threadId, turnId, itemId: "agent-1", delta: "fake " });
      notify("agent/message/delta", { threadId, turnId, itemId: "agent-1", delta: `Codex response to ${text}` });
    }
    notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: "agent-1", text: "", phase: null, memoryCitation: null }, completedAtMs: Date.now() });
    notify("turn/completed", { threadId, turnId, turn: { id: turnId, status: "completed" } });
    notify("thread/status/changed", { threadId, status: { type: "idle" } });
    return;
  }
  send({ id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
}

function seedDefaultThread(): void {
  if (!threads.has("thread-attached")) threads.set("thread-attached", makeThread("thread-attached", process.cwd(), false));
}

function makeThread(id: string, cwd: string, ephemeral: boolean): any {
  return { id, sessionId: id, forkedFromId: null, preview: "", ephemeral, modelProvider: "fake", createdAt: Date.now(), updatedAt: Date.now(), status: { type: "idle" }, path: null, cwd, cliVersion: "fake", source: "vscode", threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: [] };
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
function notify(method: string, params: unknown): void {
  send({ method, params });
}
async function request(method: string, params: unknown): Promise<any> {
  const id = `server-${Math.random().toString(36).slice(2)}`;
  send({ jsonrpc: "2.0", id, method, params });
  return await new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const line of text.split(/\n/)) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            process.stdin.off("data", onData);
            resolve(msg.result);
          }
        } catch {}
      }
    };
    process.stdin.on("data", onData);
    setTimeout(() => {
      process.stdin.off("data", onData);
      resolve({ decision: "timeout" });
    }, 2000);
  });
}
