// Server-side protocol-compliant agent per the §12 implementation checklist.
//
// `AgentService` handles the boilerplate every protocol-compliant agent
// needs:
//   - Registers as the NATS micro service `agents` (§3.1) with metadata
//     `{agent, owner, protocol_version: "0.3", session?}` (§3.2).
//   - Adds a `prompt` endpoint at `agents.prompt.<agent>.<owner>.<name>`
//     with queue group `"agents"` (§3.3) and metadata `{max_payload,
//     attachments_ok}` (§2.1).
//   - Adds a `status` endpoint at `agents.status.<agent>.<owner>.<name>`
//     (§8.7 (v0.3)) that replies with a freshly-built §8.3 heartbeat
//     payload. Same queue group as `prompt`.
//   - Publishes heartbeats on `agents.hb.<agent>.<owner>.<name>` every
//     `heartbeatIntervalS` seconds (§8.1, §8.2). First heartbeat is
//     emitted immediately after registration so callers discovering via
//     `$SRV.INFO.agents` can observe liveness without waiting a full
//     interval (§8.5).
//   - Runs a per-request keep-alive task that emits
//     `{"type":"status","data":"ack"}` every `keepaliveIntervalS`
//     seconds while the prompt handler is running, so callers using a
//     stream inactivity timeout (the SDK default is 60 s) don't fire on
//     slow handlers. Cancelled before the §6.5 stream terminator so the
//     ack stream never extends past the terminator.
//   - Emits the spec-mandated empty-body no-headers terminator after
//     every prompt — successful or errored (§6.5, §9.3).
//   - Translates handler exceptions into `Nats-Service-Error-Code: 500`
//     responses, while envelope decode failures and handler-raised
//     `ProtocolError`s become `400` (§9.1).
//
// Mirrors the Python SDK's `AgentService` (`client-sdk/python/src/synadia_ai/agents/service.py`)
// — wire-equivalent behaviour, idiomatic TS API.

import type { NatsConnection } from "@nats-io/nats-core";
import { Svcm, type Service, type ServiceHandler, type ServiceMsg } from "@nats-io/services";

import {
  AgentSubject,
  decodeEnvelope,
  encodeBase64,
  formatHumanBytes,
  newInbox,
  parseHumanBytes,
  PROMPT_ENDPOINT_NAME,
  PROMPT_QUEUE_GROUP,
  ProtocolError,
  SDK_PROTOCOL_VERSION,
  SERVICE_NAME,
  STATUS_ENDPOINT_NAME,
  STATUS_QUEUE_GROUP,
  type RequestAttachment,
  type RequestEnvelope,
} from "@synadia-ai/agents";

import { buildHeartbeatPayload, encodeHeartbeatPayload } from "./heartbeat/payload.js";
import {
  encodeChunk,
  type Chunk,
  type QueryChunk,
  type StatusChunk,
} from "./stream/chunk-encoder.js";

/** §3.2 + §11.1: `metadata.protocol_version` is MAJOR.MINOR only. */
const PROTOCOL_VERSION_STRING = `${SDK_PROTOCOL_VERSION.major}.${SDK_PROTOCOL_VERSION.minor}`;

/** Default §2.1 prompt-endpoint metadata. */
export const DEFAULT_MAX_PAYLOAD = "1MB";
export const DEFAULT_ATTACHMENTS_OK = true;

/** Default §8.2 heartbeat cadence — matches Python (and pre-v0.3 TS reference agent). */
export const DEFAULT_HEARTBEAT_INTERVAL_S = 30;

/**
 * Default per-request keep-alive cadence. Every TS reference harness
 * (`agents/pi/`, `agents/claude-code/`, `agents/openclaw/`) emits
 * `{"type":"status","data":"ack"}` periodically while a request is in
 * flight so callers using a stream inactivity timeout (§6.6 — TS SDK
 * default 60 s) don't fire on slow handlers. Defaults to 30 s; pass
 * `null` to disable.
 */
export const DEFAULT_KEEPALIVE_INTERVAL_S = 30;

/** Default `service.version` advertised in `$SRV.INFO`. */
const DEFAULT_VERSION = "0.0.1";

export interface AgentServiceOptions {
  /** A pre-connected `NatsConnection`. Caller retains ownership. */
  readonly nc: NatsConnection;
  /** §3.2 `metadata.agent` — canonical harness identifier (e.g. `"claude-code"`). */
  readonly agent: string;
  /** §3.2 `metadata.owner` — operator / account namespace. */
  readonly owner: string;
  /** Instance name — 5th subject token (§2 v0.3). */
  readonly name: string;
  /**
   * Optional override for the subject's 3rd token (the wire token).
   * Defaults to `agent`. Use a short form here when `metadata.agent`
   * carries a longer canonical name and the wire wants the abbreviation
   * (e.g. `agent: "claude-code", subjectToken: "cc"` —
   * `metadata.agent="claude-code"` is what callers filter on, while the
   * subject reads `agents.prompt.cc.<owner>.<name>`).
   */
  readonly subjectToken?: string;
  /**
   * Optional §5.6 envelope-level conversation label. Set when the agent
   * advertises a session label in `$SRV.INFO.metadata.session` and emits
   * it on every heartbeat — used by harnesses (e.g. Hermes) that
   * multiplex multiple conversations over a single subject.
   */
  readonly session?: string;
  /** Human-readable service description. Defaults to `"<agent> agent <name>"`. */
  readonly description?: string;
  /** Harness semver (`service.version`). Defaults to `"0.0.1"`. */
  readonly version?: string;
  /**
   * §2.1 `max_payload`. Defaults to the broker's negotiated
   * `nc.info.max_payload` (e.g. 8 MB on NGS, 1 MB on a default
   * `nats-server`), so the advertised cap matches what the connection
   * can actually carry. Falls back to `"1MB"` only if `nc.info` isn't
   * populated. An explicit value is honored verbatim **unless it
   * exceeds** the broker's limit; in that case `start()` clamps the
   * advertised value down to the server's limit and `console.warn`s.
   * Over-advertising would only break callers — the broker rejects
   * oversized publishes before any handler sees them.
   */
  readonly maxPayload?: string;
  /** §2.1 `attachments_ok`. Defaults to `true`. */
  readonly attachmentsOk?: boolean;
  /** §8.2 heartbeat cadence in seconds. Must be > 0. Defaults to 30. */
  readonly heartbeatIntervalS?: number;
  /**
   * Per-request keep-alive cadence in seconds. Must be > 0, or `null` to
   * disable (e.g. when the handler emits its own status chunks at a finer
   * cadence). Defaults to 30.
   */
  readonly keepaliveIntervalS?: number | null;
  /** Extra metadata keys merged into the service metadata (forward-compat). */
  readonly extraMetadata?: Readonly<Record<string, string>>;
  /**
   * Custom endpoints registered on the same `agents` micro service
   * alongside `prompt` and `status`. Use this for harness-specific
   * endpoints (e.g. a controller's `spawn` / `stop` / `list`). Endpoints
   * are added in array order, after `prompt` and `status`, before the
   * first heartbeat is published.
   *
   * Names MUST NOT collide with the protocol-required endpoints
   * (`prompt`, `status`) or with another entry in this list — `start()`
   * throws on collision before any registration happens. Names that
   * shadow future-reserved spec verbs are NOT validated here, but
   * harnesses SHOULD avoid them.
   *
   * Subjects are advertised verbatim — `AgentService` does not prefix
   * them. A harness that wants its custom endpoint to appear under the
   * protocol's `agents.*` namespace is responsible for assembling the
   * full subject (e.g. `agents.spawn.<agent>.<owner>.<name>`).
   *
   * For runtime-dynamic endpoints that can't be expressed at construction
   * time, use the {@link AgentService.service} getter as an escape hatch.
   */
  readonly extraEndpoints?: ReadonlyArray<AgentServiceExtraEndpoint>;
}

/**
 * Configuration for a custom endpoint added to the agent's micro service
 * alongside `prompt` and `status`. See
 * {@link AgentServiceOptions.extraEndpoints}.
 */
export interface AgentServiceExtraEndpoint {
  /** NATS micro endpoint name. MUST NOT collide with `prompt` or `status`. */
  readonly name: string;
  /** Full subject the endpoint listens on. AgentService does NOT prefix. */
  readonly subject: string;
  /** NATS queue group. Defaults to no queue group (undefined). */
  readonly queue?: string;
  /** Endpoint handler. Same shape as `service.addEndpoint(...)`'s handler. */
  readonly handler: ServiceHandler;
  /** Per-endpoint metadata advertised on `$SRV.INFO`. */
  readonly metadata?: Record<string, string>;
}

export type PromptHandler = (
  envelope: RequestEnvelope,
  response: PromptResponse,
) => Promise<void> | void;

/** A "non-empty subset of `crypto.randomUUID()`-style tokens" — used for query ids. */
function randomId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * Server-side handle given to a {@link PromptHandler} for emitting response
 * chunks back to the caller. The {@link AgentService} owns stream
 * termination — handlers `send(...)` zero or more chunks and return.
 *
 * Distinct from the client-side `PromptStream` (`@synadia-ai/agents`'s
 * `Agent.prompt(...)` return value). Same conceptual stream, opposite ends.
 */
export class PromptResponse {
  readonly #msg: ServiceMsg;
  readonly #nc: NatsConnection;

  constructor(msg: ServiceMsg, nc: NatsConnection) {
    this.#msg = msg;
    this.#nc = nc;
  }

  /**
   * Publish one chunk to the caller's reply subject.
   *
   * A `string` is wrapped in a `ResponseChunk` and emitted as the §6.3
   * bare-string form. §6.2 forbids plain-text shorthand on the response
   * side — every non-terminating chunk is a JSON object with a `type`
   * field. Returns a Promise for forward-compat with backpressure/flush
   * variants; today the underlying `respond` is fire-and-forget.
   */
  send(chunk: string | Chunk): Promise<void> {
    const c: Chunk = typeof chunk === "string" ? { type: "response", text: chunk } : chunk;
    this.#msg.respond(encodeChunk(c));
    return Promise.resolve();
  }

  /**
   * Ask the caller a mid-stream question and await a single reply (§7).
   *
   * Allocates a fresh reply inbox, publishes a `query` chunk into the
   * response stream, and waits up to `timeoutMs` milliseconds. The
   * response stream stays open across the round-trip — the caller keeps
   * iterating the prompt while the handler awaits here.
   *
   * Throws on timeout — handlers decide whether to abort the stream or
   * proceed with a default per §7.3.
   */
  async ask(
    prompt: string | RequestEnvelope,
    opts: { readonly timeoutMs: number; readonly attachments?: ReadonlyArray<RequestAttachment> },
  ): Promise<RequestEnvelope> {
    const promptText = typeof prompt === "string" ? prompt : prompt.prompt;
    const baseAttachments = typeof prompt === "string" ? undefined : prompt.attachments;
    const merged: RequestAttachment[] = [...(baseAttachments ?? []), ...(opts.attachments ?? [])];

    const replySubject = newInbox();
    const sub = this.#nc.subscribe(replySubject, { max: 1 });
    await this.#nc.flush();

    const queryChunk: QueryChunk = {
      type: "query",
      id: randomId(),
      replySubject,
      prompt: promptText,
      ...(merged.length > 0
        ? {
            attachments: merged.map((a) => ({
              filename: a.filename,
              content: encodeBase64(a.content),
            })),
          }
        : {}),
    };
    this.#msg.respond(encodeChunk(queryChunk));

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const next = (async (): Promise<RequestEnvelope> => {
        for await (const m of sub) {
          // First message wins (max:1 subscription).
          return decodeEnvelope(m.data);
        }
        throw new Error(
          `query ${queryChunk.id} reply subscription closed before any reply arrived`,
        );
      })();
      // When `timed` wins the race, the `finally` block calls
      // `sub.unsubscribe()` which closes the iterator and makes `next`
      // reject with no awaiter — Node would log it as
      // `UnhandledPromiseRejection`. Suppress that path explicitly.
      next.catch(() => {});
      const timed = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `query ${queryChunk.id} on ${replySubject} timed out after ${opts.timeoutMs}ms`,
              ),
            ),
          opts.timeoutMs,
        );
      });
      return await Promise.race([next, timed]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      sub.unsubscribe();
    }
  }
}

/** A protocol-compliant agent (§12). */
export class AgentService {
  readonly #options: AgentServiceOptions;
  readonly #subject: AgentSubject;
  readonly #heartbeatIntervalS: number;
  readonly #keepaliveIntervalS: number | null;
  #handler: PromptHandler | null = null;
  #service: Service | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: AgentServiceOptions) {
    const heartbeatIntervalS = options.heartbeatIntervalS ?? DEFAULT_HEARTBEAT_INTERVAL_S;
    if (heartbeatIntervalS <= 0) {
      throw new Error(
        "AgentService: heartbeatIntervalS must be > 0 (heartbeat is mandatory in v0.3)",
      );
    }
    const keepaliveIntervalS =
      options.keepaliveIntervalS === undefined
        ? DEFAULT_KEEPALIVE_INTERVAL_S
        : options.keepaliveIntervalS;
    if (keepaliveIntervalS !== null && keepaliveIntervalS <= 0) {
      throw new Error(
        "AgentService: keepaliveIntervalS must be > 0 or null (null disables keep-alive)",
      );
    }

    this.#options = options;
    this.#subject = AgentSubject.new(
      options.agent,
      options.owner,
      options.name,
      options.subjectToken !== undefined ? { subjectToken: options.subjectToken } : {},
    );
    this.#heartbeatIntervalS = heartbeatIntervalS;
    this.#keepaliveIntervalS = keepaliveIntervalS;
  }

  /** The validated subject for this agent. */
  get subject(): AgentSubject {
    return this.#subject;
  }

  /** The service id assigned by `@nats-io/services` once started. Matches heartbeat `instance_id`. */
  get instanceId(): string {
    if (!this.#service) {
      throw new Error("AgentService.instanceId: service not started");
    }
    return this.#service.info().id;
  }

  /**
   * Underlying `@nats-io/services` `Service` — escape hatch for
   * runtime-dynamic endpoint registration that
   * {@link AgentServiceOptions.extraEndpoints} (locked at construction)
   * can't express. Throws before {@link start} because the service
   * doesn't exist yet.
   *
   * Direct calls to `service.addEndpoint(...)` bypass the duplicate-name
   * guard that `extraEndpoints` applies — prefer `extraEndpoints` for
   * any endpoint whose name and subject are known at startup.
   */
  get service(): Service {
    if (!this.#service) {
      throw new Error("AgentService.service: service not started — call start() first");
    }
    return this.#service;
  }

  /** Register the prompt handler. Must be called before {@link start}. */
  onPrompt(handler: PromptHandler): void {
    this.#handler = handler;
  }

  /**
   * Compute the value to advertise in the prompt endpoint's `max_payload`
   * metadata. Two cases:
   *
   * - **No `maxPayload` option** → advertise the broker's negotiated
   *   `nc.info.max_payload`. This is what most agents want: callers see
   *   the *real* cap the connection can carry (e.g. 8 MB on NGS, 1 MB on
   *   a default `nats-server`) without the SDK quietly hiding headroom
   *   behind a stale "1MB" default. Falls back to {@link DEFAULT_MAX_PAYLOAD}
   *   only if `nc.info` is missing — rare; would mean construction ran
   *   before the connect handshake completed.
   * - **Explicit `maxPayload` option** → honor it, but clamp **down** to
   *   the broker's cap if the override would advertise more than the
   *   broker can deliver (anything larger would be rejected at publish
   *   time, so advertising it would only mislead callers).
   */
  #effectiveMaxPayload(): string {
    const serverBytes = this.#options.nc.info?.max_payload ?? 0;
    if (this.#options.maxPayload === undefined) {
      return serverBytes > 0 ? formatHumanBytes(serverBytes) : DEFAULT_MAX_PAYLOAD;
    }
    const override = this.#options.maxPayload;
    const overrideBytes = parseHumanBytes(override);
    if (serverBytes <= 0 || overrideBytes <= serverBytes) {
      return override;
    }
    const clamped = formatHumanBytes(serverBytes);
    // `console.warn` keeps the warning visible without taking an SDK-wide
    // logger dependency; matches the Python SDK's `log.warning` level.
    console.warn(
      `AgentService: maxPayload=${override} (${overrideBytes} bytes) exceeds ` +
        `server limit ${clamped} (${serverBytes} bytes); clamping advertised ` +
        `value to ${clamped} — anything larger would be rejected by the ` +
        `broker before reaching the handler`,
    );
    return clamped;
  }

  async start(): Promise<void> {
    if (this.#handler === null) {
      throw new Error("AgentService.start: register a prompt handler via onPrompt() first");
    }
    if (this.#service !== null) {
      throw new Error("AgentService.start: already started");
    }

    // Validate extraEndpoints names BEFORE any service registration so a
    // collision doesn't leave us with a half-registered service that
    // then fails to clean up.
    const extraEndpoints = this.#options.extraEndpoints ?? [];
    if (extraEndpoints.length > 0) {
      const seen = new Set<string>([PROMPT_ENDPOINT_NAME, STATUS_ENDPOINT_NAME]);
      for (const ep of extraEndpoints) {
        if (seen.has(ep.name)) {
          throw new Error(
            `AgentService.start: extraEndpoints[].name=${JSON.stringify(ep.name)} ` +
              `collides with a protocol-reserved or already-listed endpoint name`,
          );
        }
        seen.add(ep.name);
      }
    }

    const svcm = new Svcm(this.#options.nc);
    const metadata: Record<string, string> = {
      agent: this.#subject.agent,
      owner: this.#subject.owner,
      protocol_version: PROTOCOL_VERSION_STRING,
      ...this.#options.extraMetadata,
    };
    if (this.#options.session !== undefined) {
      metadata["session"] = this.#options.session;
    }

    this.#service = await svcm.add({
      name: SERVICE_NAME,
      version: this.#options.version ?? DEFAULT_VERSION,
      description:
        this.#options.description ?? `${this.#subject.agent} agent ${this.#subject.name}`,
      metadata,
    });

    // §2.1: the broker enforces the *server-negotiated* `max_payload`
    // (`nc.info.max_payload` from the INFO block). Advertising a larger
    // value would set callers up for `MAX_PAYLOAD_VIOLATION` rejections
    // at the broker without any local validation catching it first, so
    // cap a constructor-supplied override down to the server limit.
    // Smaller caps are honored (use case: shed expensive prompts before
    // they reach the handler). When the server didn't report a value
    // (e.g. an INFO block without `max_payload`), the override stands.
    const maxPayloadStr = this.#effectiveMaxPayload();

    this.#service.addEndpoint(PROMPT_ENDPOINT_NAME, {
      subject: this.#subject.prompt,
      queue: PROMPT_QUEUE_GROUP,
      handler: (err, msg) => {
        if (err) return;
        void this.#dispatchPrompt(msg);
      },
      metadata: {
        max_payload: maxPayloadStr,
        attachments_ok: (this.#options.attachmentsOk ?? DEFAULT_ATTACHMENTS_OK) ? "true" : "false",
      },
    });

    this.#service.addEndpoint(STATUS_ENDPOINT_NAME, {
      subject: this.#subject.status,
      queue: STATUS_QUEUE_GROUP,
      handler: (err, msg) => {
        if (err) return;
        this.#dispatchStatus(msg);
      },
    });

    for (const ep of extraEndpoints) {
      this.#service.addEndpoint(ep.name, {
        subject: ep.subject,
        ...(ep.queue !== undefined ? { queue: ep.queue } : {}),
        handler: ep.handler,
        ...(ep.metadata !== undefined ? { metadata: ep.metadata } : {}),
      });
    }

    this.#startHeartbeats();
  }

  async stop(): Promise<void> {
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    if (this.#service !== null) {
      await this.#service.stop();
      this.#service = null;
    }
  }

  #startHeartbeats(): void {
    const publish = (): void => {
      const service = this.#service;
      if (!service) return;
      const payload = buildHeartbeatPayload(
        this.#subject,
        this.#heartbeatIntervalS,
        service.info().id,
        this.#options.session !== undefined ? { session: this.#options.session } : {},
      );
      this.#options.nc.publish(this.#subject.heartbeat, encodeHeartbeatPayload(payload));
    };
    publish();
    this.#heartbeatTimer = setInterval(publish, this.#heartbeatIntervalS * 1000);
    // Allow the Node process to exit even if the timer is still active.
    this.#heartbeatTimer.unref?.();
  }

  #dispatchStatus(msg: ServiceMsg): void {
    const service = this.#service;
    if (!service) return;
    try {
      const payload = buildHeartbeatPayload(
        this.#subject,
        this.#heartbeatIntervalS,
        service.info().id,
        this.#options.session !== undefined ? { session: this.#options.session } : {},
      );
      msg.respond(encodeHeartbeatPayload(payload));
    } catch (err) {
      try {
        const desc = err instanceof Error ? err.message : String(err);
        msg.respondError(500, sanitizeErrorDesc(`status handler error: ${desc}`));
      } catch {
        /* connection may already be gone */
      }
    }
  }

  async #dispatchPrompt(msg: ServiceMsg): Promise<void> {
    const handler = this.#handler;
    if (!handler) return; // start() rejects this path; defensive

    let envelope: RequestEnvelope;
    try {
      envelope = decodeEnvelope(msg.data);
    } catch (err) {
      const desc = err instanceof ProtocolError ? err.message : "malformed prompt envelope";
      try {
        msg.respondError(400, sanitizeErrorDesc(desc));
      } catch {
        /* connection may already be gone */
      }
      // §9.3 — the error frame is NOT the terminator; emit one explicitly.
      tryRespondTerminator(msg);
      return;
    }

    const response = new PromptResponse(msg, this.#options.nc);

    // §6.4: emit the mandatory leading `ack` status chunk as the first
    // message on the reply subject, before the handler runs. Confirms
    // request acceptance and resets the caller's inactivity timeout
    // (§6.6) ahead of any latency the handler introduces (model
    // warm-up, network round-trips). Also makes the stream observable
    // from generic NATS tooling (`nats req --wait-for-empty`) which
    // would otherwise time out on the gap between request receipt and
    // the handler's first output. Mirrors the Python SDK's
    // unconditional leading-ack emission.
    const ack: StatusChunk = { type: "status", status: "ack" };
    const ackBytes = encodeChunk(ack);
    try {
      msg.respond(ackBytes);
    } catch {
      // Best-effort, matching the keepalive loop and PromptResponse.send
      // error-handling pattern: the handler will surface the same failure
      // naturally if the reply subject is truly dead.
    }

    // Optional periodic keep-alive: while the handler runs, emit
    // additional `ack` chunks so callers running long-tail work
    // (§6.6 inactivity timer, 60s default) don't trip on a quiet
    // model. The §6.4 spec mandates only the leading ack above;
    // periodic acks remain a valid wire shape and stay in the SDK
    // as additional defense.
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
    if (this.#keepaliveIntervalS !== null) {
      const intervalMs = this.#keepaliveIntervalS * 1000;
      keepaliveTimer = setInterval(() => {
        try {
          msg.respond(ackBytes);
        } catch {
          // best-effort; clear so we don't keep firing on a dead request
          if (keepaliveTimer) clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
      }, intervalMs);
      keepaliveTimer.unref?.();
    }

    const stopKeepalive = (): void => {
      if (keepaliveTimer !== null) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
    };

    try {
      await handler(envelope, response);
    } catch (err) {
      // Stop keep-alive BEFORE the §9 error frame so an ack chunk can't
      // race in between the error and the terminator.
      stopKeepalive();
      try {
        const desc = err instanceof Error ? err.message : String(err);
        const isProtocolError =
          err instanceof ProtocolError || (err instanceof Error && err.name === "ProtocolError");
        msg.respondError(
          isProtocolError ? 400 : 500,
          sanitizeErrorDesc(isProtocolError ? desc : `handler error: ${desc}`),
        );
      } catch {
        /* connection may already be gone */
      }
    } finally {
      stopKeepalive();
      // §6.5 + §9.3: every stream — successful or errored — ends with a
      // zero-byte body message that carries NO NATS headers.
      tryRespondTerminator(msg);
    }
  }
}

function tryRespondTerminator(msg: ServiceMsg): void {
  try {
    msg.respond(new Uint8Array(0));
  } catch {
    /* connection may already be gone */
  }
}

// NATS message headers are single-line, so any description passed to
// `respondError` MUST be stripped of newlines or the server will truncate
// subsequent headers. 200 chars is plenty for §9.1; richer context belongs
// in the JSON body per §9.1.
const MAX_ERROR_DESC_LEN = 200;

function sanitizeErrorDesc(desc: string): string {
  const flat = desc
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join(" | ");
  if (flat.length > MAX_ERROR_DESC_LEN) {
    return flat.slice(0, MAX_ERROR_DESC_LEN - 3) + "...";
  }
  return flat;
}
