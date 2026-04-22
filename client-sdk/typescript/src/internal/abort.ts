// Small AbortSignal utilities. Written in terms of the standard
// AbortController API only — no dependency on `AbortSignal.any` (Node
// 20.3+) so the SDK stays on any recent Node or Bun.

export function combineAbortSignals(signals: ReadonlyArray<AbortSignal | undefined>): AbortSignal {
  const active = signals.filter((s): s is AbortSignal => s !== undefined);
  if (active.length === 0) return new AbortController().signal; // never aborts
  if (active.length === 1) return active[0]!;
  for (const s of active) {
    if (s.aborted) return s;
  }
  const ctrl = new AbortController();
  for (const s of active) {
    s.addEventListener(
      "abort",
      () => {
        if (!ctrl.signal.aborted) ctrl.abort(s.reason);
      },
      { once: true },
    );
  }
  return ctrl.signal;
}

/** Return an Error that best represents an abort event — prefers `signal.reason`. */
export function abortError(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  try {
    return new DOMException("stream aborted", "AbortError");
  } catch {
    const err = new Error("stream aborted");
    err.name = "AbortError";
    return err;
  }
}
