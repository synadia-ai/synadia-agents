// The extension point: naming and precedence with Claude Code's variables,
// loading, and the fail-open composition of the loaded extensions (see
// `extensions.ts` and `agents/EXTENSIONS.md`). Modules are written to a
// temporary directory; no NATS is needed.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@synadia-ai/agents";
import {
  AGENT_EXTENSIONS_VAR,
  CLAUDE_CODE_EXTENSIONS_VAR,
  composeExtensions,
  loadExtensions,
  resolveExtensionEntries,
  resolveExtensionSpecifier,
  type AgentExtension,
  type AgentExtensionContext,
  type LoadedExtension,
  type ServedRequest,
} from "../src/extensions.js";

function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    debug: () => undefined,
    info: (m) => lines.push(`info ${m}`),
    warn: (m) => lines.push(`warn ${m}`),
    error: (m) => lines.push(`error ${m}`),
  };
}

const base: Omit<AgentExtensionContext, "options"> = {
  harness: "claude-code",
  plugin: { name: "@synadia-ai/nats-channel", version: "0.0.0-test" },
  settings: {
    owner: "acme",
    name: "echo",
    senderIdentity: "off",
    minSenderTrust: "any",
    stateDir: "/tmp/claude-code-test-state",
    config: { sessionName: "echo" },
  },
  logger: recordingLogger(),
};

const request: ServedRequest = Object.freeze({ id: "7", extras: { trace: "t" } });

function loaded(name: string, extension: Omit<AgentExtension, "name">): LoadedExtension {
  return { module: name, name, extension: { name, ...extension } };
}

async function delayTicks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe("resolveExtensionEntries: the variables and the config field", () => {
  it("the config field is the fallback, as strings or { module, options }", () => {
    const warnings: string[] = [];
    const resolved = resolveExtensionEntries(
      ["one", { module: "two", options: { level: 2 } }, { module: "three" }],
      {},
      (m) => warnings.push(m),
    );
    expect(resolved.source).toBe("config");
    expect(resolved.entries).toEqual([
      { module: "one", options: {} },
      { module: "two", options: { level: 2 } },
      { module: "three", options: {} },
    ]);
    expect(warnings).toEqual([]);
  });

  it("SYNADIA_AGENT_EXTENSIONS wins over the config field", () => {
    const resolved = resolveExtensionEntries(["from-config"], {
      [AGENT_EXTENSIONS_VAR]: "a, b ,,c",
    });
    expect(resolved.source).toBe(AGENT_EXTENSIONS_VAR);
    expect(resolved.entries.map((e) => e.module)).toEqual(["a", "b", "c"]);
  });

  it("SYNADIA_CLAUDE_CODE_EXTENSIONS wins over SYNADIA_AGENT_EXTENSIONS", () => {
    const resolved = resolveExtensionEntries(["from-config"], {
      [CLAUDE_CODE_EXTENSIONS_VAR]: "claude-code-only",
      [AGENT_EXTENSIONS_VAR]: "shared",
    });
    expect(resolved.source).toBe(CLAUDE_CODE_EXTENSIONS_VAR);
    expect(resolved.entries).toEqual([{ module: "claude-code-only", options: {} }]);
  });

  it("a variable that is set but empty names no extension and still wins", () => {
    const resolved = resolveExtensionEntries(["from-config"], {
      [CLAUDE_CODE_EXTENSIONS_VAR]: "",
    });
    expect(resolved.source).toBe(CLAUDE_CODE_EXTENSIONS_VAR);
    expect(resolved.entries).toEqual([]);
  });

  it("nothing named means no extensions", () => {
    expect(resolveExtensionEntries(undefined, {})).toEqual({ source: "none", entries: [] });
  });

  it("malformed config entries are reported and skipped, the rest kept", () => {
    const warnings: string[] = [];
    const resolved = resolveExtensionEntries(
      [
        "ok",
        42,
        { options: {} },
        { module: "", options: {} },
        { module: "bad-opts", options: "x" },
        " ",
      ],
      {},
      (m) => warnings.push(m),
    );
    expect(resolved.entries.map((e) => e.module)).toEqual(["ok"]);
    expect(warnings).toHaveLength(5);
    const notArray = resolveExtensionEntries("not-an-array", {}, (m) => warnings.push(m));
    expect(notArray).toEqual({ source: "none", entries: [] });
    expect(warnings).toHaveLength(6);
  });
});

describe("resolveExtensionSpecifier: package names and absolute paths only", () => {
  it("a relative path is refused", () => {
    for (const spec of ["./ext.mjs", "../ext", ".", "~/ext"]) {
      expect(() => resolveExtensionSpecifier(spec)).toThrow(/relative paths are refused/);
    }
  });

  it("a package name passes through for the runtime to resolve", () => {
    expect(resolveExtensionSpecifier("@scope/pkg")).toBe("@scope/pkg");
    expect(resolveExtensionSpecifier("pkg/subpath")).toBe("pkg/subpath");
  });

  it("an empty specifier is refused", () => {
    expect(() => resolveExtensionSpecifier("  ")).toThrow(/empty/);
  });
});

describe("loadExtensions", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "claude-code-ext-test-"));
    writeFileSync(
      join(dir, "good.mjs"),
      `export default function (ctx) {
        return { name: "good", seen: ctx, events: { promptAccepted() {} } };
      }`,
    );
    writeFileSync(join(dir, "throws.mjs"), `export default function () { throw new Error("boom"); }`);
    writeFileSync(join(dir, "nodefault.mjs"), `export const x = 1;`);
    writeFileSync(join(dir, "nameless.mjs"), `export default async function () { return {}; }`);
    writeFileSync(join(dir, "notobject.mjs"), `export default function () { return 42; }`);
    mkdirSync(join(dir, "pkg-main"));
    writeFileSync(
      join(dir, "pkg-main", "package.json"),
      JSON.stringify({ name: "pkg-main", main: "entry.mjs" }),
    );
    writeFileSync(join(dir, "pkg-main", "entry.mjs"), `export default () => ({ name: "from-main" });`);
    mkdirSync(join(dir, "pkg-exports", "dist"), { recursive: true });
    writeFileSync(
      join(dir, "pkg-exports", "package.json"),
      JSON.stringify({ name: "pkg-exports", exports: { ".": { import: "./dist/index.mjs" } } }),
    );
    writeFileSync(
      join(dir, "pkg-exports", "dist", "index.mjs"),
      `export default () => ({ name: "from-exports" });`,
    );
    mkdirSync(join(dir, "pkg-empty"));
    writeFileSync(join(dir, "pkg-empty", "package.json"), JSON.stringify({ name: "pkg-empty" }));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("an absolute file path loads; the factory gets the context with the entry's options", async () => {
    const logger = recordingLogger();
    const result = await loadExtensions(
      [{ module: join(dir, "good.mjs"), options: { level: 3 } }],
      base,
      logger,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("good");
    expect(result[0]!.module).toBe(join(dir, "good.mjs"));
    const seen = (result[0]!.extension as unknown as { seen: AgentExtensionContext }).seen;
    expect(seen.harness).toBe("claude-code");
    expect(seen.plugin).toEqual(base.plugin);
    expect(seen.settings).toEqual(base.settings);
    expect(seen.options).toEqual({ level: 3 });
    expect(seen.logger).toBe(base.logger);
    expect(logger.lines).toEqual([]);
  });

  it("an absolute package directory loads through its package.json: main, or exports", async () => {
    const logger = recordingLogger();
    const result = await loadExtensions(
      [
        { module: join(dir, "pkg-main"), options: {} },
        { module: join(dir, "pkg-exports"), options: {} },
      ],
      base,
      logger,
    );
    expect(result.map((l) => l.name)).toEqual(["from-main", "from-exports"]);
    expect(logger.lines).toEqual([]);
  });

  it("a relative path is refused with one log line, and the rest still load", async () => {
    const logger = recordingLogger();
    const result = await loadExtensions(
      [
        { module: "./good.mjs", options: {} },
        { module: join(dir, "good.mjs"), options: {} },
      ],
      base,
      logger,
    );
    expect(result.map((l) => l.name)).toEqual(["good"]);
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toMatch(
      /^error extension ".\/good.mjs" not loaded: .*relative paths are refused/,
    );
  });

  it("a missing module is skipped with one log line", async () => {
    const logger = recordingLogger();
    const missingPath = join(dir, "missing.mjs");
    const result = await loadExtensions(
      [
        { module: missingPath, options: {} },
        { module: "no-such-package-for-the-claude-code-channel-test", options: {} },
        { module: join(dir, "pkg-empty"), options: {} },
      ],
      base,
      logger,
    );
    expect(result).toEqual([]);
    expect(logger.lines).toHaveLength(3);
    expect(logger.lines[0]).toMatch(/no such file or directory/);
    expect(logger.lines[1]).toMatch(
      /^error extension "no-such-package-for-the-claude-code-channel-test" not loaded: /,
    );
    expect(logger.lines[2]).toMatch(/names no entry/);
  });

  it("a package name resolves from the plugin's location upward", async () => {
    // The SDK is installed next to the plugin and has no default export:
    // the failure is the export's, so the name was resolved and imported.
    const logger = recordingLogger();
    const result = await loadExtensions([{ module: "@synadia-ai/agents", options: {} }], base, logger);
    expect(result).toEqual([]);
    expect(logger.lines).toEqual([
      'error extension "@synadia-ai/agents" not loaded: the module has no default export function',
    ]);
  });

  it("a factory that throws, exports nothing usable, or returns no object is logged once and skipped", async () => {
    const logger = recordingLogger();
    const result = await loadExtensions(
      [
        { module: join(dir, "throws.mjs"), options: {} },
        { module: join(dir, "nodefault.mjs"), options: {} },
        { module: join(dir, "notobject.mjs"), options: {} },
        { module: join(dir, "nameless.mjs"), options: {} },
      ],
      base,
      logger,
    );
    // The nameless one loads, named by its specifier.
    expect(result.map((l) => l.name)).toEqual([join(dir, "nameless.mjs")]);
    expect(logger.lines).toEqual([
      `error extension "${join(dir, "throws.mjs")}" not loaded: boom`,
      `error extension "${join(dir, "nodefault.mjs")}" not loaded: the module has no default export function`,
      `error extension "${join(dir, "notobject.mjs")}" not loaded: the factory returned no extension object`,
    ]);
  });
});

describe("composeExtensions: the hooks, in load order", () => {
  const r1 = { aroundRequest: (_c: unknown, next: () => Promise<void>) => next() };
  const r2 = { aroundRequest: (_c: unknown, next: () => Promise<void>) => next() };
  const r3 = { aroundRequest: (_c: unknown, next: () => Promise<void>) => next() };
  const p1 = { beforePrompt: () => undefined };
  const p2 = { beforePrompt: () => undefined };
  const t1 = { discoveryFields: () => undefined };
  const t2 = { discoveryFields: () => undefined };

  it("interceptors and tool extensions are concatenated in load order", () => {
    const composed = composeExtensions(
      [
        loaded("first", { requestInterceptors: [r1], promptInterceptors: [p1], toolExtensions: [t1] }),
        loaded("second", { requestInterceptors: [r2, r3], promptInterceptors: [p2], toolExtensions: [t2] }),
        loaded("third", {}),
      ],
      recordingLogger(),
    );
    expect(composed.names).toEqual(["first", "second", "third"]);
    expect(composed.requestInterceptors).toEqual([r1, r2, r3]);
    expect(composed.promptInterceptors).toEqual([p1, p2]);
    expect(composed.toolExtensions).toEqual([t1, t2]);
  });

  it("heartbeat extras: none gives no provider; several merge, the later winning a clash", () => {
    expect(composeExtensions([loaded("a", {})], recordingLogger()).heartbeatExtras).toBeUndefined();
    const composed = composeExtensions(
      [
        loaded("a", { heartbeatExtras: () => ({ a: 1, shared: "a" }) }),
        loaded("b", { heartbeatExtras: () => ({ b: 2, shared: "b" }) }),
      ],
      recordingLogger(),
    );
    expect(composed.heartbeatExtras!()).toEqual({ a: 1, b: 2, shared: "b" });
  });

  it("a throwing extras provider costs only its own extras and is logged once", () => {
    const logger = recordingLogger();
    const composed = composeExtensions(
      [
        loaded("a", { heartbeatExtras: () => ({ a: 1 }) }),
        loaded("boom", {
          heartbeatExtras: () => {
            throw new Error("no extras today");
          },
        }),
      ],
      logger,
    );
    expect(composed.heartbeatExtras!()).toEqual({ a: 1 });
    expect(composed.heartbeatExtras!()).toEqual({ a: 1 });
    expect(logger.lines).toEqual(['warn extension "boom" heartbeatExtras failed: no extras today']);
  });
});

describe("composeExtensions: started and stopping are awaited and bounded", () => {
  it("started gets the handles; a hook that never settles is abandoned after the bound", async () => {
    const logger = recordingLogger();
    const handles = { agents: {}, service: {} } as never;
    let seen: unknown;
    const composed = composeExtensions(
      [
        loaded("quick", {
          async started(h) {
            seen = h;
          },
        }),
        loaded("stuck", { started: () => new Promise<void>(() => undefined) }),
      ],
      logger,
      { hookTimeoutMs: 50 },
    );
    const t0 = Date.now();
    await composed.started(handles);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(seen).toBe(handles);
    expect(logger.lines).toEqual([
      'warn extension "stuck" started() did not finish within 50 ms; continuing without it',
    ]);
  });

  it("a throwing or rejecting stopping is logged and does not stop the plugin", async () => {
    const logger = recordingLogger();
    let stopped = 0;
    const composed = composeExtensions(
      [
        loaded("sync-throw", {
          stopping() {
            throw new Error("sync");
          },
        }),
        loaded("rejects", { stopping: () => Promise.reject(new Error("async")) }),
        loaded("fine", {
          async stopping() {
            stopped++;
          },
        }),
      ],
      logger,
    );
    await composed.stopping();
    expect(stopped).toBe(1);
    expect(logger.lines.sort()).toEqual([
      'warn extension "rejects" stopping() failed: async',
      'warn extension "sync-throw" stopping() failed: sync',
    ]);
  });
});

describe("composeExtensions: Claude Code's events, fail-open", () => {
  it("notifications reach every extension with the request; a throw is logged once per event name", () => {
    const logger = recordingLogger();
    const calls: string[] = [];
    const composed = composeExtensions(
      [
        loaded("a", {
          events: {
            promptAccepted: (r) => calls.push(`a.accepted ${r.id}`),
            promptEnded: (r, outcome, at) => calls.push(`a.ended ${r.id} ${outcome} ${at}`),
          },
        }),
        loaded("b", {
          events: {
            promptAccepted: () => {
              throw new Error("b fails");
            },
            promptEnded: (r) => calls.push(`b.ended ${r.id}`),
          },
        }),
      ],
      logger,
    );
    composed.events.promptAccepted(request);
    composed.events.promptAccepted(request);
    composed.events.promptEnded(request, "ok", 123);
    composed.events.promptEnded(request, "error", 124);
    expect(calls).toEqual([
      "a.accepted 7",
      "a.accepted 7",
      "a.ended 7 ok 123",
      "b.ended 7",
      "a.ended 7 error 124",
      "b.ended 7",
    ]);
    expect(logger.lines).toEqual(['warn extension "b" promptAccepted failed: b fails']);
  });

  it("aroundToolCall (async step): the wrapper's context is what the call sees, and its promise comes back", async () => {
    const logger = recordingLogger();
    const als = new AsyncLocalStorage<string>();
    const composed = composeExtensions(
      [
        loaded("binder", {
          events: { aroundToolCall: (r, _t, run) => als.run(`bound:${r.id}`, run) },
        }),
      ],
      logger,
    );
    const step = Promise.resolve("called");
    let seen: string | undefined;
    const got = composed.events.aroundToolCall(request, "prompt_agent", () => {
      seen = als.getStore();
      return step;
    });
    // run's own promise, not a wrapper's around it.
    expect(got).toBe(step);
    expect(seen).toBe("bound:7");
    expect(await got).toBe("called");
    expect(logger.lines).toEqual([]);
  });

  it("aroundToolCall wrappers nest with the first loaded outermost, and the call runs once", async () => {
    const order: string[] = [];
    const composed = composeExtensions(
      [
        loaded("outer", {
          events: {
            async aroundToolCall(_r, _t, run) {
              order.push("outer>");
              const v = await run();
              order.push("<outer");
              return v;
            },
          },
        }),
        loaded("inner", {
          events: {
            async aroundToolCall(_r, _t, run) {
              order.push("inner>");
              const v = await run();
              order.push("<inner");
              return v;
            },
          },
        }),
      ],
      recordingLogger(),
    );
    let runs = 0;
    const value = await composed.events.aroundToolCall(request, "prompt_agent", async () => {
      order.push("step");
      runs++;
      return "done";
    });
    expect(value).toBe("done");
    expect(runs).toBe(1);
    await delayTicks(4);
    expect(order).toEqual(["outer>", "inner>", "step", "<inner", "<outer"]);
  });

  it("a tool-call wrapper that does not call run, or throws before it, has run called by the plugin, logged once", async () => {
    const logger = recordingLogger();
    let runs = 0;
    const composed = composeExtensions(
      [
        loaded("forgets", { events: { aroundToolCall: (() => Promise.resolve()) as never } }),
        loaded("throws-first", {
          events: {
            aroundToolCall() {
              throw new Error("before run");
            },
          },
        }),
      ],
      logger,
    );
    expect(await composed.events.aroundToolCall(request, "prompt_agent", async () => ++runs)).toBe(1);
    expect(await composed.events.aroundToolCall(request, "prompt_agent", async () => ++runs)).toBe(2);
    expect(runs).toBe(2);
    expect(logger.lines).toEqual([
      'warn extension "forgets" aroundToolCall returned without calling run; the plugin ran the step itself',
      'warn extension "throws-first" aroundToolCall failed: before run',
    ]);
  });

  it("the call's own rejection reaches the plugin even through a wrapper that swallows it", async () => {
    const logger = recordingLogger();
    const composed = composeExtensions(
      [
        loaded("swallows", {
          events: {
            async aroundToolCall(_r, _t, run) {
              try {
                return await run();
              } catch {
                return undefined as never;
              }
            },
          },
        }),
      ],
      logger,
    );
    await expect(
      composed.events.aroundToolCall(request, "prompt_agent", () => Promise.reject(new Error("the call failed"))),
    ).rejects.toThrow("the call failed");
    await delayTicks(4);
    // The wrapper's own promise resolved; nothing to report.
    expect(logger.lines).toEqual([]);
  });

  it("an async wrapper that throws after run is logged once and never becomes an unhandled rejection", async () => {
    const logger = recordingLogger();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const composed = composeExtensions(
        [
          loaded("throws-after", {
            events: {
              async aroundToolCall(_r, _t, run) {
                await run();
                throw new Error("after run");
              },
            },
          }),
        ],
        logger,
      );
      expect(await composed.events.aroundToolCall(request, "prompt_agent", async () => "ok")).toBe("ok");
      expect(await composed.events.aroundToolCall(request, "prompt_agent", async () => "ok")).toBe("ok");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
      expect(logger.lines).toEqual(['warn extension "throws-after" aroundToolCall failed: after run']);
      // The call's own rejection, passed through by such a wrapper, is not blamed on it.
      await expect(
        composed.events.aroundToolCall(request, "prompt_agent", () => Promise.reject(new Error("own"))),
      ).rejects.toThrow("own");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
      expect(logger.lines).toHaveLength(1);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("an async wrapper that calls run only after an await: the plugin runs the step once, the late call is ignored", async () => {
    const logger = recordingLogger();
    let runs = 0;
    const composed = composeExtensions(
      [
        loaded("late", {
          events: {
            aroundToolCall: (async (_r: unknown, _t: string, run: () => Promise<unknown>) => {
              await Promise.resolve();
              return run();
            }) as never,
          },
        }),
      ],
      logger,
    );
    expect(await composed.events.aroundToolCall(request, "prompt_agent", async () => ++runs)).toBe(1);
    await delayTicks(3);
    expect(runs).toBe(1);
    expect(logger.lines).toEqual([
      'warn extension "late" aroundToolCall returned without calling run; the plugin ran the step itself',
      'warn extension "late" aroundToolCall called run more than once, or after the plugin had run the step itself; the extra call was ignored',
    ]);
  });

  it("aroundToolCall gets the request or undefined, the tool's name, and returns run's promise as is", async () => {
    const seen: Array<[string | undefined, string]> = [];
    const composed = composeExtensions(
      [
        loaded("tools", {
          events: {
            aroundToolCall(r, name, run) {
              seen.push([r?.id, name]);
              return run();
            },
          },
        }),
      ],
      recordingLogger(),
    );
    const promise = Promise.resolve({ ok: true });
    expect(composed.events.aroundToolCall(request, "prompt_agent", () => promise)).toBe(promise);
    expect(composed.events.aroundToolCall(undefined, "discover_agents", () => promise)).toBe(promise);
    expect(seen).toEqual([
      ["7", "prompt_agent"],
      [undefined, "discover_agents"],
    ]);
  });

  it("aroundToolCall: a wrapper that calls run twice, or returns another plain value, still yields one run and its value", () => {
    const logger = recordingLogger();
    let runs = 0;
    const composed = composeExtensions(
      [
        loaded("twice", {
          events: {
            aroundToolCall(_r, _n, run) {
              run();
              return run();
            },
          },
        }),
        loaded("rewraps", {
          events: {
            aroundToolCall(_r, _n, run) {
              run();
              return "something else" as never;
            },
          },
        }),
      ],
      logger,
    );
    expect(composed.events.aroundToolCall(request, "x", () => ++runs)).toBe(1);
    expect(runs).toBe(1);
    expect(logger.lines).toEqual([
      'warn extension "rewraps" aroundToolCall did not return run\'s value; the plugin used run\'s',
      'warn extension "twice" aroundToolCall called run more than once, or after the plugin had run the step itself; the extra call was ignored',
    ]);
  });

  it("aroundToolCall: the step's own throw reaches the plugin through a wrapper that swallows it", () => {
    const logger = recordingLogger();
    const composed = composeExtensions(
      [
        loaded("swallows", {
          events: {
            aroundToolCall(_r, _n, run) {
              try {
                return run();
              } catch {
                return undefined as never;
              }
            },
          },
        }),
      ],
      logger,
    );
    expect(() =>
      composed.events.aroundToolCall(request, "x", () => {
        throw new Error("the helper is closed");
      }),
    ).toThrow("the helper is closed");
    expect(logger.lines).toEqual([]);
  });

  it("sessionStarted and turnStopped reach every extension; a throw is logged once per event name", () => {
    const logger = recordingLogger();
    const calls: string[] = [];
    const composed = composeExtensions(
      [
        loaded("a", {
          events: {
            sessionStarted: (id, source) => calls.push(`a.started ${id} ${source}`),
            turnStopped: (id, at) => calls.push(`a.stopped ${id ?? "-"} ${at}`),
          },
        }),
        loaded("b", {
          events: {
            sessionStarted: () => {
              throw new Error("b fails");
            },
            turnStopped: (id) => calls.push(`b.stopped ${id ?? "-"}`),
          },
        }),
      ],
      logger,
    );
    composed.events.sessionStarted("s-1", "startup");
    composed.events.sessionStarted("s-2", "clear");
    composed.events.turnStopped("s-2", 500);
    composed.events.turnStopped(undefined, 501);
    expect(calls).toEqual([
      "a.started s-1 startup",
      "a.started s-2 clear",
      "a.stopped s-2 500",
      "b.stopped s-2",
      "a.stopped - 501",
      "b.stopped -",
    ]);
    expect(logger.lines).toEqual(['warn extension "b" sessionStarted failed: b fails']);
  });

  it("with no extension, every event is a no-op and every wrapper just runs its step", async () => {
    const composed = composeExtensions([], recordingLogger());
    expect(composed.names).toEqual([]);
    expect(composed.heartbeatExtras).toBeUndefined();
    composed.events.promptAccepted(request);
    composed.events.promptEnded(request, "error", 1);
    composed.events.sessionStarted("s", "startup");
    composed.events.turnStopped(undefined, 1);
    expect(await composed.events.aroundToolCall(undefined, "x", async () => "ran")).toBe("ran");
    await composed.started({} as never);
    await composed.stopping();
  });
});
