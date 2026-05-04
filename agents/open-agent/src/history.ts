// Ephemeral, in-process conversation history.
//
// One bridge process = one (owner, session) pair = one history. Persistence
// across restarts is a non-goal for v1; if the process dies, the
// conversation is gone.

import type { ModelMessage } from "ai";

export class ConversationHistory {
  readonly #messages: ModelMessage[] = [];

  append(message: ModelMessage): void {
    this.#messages.push(message);
  }

  appendAll(messages: ReadonlyArray<ModelMessage>): void {
    this.#messages.push(...messages);
  }

  snapshot(): ModelMessage[] {
    // Caller may pass this straight to `agent.stream({messages})`; AI SDK
    // mutates its working copy, so hand back a fresh array.
    return [...this.#messages];
  }

  get length(): number {
    return this.#messages.length;
  }
}
