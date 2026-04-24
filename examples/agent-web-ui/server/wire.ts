// Shared WebSocket message types — the contract between the Bun server (which
// owns the @synadia-ai/agents SDK client) and the browser UI.
//
// All messages are JSON text. Binary attachments are carried as base64 strings
// so the wire stays a single JSON stream in both directions.
//
// Keep this file free of runtime imports so it can be re-exported from the
// browser bundle (see `src/wire.ts`).

/** Fields the UI needs from a DiscoveredAgent; serializable subset. */
export type DiscoveredAgentDTO = {
  instanceId: string;
  agent: string;
  owner: string;
  name: string;
  session?: string;
  protocolVersion: string;
  description: string;
  version: string;
  metadata: Record<string, string>;
  promptEndpoint: {
    subject: string;
    maxPayloadBytes?: number;
    attachmentsOk?: boolean;
    metadata: Record<string, string>;
  };
};

/** Inline attachment in either direction, RFC 4648 §4 base64. */
export type WireAttachment = {
  filename: string;
  base64: string;
};

/** Summary of a pi-headless session as returned by the controller's `list` endpoint. */
export type PiExecSessionSummary = {
  session_id: string;
  subject: string;
  heartbeat_subject: string;
  cwd: string;
  model?: string;
  thinking_level?: string;
  max_lifetime_s: number;
  remaining_lifetime_s: number;
  active_request: boolean;
  queued_requests: number;
  created_at: string;
  last_activity: string;
};

/** Spec for spawning a pi-headless session; mirrors the `spawn` wire. */
export type PiExecSpawnSpec = {
  cwd: string;
  session_id?: string;
  model?: string;
  thinking_level?: string;
  max_lifetime_s?: number;
};

/** Descriptor returned by a successful `spawn`. */
export type PiExecSpawnDescriptor = {
  session_id: string;
  subject: string;
  heartbeat_subject: string;
  cwd: string;
  model?: string;
  thinking_level?: string;
  max_lifetime_s: number;
  created_at: string;
  instance_id: string;
};

// ─── Client → Server ─────────────────────────────────────────────────────────

export type ClientMessage =
  | { kind: "discover" }
  | {
      kind: "prompt";
      id: string;
      instanceId: string;
      text: string;
      attachments?: WireAttachment[];
    }
  | { kind: "cancel"; id: string }
  | { kind: "query-reply"; id: string; queryId: string; answer: string }
  | {
      kind: "piexec-spawn";
      id: string;
      controllerInstanceId: string;
      spec: PiExecSpawnSpec;
    }
  | {
      kind: "piexec-stop";
      id: string;
      controllerInstanceId: string;
      sessionId: string;
    }
  | {
      kind: "piexec-list";
      id: string;
      controllerInstanceId: string;
    };

// ─── Server → Client ─────────────────────────────────────────────────────────

export type ServerMessage =
  | {
      kind: "ready";
      sdkProtocolVersion: string;
      natsDescription?: string;
    }
  | { kind: "agents"; agents: DiscoveredAgentDTO[] }
  | {
      kind: "response";
      id: string;
      text: string;
      attachments?: WireAttachment[];
    }
  | { kind: "status"; id: string; status: string }
  | {
      kind: "query";
      id: string;
      queryId: string;
      prompt: string;
      attachments?: WireAttachment[];
    }
  | { kind: "done"; id: string }
  | {
      kind: "heartbeat";
      instanceId: string;
      /** Heartbeat payload timestamp (ISO string, from the agent). */
      ts: string;
      /** Heartbeat interval advertised by the agent. */
      intervalS: number;
    }
  | {
      kind: "error";
      id: string | null;
      code?: string | number;
      name?: string;
      message: string;
      details?: Record<string, unknown>;
    }
  | {
      kind: "piexec-spawned";
      id: string;
      descriptor: PiExecSpawnDescriptor;
    }
  | {
      kind: "piexec-stopped";
      id: string;
      sessionId: string;
    }
  | {
      kind: "piexec-listed";
      id: string;
      controllerInstanceId: string;
      sessions: PiExecSessionSummary[];
    }
  | {
      /** Pushed when an agent appears that wasn't in the last discovery snapshot. */
      kind: "agent-added";
      agent: DiscoveredAgentDTO;
    }
  | {
      /** Pushed when an agent is removed (e.g. stopped via pi-headless). */
      kind: "agent-removed";
      instanceId: string;
    };
