// A spec-compliant reference agent for protocol v0.3.
//
// Faithfully implements the §12 agent checklist:
//   - Registers as `agents` (spec §3.1).
//   - Declares `metadata.agent`, `metadata.owner`, `metadata.protocol_version`,
//     and `metadata.session` when session-aware (§3.2).
//   - Registers a `prompt` endpoint with queue group `"agents"` (§3.3) at
//     `agents.prompt.<agent>.<owner>.<name>` (§2 v0.3) with metadata
//     `max_payload` / `attachments_ok` (§2.1).
//   - Registers a `status` endpoint at `agents.status.<agent>.<owner>.<name>`
//     (§8.7 (v0.3)) that replies with a freshly-built §8.3 heartbeat payload.
//   - Publishes heartbeats at `agents.hb.<agent>.<owner>.<name>` with all
//     §8.3 fields including `instance_id` (from the service id).
//   - Emits an empty-body no-headers terminator after each prompt
//     (default handler).
//
// Kept intentionally permissive — the `promptHandler` callback receives
// the raw `ServiceMsg` so tests can assert on malformed inputs, drop
// chunks, emit unknown shapes, etc. Production agents use
// `AgentService` (`@synadia-ai/agents/service`), which validates the
// envelope, manages keep-alive, and translates handler exceptions to
// 500s. Exported via the `@synadia-ai/agents/testing` subpath.

import type { NatsConnection } from "@nats-io/nats-core";
import { Svcm, type Service, type ServiceMsg } from "@nats-io/services";
import {
  PROMPT_QUEUE_GROUP,
  SERVICE_NAME,
  STATUS_ENDPOINT_NAME,
  STATUS_QUEUE_GROUP,
} from "../internal/service-name.js";
import { PROMPT_ENDPOINT_NAME } from "../discovery/endpoint-info.js";
import { buildHeartbeatPayload, encodeHeartbeatPayload } from "../heartbeat/payload.js";
import { formatHumanBytes, parseHumanBytes } from "../bytes.js";
import { AgentSubject } from "../subjects.js";
import { SDK_PROTOCOL_VERSION } from "../version.js";

export type ReferenceAgentPromptHandler = (msg: ServiceMsg) => void | Promise<void>;

export interface ReferenceAgentOptions {
  /** Active NATS connection. */
  readonly nc: NatsConnection;
  /** `metadata.agent` — canonical harness identifier (e.g. `"claude-code"`). */
  readonly agent: string;
  /** `metadata.owner` — operator / account. */
  readonly owner: string;
  /** Instance name — 5th subject token (§2 v0.3). */
  readonly name: string;
  /** `metadata.session` — set for session-aware harnesses (§5.6). */
  readonly session?: string;
  /** Human-readable service description. */
  readonly description?: string;
  /** Harness semver (`service.version`). Default: `"0.0.1"`. */
  readonly version?: string;
  /** Endpoint metadata `max_payload`. Default: `"1MB"`. */
  readonly maxPayload?: string;
  /** Endpoint metadata `attachments_ok`. Default: `true`. */
  readonly attachmentsOk?: boolean;
  /** Heartbeat cadence in seconds (§8.2). Default: `1` (test-friendly). */
  readonly heartbeatIntervalS?: number;
  /** Custom prompt handler. Defaults to emitting only the empty terminator. */
  readonly promptHandler?: ReferenceAgentPromptHandler;
  /** Extra metadata keys merged into the service metadata (forward-compat). */
  readonly extraMetadata?: Readonly<Record<string, string>>;
}

const DEFAULT_MAX_PAYLOAD = "1MB";
const DEFAULT_HEARTBEAT_INTERVAL_S = 1;
const DEFAULT_VERSION = "0.0.1";

export class ReferenceAgent {
  readonly #options: ReferenceAgentOptions;
  readonly #subject: AgentSubject;
  #service: Service | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ReferenceAgentOptions) {
    this.#options = options;
    this.#subject = AgentSubject.new(options.agent, options.owner, options.name);
  }

  /** Prompt endpoint subject this agent listens on (§2 v0.3 — verb-first). */
  get promptSubject(): string {
    return this.#subject.prompt;
  }

  /** Heartbeat subject this agent publishes on (§8.1 v0.3 — `agents.hb.*`). */
  get heartbeatSubject(): string {
    return this.#subject.heartbeat;
  }

  /** Status endpoint subject (§8.7 (v0.3)). */
  get statusSubject(): string {
    return this.#subject.status;
  }

  /** The service id, available after `start()`. Matches heartbeat `instance_id`. */
  get instanceId(): string {
    if (!this.#service) {
      throw new Error("ReferenceAgent.instanceId: agent not started");
    }
    return this.#service.info().id;
  }

  async start(): Promise<void> {
    if (this.#service) return;
    const svcm = new Svcm(this.#options.nc);

    const metadata: Record<string, string> = {
      agent: this.#subject.agent,
      owner: this.#subject.owner,
      protocol_version: `${SDK_PROTOCOL_VERSION.major}.${SDK_PROTOCOL_VERSION.minor}`,
      ...this.#options.extraMetadata,
    };
    if (this.#options.session !== undefined) {
      metadata["session"] = this.#options.session;
    }

    this.#service = await svcm.add({
      name: SERVICE_NAME,
      version: this.#options.version ?? DEFAULT_VERSION,
      description: this.#options.description ?? `${this.#subject.agent} reference agent`,
      metadata,
    });

    const attachmentsOk = this.#options.attachmentsOk ?? true;
    // Same clamp behaviour as `AgentService` — see `src/service.ts`. The
    // broker enforces `nc.info.max_payload`; advertising more would break
    // callers without any local validation catching it first.
    const maxPayload = this.#effectiveMaxPayload();
    const promptHandler = this.#options.promptHandler ?? defaultTerminatorHandler;

    this.#service.addEndpoint(PROMPT_ENDPOINT_NAME, {
      subject: this.#subject.prompt,
      queue: PROMPT_QUEUE_GROUP,
      handler: (err, msg) => {
        if (err) return;
        void Promise.resolve(promptHandler(msg)).catch((handlerErr: unknown) => {
          try {
            msg.respondError(500, "reference agent handler error");
          } catch {
            /* connection may already be gone */
          }

          console.error("ReferenceAgent prompt handler threw", handlerErr);
        });
      },
      metadata: {
        max_payload: maxPayload,
        attachments_ok: attachmentsOk ? "true" : "false",
      },
    });

    // §8.7 (v0.3): status request/response endpoint. Replies with a freshly-
    // built §8.3 heartbeat payload — same shape, different transport (request/
    // response instead of pub/sub). Same queue group as `prompt` so callers
    // load-balance to one responder per logical agent.
    this.#service.addEndpoint(STATUS_ENDPOINT_NAME, {
      subject: this.#subject.status,
      queue: STATUS_QUEUE_GROUP,
      handler: (err, msg) => {
        if (err) return;
        const service = this.#service;
        if (!service) return;
        const payload = buildHeartbeatPayload(
          this.#subject,
          this.#options.heartbeatIntervalS ?? DEFAULT_HEARTBEAT_INTERVAL_S,
          service.info().id,
          this.#options.session !== undefined ? { session: this.#options.session } : {},
        );
        msg.respond(encodeHeartbeatPayload(payload));
      },
    });

    // §8.2: begin publishing heartbeats AFTER service registration so that
    // callers discovering via $SRV.INFO find the metadata first. We also
    // emit one immediately so tests don't wait a full interval.
    this.#startHeartbeats();
  }

  async stop(): Promise<void> {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    if (this.#service) {
      await this.#service.stop();
      this.#service = null;
    }
  }

  #effectiveMaxPayload(): string {
    const override = this.#options.maxPayload ?? DEFAULT_MAX_PAYLOAD;
    const overrideBytes = parseHumanBytes(override);
    const serverBytes = this.#options.nc.info?.max_payload ?? 0;
    if (serverBytes <= 0 || overrideBytes <= serverBytes) {
      return override;
    }
    const clamped = formatHumanBytes(serverBytes);
    console.warn(
      `ReferenceAgent: maxPayload=${override} (${overrideBytes} bytes) exceeds ` +
        `server limit ${clamped} (${serverBytes} bytes); clamping advertised ` +
        `value to ${clamped}`,
    );
    return clamped;
  }

  #startHeartbeats(): void {
    const intervalS = this.#options.heartbeatIntervalS ?? DEFAULT_HEARTBEAT_INTERVAL_S;
    const publish = (): void => {
      const service = this.#service;
      if (!service) return;
      const payload = buildHeartbeatPayload(
        this.#subject,
        intervalS,
        service.info().id,
        this.#options.session !== undefined ? { session: this.#options.session } : {},
      );
      this.#options.nc.publish(this.#subject.heartbeat, encodeHeartbeatPayload(payload));
    };
    publish();
    this.#heartbeatTimer = setInterval(publish, intervalS * 1000);
    // Allow the Node process to exit even if the timer is still active.
    this.#heartbeatTimer.unref?.();
  }
}

function defaultTerminatorHandler(msg: ServiceMsg): void {
  // Spec §6.5: empty body + no headers is the stream terminator.
  msg.respond("");
}
