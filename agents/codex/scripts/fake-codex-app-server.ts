#!/usr/bin/env bun
const decoder = new TextDecoder();
let buffer = "";
let nextThread = 1;
let nextTurn = 1;
const encoder = new TextEncoder();

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
    send({ id: message.id, result: { thread: { id, sessionId: id, forkedFromId: null, preview: "", ephemeral: true, modelProvider: "fake", createdAt: Date.now(), updatedAt: Date.now(), status: { type: "idle" }, path: null, cwd: message.params?.cwd ?? process.cwd(), cliVersion: "fake", source: "vscode", threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: [] }, model: "fake", modelProvider: "fake", serviceTier: null, cwd: message.params?.cwd ?? process.cwd(), instructionSources: [], approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: false }, reasoningEffort: null } });
    notify("thread/started", { thread: { id, status: { type: "idle" } } });
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
