import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ActiveSession, InitializeResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import { AcpAgentClient } from "./acp-client.js";
import type { AcpBridgeClient, AcpBridgeEvent, AcpPromptRequest } from "./bridge.js";
import { resolvePermissionRequest, type AcpPermissionDecision } from "./permissions.js";
import type { AcpChannelConfig } from "./types.js";

export interface ManagedAcpRuntimeOptions {
  readonly config: AcpChannelConfig;
  /** Override the spawned command (tests/smokes point this at the fake agent). */
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string | undefined>;
  readonly permissionTimeoutMs?: number;
}

/**
 * Adapter-owned ACP agent: spawns the configured binary in ACP-stdio mode,
 * opens one long-lived session (so conversation memory persists across NATS
 * prompts), and streams each turn's `session/update` notifications as bridge
 * events.
 *
 * When the preset defines a home env var (grok: `GROK_HOME`) and no explicit
 * `agent_home` is configured, the runtime isolates the agent in an ephemeral
 * temp home which is removed on close — this also keeps grok's leader socket
 * (which lives under GROK_HOME) from multiplexing into a user's interactive
 * session. A fresh isolated home is unauthenticated; see the README auth
 * section.
 *
 * There is no subprocess supervision: if the agent crashes, in-flight and
 * subsequent prompts fail (surfaced to NATS callers as 500s) until the
 * channel is restarted. Mirrors the codex adapter's crash model.
 */
export class ManagedAcpRuntime implements AcpBridgeClient {
  readonly mode = "managed" as const;
  readonly #opts: ManagedAcpRuntimeOptions;
  readonly #ownsHome: boolean;
  #agentHome: string | undefined;
  #client: AcpAgentClient | undefined;
  #session: ActiveSession | undefined;
  #initInfo: InitializeResponse | undefined;
  #turnLock: Promise<void> = Promise.resolve();

  constructor(opts: ManagedAcpRuntimeOptions) {
    this.#opts = opts;
    const acp = opts.config.acp;
    this.#ownsHome = acp.homeEnvVar !== undefined && acp.agentHome === undefined;
    if (acp.agentHome !== undefined) {
      this.#agentHome = resolve(acp.agentHome);
    }
  }

  /** Resolved agent home (explicit or ephemeral); read-only for callers. */
  get agentHome(): string | undefined {
    return this.#agentHome;
  }

  get ready(): boolean {
    return this.#session !== undefined;
  }

  get initializeResponse(): InitializeResponse | undefined {
    return this.#initInfo;
  }

  get stderrTail(): string {
    return this.#client?.stderrTail ?? "";
  }

  async start(): Promise<void> {
    if (this.#session) return;
    const acp = this.#opts.config.acp;
    const env: Record<string, string | undefined> = { ...this.#opts.env };
    if (acp.homeEnvVar !== undefined) {
      env[acp.homeEnvVar] = this.#ensureHome();
    }
    const client = AcpAgentClient.spawn({
      command: this.#opts.command ?? acp.bin,
      args: this.#opts.args ?? acp.args,
      cwd: acp.cwd,
      env,
    });
    this.#client = client;
    try {
      this.#initInfo = await client.initialize();
      this.#session = await client.startSession(acp.cwd);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stderr = client.stderrTail.trim();
      const hint = acp.homeEnvVar !== undefined && this.#ownsHome
        ? ` Hint: managed mode runs ${acp.bin} in an isolated ${acp.homeEnvVar}; if the agent requires authentication, ` +
          `authenticate it once and pass --agent-home pointing at that home (e.g. ~/.grok).`
        : "";
      await this.close();
      throw new Error(
        `failed to start managed ACP agent (${acp.bin}): ${message}` +
        (stderr ? `; agent stderr tail: ${stderr.slice(-500)}` : "") +
        hint,
        { cause: err },
      );
    }
  }

  async *prompt(input: AcpPromptRequest): AsyncIterable<AcpBridgeEvent> {
    await this.start();
    const client = this.#client;
    const session = this.#session;
    if (!client || !session) throw new Error("managed ACP runtime failed to start");

    // ACP allows one in-flight `session/prompt` per session; serialize turns
    // so overlapping NATS requests queue instead of violating the protocol.
    const release = await this.#acquireTurn();
    try {
      yield { type: "status", text: "managed ACP agent ready" };
      client.setPermissionHandler((params) => resolvePermissionRequest(params, {
        policy: input.permissionPolicy,
        ...(input.askPermission !== undefined
          ? { sink: (prompt: string): Promise<AcpPermissionDecision> => input.askPermission!(prompt) }
          : {}),
        timeoutMs: this.#opts.permissionTimeoutMs ?? 30_000,
      }));
      try {
        const turn = session.prompt(input.prompt);
        // On success the SDK also queues a `stop` message, so the loop below
        // ends via nextUpdate(). On failure nothing is queued — race the
        // rejection in so a JSON-RPC error can't hang the stream.
        const failed = new Promise<never>((_, reject) => { turn.catch(reject); });
        for (;;) {
          const message = await client.raceExit(Promise.race([session.nextUpdate(), failed]));
          if (message.kind === "stop") {
            if (message.stopReason !== "end_turn") {
              yield { type: "status", text: `stop: ${message.stopReason}` };
            }
            break;
          }
          const event = mapSessionUpdate(message.update);
          if (event) yield event;
        }
      } finally {
        client.setPermissionHandler(undefined);
      }
    } finally {
      release();
    }
    yield { type: "done" };
  }

  async close(): Promise<void> {
    this.#session?.dispose();
    this.#session = undefined;
    await this.#client?.close();
    this.#client = undefined;
    if (this.#ownsHome && this.#agentHome !== undefined) {
      rmSync(this.#agentHome, { recursive: true, force: true });
      this.#agentHome = undefined;
    }
  }

  #ensureHome(): string {
    if (this.#agentHome === undefined) this.#agentHome = mkdtempSync(join(tmpdir(), "synadia-acp-home-"));
    mkdirSync(this.#agentHome, { recursive: true });
    return this.#agentHome;
  }

  async #acquireTurn(): Promise<() => void> {
    const prev = this.#turnLock;
    let release!: () => void;
    this.#turnLock = new Promise<void>((res) => { release = res; });
    await prev;
    return release;
  }
}

/**
 * Map one ACP `session/update` onto a bridge event. Assistant text becomes
 * response chunks; tool calls and plans surface as terse status chunks;
 * thoughts and echo/user chunks are dropped.
 */
export function mapSessionUpdate(update: SessionUpdate): AcpBridgeEvent | undefined {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (update.content.type === "text" && update.content.text.length > 0) {
        return { type: "response", text: update.content.text };
      }
      return undefined;
    case "tool_call":
      return { type: "status", text: `tool: ${update.title ?? update.toolCallId}` };
    case "tool_call_update": {
      const status = update.status;
      if (status === "completed" || status === "failed") {
        return { type: "status", text: `tool ${status}: ${update.title ?? update.toolCallId}` };
      }
      return undefined;
    }
    case "plan":
      return { type: "status", text: `plan: ${update.entries.length} step(s)` };
    default:
      return undefined;
  }
}
