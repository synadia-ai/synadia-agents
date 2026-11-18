/**
 * The inbound bridge: serves prompts from the NATS fleet in the live Copilot
 * session, one at a time, and maps the session's events back onto the
 * prompt's response stream.
 *
 * Mapping (the session's root agent only; sub-agent events are skipped):
 *
 *   inbound prompt            -> queued; sent with `session.send` when the
 *                                session is idle and no other remote prompt
 *                                holds the turn ("busy" status while queued)
 *   user.message (ours)       -> the turn is ours from here: "status"
 *   assistant.message_delta   -> "response" chunk with the delta
 *   assistant.message         -> "response" chunk, only when no deltas came
 *                                for that message (non-streaming runtimes)
 *   tool.execution_start      -> "status" `tool: <name>`
 *   tool.execution_complete   -> "status" `tool done|failed: <name>`
 *   session.error / abort     -> "status"
 *   session.idle              -> the handler returns: the service sends the
 *                                §6.5 terminator
 *   user.message (not ours)   -> also ends ours: a message typed by the
 *                                human (queued behind ours) starts a turn
 *                                that is not the caller's
 *
 * Ownership is decided by the message id `session.send` returns (or, when
 * the event beats the promise, by the exact prompt text), so output from a
 * human's turn, before or after ours, never leaks to the remote caller.
 */

export interface BridgeEvent {
  readonly type: string;
  readonly data?: unknown;
  readonly agentId?: string;
}

export interface BridgeAttachment {
  readonly type: "file";
  readonly path: string;
  readonly displayName?: string;
}

/** The part of `CopilotSession` the bridge uses. */
export interface BridgeSession {
  send(options: { prompt: string; attachments?: BridgeAttachment[] }): Promise<string>;
  on(handler: (event: BridgeEvent) => void): () => void;
}

/** The part of the service's `PromptResponse` the bridge uses. */
export interface BridgeResponse {
  send(chunk: string | { readonly type: "status"; readonly status: string }): Promise<void>;
}

export interface BridgeRequest {
  /** The text sent into the session (already framed by the caller of `serve`). */
  readonly prompt: string;
  readonly attachments?: BridgeAttachment[];
  readonly response: BridgeResponse;
  /** Opaque value handed back by {@link InboundBridge.current}. */
  readonly context?: unknown;
}

export interface BridgeOptions {
  /** Most prompts waiting behind the active one. Default 8. */
  readonly queueLimit?: number;
  /**
   * How long a sent prompt may go without the session picking it up while
   * the session reports nothing else running. Default 60 s.
   */
  readonly pickupTimeoutMs?: number;
  readonly log?: (message: string) => void;
}

export class QueueFullError extends Error {
  constructor(limit: number) {
    super(`Copilot session is busy; ${limit} prompt(s) already queued`);
    this.name = "QueueFullError";
  }
}

export class BridgeClosedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "BridgeClosedError";
  }
}

interface Pending {
  readonly request: BridgeRequest;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  sentId: string | undefined;
  sent: boolean;
  started: boolean;
  finished: boolean;
  pickupTimer: ReturnType<typeof setTimeout> | undefined;
  /** Message ids that streamed deltas; their final `assistant.message` is not re-sent. */
  readonly streamed: Set<string>;
  lastMessageId: string | undefined;
  wroteText: boolean;
  readonly tools: Map<string, string>;
  /** Chunks are sent in order: one promise chain per request. */
  chain: Promise<void>;
}

export class InboundBridge {
  readonly #session: BridgeSession;
  readonly #queueLimit: number;
  readonly #pickupTimeoutMs: number;
  readonly #log: (message: string) => void;
  readonly #queue: Pending[] = [];
  #active: Pending | undefined;
  /** A turn not started by the bridge (the human's, or one queued in the CLI) is running. */
  #busy = false;
  #closed = false;
  readonly #unsubscribe: () => void;

  constructor(session: BridgeSession, options: BridgeOptions = {}) {
    this.#session = session;
    this.#queueLimit = options.queueLimit ?? 8;
    this.#pickupTimeoutMs = options.pickupTimeoutMs ?? 60_000;
    this.#log = options.log ?? (() => undefined);
    this.#unsubscribe = session.on((event) => this.#onEvent(event));
  }

  /** Whether the session is running a turn that is not a served prompt. */
  get busy(): boolean {
    return this.#busy;
  }

  /** Prompts waiting behind the active one. */
  get queued(): number {
    return this.#queue.length;
  }

  /** The request whose turn is running now, if a served prompt holds the turn. */
  current(): BridgeRequest | undefined {
    const active = this.#active;
    return active?.started && !active.finished ? active.request : undefined;
  }

  /**
   * Serve one prompt: resolves when its turn ends (the service then sends
   * the terminator), rejects when it cannot be served.
   */
  serve(request: BridgeRequest): Promise<void> {
    if (this.#closed) return Promise.reject(new BridgeClosedError("Copilot session is shutting down"));
    const waiting = this.#queue.length + (this.#active ? 1 : 0) + (this.#busy ? 1 : 0);
    if (waiting > 0 && this.#queue.length >= this.#queueLimit) {
      return Promise.reject(new QueueFullError(this.#queueLimit));
    }
    return new Promise<void>((resolve, reject) => {
      const pending: Pending = {
        request,
        resolve,
        reject,
        sentId: undefined,
        sent: false,
        started: false,
        finished: false,
        pickupTimer: undefined,
        streamed: new Set(),
        lastMessageId: undefined,
        wroteText: false,
        tools: new Map(),
        chain: Promise.resolve(),
      };
      this.#queue.push(pending);
      if (this.#active || this.#busy) {
        this.#emit(pending, {
          type: "status",
          status: `queued: Copilot session is busy (position ${this.#queue.length})`,
        });
      }
      this.#pump();
    });
  }

  /** Fail every waiting and active prompt and stop listening. Idempotent. */
  close(reason = "Copilot session ended"): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe();
    const all = [...(this.#active ? [this.#active] : []), ...this.#queue.splice(0)];
    for (const p of all) this.#finish(p, new BridgeClosedError(reason));
  }

  #pump(): void {
    if (this.#closed || this.#active || this.#busy) return;
    const next = this.#queue.shift();
    if (!next) return;
    this.#active = next;
    this.#queue.forEach((p, i) =>
      this.#emit(p, { type: "status", status: `queued: Copilot session is busy (position ${i + 1})` }),
    );
    const { prompt, attachments } = next.request;
    this.#armPickup(next);
    next.sent = true;
    this.#session
      .send({ prompt, ...(attachments && attachments.length > 0 ? { attachments } : {}) })
      .then((id) => {
        next.sentId = id;
      })
      .catch((error: unknown) => {
        this.#finish(next, new Error(`Copilot session refused the prompt: ${errorText(error)}`));
      });
  }

  #armPickup(p: Pending): void {
    if (p.pickupTimer) clearTimeout(p.pickupTimer);
    p.pickupTimer = setTimeout(() => {
      if (!p.started && !p.finished) {
        this.#finish(p, new Error("Copilot session did not pick up the prompt"));
      }
    }, this.#pickupTimeoutMs);
    p.pickupTimer.unref?.();
  }

  #isOurs(p: Pending, data: Record<string, unknown>): boolean {
    const id = typeof data.messageId === "string" ? data.messageId : undefined;
    if (p.sentId !== undefined && id !== undefined && id === p.sentId) return true;
    if (typeof data.content !== "string") return false;
    const content = data.content.trim();
    const prompt = p.request.prompt.trim();
    // The CLI may decorate the stored text (e.g. attachment notes): a match on
    // the leading text, which carries the remote header, is enough.
    return content === prompt || content.startsWith(prompt.slice(0, 120));
  }

  #onEvent(event: BridgeEvent): void {
    if (this.#closed) return;
    const data = (event.data ?? {}) as Record<string, unknown>;
    const p = this.#active;
    // Sub-agent events belong to a tool call of the root turn; the root's
    // own tool events already describe it.
    if (event.agentId !== undefined && event.type !== "session.idle") return;
    // Activity while ours waits in the CLI's own queue: still alive.
    if (p && p.sent && !p.started && event.type !== "session.idle") this.#armPickup(p);

    switch (event.type) {
      case "assistant.turn_start":
        if (!p?.started) this.#busy = true;
        return;
      case "user.message": {
        if (p && !p.started && p.sent && this.#isOurs(p, data)) {
          p.started = true;
          this.#busy = false;
          if (p.pickupTimer) clearTimeout(p.pickupTimer);
          this.#emit(p, { type: "status", status: "copilot: turn started" });
          return;
        }
        if (p?.started) {
          if (data.isAutopilotContinuation === true) return;
          // Someone else's message: the caller's turn is over.
          this.#busy = true;
          this.#finish(p);
          return;
        }
        this.#busy = true;
        return;
      }
      case "assistant.message_delta": {
        if (!p?.started) return;
        const text = typeof data.deltaContent === "string" ? data.deltaContent : "";
        const id = typeof data.messageId === "string" ? data.messageId : undefined;
        if (id) p.streamed.add(id);
        this.#writeText(p, id, text);
        return;
      }
      case "assistant.message": {
        if (!p?.started) return;
        const id = typeof data.messageId === "string" ? data.messageId : undefined;
        if (id && p.streamed.has(id)) return;
        const text = typeof data.content === "string" ? data.content : "";
        this.#writeText(p, id, text);
        return;
      }
      case "tool.execution_start": {
        if (!p?.started) return;
        const name = typeof data.toolName === "string" ? data.toolName : "tool";
        if (typeof data.toolCallId === "string") p.tools.set(data.toolCallId, name);
        this.#emit(p, { type: "status", status: `tool: ${name}` });
        return;
      }
      case "tool.execution_complete": {
        if (!p?.started) return;
        const name =
          (typeof data.toolCallId === "string" ? p.tools.get(data.toolCallId) : undefined) ?? "tool";
        this.#emit(p, { type: "status", status: `tool ${data.success === false ? "failed" : "done"}: ${name}` });
        return;
      }
      case "session.error": {
        if (!p?.started) return;
        const message = typeof data.message === "string" ? data.message : "unknown error";
        this.#emit(p, { type: "status", status: `copilot error: ${message}` });
        return;
      }
      case "abort":
        if (p?.started) this.#emit(p, { type: "status", status: "copilot: turn aborted in the local session" });
        return;
      case "session.idle":
        if (event.agentId !== undefined) return;
        this.#busy = false;
        if (p?.started) {
          if (data.aborted === true) {
            this.#emit(p, { type: "status", status: "copilot: turn aborted in the local session" });
          }
          this.#finish(p);
        } else {
          this.#pump();
        }
        return;
      case "session.shutdown":
        this.close("Copilot session shut down");
        return;
      default:
        return;
    }
  }

  #writeText(p: Pending, messageId: string | undefined, text: string): void {
    if (!text) return;
    let out = text;
    if (p.wroteText && messageId !== undefined && p.lastMessageId !== undefined && messageId !== p.lastMessageId) {
      out = `\n\n${text}`;
    }
    if (messageId !== undefined) p.lastMessageId = messageId;
    p.wroteText = true;
    this.#emit(p, out);
  }

  #emit(p: Pending, chunk: string | { type: "status"; status: string }): void {
    if (p.finished) return;
    p.chain = p.chain
      .then(() => p.request.response.send(chunk))
      .catch((error: unknown) => this.#log(`synadia-nats: chunk send failed: ${errorText(error)}`));
  }

  #finish(p: Pending, error?: Error): void {
    if (p.finished) return;
    if (p.pickupTimer) clearTimeout(p.pickupTimer);
    const queuedAt = this.#queue.indexOf(p);
    if (queuedAt >= 0) this.#queue.splice(queuedAt, 1);
    const chain = p.chain;
    p.finished = true;
    if (this.#active === p) this.#active = undefined;
    // Let the chunks already queued go out before the terminator.
    void chain.then(() => (error ? p.reject(error) : p.resolve()));
    queueMicrotask(() => this.#pump());
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
