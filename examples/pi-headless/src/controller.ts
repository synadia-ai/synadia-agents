// pi-headless controller service.
//
// One protocol-compliant NATS agent that uses the 3rd subject token `pi`
// (the verb `prompt` lives at token 2 per §2 v0.3) and exposes endpoints:
//
//   - `prompt`  (§5/§6-compliant)  — returns a help-text response, so the
//                                    controller is usable with `nats req`.
//   - `status`  (v0.3 §-TBD)       — replies with a heartbeat-shaped payload.
//   - `spawn`   (request/reply)    — creates a new PI session, registers it
//                                    as its own NATS agent instance.
//   - `stop`    (request/reply)    — disposes a session.
//   - `list`    (request/reply)    — returns an array of session summaries.
//
// Heartbeats go to `agents.hb.pi.<owner>.<name>` every 30s (§8.1 v0.3).

import type { NatsConnection } from "@nats-io/nats-core";
import { Svcm, type Service, type ServiceMsg } from "@nats-io/services";
import {
  SDK_PROTOCOL_VERSION,
  SERVICE_NAME,
  PROMPT_QUEUE_GROUP,
  STATUS_ENDPOINT_NAME,
  STATUS_QUEUE_GROUP,
} from "@synadia-ai/agents";

import { responseText, statusAck } from "./chunk-encoder.js";
import {
  controllerHeartbeatSubject,
  controllerListSubject,
  controllerPromptSubject,
  controllerSpawnSubject,
  controllerStatusSubject,
  controllerStopSubject,
} from "./subjects.js";
import type { PiSessionManager, SpawnSpec } from "./pi-session-manager.js";

export interface ControllerOptions {
  readonly nc: NatsConnection;
  readonly owner: string;
  readonly name: string;
  readonly version?: string;
  readonly heartbeatIntervalS?: number;
  readonly manager: PiSessionManager;
  readonly logger?: (line: string) => void;
}

const DEFAULT_VERSION = "0.1.0";
const DEFAULT_HEARTBEAT_INTERVAL_S = 30;

const helpText = (
  promptSubject: string,
  spawnSubject: string,
  stopSubject: string,
  listSubject: string,
): string =>
  [
    `pi-headless controller @ ${promptSubject}`,
    "",
    "This is a control-plane agent. It spawns, stops, and lists PI coding-agent",
    "sessions. Each spawned session registers as its OWN NATS agent at",
    "`agents.prompt.pi.<owner>.<session_id>` and speaks the standard NATS Agent",
    "Protocol v0.3 — discover it via $SRV.INFO.agents and prompt it like any agent.",
    "",
    "Custom endpoints on this controller:",
    `  spawn : ${spawnSubject}`,
    '    req : { "cwd": "/abs/path", "session_id"?: string, "model"?: "anthropic/claude-sonnet-4-5",',
    '            "thinking_level"?: "off|minimal|low|medium|high|xhigh", "max_lifetime_s"?: number }',
    '    rep : { "session_id", "subject", "heartbeat_subject", "status_subject", "cwd", ... }',
    "",
    `  stop  : ${stopSubject}`,
    '    req : { "session_id": "..." }',
    '    rep : { "ok": true, "session_id": "..." }',
    "",
    `  list  : ${listSubject}`,
    "    req : (empty)",
    '    rep : { "sessions": [ { session_id, cwd, remaining_lifetime_s, ... } ] }',
  ].join("\n");

export class Controller {
  private readonly opts: ControllerOptions;
  private readonly log: (line: string) => void;
  private readonly promptSubject: string;
  private readonly heartbeatSubject: string;
  private service: Service | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private readonly statusSubject: string;

  constructor(opts: ControllerOptions) {
    this.opts = opts;
    this.log = opts.logger ?? ((line) => process.stderr.write(`${line}\n`));
    this.promptSubject = controllerPromptSubject(opts.owner, opts.name);
    this.heartbeatSubject = controllerHeartbeatSubject(opts.owner, opts.name);
    this.statusSubject = controllerStatusSubject(opts.owner, opts.name);
  }

  get instanceId(): string {
    if (!this.service) throw new Error("Controller not started");
    return this.service.info().id;
  }

  async start(): Promise<void> {
    if (this.service) return;
    const svcm = new Svcm(this.opts.nc);

    const metadata: Record<string, string> = {
      agent: "pi",
      owner: this.opts.owner,
      protocol_version: `${SDK_PROTOCOL_VERSION.major}.${SDK_PROTOCOL_VERSION.minor}`,
      role: "pi-headless-controller",
    };

    this.service = await svcm.add({
      name: SERVICE_NAME,
      version: this.opts.version ?? DEFAULT_VERSION,
      description: `pi-headless controller (${this.opts.owner}/${this.opts.name})`,
      metadata,
    });

    // §5/§6 prompt endpoint — returns help text.
    this.service.addEndpoint("prompt", {
      subject: this.promptSubject,
      queue: PROMPT_QUEUE_GROUP,
      handler: (err, msg) => {
        if (err) return;
        void this.handleHelp(msg);
      },
      metadata: {
        max_payload: "1MB",
        attachments_ok: "false",
      },
    });

    // v0.3 §-TBD status endpoint — replies with a heartbeat-shaped payload.
    this.service.addEndpoint(STATUS_ENDPOINT_NAME, {
      subject: this.statusSubject,
      queue: STATUS_QUEUE_GROUP,
      handler: (err, msg) => {
        if (err) return;
        this.handleStatus(msg);
      },
    });

    // Custom control endpoints — not protocol-standard, but allowed.
    this.service.addEndpoint("spawn", {
      subject: controllerSpawnSubject(this.opts.owner, this.opts.name),
      handler: (err, msg) => {
        if (err) return;
        void this.handleSpawn(msg);
      },
    });

    this.service.addEndpoint("stop", {
      subject: controllerStopSubject(this.opts.owner, this.opts.name),
      handler: (err, msg) => {
        if (err) return;
        void this.handleStop(msg);
      },
    });

    this.service.addEndpoint("list", {
      subject: controllerListSubject(this.opts.owner, this.opts.name),
      handler: (err, msg) => {
        if (err) return;
        void this.handleList(msg);
      },
    });

    this.startHeartbeats();
    this.log(`pi-headless: controller listening on ${this.promptSubject}`);
    this.log(
      `pi-headless: extra endpoints — ${controllerSpawnSubject(this.opts.owner, this.opts.name)}, ${controllerStopSubject(this.opts.owner, this.opts.name)}, ${controllerListSubject(this.opts.owner, this.opts.name)}`,
    );
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.service) {
      try {
        await this.service.stop();
      } catch {
        /* noop */
      }
      this.service = null;
    }
  }

  // ─── Handlers ──────────────────────────────────────────────────────────────

  private async handleHelp(msg: ServiceMsg): Promise<void> {
    try {
      msg.respond(statusAck());
      msg.respond(
        responseText(
          helpText(
            this.promptSubject,
            controllerSpawnSubject(this.opts.owner, this.opts.name),
            controllerStopSubject(this.opts.owner, this.opts.name),
            controllerListSubject(this.opts.owner, this.opts.name),
          ),
        ),
      );
    } catch {
      /* noop */
    } finally {
      try {
        msg.respond("");
      } catch {
        /* noop */
      }
    }
  }

  private handleStatus(msg: ServiceMsg): void {
    if (!this.service) return;
    const intervalS = this.opts.heartbeatIntervalS ?? DEFAULT_HEARTBEAT_INTERVAL_S;
    const payload = {
      agent: "pi",
      owner: this.opts.owner,
      instance_id: this.service.info().id,
      ts: new Date().toISOString(),
      interval_s: intervalS,
    };
    try {
      msg.respond(JSON.stringify(payload));
    } catch {
      /* noop */
    }
  }

  private async handleSpawn(msg: ServiceMsg): Promise<void> {
    let spec: SpawnSpec;
    try {
      const raw = msg.string();
      spec = raw.length === 0 ? ({ cwd: "" } as SpawnSpec) : (JSON.parse(raw) as SpawnSpec);
    } catch (e) {
      this.respondError(msg, 400, `invalid JSON: ${(e as Error).message}`);
      return;
    }

    const result = await this.opts.manager.spawn(spec);
    if ("code" in result) {
      this.respondError(msg, result.code, result.message);
      return;
    }
    try {
      msg.respond(JSON.stringify(result));
    } catch {
      /* noop */
    }
  }

  private async handleStop(msg: ServiceMsg): Promise<void> {
    let sessionId: string;
    try {
      const raw = msg.string();
      const parsed = raw.length === 0 ? {} : (JSON.parse(raw) as { session_id?: unknown });
      const value = parsed.session_id;
      if (typeof value !== "string" || value.length === 0) {
        this.respondError(msg, 400, "session_id is required");
        return;
      }
      sessionId = value;
    } catch (e) {
      this.respondError(msg, 400, `invalid JSON: ${(e as Error).message}`);
      return;
    }

    const result = await this.opts.manager.stopOne(sessionId);
    if ("code" in result) {
      this.respondError(msg, result.code, result.message);
      return;
    }
    try {
      msg.respond(JSON.stringify(result));
    } catch {
      /* noop */
    }
  }

  private async handleList(msg: ServiceMsg): Promise<void> {
    const sessions = this.opts.manager.list();
    try {
      msg.respond(JSON.stringify({ sessions }));
    } catch {
      /* noop */
    }
  }

  private respondError(msg: ServiceMsg, code: number, message: string): void {
    try {
      msg.respondError(code, message);
    } catch {
      /* noop */
    }
  }

  private startHeartbeats(): void {
    const intervalS = this.opts.heartbeatIntervalS ?? DEFAULT_HEARTBEAT_INTERVAL_S;
    const publish = (): void => {
      if (!this.service) return;
      const payload = {
        agent: "pi",
        owner: this.opts.owner,
        instance_id: this.service.info().id,
        ts: new Date().toISOString(),
        interval_s: intervalS,
      };
      try {
        this.opts.nc.publish(this.heartbeatSubject, JSON.stringify(payload));
      } catch {
        /* noop */
      }
    };
    publish();
    this.heartbeatTimer = setInterval(publish, intervalS * 1000);
    this.heartbeatTimer.unref?.();
  }
}
