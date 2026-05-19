// ACP client for gemini-cli (`gemini --acp`).
//
// Spawns the gemini-cli process in ACP mode and talks ACP JSON-RPC over
// its stdio via `ClientSideConnection` from `@agentclientprotocol/sdk`.
//
//   - `initialize()`              once on first prompt
//   - `newSession({ cwd })`       lazily on first prompt
//   - `prompt(text, onUpdate)`    one inbound NATS request → one ACP prompt
//   - `cancel()`                  forwarded from caller disconnect
//   - `close()`                   tear the subprocess down
//
// gemini-cli's `--acp` flag is the current native ACP entrypoint;
// `--experimental-acp` is accepted as a deprecated alias.

import { spawn } from "node:child_process";
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
   * Argv to launch the ACP harness as a subprocess. Defaults to
   * `["gemini", "--acp"]`. Override via `GEMINI_ACP_COMMAND`.
   */
  readonly command: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly onSessionUpdate: (notification: SessionNotification) => void | Promise<void>;
  readonly onPermissionRequest: (
    request: RequestPermissionRequest,
  ) => Promise<RequestPermissionResponse>;
  readonly logger?: Logger;
}

export interface AcpClient {
  prompt(text: string, signal?: AbortSignal): Promise<PromptResponse>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

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
      throw RequestError.methodNotFound("fs/read_text_file");
    },
    async writeTextFile(_: WriteTextFileRequest): Promise<WriteTextFileResponse> {
      throw RequestError.methodNotFound("fs/write_text_file");
    },
  };

  const connection = new ClientSideConnection(() => handler, stream);
  const agent: Agent = connection;

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

  const init: InitializeResponse = await agent.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
    },
    clientInfo: {
      name: "synadia-nats-gemini-channel",
      version: "0.0.1",
    },
  });

  opts.logger?.info?.("acp-client: initialized", {
    protocolVersion: init.protocolVersion,
    authMethods: init.authMethods?.map((m) => m.id) ?? [],
  });

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
      await agent.cancel(note);
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
      return await agent.prompt({
        sessionId,
        prompt: [block],
      });
    } finally {
      signal?.removeEventListener("abort", onParentAbort);
      if (activePromptAbort === localAbort) activePromptAbort = undefined;
    }
  };

  return { prompt, cancel, close };
}

export function defaultLaunchCommand(): string[] {
  const override = process.env["GEMINI_ACP_COMMAND"];
  if (override !== undefined && override.length > 0) {
    return splitCommand(override);
  }
  return ["gemini", "--acp"];
}

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
 * Build the env passed to the gemini-cli subprocess. gemini-cli reads
 * credentials from `~/.config/gemini/` (OAuth) and/or `GEMINI_API_KEY`
 * / `GOOGLE_API_KEY`. We also pass the standard ADC env var so users
 * with `gcloud auth application-default login` keep working.
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
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GEMINI_MODEL",
  ]);
  const out: Record<string, string> = {};
  for (const key of allow) {
    const v = source[key];
    if (typeof v === "string" && v.length > 0) out[key] = v;
  }
  return out;
}
