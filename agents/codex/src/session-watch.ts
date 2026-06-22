import type { JsonRpcNotification } from "./codex-jsonrpc.js";

export function isThreadStartedNotification(notification: JsonRpcNotification): boolean {
  // Codex emits thread/started with private thread details. Treat this as a
  // wakeup only: callers must reconcile inventory before registering anything.
  return notification.method === "thread/started";
}

export class BoundedPollScheduler {
  readonly #intervalMs: number;
  readonly #task: () => Promise<void>;
  #timer: ReturnType<typeof setInterval> | undefined;
  #inFlight: Promise<void> | undefined;
  #pending = false;
  #stopped = false;

  constructor(intervalMs: number, task: () => Promise<void>) {
    this.#intervalMs = intervalMs;
    this.#task = task;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => { void this.trigger(); }, this.#intervalMs);
    this.#timer.unref?.();
  }

  async trigger(): Promise<void> {
    if (this.#stopped) return;
    if (this.#inFlight) {
      this.#pending = true;
      await this.#inFlight;
      return;
    }
    this.#inFlight = this.#drain();
    try {
      await this.#inFlight;
    } finally {
      this.#inFlight = undefined;
    }
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async #drain(): Promise<void> {
    do {
      this.#pending = false;
      await this.#task();
    } while (this.#pending && !this.#stopped);
  }
}
