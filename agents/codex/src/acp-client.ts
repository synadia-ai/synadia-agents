// ACP client for codex-acp.
//
// Spawns the ACP server as a child process, talks ACP JSON-RPC over its
// stdio via `ClientSideConnection` from `@agentclientprotocol/sdk`, and
// exposes a small surface tailored to the NATS bridge:
//
//   - `initialize()`              once on first prompt
//   - `newSession({ cwd })`       lazily on first prompt
//   - `prompt(text, onUpdate)`    one inbound NATS request → one ACP prompt
//   - `cancel()`                  forwarded from caller disconnect
//   - `close()`                   tear the subprocess down
//
// Permission requests from the agent are routed through a caller-supplied
// `onPermissionRequest` hook. For v0.1 the bridge supplies a default-deny
// stub (see `bridge.ts`); future versions will relay these as Synadia §7
// `query` chunks.

import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
  type Agent,
  type CancelNotification,
  type Client,
  type ContentBlock,
  type InitializeResponse,
  type NewSessionResponse,
  type PromptResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from "@agentclientprotocol/sdk";

import type { Logger } from "@synadia-ai/agents";

export interface AcpLaunchOptions {
  /**
   * Argv to launch the ACP harness as a subprocess. e.g.
   * `["npx", "-y", "@zed-industries/codex-acp"]` or
   * `["codex-acp"]`. Override via `CODEX_ACP_COMMAND` env.
   */
  readonly command: ReadonlyArray<string>;
  /** Environment variables forwarded to the child. */
  readonly env: Readonly<Record<string, string>>;
  /** Initial working directory passed to `session/new`. */
  readonly cwd: string;
  /**
   * Called for every ACP `session/update` notification while a prompt is
   * in flight. The bridge fans these out to NATS via the chunk translator.
   */
  readonly onSessionUpdate: (notification: SessionNotification) => void | Promise<void>;
  /**
   * Hook for `session/request_permission`. v0.1 bridge supplies a
   * default-deny implementation; future versions will relay these as
   * Synadia §7 `query` chunks. See `bridge.ts`.
   */
  readonly onPermissionRequest: (
    request: RequestPermissionRequest,
  ) => Promise<RequestPermissionResponse>;
  /** Optional logger; defaults to silent. */
  readonly logger?: Logger;
}

export interface AcpClient {
  /** Send a prompt and resolve when the turn completes. */
  prompt(text: string, signal?: AbortSignal): Promise<PromptResponse>;
  /** Forward a §6.6-equivalent cancel for the active prompt. */
  cancel(): Promise<void>;
  /** Tear the subprocess down. Safe to call multiple times. */
  close(): Promise<void>;
}

/** Spawn the ACP harness, complete the `initialize` + `session/new` handshake. */
export async function startAcpClient(opts: AcpLaunchOptions): Promise<AcpClient> {
  if (opts.command.length === 0) {
    throw new Error("AcpLaunchOptions.command must include at least one entry");
  }
  const [bin, ...args] = opts.command;

  const child = spawn(bin as string, args, {
    env: opts.env as NodeJS.ProcessEnv,
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (child.stdin === null || child.stdout === null) {
    child.kill("SIGKILL");
    throw new Error(`ACP child '${bin}' did not expose stdin/stdout`);
  }

  // Forward child stderr to our stderr so harness errors surface in the
  // bridge log. Don't crash on read errors; the JSON-RPC stream
  // detects closure separately.
  if (child.stderr !== null) {
    child.stderr.on("data", (buf: Buffer) => {
      try {
        process.stderr.write(buf);
      } catch {
        /* ignore */
      }
    });
  }

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );

  let sessionId: string | undefined;
  let activePromptAbort: AbortController | undefined;

  const handler: Client = {
    async sessionUpdate(notification: SessionNotification): Promise<void> {
      // Filter to the active session; future-proof against an agent
      // emitting updates for a previously-closed session.
      if (sessionId !== undefined && notification.sessionId !== sessionId) return;
      try {
        await opts.onSessionUpdate(notification);
      } catch (err) {
        opts.logger?.warn?.("acp-client: onSessionUpdate handler threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    async requestPermission(
      request: RequestPermissionRequest,
    ): Promise<RequestPermissionResponse> {
      return opts.onPermissionRequest(request);
    },
    async readTextFile(_: ReadTextFileRequest): Promise<ReadTextFileResponse> {
      // The bridge does not advertise `fs.readTextFile` capability. If the
      // agent calls it anyway, surface as a method-not-found error so the
      // harness can handle the absence gracefully.
      throw RequestError.methodNotFound("fs/read_text_file");
    },
    async writeTextFile(_: WriteTextFileRequest): Promise<WriteTextFileResponse> {
      throw RequestError.methodNotFound("fs/write_text_file");
    },
  };

  let agent: Agent | undefined;
  // ClientSideConnection wires both directions; we hold the agent-side
  // proxy returned by its constructor pipeline. The SDK exposes it via
  // the connection instance itself — `connection` implements `Agent`.
  const connection = new ClientSideConnection(() => handler, stream);
  agent = connection;

  // Detect early child exit during the handshake.
  let childExited = false;
  child.on("exit", (code, signal) => {
    childExited = true;
    opts.logger?.info?.("acp-client: child exited", {
      code,
      signal: signal ?? undefined,
    });
    activePromptAbort?.abort();
  });
  child.on("error", (err) => {
    opts.logger?.error?.("acp-client: child spawn error", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // 1. initialize
  const init: InitializeResponse = await agent.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
    },
    clientInfo: {
      name: "synadia-nats-codex-channel",
      version: "0.0.1",
    },
  });

  opts.logger?.info?.("acp-client: initialized", {
    protocolVersion: init.protocolVersion,
    authMethods: init.authMethods?.map((m) => m.id) ?? [],
  });

  // 2. session/new
  const newSession: NewSessionResponse = await agent.newSession({
    cwd: opts.cwd,
    mcpServers: [],
  });
  sessionId = newSession.sessionId;
  opts.logger?.info?.("acp-client: session ready", { sessionId });

  const close = async (): Promise<void> => {
    if (!childExited) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
  };

  const cancel = async (): Promise<void> => {
    if (sessionId === undefined) return;
    const note: CancelNotification = { sessionId };
    try {
      await agent!.cancel(note);
    } catch (err) {
      opts.logger?.warn?.("acp-client: cancel forward failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    activePromptAbort?.abort();
  };

  const prompt = async (text: string, signal?: AbortSignal): Promise<PromptResponse> => {
    if (sessionId === undefined) {
      throw new Error("acp-client: prompt before session/new");
    }
    const block: ContentBlock = { type: "text", text };
    const localAbort = new AbortController();
    activePromptAbort = localAbort;
    const onParentAbort = (): void => {
      void cancel();
    };
    signal?.addEventListener("abort", onParentAbort, { once: true });
    try {
      const response = await agent!.prompt({
        sessionId,
        prompt: [block],
      });
      return response;
    } finally {
      signal?.removeEventListener("abort", onParentAbort);
      if (activePromptAbort === localAbort) activePromptAbort = undefined;
    }
  };

  return { prompt, cancel, close };
}

/** Resolve `command` + `env` from process env. Exported for the smoke test. */
export function defaultLaunchCommand(): string[] {
  const override = process.env["CODEX_ACP_COMMAND"];
  if (override !== undefined && override.length > 0) {
    return splitCommand(override);
  }
  return ["npx", "-y", "@zed-industries/codex-acp"];
}

/** Minimal shell-style splitter; supports double-quoted args. */
export function splitCommand(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && /\s/.test(c as string)) {
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += c;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * Build the env passed to the codex-acp subprocess. Keeps secrets that the
 * harness actually needs (`OPENAI_API_KEY`, `CODEX_API_KEY`) plus a
 * minimal allowlist of process-runtime vars (`PATH`, `HOME`, `TMPDIR`,
 * locale). Everything else is dropped so the bridge doesn't leak
 * unrelated secrets into the child.
 */
export function buildChildEnv(
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  const allow = new Set([
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "USER",
    "LOGNAME",
    "SHELL",
    "NODE_OPTIONS",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORG_ID",
    "CODEX_API_KEY",
    "CODEX_HOME",
  ]);
  const out: Record<string, string> = {};
  for (const key of allow) {
    const v = source[key];
    if (typeof v === "string" && v.length > 0) out[key] = v;
  }
  return out;
}
