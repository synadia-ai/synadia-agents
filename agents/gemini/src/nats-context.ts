// NATS connection resolution for the gemini channel.
//
// Resolution order (first hit wins):
//   1. `--nats-url` flag / `NATS_URL` env (direct URL)
//   2. `--nats-context` flag (saved `nats` CLI context by name)
//   3. `~/.gemini/agent/nats-channel.json` (optional config file)
//   4. fallback to `nats://127.0.0.1:4222`

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { connect, type NodeConnectionOptions } from "@nats-io/transport-node";
import { loadContextOptions, parseNatsUrl } from "@synadia-ai/agents";
import type { NatsConnection } from "@nats-io/nats-core";

export interface ChannelConfig {
  readonly context?: string;
  readonly owner?: string;
  readonly session?: string;
}

export const CONFIG_DIR = join(homedir(), ".gemini", "agent");
export const CONFIG_FILE = join(CONFIG_DIR, "nats-channel.json");

export function loadChannelConfig(): ChannelConfig {
  try {
    const raw = readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") return {};
    return parsed as ChannelConfig;
  } catch {
    return {};
  }
}

export interface ResolveNatsOptions {
  readonly natsContext?: string;
  readonly natsUrl?: string;
  readonly config?: ChannelConfig;
}

export async function resolveConnectionOptions(
  opts: ResolveNatsOptions,
): Promise<NodeConnectionOptions> {
  if (opts.natsUrl !== undefined && opts.natsUrl.length > 0) {
    return parseNatsUrl(opts.natsUrl);
  }
  if (opts.natsContext !== undefined && opts.natsContext.length > 0) {
    return loadContextOptions(opts.natsContext);
  }
  if (opts.config?.context !== undefined && opts.config.context.length > 0) {
    return loadContextOptions(opts.config.context);
  }
  return parseNatsUrl("nats://127.0.0.1:4222");
}

export async function connectFrom(opts: ResolveNatsOptions): Promise<NatsConnection> {
  const co = await resolveConnectionOptions(opts);
  return connect(co);
}
