import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChildProcessJsonRpcTransport, JsonLineRpcClient, type JsonRpcNotification, type JsonValue } from "../src/codex-jsonrpc.js";
import { createUnixSocketTransport, createWebSocketTransport, parseCodexEndpoint } from "../src/endpoint.js";
import { responseFor } from "../src/permissions.js";

const decision = (process.argv[2] ?? "deny") as "approve" | "deny";
if (decision !== "approve" && decision !== "deny") throw new Error("usage: bun scripts/live-codex-approval-harness.ts approve|deny");

const endpoint = process.env.CODEX_ENDPOINT ?? "ws://127.0.0.1:8765";
const codexHome = process.env.CODEX_HOME ?? `${process.env.HOME}/.codex`;
const root = join(tmpdir(), `synadia-codex-live-approval-${decision}-${Date.now()}`);
const target = join(root, "delete-me");
mkdirSync(target, { recursive: true });
writeFileSync(join(target, "marker.txt"), "delete me only if approval is granted\n");

let child: ChildProcessWithoutNullStreams | undefined;
const transport = endpoint === "spawn"
  ? (() => {
      child = spawn("codex", ["app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CODEX_HOME: codexHome } });
      return new ChildProcessJsonRpcTransport(child);
    })()
  : await (async () => {
      const parsed = parseCodexEndpoint(endpoint);
      return parsed.kind === "unix" ? createUnixSocketTransport(parsed.socketPath!) : createWebSocketTransport(parsed.websocketUrl!);
    })();

const approvals: Array<{ method: string; response: JsonValue }> = [];
const rpc = new JsonLineRpcClient(transport, {
  serverRequestHandler(input) {
    let response: JsonValue = null;
    if (input.method === "item/commandExecution/requestApproval" || input.method === "item/fileChange/requestApproval" || input.method === "item/permissions/requestApproval") {
      response = responseFor(input.method, decision === "approve" ? "approve" : "deny");
    } else if (input.method === "item/tool/requestUserInput") response = { answer: { type: "cancel" } };
    else if (input.method === "mcpServer/elicitation/request") response = { action: "cancel" };
    approvals.push({ method: input.method, response });
    return response;
  },
});

const notifications: JsonRpcNotification[] = [];
rpc.onNotification((notification) => notifications.push(notification));
rpc.onStderr((chunk) => process.stderr.write(chunk));

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitCompleted(timeoutMs = 180_000): Promise<JsonRpcNotification> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const completed = notifications.find((notification) => notification.method === "turn/completed");
    if (completed) return completed;
    await sleep(250);
  }
  throw new Error("timed out waiting for turn/completed");
}

try {
  await rpc.request("initialize", {
    clientInfo: { name: "synadia-live-approval-harness", version: "0.1.0" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  }, { timeoutMs: 20_000 });
  rpc.notify("initialized");

  const sandboxPolicy = { type: "workspaceWrite", writableRoots: [root], networkAccess: false };
  const threadResult = await rpc.request("thread/start", {
    cwd: root,
    approvalPolicy: "on-request",
    sandboxPolicy,
    ephemeral: true,
    baseInstructions: "You are running a live approval harness. Follow the user's instruction exactly. Do not touch paths outside the harness cwd.",
  }, { timeoutMs: 30_000 });
  const threadId = (threadResult as { thread?: { id?: string } }).thread?.id;
  if (typeof threadId !== "string") throw new Error("thread/start did not return thread.id");

  const prompt = (process.env.HARNESS_PROMPT ?? `Harness test. Run exactly this shell command and nothing else: rm -rf ${JSON.stringify(target)}. This path is a temporary harness directory.`)
    .replaceAll("{target}", target)
    .replaceAll("{root}", root);

  await rpc.request("turn/start", {
    threadId,
    input: [{ type: "text", text: prompt, text_elements: [] }],
    approvalPolicy: "on-request",
    sandboxPolicy,
  }, { timeoutMs: 30_000 });
  await waitCompleted();

  const targetExistsAfter = existsSync(target);
  const result = {
    decision,
    endpoint,
    root,
    target,
    targetExistsAfter,
    approvalMethods: approvals.map((approval) => approval.method),
    approvalResponses: approvals.map((approval) => approval.response),
    notificationMethods: [...new Set(notifications.map((notification) => notification.method))],
  };
  console.log(JSON.stringify(result, null, 2));

  if (decision === "deny" && !targetExistsAfter) throw new Error("deny failed: target was deleted");
  if (decision === "approve" && targetExistsAfter) throw new Error("approve failed: target still exists");
} finally {
  rpc.close();
  child?.kill("SIGTERM");
  if (process.env.KEEP_HARNESS_ROOT !== "1") rmSync(root, { recursive: true, force: true });
}
