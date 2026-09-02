// Observability tracing — the vocabulary shared by the client and the
// agent service. Mirrors `synadia_ai/agents/trace.py` in the Python SDK;
// the two must stay wire-identical.
//
// The ambient binding is what lets a client used as a tool inside a
// prompt handler inherit lineage with no plumbing through user code:
// AsyncLocalStorage flows into awaited work and into tasks created inside
// the bound scope (Node and Bun alike).
//
// A thread ID names one prompt execution: minted by the caller at
// `prompt()` time, 128-bit random as 32 lowercase hex characters, and
// adopted by the receiving service. `rootId` has the same shape — it IS a
// thread ID, the tree's first execution.

import { AsyncLocalStorage } from "node:async_hooks";

// Bump every time you change the trace record schema
// (be sure the Python SDK is updated in lockstep)
export const EDGE_RECORD_VERSION = 1;

/** Default subject edge records are published to — the tenant-side short
 * form; the account's import qualifies it to `TRACE.{account}.edges`. */
export const DEFAULT_EDGE_SUBJECT = "TRACE.edges";

/**
 * Opt-in tracing configuration; passing an object (even empty, for all
 * defaults) enables tracing. Omitting it disables tracing entirely, and
 * prompts stay byte-identical to plain protocol 0.3.
 */
export interface TraceOptions {
  /**
   * Where edge records are published. `null` selects propagate-only mode
   * — mint IDs and forward lineage, but publish no edge records.
   */
  readonly edgeSubject?: string | null;
}

/** Identity of the prompt execution running in the current async context. */
export interface TraceScope {
  /** This execution's own thread ID — the parent of any thread it spawns. */
  readonly threadId: string;
  /** The tree's root thread ID, inherited unchanged; equals `threadId` on a root. */
  readonly rootId: string;
}

// The binding carries the service's tracing configuration alongside the
// ids, so an agent configured once passes tracing down to every client it
// uses inside the handler.
interface TraceBinding {
  readonly scope: TraceScope;
  readonly options: TraceOptions | undefined;
}

const storage = new AsyncLocalStorage<TraceBinding>();

/**
 * Run `fn` with `scope` as the ambient execution (used by the agent
 * service). AsyncLocalStorage restores the previous binding on exit, so
 * nothing leaks into the next request. `options`, when given, is the
 * service's tracing configuration and is inherited by clients used
 * inside `fn`.
 */
export function bindActiveTrace<T>(
  scope: TraceScope,
  fn: () => T,
  options: TraceOptions | undefined = undefined,
): T {
  return storage.run({ scope, options }, fn);
}

/** The ambient {@link TraceScope}, or `undefined` outside a bound handler. */
export function activeTrace(): TraceScope | undefined {
  return storage.getStore()?.scope;
}

/**
 * Tracing configuration handed down by the enclosing agent service.
 * `undefined` when the service has none, or outside a handler.
 */
export function inheritedTraceOptions(): TraceOptions | undefined {
  return storage.getStore()?.options;
}

/** Length in hex characters of a thread ID — 128 bits. */
export const THREAD_ID_HEX_LEN = 32;

export function randomThreadId(): string {
  // Thread IDs don't need to be secure and any random generator will
  // suffice. Still, using crypto.getRandomValues() doesn't cost us much.
  const bytes = new Uint8Array(THREAD_ID_HEX_LEN / 2);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export const TOOL_CALL_ID_MAX = 256;

export function validToolCallId(toolCallId: string): boolean {
  // This isn't intended as strict validation. It's just a basic
  // pass to avoid obvious garbage gets into the tracing system.
  return toolCallId.length > 0 && toolCallId.length <= TOOL_CALL_ID_MAX;
}

/** One edge record, ready to publish. */
export function buildEdgeRecord(
  threadId: string,
  parentId: string | null,
  rootId: string,
  toolCallId: string | null,
): Uint8Array {
  const record = {
    version: EDGE_RECORD_VERSION,
    record_id: randomThreadId(),
    ts: Math.floor(Date.now() / 1000),
    thread_id: threadId,
    parent_id: parentId,
    root_id: rootId,
    tool_call_id: toolCallId,
  };
  return new TextEncoder().encode(JSON.stringify(record));
}
