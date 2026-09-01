import { connect, type NatsConnection } from "@nats-io/transport-node";
import {
  resolveNatsConnectionBundle,
  type NatsConnectionBundle,
  type NatsConnectionSource,
} from "@synadia-ai/agents";

export interface ExampleNatsConnection {
  readonly nc: NatsConnection;
  readonly bundle: NatsConnectionBundle;
}

export async function connectExampleNats(name: string): Promise<ExampleNatsConnection> {
  const source = connectionSource();
  const identity = senderIdentity();
  const bundle = identity === "signed"
    ? await resolveNatsConnectionBundle(source, { identity })
    : await resolveNatsConnectionBundle(source);
  bundle.connectionOptions.name = name;
  try {
    return { nc: await connect(bundle.connectionOptions), bundle };
  } catch (error) {
    bundle.wipe();
    throw error;
  }
}

/** Close reconnecting NATS state before erasing its retained credential snapshot. */
export async function closeExampleNats(connection: ExampleNatsConnection): Promise<void> {
  await connection.nc.close();
  connection.bundle.wipe();
}

export function minSenderTrust(): "any" | "signed" {
  const value = process.env.NATS_MIN_SENDER_TRUST ?? "any";
  if (value === "any" || value === "signed") return value;
  throw new Error("NATS_MIN_SENDER_TRUST must be 'any' or 'signed'");
}

export function natsTargetDescription(): string {
  const context = process.env.NATS_CONTEXT?.trim();
  if (context) return `context ${context}`;
  return process.env.NATS_URL ? "configured URL" : "local default";
}

function connectionSource(): NatsConnectionSource {
  const context = process.env.NATS_CONTEXT?.trim();
  if (context) return { context };
  const url = process.env.NATS_URL ?? "nats://127.0.0.1:4222";
  const creds = process.env.NATS_CREDS;
  return creds ? { url, creds } : { url };
}

function senderIdentity(): "off" | "signed" {
  const value = process.env.NATS_SENDER_IDENTITY ?? "off";
  if (value === "off" || value === "signed") return value;
  throw new Error("NATS_SENDER_IDENTITY must be 'off' or 'signed'");
}
