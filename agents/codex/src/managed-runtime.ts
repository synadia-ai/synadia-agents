import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CodexBridgeClient, CodexBridgeEvent, CodexPromptRequest } from "./bridge.js";
import { CodexAppServerClient } from "./codex-app-server-client.js";
import type { CodexChannelConfig } from "./types.js";

export interface ManagedCodexRuntimeOptions {
  readonly config: CodexChannelConfig;
  readonly cwd?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string | undefined>;
  readonly permissionTimeoutMs?: number;
}

export class ManagedCodexRuntime implements CodexBridgeClient {
  readonly mode = "managed" as const;
  readonly codeHome: string;
  readonly #opts: ManagedCodexRuntimeOptions;
  #client: CodexAppServerClient | undefined;

  constructor(opts: ManagedCodexRuntimeOptions) {
    this.#opts = opts;
    this.codeHome = resolve(opts.config.codex.codeHome ?? mkdtempSync(join(tmpdir(), "synadia-codex-home-")));
    mkdirSync(this.codeHome, { recursive: true });
  }

  get ready(): boolean { return this.#client !== undefined; }
  get threadId(): string | undefined { return this.#client?.threadId; }
  get stderrTail(): string { return this.#client?.stderrTail ?? ""; }

  async start(): Promise<void> {
    if (this.#client) return;
    const spawnOpts: { command: string; args?: readonly string[]; cwd: string; env: Record<string, string | undefined>; permissionTimeoutMs: number } = {
      command: this.#opts.command ?? this.#opts.config.codex.codexBin,
      cwd: this.#opts.cwd ?? process.cwd(),
      env: { ...this.#opts.env, CODEX_HOME: this.codeHome },
      permissionTimeoutMs: this.#opts.permissionTimeoutMs ?? 30_000,
    };
    if (this.#opts.args !== undefined) spawnOpts.args = this.#opts.args;
    const client = CodexAppServerClient.spawn(spawnOpts);
    await client.initialize();
    await client.startThread({ cwd: this.#opts.cwd ?? process.cwd(), approvalPolicy: "never" });
    this.#client = client;
  }

  async *prompt(input: CodexPromptRequest): AsyncIterable<CodexBridgeEvent> {
    await this.start();
    const client = this.#client;
    if (!client) throw new Error("Managed Codex runtime failed to start");
    yield { type: "status", text: "managed Codex app-server ready" };
    client.setPermissionSink(input.permissionPolicy === "query" && input.askPermission
      ? (request) => input.askPermission!(request.prompt)
      : undefined);
    try {
      for await (const event of client.turn(input.prompt, { cwd: this.#opts.cwd ?? process.cwd() })) {
        yield event.type === "response" ? { type: "response", text: event.text } : { type: "status", text: event.text };
      }
    } finally {
      client.setPermissionSink(undefined);
    }
    yield { type: "done" };
  }

  async close(): Promise<void> {
    await this.#client?.close();
    this.#client = undefined;
  }
}
