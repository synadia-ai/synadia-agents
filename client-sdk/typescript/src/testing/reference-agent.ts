// A spec-compliant reference agent for protocol `0.2.0-draft`.
//
// Faithfully implements the §12 agent checklist:
//   - Registers as `agents` (spec §3.1).
//   - Declares `metadata.agent`, `metadata.owner`, `metadata.protocol_version = "0.2"`,
//     and `metadata.session` when session-aware.
//   - Registers a `prompt` endpoint with queue group `"agents"` (§3.3) and metadata
//     `max_payload` / `attachments_ok`.
//   - Publishes heartbeats at `agents.{agent}.{owner}.{name}.heartbeat` with all §8.3 fields,
//     including `instance_id` (from the service id).
//   - Emits an empty-body no-headers terminator after each prompt (default handler).
//
// Third parties can use this as a canonical counterparty for their own test
// suites. Exported via the `@synadia/agents/testing` subpath.

import type { NatsConnection } from "@nats-io/nats-core";
import { Svcm, type Service, type ServiceMsg } from "@nats-io/services";
import { PROMPT_QUEUE_GROUP, SERVICE_NAME } from "../internal/service-name.js";
import { SDK_PROTOCOL_VERSION } from "../version.js";

export type ReferenceAgentPromptHandler = (msg: ServiceMsg) => void | Promise<void>;

export interface ReferenceAgentOptions {
  /** Active NATS connection. */
  readonly nc: NatsConnection;
  /** `metadata.agent` — canonical harness identifier (e.g. `"claude-code"`). */
  readonly agent: string;
  /** `metadata.owner` — operator / account. */
  readonly owner: string;
  /** Instance name — 4th subject token. */
  readonly name: string;
  /** `metadata.session` — set for session-aware harnesses. */
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
  /**
   * Override the 2nd subject token — useful when a deployment uses the
   * abbreviation convention (e.g. `"cc"` for `"claude-code"`). Defaults to
   * `agent` verbatim.
   */
  readonly subjectAgentToken?: string;
  /** Extra metadata keys merged into the service metadata (forward-compat). */
  readonly extraMetadata?: Readonly<Record<string, string>>;
}

const DEFAULT_MAX_PAYLOAD = "1MB";
const DEFAULT_HEARTBEAT_INTERVAL_S = 1;
const DEFAULT_VERSION = "0.0.1";

export class ReferenceAgent {
  readonly #options: ReferenceAgentOptions;
  readonly #promptSubject: string;
  readonly #heartbeatSubject: string;
  #service: Service | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ReferenceAgentOptions) {
    this.#options = options;
    const agentToken = options.subjectAgentToken ?? options.agent;
    this.#promptSubject = `agents.${agentToken}.${options.owner}.${options.name}`;
    this.#heartbeatSubject = `${this.#promptSubject}.heartbeat`;
  }

  /** Prompt endpoint subject this agent listens on. */
  get promptSubject(): string {
    return this.#promptSubject;
  }

  /** Heartbeat subject this agent publishes on. */
  get heartbeatSubject(): string {
    return this.#heartbeatSubject;
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
      agent: this.#options.agent,
      owner: this.#options.owner,
      protocol_version: `${SDK_PROTOCOL_VERSION.major}.${SDK_PROTOCOL_VERSION.minor}`,
      ...this.#options.extraMetadata,
    };
    if (this.#options.session !== undefined) {
      metadata["session"] = this.#options.session;
    }

    this.#service = await svcm.add({
      name: SERVICE_NAME,
      version: this.#options.version ?? DEFAULT_VERSION,
      description: this.#options.description ?? `${this.#options.agent} reference agent`,
      metadata,
    });

    const attachmentsOk = this.#options.attachmentsOk ?? true;
    const maxPayload = this.#options.maxPayload ?? DEFAULT_MAX_PAYLOAD;

    const promptHandler = this.#options.promptHandler ?? defaultTerminatorHandler;

    this.#service.addEndpoint("prompt", {
      subject: this.#promptSubject,
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

  #startHeartbeats(): void {
    const intervalS = this.#options.heartbeatIntervalS ?? DEFAULT_HEARTBEAT_INTERVAL_S;
    const publish = (): void => {
      const service = this.#service;
      if (!service) return;
      const payload: Record<string, unknown> = {
        agent: this.#options.agent,
        owner: this.#options.owner,
        instance_id: service.info().id,
        ts: new Date().toISOString(),
        interval_s: intervalS,
      };
      if (this.#options.session !== undefined) {
        payload["session"] = this.#options.session;
      }
      this.#options.nc.publish(this.#heartbeatSubject, JSON.stringify(payload));
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
