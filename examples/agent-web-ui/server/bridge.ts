// One Bridge per WebSocket. Owns per-connection state: which agents were last
// discovered, which streams are currently open, and pending in-stream queries.
//
// The underlying `Client` is shared across all Bridges — it holds the single
// NATS connection and heartbeat subscription for the whole server process.

import type { ServerWebSocket } from "bun";
import {
  decodeBase64,
  AttachmentsNotSupportedError,
  PayloadTooLargeError,
  ServiceError,
  StreamStalledError,
  type Client,
  type DiscoveredAgent,
  type QueryEvent,
  type RequestAttachment,
} from "@synadia/agents";
import type {
  ClientMessage,
  DiscoveredAgentDTO,
  ServerMessage,
} from "./wire.ts";

type ActiveStream = { controller: AbortController };

export type BridgeWsData = { bridge: Bridge };

export class Bridge {
  private ws: ServerWebSocket<BridgeWsData> | null = null;
  private agentsByInstanceId = new Map<string, DiscoveredAgent>();
  private activeStreams = new Map<string, ActiveStream>();
  private activeQueries = new Map<string, QueryEvent>();
  private heartbeatSubs = new Map<string, () => void>();
  private closed = false;

  constructor(
    private readonly client: Client,
    private readonly sdkProtocolVersion: string,
  ) {}

  open(ws: ServerWebSocket<BridgeWsData>): void {
    this.ws = ws;
    this.send({
      kind: "ready",
      sdkProtocolVersion: this.sdkProtocolVersion,
    });
  }

  onMessage(raw: string): void {
    if (this.closed) return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch (e) {
      this.sendError(null, "bad_json", `could not parse message: ${(e as Error).message}`);
      return;
    }

    switch (msg.kind) {
      case "discover":
        void this.handleDiscover(msg.timeoutMs);
        break;
      case "prompt":
        void this.handlePrompt(msg);
        break;
      case "cancel":
        this.handleCancel(msg.id);
        break;
      case "query-reply":
        void this.handleQueryReply(msg.id, msg.queryId, msg.answer);
        break;
      default: {
        const anyMsg = msg as { kind?: string };
        this.sendError(null, "unknown_kind", `unknown message kind: ${anyMsg.kind ?? "(none)"}`);
      }
    }
  }

  close(): void {
    this.closed = true;
    for (const stream of this.activeStreams.values()) {
      stream.controller.abort();
    }
    this.activeStreams.clear();
    this.activeQueries.clear();
    for (const unsub of this.heartbeatSubs.values()) unsub();
    this.heartbeatSubs.clear();
    this.ws = null;
  }

  // ─── Handlers ──────────────────────────────────────────────────────────────

  private async handleDiscover(timeoutMs?: number): Promise<void> {
    try {
      const discovered = await this.client.discover({ timeoutMs: timeoutMs ?? 2000 });
      this.agentsByInstanceId.clear();
      const dto: DiscoveredAgentDTO[] = [];
      const seenIds = new Set<string>();
      for (const a of discovered) {
        this.agentsByInstanceId.set(a.instanceId, a);
        seenIds.add(a.instanceId);
        dto.push(toDTO(a));
      }
      this.send({ kind: "agents", agents: dto });

      // Heartbeat tracking: subscribe for newly-seen instances, drop vanished ones.
      for (const id of seenIds) {
        if (this.heartbeatSubs.has(id)) continue;
        const unsub = this.client.onHeartbeat(id, (hb) => {
          this.send({
            kind: "heartbeat",
            instanceId: id,
            ts: hb.ts,
            intervalS: hb.intervalS,
          });
        });
        this.heartbeatSubs.set(id, unsub);
      }
      for (const [id, unsub] of this.heartbeatSubs) {
        if (seenIds.has(id)) continue;
        unsub();
        this.heartbeatSubs.delete(id);
      }
    } catch (err) {
      this.sendError(null, "discover_failed", (err as Error).message);
    }
  }

  private async handlePrompt(
    msg: Extract<ClientMessage, { kind: "prompt" }>,
  ): Promise<void> {
    const agent = this.agentsByInstanceId.get(msg.instanceId);
    if (!agent) {
      this.sendError(
        msg.id,
        "agent_not_found",
        `no agent with instance id ${msg.instanceId} in last discovery result — click Refresh`,
      );
      this.send({ kind: "done", id: msg.id });
      return;
    }

    const controller = new AbortController();
    this.activeStreams.set(msg.id, { controller });

    const remote = this.client.bind(agent);

    const attachments: RequestAttachment[] | undefined = msg.attachments?.map((a) => ({
      filename: a.filename,
      content: decodeBase64(a.base64),
    }));

    try {
      const stream = await remote.prompt(msg.text, {
        attachments,
        signal: controller.signal,
      });

      for await (const ev of stream) {
        if (this.closed) break;
        switch (ev.type) {
          case "response":
            this.send({
              kind: "response",
              id: msg.id,
              text: ev.text,
              attachments: ev.attachments?.map((a) => ({
                filename: a.filename,
                base64: a.content,
              })),
            });
            break;
          case "status":
            this.send({ kind: "status", id: msg.id, status: ev.status });
            break;
          case "query": {
            const key = queryKey(msg.id, ev.id);
            this.activeQueries.set(key, ev);
            this.send({
              kind: "query",
              id: msg.id,
              queryId: ev.id,
              prompt: ev.prompt,
              attachments: ev.attachments?.map((a) => ({
                filename: a.filename,
                base64: a.content,
              })),
            });
            break;
          }
        }
      }

      this.send({ kind: "done", id: msg.id });
    } catch (err) {
      this.mapAndSendError(msg.id, err);
      this.send({ kind: "done", id: msg.id });
    } finally {
      this.activeStreams.delete(msg.id);
      // Purge any lingering queries keyed to this prompt.
      for (const key of [...this.activeQueries.keys()]) {
        if (key.startsWith(`${msg.id}:`)) this.activeQueries.delete(key);
      }
    }
  }

  private handleCancel(id: string): void {
    const stream = this.activeStreams.get(id);
    if (!stream) return;
    stream.controller.abort();
  }

  private async handleQueryReply(
    id: string,
    queryId: string,
    answer: string,
  ): Promise<void> {
    const key = queryKey(id, queryId);
    const q = this.activeQueries.get(key);
    if (!q) {
      this.sendError(id, "query_not_found", `query ${queryId} is not awaiting a reply`);
      return;
    }
    try {
      await q.reply(answer);
      this.activeQueries.delete(key);
    } catch (err) {
      this.sendError(id, "query_reply_failed", (err as Error).message);
    }
  }

  // ─── Error mapping ─────────────────────────────────────────────────────────

  private mapAndSendError(id: string, err: unknown): void {
    if (err instanceof AttachmentsNotSupportedError) {
      this.sendError(id, "attachments_not_supported", err.message);
      return;
    }
    if (err instanceof PayloadTooLargeError) {
      this.sendError(id, "payload_too_large", err.message, {
        limit: err.limit,
        actual: err.actual,
      });
      return;
    }
    if (err instanceof ServiceError) {
      this.sendError(id, err.code, err.description, err.body as Record<string, unknown> | undefined);
      return;
    }
    if (err instanceof StreamStalledError) {
      this.sendError(id, "stream_stalled", err.message, { timeoutMs: err.timeoutMs });
      return;
    }
    // AbortError from user-initiated cancel — surface as a neutral "stopped" status
    // rather than an error, so the UI can show it non-destructively.
    if ((err as { name?: string }).name === "AbortError") {
      this.send({ kind: "status", id, status: "stopped" });
      return;
    }
    const e = err as Error;
    this.sendError(id, "internal", e.message || "internal error", {
      name: e.name,
    });
  }

  // ─── Wire I/O ──────────────────────────────────────────────────────────────

  private send(msg: ServerMessage): void {
    if (!this.ws || this.closed) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (e) {
      console.warn("[bridge] ws.send failed:", (e as Error).message);
    }
  }

  private sendError(
    id: string | null,
    code: string | number,
    message: string,
    details?: Record<string, unknown>,
  ): void {
    const payload: ServerMessage = { kind: "error", id, code, message };
    if (details) payload.details = details;
    this.send(payload);
  }
}

function queryKey(promptId: string, queryId: string): string {
  return `${promptId}:${queryId}`;
}

function toDTO(a: DiscoveredAgent): DiscoveredAgentDTO {
  const ep = a.promptEndpoint;
  const dto: DiscoveredAgentDTO = {
    instanceId: a.instanceId,
    agent: a.agent,
    owner: a.owner,
    name: a.name,
    protocolVersion: a.protocolVersion,
    description: a.description,
    version: a.version,
    metadata: { ...a.metadata },
    promptEndpoint: {
      subject: ep.subject,
      metadata: { ...ep.metadata },
    },
  };
  if (a.session !== undefined) dto.session = a.session;
  if (ep.maxPayloadBytes !== undefined) dto.promptEndpoint.maxPayloadBytes = ep.maxPayloadBytes;
  if (ep.attachmentsOk !== undefined) dto.promptEndpoint.attachmentsOk = ep.attachmentsOk;
  return dto;
}

/** Format the SDK's ProtocolVersion object as a "major.minor" string for the UI. */
export function formatSdkProtocolVersion(v: {
  readonly major: number;
  readonly minor: number;
}): string {
  return `${v.major}.${v.minor}`;
}
