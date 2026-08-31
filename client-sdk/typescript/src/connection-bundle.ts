// Resolve one NATS connection credential source into connection options and,
// only when explicitly requested, a sender-identity signer derived from the
// exact same immutable input snapshot.
//
// This is the safe high-level seam for long-running agent integrations. A
// pre-opened NatsConnection cannot reveal its private seed, while composing
// `loadContextOptions()` with `signerFromContext()` (or two separate creds
// reads) allows a file rotation between reads. This helper reads the selected
// context and auth/TLS files once, then builds both capabilities together.

import { credsAuthenticator, jwtAuthenticator, nkeyAuthenticator } from "@nats-io/nats-core";
import type { NodeConnectionOptions } from "@nats-io/transport-node";
import {
  expandHome,
  loadContextConnectionSnapshot,
  parseNatsUrl,
  readAuthFile,
  type ContextAuthSnapshot,
} from "./context.js";
import { IdentityError, NatsContextError } from "./errors.js";
import {
  normalizeUserSeed,
  signerFromCanonicalSeed,
  signerFromCanonicalSeedAndJwt,
  signerFromCreds,
  type SenderSigner,
} from "./identity/signer.js";

/** A direct URL with at most one connection credential source. */
export type NatsUrlConnectionSource = { readonly url: string } & (
  | { readonly creds: string; readonly nkey?: never }
  | { readonly nkey: string; readonly creds?: never }
  | { readonly creds?: never; readonly nkey?: never }
);

/**
 * The one source from which a connection bundle is resolved. `creds` and
 * `nkey` are connection credentials, never separate identity credentials.
 */
export type NatsConnectionSource =
  | {
      readonly context: string;
      readonly url?: never;
      readonly creds?: never;
      readonly nkey?: never;
    }
  | NatsUrlConnectionSource;

export interface ResolveNatsConnectionBundleOptions {
  /** Omit or use `"off"` for no signer; `"signed"` derives one from the connection credential snapshot. */
  readonly identity?: "off" | "signed";
}

/** Connection options backed by one retained credential snapshot. */
export interface NatsConnectionBundle {
  readonly connectionOptions: NodeConnectionOptions;
  /** Present only when `identity: "signed"` was selected. */
  readonly signer?: SenderSigner;
  /**
   * Clear retained auth/signing bytes and remove auth-bearing option fields.
   * Idempotent. Call only after the NATS connection has closed, because
   * reconnect authentication still needs them.
   */
  wipe(): void;
}

/** A connection bundle whose signer came from the same credential snapshot. */
export interface SignedNatsConnectionBundle extends NatsConnectionBundle {
  readonly signer: SenderSigner;
}

export function resolveNatsConnectionBundle(
  source: NatsConnectionSource,
  options?: { readonly identity?: "off" },
): Promise<NatsConnectionBundle>;
export function resolveNatsConnectionBundle(
  source: NatsConnectionSource,
  options: { readonly identity: "signed" },
): Promise<SignedNatsConnectionBundle>;
export function resolveNatsConnectionBundle(
  source: NatsConnectionSource,
  options?: ResolveNatsConnectionBundleOptions,
): Promise<NatsConnectionBundle | SignedNatsConnectionBundle>;
export async function resolveNatsConnectionBundle(
  source: NatsConnectionSource,
  options: ResolveNatsConnectionBundleOptions = {},
): Promise<NatsConnectionBundle | SignedNatsConnectionBundle> {
  validateSource(source);
  if (
    options.identity !== undefined &&
    options.identity !== "off" &&
    options.identity !== "signed"
  ) {
    throw new IdentityError('connection bundle identity must be "off" or "signed"');
  }

  const context = (source as Record<string, unknown>)["context"];
  if (typeof context === "string") {
    const snapshot = await loadContextConnectionSnapshot(context);
    let prepared: PreparedContextSnapshot;
    try {
      prepared = prepareContextSnapshot(snapshot);
    } catch (error) {
      snapshot.wipe();
      throw error;
    }
    if (options.identity !== "signed") {
      return makeBundle(prepared.connectionOptions, undefined, () => prepared.wipe());
    }
    try {
      const signer = signerFromContextSnapshot(snapshot.name, prepared.auth);
      return makeBundle(prepared.connectionOptions, signer, () => prepared.wipe());
    } catch (error) {
      prepared.wipe();
      throw error;
    }
  }

  // Runtime validation above established the URL branch; keep the cast here
  // rather than relying on property presence, since `{ context: undefined,
  // url: "…" }` is a valid JavaScript shape at this boundary.
  const directSource = source as NatsUrlConnectionSource;
  const connectionOptions = parseNatsUrl(directSource.url);
  const credential = await readDirectCredential(directSource);
  if (credential !== undefined) {
    // An explicit creds/nkey file is the selected connection auth source;
    // userinfo from the URL must not become a second competing credential.
    delete connectionOptions.token;
    delete connectionOptions.user;
    delete connectionOptions.pass;
    connectionOptions.authenticator =
      credential.kind === "creds"
        ? credsAuthenticator(credential.bytes)
        : nkeyAuthenticator(credential.bytes);
  }

  if (options.identity !== "signed") {
    return makeBundle(connectionOptions, undefined, () => credential?.bytes.fill(0));
  }
  if (credential === undefined) {
    throw new IdentityError(
      "signed identity requires URL connection credentials with a user seed (`creds` or `nkey`)",
    );
  }
  try {
    const signer =
      credential.kind === "creds"
        ? signerFromCreds(new TextDecoder().decode(credential.bytes))
        : signerFromCanonicalSeed(credential.bytes);
    return makeBundle(connectionOptions, signer, () => credential.bytes.fill(0));
  } catch (error) {
    credential.bytes.fill(0);
    throw error;
  }
}

function signerFromContextSnapshot(name: string, auth: ContextAuthSnapshot): SenderSigner {
  if (auth.kind === "creds") return signerFromCreds(new TextDecoder().decode(auth.bytes));
  if (auth.kind === "nkey") return signerFromCanonicalSeed(auth.bytes);
  if (auth.kind === "jwt-seed") return signerFromCanonicalSeedAndJwt(auth.seed, auth.jwt);
  throw new IdentityError(
    `NATS context "${name}" has no user seed; signed identity requires creds, nkey, or user_jwt with user_seed in that same context`,
  );
}

type DirectCredential =
  | { readonly kind: "creds"; readonly bytes: Uint8Array }
  | { readonly kind: "nkey"; readonly bytes: Uint8Array };

async function readDirectCredential(
  source: NatsUrlConnectionSource,
): Promise<DirectCredential | undefined> {
  if (source.creds !== undefined) {
    const bytes = await readAuthFile("creds", expandHome(source.creds));
    return {
      kind: "creds",
      bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    };
  }
  if (source.nkey !== undefined) {
    const bytes = await readAuthFile("nkey", expandHome(source.nkey));
    const raw = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    try {
      return { kind: "nkey", bytes: normalizeUserSeed(raw) };
    } finally {
      raw.fill(0);
    }
  }
  return undefined;
}

function makeBundle(
  connectionOptions: NodeConnectionOptions,
  signer: SenderSigner | undefined,
  wipeSnapshot: () => void,
): NatsConnectionBundle | SignedNatsConnectionBundle {
  let wiped = false;
  const wipe = (): void => {
    if (wiped) return;
    wiped = true;
    try {
      signer?.wipe?.();
    } finally {
      try {
        wipeSnapshot();
      } finally {
        clearAuthOptions(connectionOptions);
      }
    }
  };
  const identity = signer === undefined ? "off" : "signed";
  const bundle = Object.create(null) as Record<PropertyKey, unknown>;
  Object.defineProperty(bundle, "connectionOptions", {
    value: connectionOptions,
    enumerable: false,
  });
  if (signer !== undefined) {
    Object.defineProperty(bundle, "signer", { value: signer, enumerable: false });
  }
  Object.defineProperty(bundle, "wipe", { value: wipe, enumerable: false });
  Object.defineProperty(bundle, "toJSON", {
    value: (): { identity: "off" | "signed" } => ({ identity }),
    enumerable: false,
  });
  Object.defineProperty(bundle, "toString", {
    value: (): string => `NatsConnectionBundle(${identity})`,
    enumerable: false,
  });
  Object.defineProperty(bundle, Symbol.for("nodejs.util.inspect.custom"), {
    value: (): string => `NatsConnectionBundle(${identity})`,
    enumerable: false,
  });
  return Object.freeze(bundle) as unknown as NatsConnectionBundle | SignedNatsConnectionBundle;
}

function clearAuthOptions(connectionOptions: NodeConnectionOptions): void {
  delete connectionOptions.authenticator;
  delete connectionOptions.token;
  delete connectionOptions.user;
  delete connectionOptions.pass;
  delete connectionOptions.tls;
}

interface PreparedContextSnapshot {
  readonly connectionOptions: NodeConnectionOptions;
  readonly auth: ContextAuthSnapshot;
  wipe(): void;
}

/** Canonicalize seed auth once, then give NATS and signing that same buffer. */
function prepareContextSnapshot(
  snapshot: Awaited<ReturnType<typeof loadContextConnectionSnapshot>>,
): PreparedContextSnapshot {
  if (snapshot.auth.kind !== "nkey" && snapshot.auth.kind !== "jwt-seed") {
    return {
      connectionOptions: snapshot.connectionOptions,
      auth: snapshot.auth,
      wipe: () => snapshot.wipe(),
    };
  }

  const canonicalSeed = normalizeUserSeed(
    snapshot.auth.kind === "nkey" ? snapshot.auth.bytes : snapshot.auth.seed,
  );
  const auth: ContextAuthSnapshot =
    snapshot.auth.kind === "nkey"
      ? { kind: "nkey", bytes: canonicalSeed }
      : { kind: "jwt-seed", jwt: snapshot.auth.jwt, seed: canonicalSeed };
  snapshot.connectionOptions.authenticator =
    auth.kind === "nkey"
      ? nkeyAuthenticator(canonicalSeed)
      : jwtAuthenticator(auth.jwt, canonicalSeed);
  // The original raw bytes are no longer retained by the selected
  // authenticator. Zero them immediately; keep the canonical bytes until the
  // connection has closed so reconnect authentication remains possible.
  snapshot.wipe();
  let wiped = false;
  return {
    connectionOptions: snapshot.connectionOptions,
    auth,
    wipe() {
      if (wiped) return;
      wiped = true;
      canonicalSeed.fill(0);
    },
  };
}

function validateSource(source: NatsConnectionSource): void {
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    throw new NatsContextError("connection source must be an object");
  }
  const candidate = source as Record<string, unknown>;
  for (const field of ["context", "url", "creds", "nkey"] as const) {
    const value = candidate[field];
    if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
      throw new NatsContextError(`connection source \`${field}\` must be a non-empty string`);
    }
  }
  const hasContext = typeof candidate["context"] === "string";
  const hasUrl = typeof candidate["url"] === "string";
  if (hasContext === hasUrl) {
    throw new NatsContextError("connection source must select exactly one of `context` or `url`");
  }
  if (hasContext && (candidate["creds"] !== undefined || candidate["nkey"] !== undefined)) {
    throw new NatsContextError(
      "a context connection cannot also select direct `creds` or `nkey` credentials",
    );
  }
  if (candidate["creds"] !== undefined && candidate["nkey"] !== undefined) {
    throw new NatsContextError("a URL connection must select at most one of `creds` or `nkey`");
  }
}
