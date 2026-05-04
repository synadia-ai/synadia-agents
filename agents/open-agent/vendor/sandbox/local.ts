// LocalSandbox — a `Sandbox` impl backed by `node:fs/promises` and
// `Bun.spawn`. NOT vendored. Pairs with our custom `factory.ts` so the
// vendored open-agents tools (which `connectSandbox(state)` on every
// invocation) can run unmodified against a host filesystem.
//
// Confinement guarantees:
//   - All file-system methods reject paths resolving outside
//     `workingDirectory`. Vendored tools that pass absolute paths
//     through (e.g. `read.ts`) get fenced here regardless of how the
//     model phrased the path. The fence is enforced via `path.resolve`
//     prefix checking — symlinks crossing the boundary are NOT
//     followed-and-rejected and remain a known gap.
//   - `exec` confines its `cwd` argument the same way. The command
//     itself runs through bash with full host privileges of the bridge
//     user — bash can read anything that user can. A real isolation
//     boundary (container/chroot) belongs in a real sandbox; the
//     Vercel example sits behind the same factory for that case.
//   - Subprocess env is allow-listed (not a blanket `...process.env`)
//     so credentials in the bridge process (e.g. `*_API_KEY`,
//     `NATS_CREDS`) can't leak through `bash printenv`.

import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ExecResult, Sandbox, SandboxStats } from "./interface.js";

/** Discriminated state for {@link LocalSandbox} (mirrors `VercelState` shape). */
export interface LocalSandboxState {
  readonly type: "local";
  readonly workingDirectory: string;
  readonly env?: Record<string, string>;
}

/** 50 KB cap on combined stdout+stderr for `exec` — matches the bash tool's contract. */
const EXEC_OUTPUT_CAP_BYTES = 50_000;

/**
 * Parent-environment keys forwarded into `exec` subprocesses. Anything
 * not on this list is dropped to avoid leaking credentials (`*_API_KEY`,
 * `NATS_CREDS`, etc.) through the bash tool. Caller-supplied
 * `state.env` overrides are merged on top.
 */
const FORWARDED_ENV_KEYS: ReadonlySet<string> = new Set([
  "HOME",
  "PATH",
  "TERM",
  "TMPDIR",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PWD",
]);

class LocalSandbox implements Sandbox {
  readonly type = "cloud" as const;
  readonly workingDirectory: string;
  readonly env?: Record<string, string>;

  readonly #state: LocalSandboxState;
  readonly #workdirResolved: string;

  constructor(state: LocalSandboxState) {
    this.workingDirectory = state.workingDirectory;
    if (state.env !== undefined) {
      this.env = state.env;
    }
    this.#state = state;
    this.#workdirResolved = path.resolve(state.workingDirectory);
  }

  /**
   * Reject paths resolving outside `workingDirectory`. Returns the
   * resolved (absolute) path on success.
   */
  #assertWithinWorkdir(p: string): string {
    const resolved = path.resolve(p);
    const root = this.#workdirResolved;
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(
        `Path '${p}' is outside the sandbox working directory '${root}'`,
      );
    }
    return resolved;
  }

  async readFile(p: string, _encoding: "utf-8"): Promise<string> {
    this.#assertWithinWorkdir(p);
    return fs.readFile(p, "utf-8");
  }

  async readFileBuffer(p: string): Promise<Buffer> {
    this.#assertWithinWorkdir(p);
    return fs.readFile(p);
  }

  async writeFile(p: string, content: string, _encoding: "utf-8"): Promise<void> {
    this.#assertWithinWorkdir(p);
    await fs.writeFile(p, content, "utf-8");
  }

  async stat(p: string): Promise<SandboxStats> {
    this.#assertWithinWorkdir(p);
    const s = await fs.stat(p);
    return {
      isDirectory: () => s.isDirectory(),
      isFile: () => s.isFile(),
      size: s.size,
      mtimeMs: s.mtimeMs,
    };
  }

  async access(p: string): Promise<void> {
    this.#assertWithinWorkdir(p);
    await fs.access(p);
  }

  async mkdir(p: string, options?: { recursive?: boolean }): Promise<void> {
    this.#assertWithinWorkdir(p);
    await fs.mkdir(p, options);
  }

  async readdir(p: string, _options: { withFileTypes: true }): Promise<Dirent[]> {
    this.#assertWithinWorkdir(p);
    return fs.readdir(p, { withFileTypes: true });
  }

  async exec(
    command: string,
    cwd: string,
    timeoutMs: number,
    options?: { signal?: AbortSignal },
  ): Promise<ExecResult> {
    this.#assertWithinWorkdir(cwd);

    // Compose the per-call abort with the caller's signal (if any) so a
    // tool-level cancel and the per-exec timeout both cut the process.
    const timeoutCtl = new AbortController();
    const timer = setTimeout(() => timeoutCtl.abort(new Error(`exec timed out after ${timeoutMs}ms`)), timeoutMs);

    const signal = options?.signal
      ? anySignal([options.signal, timeoutCtl.signal])
      : timeoutCtl.signal;

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (FORWARDED_ENV_KEYS.has(k) && typeof v === "string") env[k] = v;
    }
    if (this.#state.env) Object.assign(env, this.#state.env);

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
