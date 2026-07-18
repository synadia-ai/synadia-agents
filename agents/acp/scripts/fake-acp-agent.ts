#!/usr/bin/env bun
// Deterministic fake ACP agent for tests and smokes. Speaks raw
// newline-delimited JSON-RPC 2.0 on stdio — deliberately no SDK dependency,
// so it exercises our client against the actual wire shape (the ACP analog
// of agents/codex/scripts/fake-codex-app-server.ts).
//
// Behaviors keyed off the prompt text:
//   - contains "explode"    -> JSON-RPC error (drives handler-500 coverage)
//   - contains "permission" -> server-side session/request_permission
//                              round-trip, then echoes the outcome
//   - otherwise             -> thought chunk (dropped by the bridge), text
//                              chunks, a tool_call status, end_turn
const decoder = new TextDecoder();
let buffer = "";
let nextSession = 1;
let nextServerRequest = 1;
const pendingServerRequests = new Map<string, (message: any) => void>();

process.stdin.on("data", (chunk) => {
  buffer += decoder.decode(chunk);
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      void handle(JSON.parse(line));
    } catch (err) {
      // Malformed input should surface as a visible fixture diagnostic, not
      // an unhandled crash mid-test.
      process.stderr.write(`[fake-acp-agent] dropping malformed line: ${(err as Error).message}\n`);
    }
  }
});

async function handle(message: any): Promise<void> {
  if (!message.method && ("result" in message || "error" in message)) {
    const resolve = pendingServerRequests.get(String(message.id));
    if (resolve) {
      pendingServerRequests.delete(String(message.id));
      resolve(message);
    }
    return;
  }
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? 1,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
        authMethods: [],
      },
    });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: `sess-${nextSession++}` } });
    return;
  }
  if (message.method === "session/prompt") {
    const sessionId = message.params?.sessionId ?? "sess-1";
    const text: string = (message.params?.prompt ?? [])
      .filter((block: any) => block?.type === "text")
      .map((block: any) => block.text)
      .join(" ");

    if (text.includes("explode")) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "fake ACP agent exploded" } });
      return;
    }

    if (text.includes("permission")) {
      const response = await serverRequest("session/request_permission", {
        sessionId,
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
        toolCall: {
          toolCallId: "tc-1",
          title: "touch /tmp/fake-acp",
          kind: "execute",
          status: "pending",
          rawInput: { command: "touch /tmp/fake-acp" },
        },
      });
      const outcome = response?.result?.outcome;
      const label = outcome?.outcome === "selected" ? outcome.optionId : outcome?.outcome ?? "missing";
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `permission:${label}` } });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }

    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "pondering (should be dropped)" } });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fake " } });
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "tc-echo",
      title: "echo fixture tool",
      kind: "execute",
      status: "pending",
    });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `ACP response to ${text}` } });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (message.method === "session/cancel") return; // notification
  if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
  }
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function update(sessionId: string, updateBody: unknown): void {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: updateBody } });
}

async function serverRequest(method: string, params: unknown): Promise<any> {
  const id = `srv-${nextServerRequest++}`;
  const settled = new Promise((resolve) => {
    pendingServerRequests.set(id, resolve);
    setTimeout(() => {
      if (pendingServerRequests.delete(id)) resolve({ result: { outcome: { outcome: "timeout" } } });
    }, 5_000);
  });
  send({ jsonrpc: "2.0", id, method, params });
  return await settled;
}
