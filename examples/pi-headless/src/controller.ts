// pi-headless controller service.
//
// AgentService owns the protocol prompt/status endpoints, sender admission,
// stream lifecycle, and heartbeats. Its extension endpoints preserve the
// controller's spawn/stop/list request/reply wire contract.

import type { NatsConnection } from "@nats-io/nats-core";
import type { ServiceMsg } from "@nats-io/services";
import {
  formatSender,
  type MinSenderTrust,
  type SenderSigner,
} from "@synadia-ai/agents";
import { AgentService, type PromptResponse } from "@synadia-ai/agent-service";

import {
  controllerListSubject,
  controllerPromptSubject,
  controllerSpawnSubject,
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
  /** Connection-bound signer shared by the controller and every session. */
  readonly signer?: SenderSigner;
  readonly minSenderTrust?: MinSenderTrust;
  readonly logger?: (line: string) => void;
}

const DEFAULT_VERSION = "0.4.0";
const DEFAULT_HEARTBEAT_INTERVAL_S = 5;

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
    "sessions. Each spawned session registers as its own logical NATS agent at",
    "`agents.prompt.pi-headless.<owner>.<session_id>` and speaks the standard NATS",
    "Agent Protocol v0.3 — discover it via $SRV.INFO.agents and prompt it like any agent.",
    "The controller and sessions share this process's one NATS connection identity.",
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
  private service: AgentService | null = null;

  constructor(opts: ControllerOptions) {
    this.opts = opts;
    this.log = opts.logger ?? ((line) => process.stderr.write(`${line}\n`));
    this.promptSubject = controllerPromptSubject(opts.owner, opts.name);
  }

  get instanceId(): string {
    if (!this.service) throw new Error("Controller not started");
    return this.service.instanceId;
  }

  async start(): Promise<void> {
    if (this.service) return;
    const service = new AgentService({
      nc: this.opts.nc,
      agent: "pi-headless",
      owner: this.opts.owner,
      name: this.opts.name,
      version: this.opts.version ?? DEFAULT_VERSION,
      description: `pi-headless controller (${this.opts.owner}/${this.opts.name})`,
      attachmentsOk: false,
      heartbeatIntervalS:
        this.opts.heartbeatIntervalS ?? DEFAULT_HEARTBEAT_INTERVAL_S,
      minSenderTrust: this.opts.minSenderTrust ?? "any",
      ...(this.opts.signer ? { identity: { signer: this.opts.signer } } : {}),
      extraMetadata: { role: "controller" },
      extraEndpoints: [
        {
          name: "spawn",
          subject: controllerSpawnSubject(this.opts.owner, this.opts.name),
          handler: (err, msg) => {
            if (err) return;
            void this.handleSpawn(msg);
          },
        },
        {
          name: "stop",
          subject: controllerStopSubject(this.opts.owner, this.opts.name),
          handler: (err, msg) => {
            if (err) return;
            void this.handleStop(msg);
          },
        },
        {
          name: "list",
          subject: controllerListSubject(this.opts.owner, this.opts.name),
          handler: (err, msg) => {
            if (err) return;
            void this.handleList(msg);
          },
        },
      ],
    });
    service.onPrompt((_envelope, response) => this.handleHelp(response));
    try {
      await service.start();
    } catch (e) {
      try {
        await service.stop();
      } catch {
        /* noop */
      }
      throw e;
    }
    this.service = service;
    this.log(`pi-headless: controller listening on ${this.promptSubject}`);
    this.log(
      `pi-headless: control endpoints — ${controllerSpawnSubject(this.opts.owner, this.opts.name)}, ${controllerStopSubject(this.opts.owner, this.opts.name)}, ${controllerListSubject(this.opts.owner, this.opts.name)}`,
    );
  }

  async stop(): Promise<void> {
    const service = this.service;
    this.service = null;
    if (!service) return;
    try {
      await service.stop();
    } catch {
      /* noop */
    }
  }

  private async handleHelp(response: PromptResponse): Promise<void> {
    // Sender metadata is emitted only to the operator diagnostic. It is never
    // added to a spawned PI session's model prompt.
    this.log(
      `pi-headless: controller prompt sender=${formatSender(response.sender)}`,
    );
    await response.send(
      helpText(
        this.promptSubject,
        controllerSpawnSubject(this.opts.owner, this.opts.name),
        controllerStopSubject(this.opts.owner, this.opts.name),
        controllerListSubject(this.opts.owner, this.opts.name),
      ),
    );
  }

  private async handleSpawn(msg: ServiceMsg): Promise<void> {
    let spec: SpawnSpec;
    try {
      const raw = msg.string();
      spec =
        raw.length === 0
          ? ({ cwd: "" } as SpawnSpec)
          : (JSON.parse(raw) as SpawnSpec);
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
      const parsed =
        raw.length === 0 ? {} : (JSON.parse(raw) as { session_id?: unknown });
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
}
