// Error class hierarchy. All SDK errors inherit from `NatsAgentError` so
// callers can branch on one base class; `instanceof` matches on specific
// subclasses for targeted handling.
//
// Wire errors (spec §9) live under {@link ServiceError}. Local validation
// errors (§5.4) are synchronous throws from `RemoteAgent.prompt` and live
// under {@link ValidationError}.

/** Base class for all errors produced by this SDK. */
export class NatsAgentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NatsAgentError";
  }
}

// ---------------------------------------------------------------------------
// Local validation — thrown synchronously from `prompt()` before any wire I/O.
// ---------------------------------------------------------------------------

export class ValidationError extends NatsAgentError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ValidationError";
  }
}

/** `prompt` field must be non-empty (spec §5.1). */
export class PromptEmptyError extends ValidationError {
  constructor() {
    super("prompt must be non-empty (spec §5.1)");
    this.name = "PromptEmptyError";
  }
}

/** Attachments supplied but endpoint declared `attachments_ok: false` (spec §5.4). */
export class AttachmentsNotSupportedError extends ValidationError {
  constructor() {
    super(
      "this agent's prompt endpoint does not accept attachments (attachments_ok=false, spec §5.4)",
    );
    this.name = "AttachmentsNotSupportedError";
  }
}

/** Serialized envelope exceeds the endpoint's `max_payload` (spec §5.4). */
export class PayloadTooLargeError extends ValidationError {
  constructor(
    public readonly limit: number,
    public readonly actual: number,
  ) {
    super(
      `payload size ${actual} bytes exceeds endpoint max_payload of ${limit} bytes (spec §5.4)`,
    );
    this.name = "PayloadTooLargeError";
  }
}

// ---------------------------------------------------------------------------
// Wire errors — thrown from the stream iterator.
// ---------------------------------------------------------------------------

export interface ServiceErrorBody {
  readonly error?: string;
  readonly message?: string;
  readonly [extra: string]: unknown;
}

/**
 * The agent returned an error response per spec §9. Carries the numeric
 * status code from the `Nats-Service-Error-Code` header, the header's
 * description, and the parsed JSON body if the response carried one.
 */
export class ServiceError extends NatsAgentError {
  constructor(
    public readonly code: number,
    public readonly description: string,
    public readonly body?: ServiceErrorBody,
  ) {
    super(`service error ${code}: ${description}`);
    this.name = "ServiceError";
  }
}

/** The stream went silent for longer than the inactivity timeout (spec §6.6). */
export class StreamStalledError extends NatsAgentError {
  constructor(public readonly timeoutMs: number) {
    super(`stream stalled: no chunk received within ${timeoutMs}ms (spec §6.6)`);
    this.name = "StreamStalledError";
  }
}

/** A received wire payload could not be interpreted per spec. */
export class ProtocolError extends NatsAgentError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProtocolError";
  }
}

// ---------------------------------------------------------------------------
// NATS context (§10.2) — thrown by `loadNatsContext` and `connect({ context })`.
// ---------------------------------------------------------------------------

export class NatsContextError extends NatsAgentError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NatsContextError";
  }
}

export class NatsContextNotFoundError extends NatsContextError {
  constructor(
    public readonly contextName: string,
    public readonly searchedPath: string,
  ) {
    super(`NATS context "${contextName}" not found at ${searchedPath}`);
    this.name = "NatsContextNotFoundError";
  }
}

export class NatsContextNotSelectedError extends NatsContextError {
  constructor(public readonly selectionFilePath: string) {
    super(
      `no NATS context is currently selected (no $NATS_CONTEXT env var and no file at ${selectionFilePath})`,
    );
    this.name = "NatsContextNotSelectedError";
  }
}

export class NatsContextInvalidError extends NatsContextError {
  constructor(
    public readonly contextName: string,
    public readonly reason: string,
  ) {
    super(`NATS context "${contextName}" is invalid: ${reason}`);
    this.name = "NatsContextInvalidError";
  }
}
