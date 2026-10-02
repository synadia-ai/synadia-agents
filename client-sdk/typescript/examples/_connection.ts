import type { NatsConnection } from "@nats-io/nats-core";
import { connect as natsConnect } from "@nats-io/transport-node";
import {
  Agents,
  resolveNatsConnectionBundle,
  type NatsConnectionSource,
  type SenderSigner,
} from "@synadia-ai/agents";

const DEFAULT_NATS_URL = "nats://127.0.0.1:4222";

export type ExampleIdentityMode = "off" | "signed";

export interface ExampleConnectionOptions {
  /** Defaults to NATS_SENDER_IDENTITY, then `off`. */
  readonly identity?: ExampleIdentityMode;
  /** The interop probe disables contexts so developer state cannot leak in. */
  readonly allowContext?: boolean;
  /** Override env resolution for tests and specialized examples. */
  readonly source?: NatsConnectionSource;
}

export interface ExampleNatsConnection {
  readonly nc: NatsConnection;
  readonly signer?: SenderSigner;
  /** Close NATS first, then wipe the retained reconnect/signing snapshot. */
  close(): Promise<void>;
}

export interface ExampleAgentsConnection extends ExampleNatsConnection {
  readonly agents: Agents;
}

/** Resolve one complete context or direct URL/auth source from the established env vars. */
export function exampleConnectionSource(
  options: { readonly allowContext?: boolean } = {},
): NatsConnectionSource {
  const allowContext = options.allowContext ?? true;
  const context = allowContext ? process.env["NATS_CONTEXT"] : undefined;
  if (context) return { context };

  const url = process.env["NATS_URL"] || DEFAULT_NATS_URL;
  // Preserve the interop tools' historical precedence when both are set.
  const nkey = process.env["NATS_NKEY_SEED_FILE"];
  if (nkey) return { url, nkey };
  const creds = process.env["NATS_CREDS"] || process.env["NATS_CREDENTIALS"];
  if (creds) return { url, creds };
  return { url };
}

export function exampleIdentityMode(fallback: ExampleIdentityMode = "off"): ExampleIdentityMode {
  const value = process.env["NATS_SENDER_IDENTITY"];
  if (value === undefined || value === "") return fallback;
  if (value === "off" || value === "signed") return value;
  throw new Error('NATS_SENDER_IDENTITY must be "off" or "signed"');
}

/** Whether a direct source can derive a signer without inspecting credential bytes. */
export function hasSignerCredential(source: NatsConnectionSource): boolean {
  return "creds" in source || "nkey" in source;
}

export async function openExampleNatsConnection(
  options: ExampleConnectionOptions = {},
): Promise<ExampleNatsConnection> {
  const identity = options.identity ?? exampleIdentityMode();
  const source =
    options.source ?? exampleConnectionSource({ allowContext: options.allowContext ?? true });
  const bundle = await resolveNatsConnectionBundle(source, { identity });
  let nc: NatsConnection;
  try {
    nc = await natsConnect(bundle.connectionOptions);
  } catch (error) {
    bundle.wipe();
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      try {
        // Reconnect authentication may still reference the bundle snapshot.
        // Wipe only after close succeeds and reconnect is impossible.
        await nc.close();
        bundle.wipe();
      } catch (error) {
        closePromise = undefined;
        throw error;
      }
    })();
    return closePromise;
  };
  return {
    nc,
    ...(bundle.signer ? { signer: bundle.signer } : {}),
    close,
  };
}

export async function openExampleAgents(
  options: ExampleConnectionOptions = {},
): Promise<ExampleAgentsConnection> {
  const connection = await openExampleNatsConnection(options);
  let agents: Agents;
  try {
    agents = new Agents({
      nc: connection.nc,
      ...(connection.signer ? { identity: { signer: connection.signer } } : {}),
    });
  } catch (error) {
    await connection.close();
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      try {
        await agents.close();
      } finally {
        await connection.close();
      }
    })().catch((error: unknown) => {
      closePromise = undefined;
      throw error;
    });
    return closePromise;
  };
  return {
    nc: connection.nc,
    agents,
    ...(connection.signer ? { signer: connection.signer } : {}),
    close,
  };
}

export function waitForTermination(): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => resolve();
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}
