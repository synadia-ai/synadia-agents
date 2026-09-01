// Small shared helpers for the CLI scripts. Not exported publicly.

import { connect as natsConnect } from "@nats-io/transport-node";
import type { Msg, NatsConnection } from "@nats-io/nats-core";
import {
  Agents,
  resolveNatsConnectionBundle,
  type Agent,
  type NatsConnectionBundle,
  type NatsConnectionSource,
} from "@synadia-ai/agents";

export interface CliArgs {
  readonly context?: string;
  readonly natsUrl?: string;
  readonly owner?: string;
  readonly name?: string; // controller name, default "control"
  readonly rest: ReadonlyMap<string, string>;
  readonly positional: ReadonlyArray<string>;
}

export function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  const rest = new Map<string, string>();
  const positional: string[] = [];
  let context: string | undefined;
  let natsUrl: string | undefined;
  let owner: string | undefined;
  let name: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    let key: string;
    let value: string | undefined;
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      key = arg.slice(2, eq);
      value = arg.slice(eq + 1);
    } else {
      key = arg.slice(2);
      value = argv[i + 1];
      if (value !== undefined && value.startsWith("--")) value = undefined;
      else if (value !== undefined) i += 1;
    }
    if (value === undefined) {
      rest.set(key, "true");
      continue;
    }
    switch (key) {
      case "context":
        context = value;
        break;
      case "url":
      case "nats-url":
        natsUrl = value;
        break;
      case "owner":
        owner = value;
        break;
      case "name":
        name = value;
        break;
      default:
        rest.set(key, value);
    }
  }
  return {
    ...(context ? { context } : {}),
    ...(natsUrl ? { natsUrl } : {}),
    ...(owner ? { owner } : {}),
    ...(name ? { name } : {}),
    rest,
    positional,
  };
}

interface OpenedNats {
  readonly nc: NatsConnection;
  readonly bundle: NatsConnectionBundle;
  readonly senderIdentity: "off" | "signed";
}

async function openNats(args: CliArgs): Promise<OpenedNats> {
  const source: NatsConnectionSource | undefined = args.context
    ? { context: args.context }
    : args.natsUrl
      ? { url: args.natsUrl }
      : process.env["NATS_CONTEXT"]
        ? { context: process.env["NATS_CONTEXT"] }
        : process.env["NATS_URL"]
          ? { url: process.env["NATS_URL"] }
          : undefined;
  if (!source) {
    throw new Error("provide --context or --url (or set NATS_CONTEXT / NATS_URL)");
  }
  const rawMode = process.env["NATS_SENDER_IDENTITY"] ?? "off";
  if (rawMode !== "off" && rawMode !== "signed") {
    throw new Error('NATS_SENDER_IDENTITY must be "off" or "signed"');
  }
  const bundle = await resolveNatsConnectionBundle(source, { identity: rawMode });
  bundle.connectionOptions.name = "claude-code-headless-cli";
  try {
    return {
      nc: await natsConnect(bundle.connectionOptions),
      bundle,
      senderIdentity: rawMode,
    };
  } catch (error) {
    bundle.wipe();
    throw error;
  }
}

export function ownerFilter(args: CliArgs): string {
  return args.owner ??
    process.env["SYNADIA_CLAUDE_CODE_HEADLESS_OWNER"] ??
    process.env["SYNADIA_OWNER"] ??
    process.env["CLAUDE_CODE_HEADLESS_OWNER"] ??
    process.env["USER"] ??
    "";
}

export function nameFilter(args: CliArgs): string {
  return args.name ??
    process.env["SYNADIA_CLAUDE_CODE_HEADLESS_NAME"] ??
    process.env["SYNADIA_NAME"] ??
    process.env["CLAUDE_CODE_HEADLESS_NAME"] ??
    "control";
}

export async function findController(agents: Agents, args: CliArgs): Promise<Agent> {
  const found = await agents.discover();
  const owner = ownerFilter(args);
  const name = nameFilter(args);
  const candidates = found.filter((a) => {
    if (a.agent !== "cc-headless") return false;
    if (a.metadata["role"] !== "controller") return false;
    if (owner && a.owner !== owner) return false;
    if (name && a.name !== name) return false;
    return true;
  });
  if (candidates.length === 0) {
    throw new Error(
      `no claude-code-headless controller found (owner=${owner || "*"} name=${name}). Is it running?`,
    );
  }
  if (candidates.length > 1) {
    process.stderr.write(
      `claude-code-headless-cli: ${candidates.length} controllers found; using ${candidates[0]!.instanceId}\n`,
    );
  }
  return candidates[0]!;
}

export async function waitForSession(
  agents: Agents,
  instanceId: string,
  retries = 10,
  delayMs = 200,
): Promise<Agent> {
  for (let i = 0; i < retries; i++) {
    const found = await agents.discover();
    const match = found.find((a) => a.instanceId === instanceId);
    if (match) return match;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`spawned session ${instanceId} not discoverable after ${retries} tries`);
}

export interface CliClient {
  readonly nc: NatsConnection;
  readonly agents: Agents;
  request(subject: string, payload: string, timeout: number): Promise<Msg>;
  close(): Promise<void>;
}

export async function openCliClient(args: CliArgs): Promise<CliClient> {
  const opened = await openNats(args);
  const { nc, bundle, senderIdentity } = opened;
  let agents: Agents;
  try {
    agents = new Agents({
      nc,
      ...(senderIdentity === "signed"
        ? { identity: { signer: bundle.signer!, name: "claude-code-headless-cli" } }
        : {}),
    });
  } catch (error) {
    await nc.close();
    bundle.wipe();
    throw error;
  }
  return {
    nc,
    agents,
    request(subject, payload, timeout) {
      return senderIdentity === "signed"
        ? agents.requestSigned(subject, payload, { timeoutMs: timeout })
        : nc.request(subject, payload, { timeout });
    },
    async close() {
      try {
        await agents.close();
      } catch {
        /* noop */
      }
      await nc.close();
      bundle.wipe();
    },
  };
}
