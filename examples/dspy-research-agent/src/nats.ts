import { connect, type NatsConnection } from "@nats-io/transport-node";
import {
  resolveNatsConnectionBundle,
  type NatsConnectionBundle,
  type NatsConnectionSource,
} from "@synadia-ai/agents";

export interface ResearchNatsConnection {
  readonly nc: NatsConnection;
  readonly bundle: NatsConnectionBundle;
}

export async function connectResearchNats(name: string): Promise<ResearchNatsConnection> {
  const context = process.env["NATS_CONTEXT"]?.trim();
  const url = process.env["NATS_URL"] ?? "nats://127.0.0.1:4222";
  const creds = process.env["NATS_CREDS"];
  const source: NatsConnectionSource = context
    ? { context }
    : creds
      ? { url, creds }
      : { url };
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

export function minSenderTrust(): "any" | "signed" {
  const value = process.env["NATS_MIN_SENDER_TRUST"] ?? "any";
  if (value === "any" || value === "signed") return value;
  throw new Error("NATS_MIN_SENDER_TRUST must be 'any' or 'signed'");
}

function senderIdentity(): "off" | "signed" {
  const value = process.env["NATS_SENDER_IDENTITY"] ?? "off";
  if (value === "off" || value === "signed") return value;
  throw new Error("NATS_SENDER_IDENTITY must be 'off' or 'signed'");
}
