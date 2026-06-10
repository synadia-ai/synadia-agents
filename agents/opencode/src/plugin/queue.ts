import type { PluginEventQueue, PluginPromptEventQueueItem } from "./types.js";

export class AsyncPluginEventQueue implements PluginEventQueue {
  #events: PluginPromptEventQueueItem[] = [];
  #waiters: Array<{ resolve(result: IteratorResult<PluginPromptEventQueueItem>): void; reject(error: unknown): void }> = [];
  #closed = false;
  #error: unknown;

  push(event: PluginPromptEventQueueItem): void {
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

  [Symbol.asyncIterator](): AsyncIterator<PluginPromptEventQueueItem> {
    return {
      next: async () => {
        if (this.#error) throw this.#error;
        const event = this.#events.shift();
        if (event) return { value: event, done: false };
        if (this.#closed) return { value: undefined, done: true };
        return await new Promise<IteratorResult<PluginPromptEventQueueItem>>((resolve, reject) => this.#waiters.push({ resolve, reject }));
      },
    };
  }
}
