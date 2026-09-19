// Production AgentService-backed controller for claude-code-headless.
//
// The protocol-required prompt/status/heartbeat behavior comes from
// AgentService. Spawn/stop/list remain extension endpoints registered on the
// same service through extraEndpoints.

import type { NatsConnection } from "@nats-io/nats-core";
import type { ServiceMsg } from "@nats-io/services";
import type { MinSenderTrust, SenderSigner } from "@synadia-ai/agents";
import { AgentService, type AgentServiceExtraEndpoint } from "@synadia-ai/agent-service";

import {
  controllerListSubject,
  controllerSpawnSubject,
  controllerStopSubject,
} from "./subjects.js";
import type { ClaudeSessionManager, SpawnSpec } from "./claude-session-manager.js";
import { protocolLogger } from "./protocol-logger.js";
import { PACKAGE_VERSION } from "./version.js";

export interface ControllerOptions {
  readonly nc: NatsConnection;
  readonly owner: string;
  readonly name: string;
  readonly manager: ClaudeSessionManager;
  readonly signer?: SenderSigner;
  readonly minSenderTrust?: MinSenderTrust;
  readonly heartbeatIntervalS?: number;
  readonly logger?: (line: string) => void;
}

const DEFAULT_HEARTBEAT_INTERVAL_S = 5;

const helpText = (
  promptSubject: string,
  spawnSubject: string,
  stopSubject: string,
  listSubject: string,
): string =>
  [
    `claude-code-headless controller @ ${promptSubject}`,
    "",
    "This is a control-plane agent. It spawns, stops, and lists Claude Code",
    "sessions backed by @anthropic-ai/claude-agent-sdk. Each spawned session",
    "registers as a logical NATS agent at `agents.prompt.cc-headless.<owner>.<session_id>`",
    "and speaks the standard Synadia Agent Protocol for NATS v0.3 — discover it via",
    "$SRV.INFO.agents and prompt it like any agent.",
    "",
    "Custom endpoints on this controller:",
    `  spawn : ${spawnSubject}`,
    '    req : { "cwd": "/abs/path", "session_id"?: string,',
    '            "model"?: "claude-sonnet-4-6", "allowed_tools"?: ["Read", ...],',
    '            "permission_mode"?: "dontAsk|acceptEdits|bypassPermissions|plan|default",',
    '            "max_turns"?: number, "max_lifetime_s"?: number }',
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
  private readonly agentService: AgentService;

  constructor(opts: ControllerOptions) {
    this.opts = opts;
    this.log = opts.logger ?? ((line) => process.stderr.write(`${line}\n`));

    const spawnSubject = controllerSpawnSubject(opts.owner, opts.name);
    const stopSubject = controllerStopSubject(opts.owner, opts.name);
    const listSubject = controllerListSubject(opts.owner, opts.name);
    const extraEndpoints: AgentServiceExtraEndpoint[] = [
      {
        name: "spawn",
        subject: spawnSubject,
        handler: (err, msg) => {
          if (!err) {
            void this.handleSpawn(msg).catch(() => this.respondError(msg, 500, "spawn failed"));
          }
        },
      },
      {
        name: "stop",
        subject: stopSubject,
        handler: (err, msg) => {
          if (!err) {
            void this.handleStop(msg).catch(() => this.respondError(msg, 500, "stop failed"));
          }
        },
      },
      {
        name: "list",
        subject: listSubject,
        handler: (err, msg) => {
          if (!err) this.handleList(msg);
        },
      },
    ];

    this.agentService = new AgentService({
      nc: opts.nc,
      agent: "cc-headless",
      owner: opts.owner,
      name: opts.name,
      description: `claude-code-headless controller (${opts.owner}/${opts.name})`,
      version: PACKAGE_VERSION,
      attachmentsOk: false,
      heartbeatIntervalS: opts.heartbeatIntervalS ?? DEFAULT_HEARTBEAT_INTERVAL_S,
      extraMetadata: { role: "controller" },
      extraEndpoints,
      minSenderTrust: opts.minSenderTrust ?? "any",
      logger: protocolLogger,
      ...(opts.signer ? { identity: { signer: opts.signer } } : {}),
    });
    this.agentService.onPrompt(async (_envelope, response) => {
      await response.send(
        helpText(this.agentService.subject.prompt, spawnSubject, stopSubject, listSubject),
      );
    });
  }

  get instanceId(): string {
    return this.agentService.instanceId;
  }

  async start(): Promise<void> {
    await this.agentService.start();
    this.log(`claude-code-headless: controller listening on ${this.agentService.subject.prompt}`);
    this.log(
      `claude-code-headless: control endpoints — ${controllerSpawnSubject(this.opts.owner, this.opts.name)}, ${controllerStopSubject(this.opts.owner, this.opts.name)}, ${controllerListSubject(this.opts.owner, this.opts.name)}`,
    );
  }

  async stop(): Promise<void> {
    await this.agentService.stop();
  }

  private async handleSpawn(msg: ServiceMsg): Promise<void> {
    let spec: SpawnSpec;
    try {
      const raw = msg.string();
      spec = raw.length === 0 ? ({ cwd: "" } as SpawnSpec) : (JSON.parse(raw) as SpawnSpec);
    } catch {
      this.respondError(msg, 400, "invalid JSON");
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
      /* connection gone */
    }
  }

  private async handleStop(msg: ServiceMsg): Promise<void> {
    let sessionId: string;
    try {
      const raw = msg.string();
      const parsed = raw.length === 0 ? {} : (JSON.parse(raw) as { session_id?: unknown });
      if (typeof parsed.session_id !== "string" || parsed.session_id.length === 0) {
        this.respondError(msg, 400, "session_id is required");
        return;
      }
      sessionId = parsed.session_id;
    } catch {
      this.respondError(msg, 400, "invalid JSON");
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
      /* connection gone */
    }
  }

  private handleList(msg: ServiceMsg): void {
    try {
      msg.respond(JSON.stringify({ sessions: this.opts.manager.list() }));
    } catch {
      /* connection gone */
    }
  }

  private respondError(msg: ServiceMsg, code: number, message: string): void {
    try {
      msg.respondError(code, message);
    } catch {
      /* connection gone */
    }
  }
}
