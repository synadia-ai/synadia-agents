// One Bridge per WebSocket. Owns per-connection state: which agents were last
// discovered, which streams are currently open, and pending in-stream queries.
//
// The underlying `Agents` is shared across all Bridges — it holds the single
// NATS connection and heartbeat subscription for the whole server process.

import type { ServerWebSocket } from "bun";
import {
  Agent,
  Agents,
  HeartbeatTracker,
  decodeBase64,
  AttachmentsNotSupportedError,
  PayloadTooLargeError,
  ServiceError,
  StreamMaxWaitExceededError,
  StreamStalledError,
  type NatsConnection,
  type QueryEvent,
  type RequestAttachment,
} from "@synadia-ai/agents";
import type {
  CcExecSessionSummary,
  CcExecSpawnDescriptor,
  ClientMessage,
  DiscoveredAgentDTO,
  PiExecSessionSummary,
  PiExecSpawnDescriptor,
  ServerMessage,
} from "./wire.ts";

type ActiveStream = { controller: AbortController };

export type BridgeWsData = { bridge: Bridge };

export class Bridge {
  private ws: ServerWebSocket<BridgeWsData> | null = null;
  private agentsByInstanceId = new Map<string, Agent>();
  private activeStreams = new Map<string, ActiveStream>();
  private activeQueries = new Map<string, QueryEvent>();
  private heartbeatSubs = new Map<string, () => void>();
  private heartbeatTracker: HeartbeatTracker | null = null;
  private heartbeatWatchUnsub: (() => void) | null = null;
  private pendingInstanceLookups = new Set<string>();
  private closed = false;

  constructor(
    private readonly agents: Agents,
    private readonly nc: NatsConnection,
    private readonly sdkProtocolVersion: string,
  ) {}

  open(ws: ServerWebSocket<BridgeWsData>): void {
    this.ws = ws;
    this.send({
      kind: "ready",
      sdkProtocolVersion: this.sdkProtocolVersion,
    });
    this.startHeartbeatWatch();
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
        void this.handleDiscover();
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
      case "piexec-spawn":
        void this.handlePiExecSpawn(msg.id, msg.controllerInstanceId, msg.spec);
        break;
      case "piexec-stop":
        void this.handlePiExecStop(msg.id, msg.controllerInstanceId, msg.sessionId);
        break;
      case "piexec-list":
        void this.handlePiExecList(msg.id, msg.controllerInstanceId);
        break;
      case "ccexec-spawn":
        void this.handleCcExecSpawn(msg.id, msg.controllerInstanceId, msg.spec);
        break;
      case "ccexec-stop":
        void this.handleCcExecStop(msg.id, msg.controllerInstanceId, msg.sessionId);
        break;
      case "ccexec-list":
        void this.handleCcExecList(msg.id, msg.controllerInstanceId);
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
    if (this.heartbeatWatchUnsub) {
      this.heartbeatWatchUnsub();
      this.heartbeatWatchUnsub = null;
    }
    if (this.heartbeatTracker) {
      void this.heartbeatTracker.stop();
      this.heartbeatTracker = null;
    }
    this.pendingInstanceLookups.clear();
    this.ws = null;
  }

  // ─── Handlers ──────────────────────────────────────────────────────────────

  private async handleDiscover(): Promise<void> {
    try {
      let discovered: Agent[];
      try {
        discovered = await this.agents.discover();
      } catch (err) {
        // NoRespondersError on `$SRV.INFO.agents` means zero agents are
        // registered — a normal empty state, not an error. The SDK already
        // catches this internally, but a `file:`-linked install can produce
        // two copies of `@nats-io/nats-core` whose `NoRespondersError`
        // classes differ, so the SDK's `instanceof` check misses and the
        // error escapes. Duck-type as a safety net.
        if (isNoRespondersError(err)) {
          discovered = [];
        } else {
          throw err;
        }
      }
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
        const unsub = this.agents.onHeartbeat(id, (hb) => {
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

    const attachments: RequestAttachment[] | undefined = msg.attachments?.map((a) => ({
      filename: a.filename,
      content: decodeBase64(a.base64),
    }));

    try {
      const stream = await agent.prompt(msg.text, {
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
          case "status": {
            // Inspect for our prefixed observability tokens before falling
            // through to the generic status path. The agent encodes tool
            // calls / results / cost as `<kind>:<json>` status strings so the
            // wire stays §6.4-compliant; here we translate them into typed
            // server messages the UI can render richly.
            const structured = parseStructuredStatus(msg.id, ev.status);
            if (structured) {
              this.send(structured);
            } else {
              this.send({ kind: "status", id: msg.id, status: ev.status });
            }
            break;
          }
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

  // ─── pi-headless control plane ────────────────────────────────────────────

  private async handlePiExecSpawn(
    id: string,
    controllerInstanceId: string,
    spec: unknown,
  ): Promise<void> {
    const subject = this.resolveControllerSubject(id, controllerInstanceId, "spawn");
    if (!subject) return;
    try {
      const rep = await this.nc.request(subject, JSON.stringify(spec ?? {}), { timeout: 15_000 });
      const errHeader = rep.headers?.get("Nats-Service-Error-Code");
      if (errHeader) {
        this.sendError(
          id,
          errHeader,
          rep.headers?.get("Nats-Service-Error") ?? "spawn error",
        );
        return;
      }
      const descriptor = JSON.parse(rep.string()) as PiExecSpawnDescriptor;
      // Register the new session with the UI immediately — no 30s heartbeat
      // wait. The heartbeat-watch path would also pick this up, but a direct
      // $SRV.INFO lookup here removes any race with the controller's reply.
      await this.ensureAgentKnown(descriptor.instance_id);
      this.send({ kind: "piexec-spawned", id, descriptor });
    } catch (err) {
      this.sendError(id, "piexec_spawn_failed", (err as Error).message);
    }
  }

  private async handlePiExecStop(
    id: string,
    controllerInstanceId: string,
    sessionId: string,
  ): Promise<void> {
    const subject = this.resolveControllerSubject(id, controllerInstanceId, "stop");
    if (!subject) return;
    try {
      const rep = await this.nc.request(
        subject,
        JSON.stringify({ session_id: sessionId }),
        { timeout: 10_000 },
      );
      const errHeader = rep.headers?.get("Nats-Service-Error-Code");
      if (errHeader) {
        this.sendError(
          id,
          errHeader,
          rep.headers?.get("Nats-Service-Error") ?? "stop error",
        );
        return;
      }
      // Drop the stopped session from this bridge's agent map + UI eagerly.
      // The session_id equals the 4th-token `name` of a pi-headless session.
      for (const [instanceId, agent] of this.agentsByInstanceId) {
        if (
          agent.agent === "pi-headless" &&
          agent.metadata["role"] === "session" &&
          agent.name === sessionId
        ) {
          this.forgetAgent(instanceId);
          break;
        }
      }
      this.send({ kind: "piexec-stopped", id, sessionId });
    } catch (err) {
      this.sendError(id, "piexec_stop_failed", (err as Error).message);
    }
  }

  private async handlePiExecList(
    id: string,
    controllerInstanceId: string,
  ): Promise<void> {
    const subject = this.resolveControllerSubject(id, controllerInstanceId, "list");
    if (!subject) return;
    try {
      const rep = await this.nc.request(subject, "", { timeout: 10_000 });
      const errHeader = rep.headers?.get("Nats-Service-Error-Code");
      if (errHeader) {
        this.sendError(
          id,
          errHeader,
          rep.headers?.get("Nats-Service-Error") ?? "list error",
        );
        return;
      }
      const body = JSON.parse(rep.string()) as { sessions: PiExecSessionSummary[] };
      this.send({
        kind: "piexec-listed",
        id,
        controllerInstanceId,
        sessions: body.sessions ?? [],
      });
    } catch (err) {
      this.sendError(id, "piexec_list_failed", (err as Error).message);
    }
  }

  private resolveControllerSubject(
    id: string,
    controllerInstanceId: string,
    endpoint: "spawn" | "stop" | "list",
    expectedAgent: "pi-headless" | "cc-headless" = "pi-headless",
  ): string | null {
    const agent = this.agentsByInstanceId.get(controllerInstanceId);
    if (!agent) {
      this.sendError(
        id,
        "agent_not_found",
        `no ${expectedAgent} controller with instance id ${controllerInstanceId} in last discovery result — click Refresh`,
      );
      return null;
    }
    // Both pi-headless and cc-headless controllers carry `metadata.role
    // = "controller"`, so the agent token is what disambiguates which
    // handler this controller belongs under. Without this check, a
    // mis-dispatched cc controller id into a pi handler would silently
    // construct a `cc-headless` extension subject and call it.
    if (agent.agent !== expectedAgent) {
      this.sendError(
        id,
        "wrong_agent_token",
        `instance ${controllerInstanceId} is agent="${agent.agent}", expected "${expectedAgent}"`,
      );
      return null;
    }
    if (agent.metadata["role"] !== "controller") {
      this.sendError(
        id,
        "not_a_controller",
        `instance ${controllerInstanceId} is not a ${expectedAgent} controller`,
      );
      return null;
    }
    // Verb-first throughout: swap `prompt` for the extension verb in the
    // controller's prompt subject.
    //   prompt subject:    agents.prompt.<agent>.<owner>.<name>     (5 tokens)
    //   extension subject: agents.<endpoint>.<agent>.<owner>.<name> (5 tokens)
    const tokens = agent.promptEndpoint.subject.split(".");
    if (tokens.length !== 5 || tokens[0] !== "agents" || tokens[1] !== "prompt") {
      this.sendError(
        id,
        "bad_prompt_subject",
        `controller's prompt subject doesn't match the verb-first shape: ${agent.promptEndpoint.subject}`,
      );
      return null;
    }
    return `${tokens[0]}.${endpoint}.${tokens[2]}.${tokens[3]}.${tokens[4]}`;
  }

  // ─── claude-code-headless control plane ───────────────────────────────────

  private async handleCcExecSpawn(
    id: string,
    controllerInstanceId: string,
    spec: unknown,
  ): Promise<void> {
    const subject = this.resolveControllerSubject(
      id,
      controllerInstanceId,
      "spawn",
      "cc-headless",
    );
    if (!subject) return;
    try {
      const rep = await this.nc.request(subject, JSON.stringify(spec ?? {}), { timeout: 15_000 });
      const errHeader = rep.headers?.get("Nats-Service-Error-Code");
      if (errHeader) {
        this.sendError(
          id,
          errHeader,
          rep.headers?.get("Nats-Service-Error") ?? "spawn error",
        );
        return;
      }
      const descriptor = JSON.parse(rep.string()) as CcExecSpawnDescriptor;
      await this.ensureAgentKnown(descriptor.instance_id);
      this.send({ kind: "ccexec-spawned", id, descriptor });
    } catch (err) {
      this.sendError(id, "ccexec_spawn_failed", (err as Error).message);
    }
  }

  private async handleCcExecStop(
    id: string,
    controllerInstanceId: string,
    sessionId: string,
  ): Promise<void> {
    const subject = this.resolveControllerSubject(
      id,
      controllerInstanceId,
      "stop",
      "cc-headless",
    );
    if (!subject) return;
    try {
      const rep = await this.nc.request(
        subject,
        JSON.stringify({ session_id: sessionId }),
        { timeout: 10_000 },
      );
      const errHeader = rep.headers?.get("Nats-Service-Error-Code");
      if (errHeader) {
        this.sendError(
          id,
          errHeader,
          rep.headers?.get("Nats-Service-Error") ?? "stop error",
        );
        return;
      }
      // Drop the stopped session from this bridge's agent map + UI eagerly.
      // The session_id equals the 4th-token `name` of a cc-headless session.
      for (const [instanceId, agent] of this.agentsByInstanceId) {
        if (
          agent.agent === "cc-headless" &&
          agent.metadata["role"] === "session" &&
          agent.name === sessionId
        ) {
          this.forgetAgent(instanceId);
          break;
        }
      }
      this.send({ kind: "ccexec-stopped", id, sessionId });
    } catch (err) {
      this.sendError(id, "ccexec_stop_failed", (err as Error).message);
    }
  }

  private async handleCcExecList(
    id: string,
    controllerInstanceId: string,
  ): Promise<void> {
    const subject = this.resolveControllerSubject(
      id,
      controllerInstanceId,
      "list",
      "cc-headless",
    );
    if (!subject) return;
    try {
      const rep = await this.nc.request(subject, "", { timeout: 10_000 });
      const errHeader = rep.headers?.get("Nats-Service-Error-Code");
      if (errHeader) {
        this.sendError(
          id,
          errHeader,
          rep.headers?.get("Nats-Service-Error") ?? "list error",
        );
        return;
      }
      const body = JSON.parse(rep.string()) as { sessions: CcExecSessionSummary[] };
      this.send({
        kind: "ccexec-listed",
        id,
        controllerInstanceId,
        sessions: body.sessions ?? [],
      });
    } catch (err) {
      this.sendError(id, "ccexec_list_failed", (err as Error).message);
    }
  }

  // ─── Auto-discovery via heartbeat wildcard ────────────────────────────────

  /**
   * Use the SDK's {@link HeartbeatTracker} to listen for any heartbeat on
   * `agents.hb.*.*.*`. New `instance_id`s trigger a targeted
   * `Agents.lookupInstance(id)` so the bridge adds them to the map with
   * full $SRV.INFO metadata as soon as their first heartbeat arrives —
   * sub-second pickup, no waiting for the next `discover()` cycle.
   */
  private startHeartbeatWatch(): void {
    if (this.heartbeatTracker) return;
    const tracker = new HeartbeatTracker(this.nc);
    this.heartbeatTracker = tracker;
    void tracker.start().catch((e) => {
      console.warn("[bridge] heartbeat watch failed to start:", (e as Error).message);
    });
    this.heartbeatWatchUnsub = tracker.onAnyHeartbeat((hb) => {
      if (this.closed) return;
      if (this.agentsByInstanceId.has(hb.instanceId)) return;
      void this.ensureAgentKnown(hb.instanceId);
    });
  }

  /**
   * If `instanceId` isn't already in our map, fetch its `$SRV.INFO` record
   * via `Agents.lookupInstance`, register the resulting `Agent`, and push
   * it to the UI. Reentrant calls for the same id coalesce via
   * `pendingInstanceLookups`.
   */
  private async ensureAgentKnown(instanceId: string): Promise<void> {
    if (this.agentsByInstanceId.has(instanceId)) return;
    if (this.pendingInstanceLookups.has(instanceId)) return;
    this.pendingInstanceLookups.add(instanceId);
    try {
      const agent = await this.agents.lookupInstance(instanceId);
      if (!agent) return;
      if (this.agentsByInstanceId.has(instanceId)) return; // raced
      this.registerAgent(agent);
    } catch (e) {
      console.warn(
        `[bridge] lookup for ${instanceId} failed:`,
        (e as Error).message,
      );
    } finally {
      this.pendingInstanceLookups.delete(instanceId);
    }
  }

  private registerAgent(agent: Agent): void {
    this.agentsByInstanceId.set(agent.instanceId, agent);
    if (!this.heartbeatSubs.has(agent.instanceId)) {
      const unsub = this.agents.onHeartbeat(agent.instanceId, (hb) => {
        this.send({
          kind: "heartbeat",
          instanceId: agent.instanceId,
          ts: hb.ts,
          intervalS: hb.intervalS,
        });
      });
      this.heartbeatSubs.set(agent.instanceId, unsub);
    }
    this.send({ kind: "agent-added", agent: toDTO(agent) });
  }

  private forgetAgent(instanceId: string): void {
    if (!this.agentsByInstanceId.delete(instanceId)) return;
    const unsub = this.heartbeatSubs.get(instanceId);
    if (unsub) {
      try {
        unsub();
      } catch {
        /* noop */
      }
      this.heartbeatSubs.delete(instanceId);
    }
    this.send({ kind: "agent-removed", instanceId });
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
    if (err instanceof StreamMaxWaitExceededError) {
      this.sendError(id, "stream_max_wait_exceeded", err.message, { maxWaitMs: err.maxWaitMs });
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

function isNoRespondersError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; message?: unknown };
  // The class is `NoRespondersError` but the constructor sets
  // `this.name = "NoResponders"` (no `Error` suffix) — match the actual
  // runtime value, not the class name.
  if (e.name === "NoResponders") return true;
  return typeof e.message === "string" && e.message.includes("no responders");
}

/**
 * Translate a `<prefix>:<json>` status payload into a typed server message.
 * Returns null if the status doesn't match a known observability prefix —
 * caller falls back to the generic `status` send.
 */
function parseStructuredStatus(promptId: string, status: string): ServerMessage | null {
  const colonAt = status.indexOf(":");
  if (colonAt < 0) return null;
  const prefix = status.slice(0, colonAt);
  const rest = status.slice(colonAt + 1);
  switch (prefix) {
    case "tool_use": {
      const parsed = safeParse<{ id?: string; name?: string; input?: Record<string, unknown> }>(rest);
      if (!parsed || typeof parsed.id !== "string" || typeof parsed.name !== "string") return null;
      return {
        kind: "tool-use",
        id: promptId,
        toolUseId: parsed.id,
        toolName: parsed.name,
        input: parsed.input ?? {},
      };
    }
    case "tool_result": {
      const parsed = safeParse<{ tool_use_id?: string; output?: string; is_error?: boolean }>(rest);
      if (!parsed || typeof parsed.tool_use_id !== "string") return null;
      return {
        kind: "tool-result",
        id: promptId,
        toolUseId: parsed.tool_use_id,
        output: typeof parsed.output === "string" ? parsed.output : "",
        isError: parsed.is_error === true,
      };
    }
    case "cost": {
      const parsed = safeParse<{ turn_cost_usd?: number; total_cost_usd?: number }>(rest);
      if (!parsed) return null;
      return {
        kind: "cost",
        id: promptId,
        turnCostUsd: typeof parsed.turn_cost_usd === "number" ? parsed.turn_cost_usd : 0,
        totalCostUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : 0,
      };
    }
    default:
      return null;
  }
}

function safeParse<T>(text: string): T | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") return parsed as T;
    return null;
  } catch {
    return null;
  }
}

function toDTO(a: Agent): DiscoveredAgentDTO {
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
