// Observability tracing — the vocabulary shared by the client and the
// agent service. Mirrors `synadia_ai/agents/trace.py` in the Python SDK;
// the two must stay wire-identical.
//
// A thread ID names one prompt execution: minted by the caller at
// `prompt()` time, 128-bit random as 32 lowercase hex characters, and
// adopted by the receiving service. `rootId` has the same shape — it IS a
// thread ID, the tree's first execution.

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
