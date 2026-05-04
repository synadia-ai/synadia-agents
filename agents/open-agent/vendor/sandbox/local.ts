// LocalSandbox — a `Sandbox` impl backed by `node:fs/promises` and
// `Bun.spawn`. NOT vendored. Pairs with our custom `factory.ts` so the
// vendored open-agents tools (which `connectSandbox(state)` on every
// invocation) can run unmodified against a host filesystem.
//
// Not isolated — there is no chroot/cgroup/namespace boundary. Trust the
// operator. Designed for the v1 inbound-bridge demo; production deployments
// belong on a real sandbox (the Vercel example sits behind the same factory).

import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";

import type { ExecResult, Sandbox, SandboxStats } from "./interface.js";

/** Discriminated state for {@link LocalSandbox} (mirrors `VercelState` shape). */
export interface LocalSandboxState {
  readonly type: "local";
  readonly workingDirectory: string;
  readonly env?: Record<string, string>;
}

/** 50 KB cap on combined stdout+stderr for `exec` — matches the bash tool's contract. */
const EXEC_OUTPUT_CAP_BYTES = 50_000;

class LocalSandbox implements Sandbox {
  readonly type = "cloud" as const;
  readonly workingDirectory: string;
  readonly env?: Record<string, string>;

  readonly #state: LocalSandboxState;

  constructor(state: LocalSandboxState) {
    this.workingDirectory = state.workingDirectory;
    if (state.env !== undefined) {
      this.env = state.env;
    }
    this.#state = state;
  }

  async readFile(path: string, _encoding: "utf-8"): Promise<string> {
    return fs.readFile(path, "utf-8");
  }

  async readFileBuffer(path: string): Promise<Buffer> {
    return fs.readFile(path);
  }

  async writeFile(path: string, content: string, _encoding: "utf-8"): Promise<void> {
    await fs.writeFile(path, content, "utf-8");
  }

  async stat(path: string): Promise<SandboxStats> {
    const s = await fs.stat(path);
    return {
      isDirectory: () => s.isDirectory(),
      isFile: () => s.isFile(),
      size: s.size,
      mtimeMs: s.mtimeMs,
    };
  }

  async access(path: string): Promise<void> {
    await fs.access(path);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await fs.mkdir(path, options);
  }

  async readdir(path: string, _options: { withFileTypes: true }): Promise<Dirent[]> {
    return fs.readdir(path, { withFileTypes: true });
  }

  async exec(
    command: string,
    cwd: string,
    timeoutMs: number,
    options?: { signal?: AbortSignal },
  ): Promise<ExecResult> {
    // Compose the per-call abort with the caller's signal (if any) so a
    // tool-level cancel and the per-exec timeout both cut the process.
    const timeoutCtl = new AbortController();
    const timer = setTimeout(() => timeoutCtl.abort(new Error(`exec timed out after ${timeoutMs}ms`)), timeoutMs);

    const signal = options?.signal
      ? anySignal([options.signal, timeoutCtl.signal])
      : timeoutCtl.signal;

    const env = {
      ...process.env,
      ...this.#state.env,
    };

    const proc = Bun.spawn(["bash", "-c", command], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const onAbort = (): void => {
      try {
        proc.kill();
      } catch {
        // proc may already be exited
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });

    let stdout = "";
    let stderr = "";
    let truncated = false;

    try {
      const [outText, errText, exitCode] = await Promise.all([
        readCappedStream(proc.stdout),
        readCappedStream(proc.stderr),
        proc.exited,
      ]);

      stdout = outText.text;
      stderr = errText.text;
      truncated = outText.truncated || errText.truncated;

      // Joint cap on combined size, biased to stdout.
      const total = stdout.length + stderr.length;
      if (total > EXEC_OUTPUT_CAP_BYTES) {
        const stdoutBudget = Math.min(stdout.length, EXEC_OUTPUT_CAP_BYTES);
        stdout = stdout.slice(0, stdoutBudget);
        const stderrBudget = Math.max(0, EXEC_OUTPUT_CAP_BYTES - stdout.length);
        stderr = stderr.slice(0, stderrBudget);
        truncated = true;
      }

      return {
        success: exitCode === 0,
        exitCode,
        stdout,
        stderr,
        truncated,
      };
    } catch (err) {
      // Bun rarely throws here; surface as a non-zero exit.
      return {
        success: false,
        exitCode: null,
        stdout,
        stderr: stderr || (err instanceof Error ? err.message : String(err)),
        truncated,
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  async stop(): Promise<void> {
    // No persistent resources held — caller decides whether to rm -rf the
    // working directory.
  }

  getState(): LocalSandboxState {
    return this.#state;
  }
}

/** Connect to a `LocalSandbox`. Naming mirrors `connectVercelSandbox`. */
export async function connectLocalSandbox(state: LocalSandboxState): Promise<Sandbox> {
  await fs.mkdir(state.workingDirectory, { recursive: true });
  return new LocalSandbox(state);
}

async function readCappedStream(
  stream: ReadableStream<Uint8Array> | undefined,
): Promise<{ text: string; truncated: boolean }> {
  if (!stream) return { text: "", truncated: false };
  const decoder = new TextDecoder("utf-8");
  let text = "";
  let truncated = false;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (text.length >= EXEC_OUTPUT_CAP_BYTES) {
        truncated = true;
        continue;
      }
      const piece = decoder.decode(value, { stream: true });
      const remaining = EXEC_OUTPUT_CAP_BYTES - text.length;
      if (piece.length > remaining) {
        text += piece.slice(0, remaining);
        truncated = true;
      } else {
        text += piece;
      }
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return { text, truncated };
}

// Tiny AbortSignal.any fallback — Node 20 ships AbortSignal.any but Bun
// has shipped it for a while too. Use a typed shim so this compiles
// against the Node 20 baseline targeted by `tsconfig.json`.
function anySignal(signals: AbortSignal[]): AbortSignal {
  const anyFn = (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") return anyFn(signals);
  const ctl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctl.abort((s as AbortSignal & { reason?: unknown }).reason);
      return ctl.signal;
    }
    s.addEventListener(
      "abort",
      () => ctl.abort((s as AbortSignal & { reason?: unknown }).reason),
      { once: true },
    );
  }
  return ctl.signal;
}
