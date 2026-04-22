// Shared WebSocket message types — the contract between the Bun server (which
// owns the @synadia/agents SDK client) and the browser UI.
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

// ─── Client → Server ─────────────────────────────────────────────────────────

export type ClientMessage =
  | { kind: "discover"; timeoutMs?: number }
  | {
      kind: "prompt";
      id: string;
      instanceId: string;
      text: string;
      attachments?: WireAttachment[];
    }
  | { kind: "cancel"; id: string }
  | { kind: "query-reply"; id: string; queryId: string; answer: string };

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
    };
