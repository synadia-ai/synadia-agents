// Wrap an async iterable with a per-item inactivity deadline (§6.6).
//
// If no item arrives within `timeoutMs` since the previous item, the
// generator throws `buildError()`. The timer resets on every delivered
// item.
//
// Deliberately does NOT call `it.return?.()` in a finally — the upstream
// iterator is owned by the caller (e.g. `PromptStream` owns the NATS
// subscription). Calling `it.return()` here could deadlock on a pending
// `it.next()` that only completes after the owner unsubscribes.

export async function* withInactivityTimeout<T>(
  source: AsyncIterable<T>,
  timeoutMs: number,
  buildError: () => Error,
): AsyncGenerator<T> {
  const it = source[Symbol.asyncIterator]();
  while (true) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(buildError()), timeoutMs);
    });
    let result: IteratorResult<T>;
    try {
      result = await Promise.race([it.next(), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (result.done) return;
    yield result.value;
  }
}
