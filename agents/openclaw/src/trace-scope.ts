/**
 * Seeding OpenClaw's diagnostic trace scope with a trace id of our own.
 *
 * OpenClaw stamps a W3C `traceparent` header on every model call of a
 * turn, and derives each turn's trace as a child of whatever trace scope
 * is active when the turn is dispatched — the channel turn, the harness
 * operation, the run and each model call all keep the parent's trace id.
 * So dispatching a prompt inside a scope whose trace id the plugin minted
 * puts that id on every model call the turn makes: the harness thread id
 * the plugin's `served` records name as `harness_thread_id`, bare. A fresh id
 * per prompt, never the caller's thread id, so nothing of the NATS side
 * reaches a model provider.
 *
 * The scope is an `AsyncLocalStorage` OpenClaw keeps on `globalThis` under
 * a versioned symbol, on purpose, so every copy of its modules shares one.
 * The runner itself is not part of the plugin SDK, so the plugin runs the
 * store directly, feature-checked: a runtime whose store has another shape
 * dispatches as before, with an id of OpenClaw's own on the header.
 * OpenClaw 2026.8 and later carry the scope through their command lane;
 * 2026.5.4 does not, so there the header does not carry the plugin's id.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** The symbol OpenClaw keeps its trace scope store under (2026.5.4 through 2026.9.x). */
export const OPENCLAW_TRACE_SCOPE_KEY = Symbol.for("openclaw.diagnosticTraceScope.state.v1");

/** What OpenClaw puts in the scope: its diagnostic trace context. */
export interface OpenClawTraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly traceFlags: string;
}

interface ScopeState {
  readonly marker?: unknown;
  readonly storage?: AsyncLocalStorage<OpenClawTraceContext | undefined>;
}

const TRACE_ID = /^[0-9a-f]{32}$/;

/** `true` iff `value` is a W3C trace id: 32 lowercase hex, not all zeros. */
export function validTraceId(value: unknown): value is string {
  return typeof value === "string" && TRACE_ID.test(value) && !/^0+$/.test(value);
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

/** A fresh W3C trace id: 128 random bits as 32 lowercase hex characters. */
export function newTraceId(): string {
  let id = randomHex(16);
  // All zeros is the one invalid value; astronomically unlikely, still handled.
  while (!validTraceId(id)) id = randomHex(16);
  return id;
}

/**
 * OpenClaw's trace scope store, or `undefined` when this runtime's global
 * has another shape. When the global is absent the store is created here
 * in OpenClaw's own shape, which OpenClaw adopts on its first use: the
 * marker and an `AsyncLocalStorage` are all it checks for.
 */
export function openClawTraceScope(
  root: Record<symbol, unknown> = globalThis as unknown as Record<symbol, unknown>,
): AsyncLocalStorage<OpenClawTraceContext | undefined> | undefined {
  const existing = root[OPENCLAW_TRACE_SCOPE_KEY] as ScopeState | undefined;
  if (existing !== undefined) {
    return existing.marker === OPENCLAW_TRACE_SCOPE_KEY &&
      existing.storage instanceof AsyncLocalStorage
      ? existing.storage
      : undefined;
  }
  const state: ScopeState = {
    marker: OPENCLAW_TRACE_SCOPE_KEY,
    storage: new AsyncLocalStorage(),
  };
  Object.defineProperty(root, OPENCLAW_TRACE_SCOPE_KEY, {
    configurable: true,
    enumerable: false,
    value: state,
    writable: false,
  });
  return state.storage;
}

/**
 * Run `fn` with a trace whose id is `traceId` as OpenClaw's active trace
 * scope, so the model calls of the turn `fn` dispatches carry it. Runs
 * `fn` as-is when there is no id to seed or the runtime offers no scope
 * store.
 */
export function runWithTraceId<T>(
  traceId: string | undefined,
  fn: () => Promise<T>,
  scope: AsyncLocalStorage<OpenClawTraceContext | undefined> | undefined = openClawTraceScope(),
): Promise<T> {
  if (scope === undefined || !validTraceId(traceId)) return fn();
  const trace: OpenClawTraceContext = Object.freeze({
    traceId,
    spanId: randomHex(8),
    traceFlags: "01",
  });
  return scope.run(trace, fn);
}
