// Error class hierarchy. All SDK errors inherit from `NatsAgentError` so
// callers can branch on one base class; `instanceof` matches on specific
// subclasses for targeted handling.
//
// Wire errors (spec §9) live under {@link ServiceError}. Local validation
// errors (§5.4) are synchronous throws from `Agent.prompt` and live
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

/**
 * Serialized envelope exceeds the endpoint's `max_payload` (spec §5.4).
 * `headerBytes` is the framed `Agent-Sender` header size counted alongside
 * the payload (sender-identity extension); `0` when no header is sent.
 */
export class PayloadTooLargeError extends ValidationError {
  constructor(
    public readonly limit: number,
    public readonly actual: number,
    public readonly headerBytes: number = 0,
  ) {
    super(
      headerBytes > 0
        ? `payload size ${actual} bytes plus Agent-Sender header ${headerBytes} bytes exceeds ` +
            `endpoint max_payload of ${limit} bytes (spec §5.4)`
        : `payload size ${actual} bytes exceeds endpoint max_payload of ${limit} bytes (spec §5.4)`,
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

/**
 * The stream ran past its absolute deadline without seeing the wire
 * terminator (spec §6.5). Distinct from {@link StreamStalledError}: the
 * agent may still be sending chunks at less than the inactivity gap, but
 * the total time exceeded the per-prompt `maxWaitMs` ceiling.
 */
export class StreamMaxWaitExceededError extends NatsAgentError {
  constructor(public readonly maxWaitMs: number) {
    super(`stream exceeded maxWait of ${maxWaitMs}ms without terminator`);
    this.name = "StreamMaxWaitExceededError";
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
// Configuration / context resolution.
// ---------------------------------------------------------------------------

/** Failure resolving a `nats` CLI context (see {@link loadContextOptions}). */
export class NatsContextError extends NatsAgentError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NatsContextError";
  }
}

// ---------------------------------------------------------------------------
// Sender identity (the sender-identity extension, spec
// `agent-protocol-sender-identity.md`). Base class is `IdentityError`,
// deliberately NOT under `ValidationError`: only the two errors the
// caller can know synchronously (`SenderSignatureRequiredError`, the size
// bound) are thrown from `prompt()`; the rest reject the returned promise.
// ---------------------------------------------------------------------------

/** Base class for every sender-identity error. */
export class IdentityError extends NatsAgentError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IdentityError";
  }
}

/**
 * The server answered `$SYS.REQ.USER.INFO` but the connection has no NKEY
 * user (no authentication, a password or token user), or reported a
 * config-mode account name the canonical agent-ID form cannot carry. The
 * message names the fix.
 */
export class NoIdentityError extends IdentityError {
  constructor(reason: string) {
    super(
      `this connection has no NKEY identity (${reason}); configure an nkey user on ` +
        `the server and connect with its seed, or connect with a credentials file`,
    );
    this.name = "NoIdentityError";
  }
}

/**
 * The SDK does not know the connection's identity: `$SYS.REQ.USER.INFO`
 * did not answer within the timeout, a permission blocks it, or the two
 * identity sources (credentials JWT, server) disagree.
 */
export class IdentityUnavailableError extends IdentityError {
  constructor(message: string, options?: ErrorOptions) {
    super(`identity unavailable: ${message}`, options);
    this.name = "IdentityUnavailableError";
  }
}

/** The configured signer's public key is not the connection's user NKEY. */
export class IdentityMismatchError extends IdentityError {
  constructor(
    public readonly signerPublicKey: string,
    public readonly identityUser: string,
  ) {
    super(
      `identity mismatch: the configured signer holds ${signerPublicKey} but the ` +
        `connection's user NKEY is ${identityUser}`,
    );
    this.name = "IdentityMismatchError";
  }
}

/** `parseAgentId` / `newAgentId` rejected the input (also for empty tokens). */
export class InvalidAgentIdError extends IdentityError {
  constructor(message: string) {
    super(`invalid agent id: ${message}`);
    this.name = "InvalidAgentIdError";
  }
}

/** The `Agent-Sender` header failed the parser (spec: `400`). */
export class MalformedSenderHeaderError extends IdentityError {
  constructor(message: string) {
    super(`malformed Agent-Sender header: ${message}`);
    this.name = "MalformedSenderHeaderError";
  }
}

/** The endpoint declares `min_sender_trust: signed` and no signer is configured. */
export class SenderSignatureRequiredError extends IdentityError {
  constructor(subject: string) {
    super(
      `${subject} requires a signed Agent-Sender header (min_sender_trust=signed) but no ` +
        `identity.signer is configured`,
    );
    this.name = "SenderSignatureRequiredError";
  }
}

/**
 * Host-internal: a classified request is refused. `.code` is the wire
 * status — `401` for a required-but-absent signature, a failing check
 * (signature, `sub`, stale `ts`, replayed nonce, operator-attested
 * disagreement) or a claimed / absent sender the acceptance hook refused;
 * `403` for a verified sender the hook refused. The description carries
 * one of two generic texts; details go to the receiver's log only.
 */
export class SenderVerificationError extends IdentityError {
  constructor(
    public readonly code: 401 | 403,
    /** Generic wire description ("signature required" or "sender rejected"). */
    public readonly description: string,
    /** Receiver-side detail — never sent on the wire. */
    public readonly detail: string,
  ) {
    super(`sender verification failed (${code}): ${detail}`);
    this.name = "SenderVerificationError";
  }
}
