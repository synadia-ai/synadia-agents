import { Client } from "eve/client";
import type { ClientSession, HandleMessageStreamEvent, SendTurnPayload } from "eve/client";
import type { EveBridgeClient, EveSendInput } from "./bridge.js";
import type { EveTargetConfig } from "./config.js";

/**
 * eve/client-backed bridge client. Holds one lazy `ClientSession` for the
 * sidecar's lifetime — the session self-resets after a `session.completed` /
 * `session.failed` boundary (`preserveCompletedSessions` defaults to false),
 * so the next prompt starts a fresh Eve conversation without recreating it.
 */
export class SdkEveBridgeClient implements EveBridgeClient {
  readonly #target: EveTargetConfig;
  #session: ClientSession | undefined;

  constructor(target: EveTargetConfig) {
    this.#target = target;
  }

  async send(input: EveSendInput): Promise<AsyncIterable<HandleMessageStreamEvent>> {
    const session = this.#ensureSession();
    const payload: SendTurnPayload = {
      ...(input.message !== undefined ? { message: input.message } : {}),
      ...(input.inputResponses !== undefined && input.inputResponses.length > 0
        ? { inputResponses: input.inputResponses }
        : {}),
    };
    try {
      return await session.send(payload);
    } catch (err) {
      throw new Error(
        `eve server unreachable at ${this.#target.baseUrl}: ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  sessionId(): string | undefined {
    return this.#session?.state.sessionId;
  }

  /** Drop the current session handle; the next send creates a fresh Eve conversation. */
  resetSession(): void {
    this.#session = undefined;
  }

  #ensureSession(): ClientSession {
    if (this.#session === undefined) {
      const client = new Client({
        host: this.#target.baseUrl,
        ...(this.#target.authToken !== undefined ? { auth: { bearer: this.#target.authToken } } : {}),
      });
      this.#session = client.session();
    }
    return this.#session;
  }
}
