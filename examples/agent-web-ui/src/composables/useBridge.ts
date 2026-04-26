// Thin WebSocket client for the Bun server. Module-scoped singleton so every
// component that calls `useBridge()` shares the same connection, stream map,
// and reactive state.

import { bridgeState } from "../stores/bridge.ts";
import { addAgent, removeAgent, setAgents } from "../stores/agents.ts";
import { recordHeartbeat } from "../stores/heartbeats.ts";
import { randomUUID } from "../uuid.ts";
import type {
  CcExecSessionSummary,
  CcExecSpawnDescriptor,
  CcExecSpawnSpec,
  ClientMessage,
  DiscoveredAgentDTO,
  PiExecSessionSummary,
  PiExecSpawnDescriptor,
  PiExecSpawnSpec,
  ServerMessage,
  WireAttachment,
} from "../wire.ts";

export type StreamHandlers = {
  onResponse?: (text: string, attachments?: WireAttachment[]) => void;
  onStatus?: (status: string) => void;
  onQuery?: (queryId: string, prompt: string, attachments?: WireAttachment[]) => void;
  /** Claude Code surfaces tool calls (Bash, Read, Edit, etc.) — agent emitted a tool_use. */
  onToolUse?: (toolUseId: string, toolName: string, input: Record<string, unknown>) => void;
  /** Result of a previously-emitted tool_use, paired by toolUseId. */
  onToolResult?: (toolUseId: string, output: string, isError: boolean) => void;
  /** Per-turn cost notification, fires when each turn completes. */
  onCost?: (turnCostUsd: number, totalCostUsd: number) => void;
  onDone?: () => void;
  onError?: (message: string, code?: string | number, details?: Record<string, unknown>) => void;
};

let ws: WebSocket | null = null;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

const streams = new Map<string, StreamHandlers>();
let pendingDiscover:
  | { resolve: (a: DiscoveredAgentDTO[]) => void; reject: (e: Error) => void }
  | null = null;

type PendingControl = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};
const pendingControl = new Map<string, PendingControl>();

function rejectPendingControls(err: Error): void {
  for (const p of pendingControl.values()) p.reject(err);
  pendingControl.clear();
}

function connect(): void {
  if (ws) return;
  const url = new URL("/ws", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  bridgeState.status = "connecting";
  bridgeState.lastError = null;

  ws = new WebSocket(url.toString());

  ws.addEventListener("open", () => {
    bridgeState.status = "open";
    reconnectAttempt = 0;
  });

  ws.addEventListener("message", (ev) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(ev.data)) as ServerMessage;
    } catch {
      return;
    }
    handleServerMessage(msg);
  });

  ws.addEventListener("close", () => {
    bridgeState.status = "closed";
    ws = null;

    if (pendingDiscover) {
      pendingDiscover.reject(new Error("connection closed"));
      pendingDiscover = null;
    }
    rejectPendingControls(new Error("connection closed"));
    for (const s of streams.values()) {
      s.onError?.("connection closed");
    }
    streams.clear();

    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    bridgeState.status = "error";
    bridgeState.lastError = "WebSocket error";
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  const delay = Math.min(15_000, 500 * 2 ** Math.min(reconnectAttempt, 6));
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function handleServerMessage(msg: ServerMessage): void {
  switch (msg.kind) {
    case "ready":
      bridgeState.sdkProtocolVersion = msg.sdkProtocolVersion;
      break;
    case "agents":
      setAgents(msg.agents);
      pendingDiscover?.resolve(msg.agents);
      pendingDiscover = null;
      break;
    case "response":
      streams.get(msg.id)?.onResponse?.(msg.text, msg.attachments);
      break;
    case "status":
      streams.get(msg.id)?.onStatus?.(msg.status);
      break;
    case "query":
      streams.get(msg.id)?.onQuery?.(msg.queryId, msg.prompt, msg.attachments);
      break;
    case "tool-use":
      streams.get(msg.id)?.onToolUse?.(msg.toolUseId, msg.toolName, msg.input);
      break;
    case "tool-result":
      streams.get(msg.id)?.onToolResult?.(msg.toolUseId, msg.output, msg.isError);
      break;
    case "cost":
      streams.get(msg.id)?.onCost?.(msg.turnCostUsd, msg.totalCostUsd);
      break;
    case "done":
      streams.get(msg.id)?.onDone?.();
      streams.delete(msg.id);
      break;
    case "heartbeat":
      recordHeartbeat(msg.instanceId);
      break;
    case "agent-added":
      addAgent(msg.agent);
      break;
    case "agent-removed":
      removeAgent(msg.instanceId);
      break;
    case "piexec-spawned": {
      const entry = pendingControl.get(msg.id);
      if (entry) {
        pendingControl.delete(msg.id);
        entry.resolve(msg.descriptor);
      }
      break;
    }
    case "piexec-stopped": {
      const entry = pendingControl.get(msg.id);
      if (entry) {
        pendingControl.delete(msg.id);
        entry.resolve(msg.sessionId);
      }
      break;
    }
    case "piexec-listed": {
      const entry = pendingControl.get(msg.id);
      if (entry) {
        pendingControl.delete(msg.id);
        entry.resolve(msg.sessions);
      }
      break;
    }
    case "ccexec-spawned": {
      const entry = pendingControl.get(msg.id);
      if (entry) {
        pendingControl.delete(msg.id);
        entry.resolve(msg.descriptor);
      }
      break;
    }
    case "ccexec-stopped": {
      const entry = pendingControl.get(msg.id);
      if (entry) {
        pendingControl.delete(msg.id);
        entry.resolve(msg.sessionId);
      }
      break;
    }
    case "ccexec-listed": {
      const entry = pendingControl.get(msg.id);
      if (entry) {
        pendingControl.delete(msg.id);
        entry.resolve(msg.sessions);
      }
      break;
    }
    case "error": {
      if (msg.id && streams.has(msg.id)) {
        streams.get(msg.id)!.onError?.(msg.message, msg.code, msg.details);
      } else if (msg.id && pendingControl.has(msg.id)) {
        const entry = pendingControl.get(msg.id)!;
        pendingControl.delete(msg.id);
        entry.reject(new Error(msg.message));
      } else if (pendingDiscover) {
        pendingDiscover.reject(new Error(msg.message));
        pendingDiscover = null;
      } else {
        bridgeState.lastError = msg.message;
      }
      break;
    }
  }
}

function send(msg: ClientMessage): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

function discover(): Promise<DiscoveredAgentDTO[]> {
  return new Promise((resolve, reject) => {
    if (pendingDiscover) {
      pendingDiscover.reject(new Error("superseded by another discover() call"));
    }
    pendingDiscover = { resolve, reject };
    if (!send({ kind: "discover" })) {
      pendingDiscover = null;
      reject(new Error("WebSocket not open"));
    }
  });
}

function prompt(
  instanceId: string,
  text: string,
  attachments: WireAttachment[] | undefined,
  handlers: StreamHandlers,
): string {
  const id = randomUUID();
  streams.set(id, handlers);
  const payload: ClientMessage = { kind: "prompt", id, instanceId, text };
  if (attachments && attachments.length > 0) payload.attachments = attachments;
  if (!send(payload)) {
    streams.delete(id);
    handlers.onError?.("WebSocket not open");
  }
  return id;
}

function cancel(id: string): void {
  send({ kind: "cancel", id });
}

function queryReply(id: string, queryId: string, answer: string): void {
  send({ kind: "query-reply", id, queryId, answer });
}

function controlRequest<T>(msg: ClientMessage & { id: string }): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    pendingControl.set(msg.id, {
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    if (!send(msg)) {
      pendingControl.delete(msg.id);
      reject(new Error("WebSocket not open"));
    }
  });
}

function piexecSpawn(
  controllerInstanceId: string,
  spec: PiExecSpawnSpec,
): Promise<PiExecSpawnDescriptor> {
  const id = randomUUID();
  return controlRequest<PiExecSpawnDescriptor>({
    kind: "piexec-spawn",
    id,
    controllerInstanceId,
    spec,
  });
}

function piexecStop(controllerInstanceId: string, sessionId: string): Promise<string> {
  const id = randomUUID();
  return controlRequest<string>({
    kind: "piexec-stop",
    id,
    controllerInstanceId,
    sessionId,
  });
}

function piexecList(
  controllerInstanceId: string,
): Promise<PiExecSessionSummary[]> {
  const id = randomUUID();
  return controlRequest<PiExecSessionSummary[]>({
    kind: "piexec-list",
    id,
    controllerInstanceId,
  });
}

function ccexecSpawn(
  controllerInstanceId: string,
  spec: CcExecSpawnSpec,
): Promise<CcExecSpawnDescriptor> {
  const id = randomUUID();
  return controlRequest<CcExecSpawnDescriptor>({
    kind: "ccexec-spawn",
    id,
    controllerInstanceId,
    spec,
  });
}

function ccexecStop(controllerInstanceId: string, sessionId: string): Promise<string> {
  const id = randomUUID();
  return controlRequest<string>({
    kind: "ccexec-stop",
    id,
    controllerInstanceId,
    sessionId,
  });
}

function ccexecList(
  controllerInstanceId: string,
): Promise<CcExecSessionSummary[]> {
  const id = randomUUID();
  return controlRequest<CcExecSessionSummary[]>({
    kind: "ccexec-list",
    id,
    controllerInstanceId,
  });
}

export function useBridge() {
  connect();
  return {
    state: bridgeState,
    discover,
    prompt,
    cancel,
    queryReply,
    piexecSpawn,
    piexecStop,
    piexecList,
    ccexecSpawn,
    ccexecStop,
    ccexecList,
  };
}

/** Encode a File to a wire attachment (RFC 4648 §4 base64). */
export async function fileToAttachment(file: File): Promise<WireAttachment> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Chunked binary-string assembly avoids the argument-length cap on
  // String.fromCharCode(...array) for larger files.
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return { filename: file.name, base64: btoa(binary) };
}
