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
import { NatsAgentError } from "./errors.js";

// Bump every time you change the trace record schema
// (be sure the Python SDK is updated in lockstep)
export const EDGE_RECORD_VERSION = 2;

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

/**
 * Throws {@link NatsAgentError} when `options.edgeSubject` names a subject
 * that can never be published to: empty, an empty token, whitespace or
 * NUL, or a wildcard. Publishing is fail-open, so without this check a
 * misconfigured subject would only ever show up as a warning on every
 * prompt; checking where the options are accepted makes it fail at
 * construction instead.
 */
export function assertValidTraceOptions(options: TraceOptions | undefined): void {
  if (options === undefined) return;
  const subject = options.edgeSubject;
  if (subject === undefined || subject === null) return;
  const reject = (reason: string): never => {
    throw new NatsAgentError(`trace.edgeSubject ${JSON.stringify(subject)}: ${reason}`);
  };
  if (typeof subject !== "string") reject("must be a string or null");
  if (subject.length === 0) reject("must not be empty");
  for (const token of subject.split(".")) {
    if (token.length === 0) reject("must not contain an empty token");
    if (/[\s\0]/.test(token)) reject("must not contain whitespace or NUL");
    if (token.includes("*") || token.includes(">")) reject("must not contain wildcards");
  }
}

/** Identity of the prompt execution running in the current async context. */
export interface TraceScope {
  /** This execution's own thread ID — the parent of any thread it spawns. */
  readonly threadId: string;
  /** The tree's root thread ID, inherited unchanged; equals `threadId` on a root. */
  readonly rootId: string;
  /**
   * Where in this execution any thread it spawns next was sent out: how
   * many times it has stamped trace headers on a model request so far.
   * Deliberately mutable and shared — work spawned inside the handler
   * holds the same scope object, so its turns count against this
   * execution.
   */
  turnCountHint: number;
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

const THREAD_ID_RE = new RegExp(`^[0-9a-f]{${THREAD_ID_HEX_LEN}}$`);

/**
 * `true` iff `value` has the shape of a thread ID: exactly
 * {@link THREAD_ID_HEX_LEN} lowercase hex characters. Ids arriving on the
 * wire are untrusted input that ends up in the headers an agent stamps on
 * its model requests, so a receiver adopts nothing that is not shaped
 * exactly like what the SDKs mint.
 */
export function isThreadId(value: string): boolean {
  return THREAD_ID_RE.test(value);
}

export function randomThreadId(): string {
  // Thread IDs don't need to be secure and any random generator will
  // suffice. Still, using crypto.getRandomValues() doesn't cost us much.
  const bytes = new Uint8Array(THREAD_ID_HEX_LEN / 2);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Longest accepted tool call id, in Unicode code points. */
export const TOOL_CALL_ID_MAX = 256;

// A surrogate half with no partner: not a Unicode scalar value, so it has
// no UTF-8 form. `JSON.stringify` would escape it while Python could not
// encode the record at all, and the two SDKs must write the same bytes.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function validToolCallId(toolCallId: string): boolean {
  // This isn't intended as strict validation. It's just a basic
  // pass to avoid obvious garbage gets into the tracing system.
  // Counted in code points — not UTF-16 units — so the Python SDK, whose
  // `len()` counts code points, accepts exactly the same ids.
  if (LONE_SURROGATE.test(toolCallId)) return false;
  const codePoints = Array.from(toolCallId).length;
  return codePoints > 0 && codePoints <= TOOL_CALL_ID_MAX;
}

/** One built edge record: its wire bytes and the id that de-duplicates it. */
export interface BuiltEdgeRecord {
  readonly recordId: string;
  readonly payload: Uint8Array;
}

/**
 * One edge record, ready to publish. The record id comes back alongside
 * the payload: the publisher stamps it as `Nats-Msg-Id` so a stream
 * de-duplicates a record it already stored.
 */
export function buildEdgeRecord(
  threadId: string,
  parentId: string | null,
  rootId: string,
  toolCallId: string | null,
  turnCountHint: number,
): BuiltEdgeRecord {
  // `turnCountHint` says where in the spawning thread this subprompt went
  // out: turns completed when it was spawned, 0 on a root (nothing spawned
  // it). A position marker, not a total — turns the parent takes after its
  // last spawn are recorded nowhere.
  const recordId = randomThreadId();
  const record = {
    version: EDGE_RECORD_VERSION,
    record_id: recordId,
    ts: Math.floor(Date.now() / 1000),
    thread_id: threadId,
    parent_id: parentId,
    root_id: rootId,
    tool_call_id: toolCallId,
    turn_count_hint: turnCountHint,
  };
  return { recordId, payload: new TextEncoder().encode(JSON.stringify(record)) };
}
