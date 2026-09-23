/**
 * The extension point of the OpenClaw channel.
 *
 * An extension is a module the operator names in
 * `SYNADIA_OPENCLAW_EXTENSIONS`, `SYNADIA_AGENT_EXTENSIONS` or the
 * `extensions` field of the account's block under `channels.nats.accounts`.
 * It is loaded once per account at gateway start, before the channel
 * connects, and hands the channel what the SDK's hooks accept (prompt and
 * request interceptors, heartbeat extras, agent-tools extensions) plus
 * handlers for the gateway's events. The contract an extension author reads
 * is `agents/EXTENSIONS.md`; this file is its reference in code.
 *
 * This file and `agents/pi/extensions/extensions.ts` are one contract kept
 * in step: the types, the naming, the loader and the fail-open composition
 * are the same code, and only the dispatch of the harness's events differs
 * (PI's `aroundInject` and `providerHeaders` here become OpenClaw's
 * `aroundDispatch`). A change to the shared parts is made in both until
 * they get a shared home.
 *
 * Everything an extension sees is structural — interfaces, never classes —
 * so a module compiled elsewhere, against its own copy of the SDK packages,
 * satisfies the types without sharing ours.
 *
 * Two halves:
 *
 *   - naming and loading (`resolveExtensionEntries`, `loadExtensions`): the
 *     precedence of the variables over the config field, package names and
 *     absolute paths, relative paths refused, a module that fails logged
 *     once and skipped so the channel starts plain;
 *   - composition (`composeExtensions`): the loaded extensions as one set
 *     of interceptors, one heartbeat-extras provider, one dispatcher for
 *     the gateway's events. Every event call fails open: a throw is logged
 *     once per extension and event and ignored; a wrapper that does not
 *     call `run` has it called by the channel; `started` and `stopping` are
 *     awaited for at most {@link DEFAULT_HOOK_TIMEOUT_MS}.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  Agents,
  AgentToolsExtension,
  Logger,
  PromptInterceptor,
} from "@synadia-ai/agents";
import type {
  AgentService,
  RequestInterceptor,
} from "@synadia-ai/agent-service";

// ─────────────────────────────────────────────────────────────────────────────
// The contract: what a module exports, what it receives, what it returns
// ─────────────────────────────────────────────────────────────────────────────

/** The harnesses that expose this extension point. OpenClaw is this plugin's. */
export type Harness = "pi" | "openclaw" | "claude-code";

/** The plugin's resolved settings, as the factory sees them before connect. */
export interface AgentExtensionSettings {
  /** The address tokens: `agents.prompt.<token>.<owner>.<name>`. */
  readonly owner: string;
  /**
   * The name token as configured (`agentName`); the definitive address is
   * `service.subject.prompt` in `started()`.
   */
  readonly name: string;
  readonly senderIdentity: "off" | "signed";
  readonly minSenderTrust: "any" | "signed";
  /** Where the plugin keeps its files, when it has such a directory. */
  readonly stateDir?: string;
  /** The plugin's configuration as read, unknown keys included; read-only. */
  readonly config: Readonly<Record<string, unknown>>;
}

/** What the plugin knows when it loads the module, before it connects. */
export interface AgentExtensionContext {
  readonly harness: Harness;
  readonly plugin: { readonly name: string; readonly version: string };
  readonly settings: AgentExtensionSettings;
  /** The `options` of this module's config entry, verbatim; `{}` when the variable named it. */
  readonly options: Readonly<Record<string, unknown>>;
  /** The plugin's logger, in the SDK's `Logger` shape. */
  readonly logger: Logger;
}

/** A served prompt, as the harness's events name it. */
export interface ServedRequest {
  /** The plugin's id for the request, unique in the process. */
  readonly id: string;
  /** The envelope's fields the protocol does not define (§5.6), as decoded. */
  readonly extras: Readonly<Record<string, unknown>>;
  /** The verified sender's id, when the signature verified. */
  readonly caller?: string;
  /** Claude Code only: the session the prompt was delivered to, when known. */
  readonly sessionId?: string;
}

export type Outcome = "ok" | "error" | "timeout";

/**
 * The harness's events. Two kinds: a notification, called and forgotten,
 * and a wrapper, which the plugin calls around one of its own steps. A
 * wrapper must call `run` once, synchronously, and return its value — a
 * promise included — so binding an `AsyncLocalStorage` around `run`
 * changes nothing of the step's timing. A wrapper may be an async
 * function; the plugin still takes `run`'s own value, and the wrapper must
 * call `run` once, before its first `await`, so the step keeps its timing.
 * OpenClaw calls `promptAccepted`, `promptEnded`, `aroundToolCall` and
 * `aroundDispatch`; the other harnesses' events are listed so one shape
 * serves all three.
 */
export interface HarnessEvents {
  // Every harness.
  /** Inside the prompt handler, after every interceptor ran. */
  promptAccepted?(request: ServedRequest): void;
  /** When the plugin settles the request. */
  promptEnded?(request: ServedRequest, outcome: Outcome, atMs: number): void;
  /** Around every agent-tool call, with the request the model works in. */
  aroundToolCall?<T>(
    request: ServedRequest | undefined,
    toolName: string,
    run: () => T,
  ): T;
  // PI.
  aroundInject?<T>(request: ServedRequest, run: () => T): T;
  providerHeaders?(
    request: ServedRequest,
  ): Readonly<Record<string, string>> | undefined;
  // OpenClaw.
  /**
   * Around the dispatch of the turn to OpenClaw
   * (`dispatchInboundDirectDmWithRuntime()`). Asynchronous: the extension
   * calls `run` once and returns its promise.
   */
  aroundDispatch?<T>(request: ServedRequest, run: () => Promise<T>): Promise<T>;
  // Claude Code.
  sessionStarted?(sessionId: string, source: string): void;
  turnStopped?(sessionId: string | undefined, atMs: number): void;
}

/** The live handles, once the plugin is on the bus. */
export interface AgentExtensionHandles {
  readonly agents: Agents;
  readonly service: AgentService;
}

/** What the factory returns. */
export interface AgentExtension {
  readonly name: string;
  /** For the plugin's `Agents` client: `new Agents({ interceptors })`. */
  readonly promptInterceptors?: ReadonlyArray<PromptInterceptor>;
  /** For the plugin's `AgentService`, before the plugin's own interceptors. */
  readonly requestInterceptors?: ReadonlyArray<RequestInterceptor>;
  /** For the plugin's `AgentService`: `heartbeatExtras`. */
  readonly heartbeatExtras?: () => Readonly<Record<string, unknown>>;
  /** For the plugin's `AgentTools`: `extensions`. */
  readonly toolExtensions?: ReadonlyArray<AgentToolsExtension>;
  /** After the service started. Awaited, bounded by the plugin. */
  started?(handles: AgentExtensionHandles): void | Promise<void>;
  /** Before the plugin stops its service. Awaited, bounded by the plugin. */
  stopping?(): void | Promise<void>;
  /** The harness's events. */
  readonly events?: HarnessEvents;
}

/** The module's one default export. */
export type AgentExtensionFactory = (
  ctx: AgentExtensionContext,
) => AgentExtension | Promise<AgentExtension>;

// ─────────────────────────────────────────────────────────────────────────────
// Naming: the variables and the config field
// ─────────────────────────────────────────────────────────────────────────────

export const OPENCLAW_EXTENSIONS_VAR = "SYNADIA_OPENCLAW_EXTENSIONS";
export const AGENT_EXTENSIONS_VAR = "SYNADIA_AGENT_EXTENSIONS";

/** One entry of the account's `extensions` array. */
export type ExtensionConfigEntry =
  | string
  | {
      readonly module: string;
      readonly options?: Readonly<Record<string, unknown>>;
    };

/** A resolved entry: the module specifier and the options handed to it. */
export interface ExtensionEntry {
  readonly module: string;
  readonly options: Readonly<Record<string, unknown>>;
}

export type ExtensionSource =
  | typeof OPENCLAW_EXTENSIONS_VAR
  | typeof AGENT_EXTENSIONS_VAR
  | "config"
  | "none";

export interface ResolvedExtensionEntries {
  /** Which source won. */
  readonly source: ExtensionSource;
  readonly entries: ReadonlyArray<ExtensionEntry>;
}

const EMPTY_OPTIONS: Readonly<Record<string, unknown>> = Object.freeze({});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve which modules to load and where the list came from.
 *
 * Precedence: `SYNADIA_OPENCLAW_EXTENSIONS`, then `SYNADIA_AGENT_EXTENSIONS`,
 * then the config field — the order the plugin already uses for the owner
 * and name variables. A variable that is set wins even when empty, so a
 * launcher can disable a config file's extensions with `VAR=`. Variables
 * hold comma-separated specifiers; the config field is an array of
 * specifiers or `{ "module": "…", "options": { … } }` objects. A malformed
 * config entry is reported through `warn` and skipped.
 */
export function resolveExtensionEntries(
  configField: unknown,
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = () => undefined,
): ResolvedExtensionEntries {
  for (const variable of [OPENCLAW_EXTENSIONS_VAR, AGENT_EXTENSIONS_VAR] as const) {
    const value = env[variable];
    if (value === undefined) continue;
    const entries = value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((module) => ({ module, options: EMPTY_OPTIONS }));
    return { source: variable, entries };
  }
  if (configField === undefined || configField === null) {
    return { source: "none", entries: [] };
  }
  if (!Array.isArray(configField)) {
    warn(
      `extensions: the config field must be an array of module specifiers or { module, options } objects; ignored`,
    );
    return { source: "none", entries: [] };
  }
  const entries: ExtensionEntry[] = [];
  configField.forEach((item: unknown, index) => {
    if (typeof item === "string") {
      const module = item.trim();
      if (module.length === 0) {
        warn(`extensions[${index}]: empty specifier; ignored`);
        return;
      }
      entries.push({ module, options: EMPTY_OPTIONS });
      return;
    }
    if (isRecord(item) && typeof item["module"] === "string") {
      const module = item["module"].trim();
      if (module.length === 0) {
        warn(`extensions[${index}]: empty "module"; ignored`);
        return;
      }
      const options = item["options"];
      if (options !== undefined && !isRecord(options)) {
        warn(`extensions[${index}]: "options" must be an object; ignored`);
        return;
      }
      entries.push({
        module,
        options: options === undefined ? EMPTY_OPTIONS : Object.freeze({ ...options }),
      });
      return;
    }
    warn(
      `extensions[${index}]: expected a module specifier or { module, options }; ignored`,
    );
  });
  return { source: "config", entries };
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading
// ─────────────────────────────────────────────────────────────────────────────

/** A loaded extension, with the specifier that named it. */
export interface LoadedExtension {
  readonly module: string;
  /** The extension's `name`, or the specifier when it gave none. */
  readonly name: string;
  readonly extension: AgentExtension;
}

/**
 * Turn a specifier into what `import()` takes: a `file:` URL for an
 * absolute path (a file, or a package directory whose entry is read from
 * its `package.json`), the name itself for a package, which the runtime
 * resolves from this file's location upward like any import. A relative
 * path is refused: the plugins' working directories differ per harness, so
 * it would mean something different in each.
 */
export function resolveExtensionSpecifier(specifier: string): string {
  const spec = specifier.trim();
  if (spec.length === 0) throw new Error("empty module specifier");
  if (isAbsolute(spec)) {
    if (!existsSync(spec)) throw new Error(`${spec}: no such file or directory`);
    return pathToFileURL(
      statSync(spec).isDirectory() ? packageEntryFile(spec) : spec,
    ).href;
  }
  if (spec.startsWith(".") || spec.startsWith("~") || /^[A-Za-z]:[\\/]/.test(spec)) {
    throw new Error(
      `${spec}: relative paths are refused; name a package or give an absolute path`,
    );
  }
  return spec;
}

/** The file a package directory's `package.json` points at. */
function packageEntryFile(dir: string): string {
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`${dir}: a directory must hold a package.json`);
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`${manifestPath}: ${(e as Error).message}`);
  }
  const entry = exportsEntry(manifest["exports"]) ?? stringOr(manifest["main"]);
  if (entry !== undefined) return join(dir, entry);
  for (const candidate of ["index.js", "index.mjs", "index.cjs"]) {
    if (existsSync(join(dir, candidate))) return join(dir, candidate);
  }
  throw new Error(`${dir}: package.json names no entry (exports or main)`);
}

function stringOr(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The `.` entry of an `exports` map under the `import`/`default` conditions. */
function exportsEntry(exportsField: unknown): string | undefined {
  if (exportsField === undefined) return undefined;
  const target = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (!isRecord(value)) return undefined;
    return target(value["import"]) ?? target(value["default"]);
  };
  if (typeof exportsField === "string") return exportsField;
  if (!isRecord(exportsField)) return undefined;
  if ("." in exportsField) return target(exportsField["."]);
  return target(exportsField);
}

/**
 * Load every entry, once, in order. A module that cannot be resolved,
 * cannot be imported, exports no factory, or whose factory throws is
 * logged once with the error and skipped: the plugin starts plain with
 * the rest. The factory receives `base` with the entry's `options`.
 */
export async function loadExtensions(
  entries: ReadonlyArray<ExtensionEntry>,
  base: Omit<AgentExtensionContext, "options">,
  logger: Logger,
): Promise<LoadedExtension[]> {
  const loaded: LoadedExtension[] = [];
  for (const entry of entries) {
    try {
      const specifier = resolveExtensionSpecifier(entry.module);
      const imported = (await import(specifier)) as { default?: unknown };
      const factory = imported.default;
      if (typeof factory !== "function") {
        throw new Error("the module has no default export function");
      }
      const extension = (await (factory as AgentExtensionFactory)({
        ...base,
        options: entry.options,
      })) as AgentExtension | undefined;
      if (!isRecord(extension)) {
        throw new Error("the factory returned no extension object");
      }
      const name =
        typeof extension.name === "string" && extension.name.length > 0
          ? extension.name
          : entry.module;
      loaded.push({ module: entry.module, name, extension });
    } catch (e) {
      logger.error(`extension "${entry.module}" not loaded: ${errorText(e)}`);
    }
  }
  return loaded;
}

// ─────────────────────────────────────────────────────────────────────────────
// Composition: one set of hooks, one fail-open dispatcher for the events
// ─────────────────────────────────────────────────────────────────────────────

/** How long the plugin waits for one extension's `started()` or `stopping()`. */
export const DEFAULT_HOOK_TIMEOUT_MS = 5_000;

export interface ComposeOptions {
  readonly hookTimeoutMs?: number;
}

/** OpenClaw's events as the plugin calls them, fail-open over every extension. */
export interface OpenClawHarnessEventDispatch {
  promptAccepted(request: ServedRequest): void;
  promptEnded(request: ServedRequest, outcome: Outcome, atMs: number): void;
  aroundDispatch<T>(request: ServedRequest, run: () => Promise<T>): Promise<T>;
  aroundToolCall<T>(
    request: ServedRequest | undefined,
    toolName: string,
    run: () => T,
  ): T;
}

export interface ComposedExtensions {
  readonly loaded: ReadonlyArray<LoadedExtension>;
  /** The extensions' names, in load order. */
  readonly names: ReadonlyArray<string>;
  /** For the `Agents` client, in load order. */
  readonly promptInterceptors: ReadonlyArray<PromptInterceptor>;
  /** For the `AgentService`, in load order; the plugin appends its own after these. */
  readonly requestInterceptors: ReadonlyArray<RequestInterceptor>;
  /** One provider merging every extension's extras, or `undefined` when none has any. */
  readonly heartbeatExtras: (() => Readonly<Record<string, unknown>>) | undefined;
  /** For `AgentTools`, in load order. */
  readonly toolExtensions: ReadonlyArray<AgentToolsExtension>;
  /** Every extension's `started()`, awaited together, each bounded. */
  started(handles: AgentExtensionHandles): Promise<void>;
  /** Every extension's `stopping()`, awaited together, each bounded. */
  stopping(): Promise<void>;
  readonly events: OpenClawHarnessEventDispatch;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

type WrapperEvent = "aroundDispatch" | "aroundToolCall";

export function composeExtensions(
  loaded: ReadonlyArray<LoadedExtension>,
  logger: Logger,
  options: ComposeOptions = {},
): ComposedExtensions {
  const hookTimeoutMs = options.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const reported = new Set<string>();
  const logOnce = (key: string, message: string): void => {
    if (reported.has(key)) return;
    reported.add(key);
    logger.warn(message);
  };

  const withEvent = <K extends keyof HarnessEvents>(
    event: K,
  ): LoadedExtension[] =>
    loaded.filter((l) => typeof l.extension.events?.[event] === "function");

  const notify = <K extends "promptAccepted" | "promptEnded">(
    event: K,
    call: (handler: NonNullable<HarnessEvents[K]>) => void,
  ): void => {
    for (const l of withEvent(event)) {
      try {
        call(l.extension.events![event] as NonNullable<HarnessEvents[K]>);
      } catch (e) {
        logOnce(
          `${l.name}:${event}`,
          `extension "${l.name}" ${event} failed: ${errorText(e)}`,
        );
      }
    }
  };

  /**
   * An async wrapper returns a promise of its own around `run`'s, and the
   * plugin awaits `run`'s, not the wrapper's. A rejection of the wrapper's
   * — it threw after its first `await` — would otherwise be reported by
   * nobody and, in Node, end the process as unhandled. Observe it here and
   * log it once, unless it is the step's own rejection passed through.
   */
  const observeWrapperPromise = (
    key: string,
    l: LoadedExtension,
    event: WrapperEvent,
    returned: PromiseLike<unknown>,
    value: unknown,
  ): void => {
    let stepRejected = false;
    let stepReason: unknown;
    const stepSettled: Promise<void> = isThenable(value)
      ? Promise.resolve(value).then(
          () => undefined,
          (e: unknown) => {
            stepRejected = true;
            stepReason = e;
          },
        )
      : Promise.resolve();
    Promise.resolve(returned).then(
      () => undefined,
      (e: unknown) => {
        void stepSettled.then(() => {
          if (stepRejected && e === stepReason) return;
          logOnce(key, `extension "${l.name}" ${event} failed: ${errorText(e)}`);
        });
      },
    );
  };

  /**
   * One extension's wrapper around `inner`, with the guarantees of the
   * contract enforced: `run` is called exactly once, the step's own
   * throw reaches the plugin whatever the wrapper does with it, and the
   * step's value is what the plugin gets back.
   */
  const guarded = <T>(
    event: WrapperEvent,
    l: LoadedExtension,
    invoke: (inner: () => T) => T,
    inner: () => T,
  ): T => {
    const key = `${l.name}:${event}`;
    let called = false;
    let value: T | undefined;
    let stepThrew = false;
    let stepError: unknown;
    const once = (): T => {
      if (called) {
        logOnce(
          `${key}:twice`,
          `extension "${l.name}" ${event} called run more than once, or after the plugin had run the step itself; the extra call was ignored`,
        );
        if (stepThrew) throw stepError;
        return value as T;
      }
      called = true;
      try {
        value = inner();
        return value;
      } catch (e) {
        stepThrew = true;
        stepError = e;
        throw e;
      }
    };
    let returned: T | undefined;
    try {
      returned = invoke(once);
    } catch (e) {
      // The step's own failure, passed through by the wrapper: not its fault.
      if (stepThrew && e === stepError) throw e;
      logOnce(key, `extension "${l.name}" ${event} failed: ${errorText(e)}`);
      // Through `once`, so a late call by the wrapper cannot run it again.
      if (!called) return once();
      if (stepThrew) throw stepError;
      return value as T;
    }
    // The wrapper swallowed the step's throw; the plugin must still see it.
    if (stepThrew) throw stepError;
    if (!called) {
      logOnce(
        key,
        `extension "${l.name}" ${event} returned without calling run; the plugin ran the step itself`,
      );
      // The wrapper may still call `run` later, from an async continuation;
      // `once` ignores that call. Its own promise is observed so a late
      // throw is logged, not unhandled.
      if (isThenable(returned)) observeWrapperPromise(key, l, event, returned, undefined);
      return once();
    }
    // The plugin takes run's own value in every case. Identity says nothing
    // when a promise is involved: an async wrapper returns a promise of its
    // own around run's, and run's promise may be re-wrapped on the way out.
    if (!isThenable(value) && !isThenable(returned) && returned !== value) {
      logOnce(
        `${key}:value`,
        `extension "${l.name}" ${event} did not return run's value; the plugin used run's`,
      );
    }
    if (isThenable(returned) && returned !== value) {
      observeWrapperPromise(key, l, event, returned, value);
    }
    return value as T;
  };

  /** Nest every extension's wrapper around `run`, the first loaded outermost. */
  const wrapAll = <T>(
    event: WrapperEvent,
    invoke: (l: LoadedExtension, inner: () => T) => T,
    run: () => T,
  ): T => {
    let next = run;
    const list = withEvent(event);
    for (let i = list.length - 1; i >= 0; i--) {
      const l = list[i]!;
      const inner = next;
      next = () => guarded(event, l, (once) => invoke(l, once), inner);
    }
    return next();
  };

  const bounded = async (
    l: LoadedExtension,
    hook: "started" | "stopping",
    fn: () => void | Promise<void>,
  ): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(fn),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            logOnce(
              `${l.name}:${hook}:timeout`,
              `extension "${l.name}" ${hook}() did not finish within ${hookTimeoutMs} ms; continuing without it`,
            );
            resolve();
          }, hookTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch (e) {
      logOnce(
        `${l.name}:${hook}`,
        `extension "${l.name}" ${hook}() failed: ${errorText(e)}`,
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const extrasProviders = loaded.filter(
    (l) => typeof l.extension.heartbeatExtras === "function",
  );
  const heartbeatExtras =
    extrasProviders.length === 0
      ? undefined
      : (): Readonly<Record<string, unknown>> => {
          const merged: Record<string, unknown> = {};
          for (const l of extrasProviders) {
            try {
              Object.assign(merged, l.extension.heartbeatExtras!());
            } catch (e) {
              logOnce(
                `${l.name}:heartbeatExtras`,
                `extension "${l.name}" heartbeatExtras failed: ${errorText(e)}`,
              );
            }
          }
          return merged;
        };

  return {
    loaded,
    names: loaded.map((l) => l.name),
    promptInterceptors: loaded.flatMap((l) => [
      ...(l.extension.promptInterceptors ?? []),
    ]),
    requestInterceptors: loaded.flatMap((l) => [
      ...(l.extension.requestInterceptors ?? []),
    ]),
    heartbeatExtras,
    toolExtensions: loaded.flatMap((l) => [...(l.extension.toolExtensions ?? [])]),
    async started(handles) {
      await Promise.all(
        loaded
          .filter((l) => typeof l.extension.started === "function")
          .map((l) => bounded(l, "started", () => l.extension.started!(handles))),
      );
    },
    async stopping() {
      await Promise.all(
        loaded
          .filter((l) => typeof l.extension.stopping === "function")
          .map((l) => bounded(l, "stopping", () => l.extension.stopping!())),
      );
    },
    events: {
      promptAccepted(request) {
        notify("promptAccepted", (handler) => handler(request));
      },
      promptEnded(request, outcome, atMs) {
        notify("promptEnded", (handler) => handler(request, outcome, atMs));
      },
      aroundDispatch(request, run) {
        return wrapAll(
          "aroundDispatch",
          (l, inner) => l.extension.events!.aroundDispatch!(request, inner),
          run,
        );
      },
      aroundToolCall(request, toolName, run) {
        return wrapAll(
          "aroundToolCall",
          (l, inner) =>
            l.extension.events!.aroundToolCall!(request, toolName, inner),
          run,
        );
      },
    },
  };
}
