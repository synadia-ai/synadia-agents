import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  client as acpClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ActiveSession,
  type ClientConnection,
  type ClientContext,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { selectPermissionOutcome } from "./permissions.js";

const STDERR_TAIL_BYTES = 12_000;

export interface AcpAgentClientOptions {
  /** Binary to spawn (e.g. `grok`). */
  readonly command: string;
  /** Args that put it in ACP-over-stdio mode (e.g. `["agent", "stdio"]`). */
  readonly args: readonly string[];
  /** Working directory for the child process. */
  readonly cwd: string;
  /** Extra env merged over `process.env` (e.g. an isolated `GROK_HOME`). */
  readonly env?: Record<string, string | undefined>;
}

export type PermissionRequestHandler = (
  params: RequestPermissionRequest,
) => Promise<RequestPermissionResponse> | RequestPermissionResponse;

/**
 * Spawns an ACP agent subprocess and drives it over newline-delimited
 * JSON-RPC via the official `@agentclientprotocol/sdk` client.
 *
 * The class owns the child process and the ACP connection; permission
 * requests from the agent route through a swappable handler (default:
 * deny). Session updates are consumed through the SDK's `ActiveSession`
 * helper (see {@link startSession}), not a callback — the managed runtime
 * reads them turn-by-turn.
 */
export class AcpAgentClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #connection: ClientConnection;
  readonly #exit: Promise<never>;
  #stderrTail = "";
  #closing = false;
  #permissionHandler: PermissionRequestHandler | undefined;

  private constructor(child: ChildProcessWithoutNullStreams, command: string) {
    this.#child = child;

    child.stderr.on("data", (chunk: Buffer) => {
      this.#stderrTail = (this.#stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
    });

    // Rejects when the child dies unexpectedly. Raced against every request
    // so a crashed agent surfaces as a rejected promise instead of a hang
    // (the SDK connection may or may not fail pending requests on stream
    // end — this guard makes crash behavior deterministic either way).
    this.#exit = new Promise<never>((_, reject) => {
      child.once("exit", (code, signal) => {
        if (this.#closing) return;
        const stderr = this.#stderrTail.trim();
        reject(new Error(
          `ACP agent (${command}) exited code=${code} signal=${signal}` +
          (stderr ? `; stderr tail: ${stderr.slice(-500)}` : ""),
        ));
      });
      child.once("error", (err) => {
        if (this.#closing) return;
        reject(new Error(`ACP agent (${command}) failed to spawn: ${err.message}`, { cause: err }));
      });
    });
    // Mark handled so an unobserved crash doesn't trip unhandledRejection;
    // races re-observe it per call.
    this.#exit.catch(() => {});

    // Casts route through `unknown`: node:stream's toWeb() types and the
    // bun-types/DOM web-stream declarations disagree on generics, but the
    // runtime objects are the byte streams ndJsonStream expects.
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    );
    this.#connection = acpClientApp({ name: "synadia-acp-nats-channel" })
      .onRequest(methods.client.session.requestPermission, (ctx) => this.#onPermission(ctx.params))
      .connect(stream);
  }

  static spawn(opts: AcpAgentClientOptions): AcpAgentClient {
    const child = spawn(opts.command, [...opts.args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new AcpAgentClient(child, opts.command);
  }

  /** Last ~12KB of the agent's stderr, for diagnostics. */
  get stderrTail(): string {
    return this.#stderrTail;
  }

  /** Typed context for agent-side ACP methods. */
  get agent(): ClientContext {
    return this.#connection.agent;
  }

  /**
   * Swap the permission-request handler. `undefined` restores the default
   * (deny via a `reject_*` option, else the `cancelled` outcome).
   */
  setPermissionHandler(handler: PermissionRequestHandler | undefined): void {
    this.#permissionHandler = handler;
  }

  #onPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> | RequestPermissionResponse {
    const handler = this.#permissionHandler;
    if (handler) return handler(params);
    return selectPermissionOutcome(params.options, "deny");
  }

  /** `initialize` handshake. Advertises no fs/terminal capabilities — the agent does its own I/O. */
  async initialize(): Promise<InitializeResponse> {
    return await this.raceExit(this.#connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    }));
  }

  /** `session/new` wrapped in the SDK's ActiveSession update router. */
  async startSession(cwd: string): Promise<ActiveSession> {
    return await this.raceExit(this.#connection.agent.buildSession(cwd).start());
  }

  /** Race a pending ACP call against unexpected child exit. */
  async raceExit<T>(promise: Promise<T>): Promise<T> {
    return await Promise.race([promise, this.#exit]);
  }

  async close(): Promise<void> {
    this.#closing = true;
    try {
      this.#connection.close();
    } catch {
      /* stream may already be gone */
    }
    if (this.#child.exitCode === null && !this.#child.killed) {
      this.#child.kill("SIGTERM");
    }
  }
}
