export class AsyncQueue<T> implements AsyncIterable<T> {
  #events: T[] = [];
  #waiters: Array<{ resolve(result: IteratorResult<T>): void; reject(error: unknown): void }> = [];
  #closed = false;
  #error: unknown;

  push(event: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value: event, done: false });
    else this.#events.push(event);
  }

  fail(error: unknown): void {
    this.#error = error;
    this.#closed = true;
    while (this.#waiters.length > 0) this.#waiters.shift()?.reject(error);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    while (this.#waiters.length > 0) this.#waiters.shift()?.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        if (this.#error) throw this.#error;
        const event = this.#events.shift();
        if (event) return { value: event, done: false };
        if (this.#closed) return { value: undefined, done: true };
        return await new Promise<IteratorResult<T>>((resolve, reject) => this.#waiters.push({ resolve, reject }));
      },
    };
  }
}
