import type { CodexAppServerClient } from "./codex-app-server-client.js";
import type { CodexManagerConfig } from "./types.js";
import { endpointFingerprint, normalizeRawThreadId, privateSessionKey } from "./identity.js";

export interface InventoryThreadRow {
  readonly endpoint: string;
  readonly endpointFingerprint: string;
  readonly rawThreadId: string;
  readonly privateKey: string;
  readonly loaded: boolean;
  readonly listed: boolean;
  readonly ephemeral: boolean;
  readonly turnCount: number;
  readonly thread: Record<string, unknown>;
}

export interface EligibleSessionRow extends InventoryThreadRow {
  readonly eligible: boolean;
  readonly readOk: boolean;
  readonly resumeOk: boolean;
  readonly reason: "eligible" | "not-loaded" | "hidden-ephemeral-no-turn" | "read-failed" | "resume-failed";
  readonly error?: string;
}

export function reconcileThreadInventory(input: {
  readonly endpoint: string;
  readonly loaded: readonly Record<string, unknown>[];
  readonly listed: readonly Record<string, unknown>[];
}): InventoryThreadRow[] {
  const byKey = new Map<string, InventoryThreadRow>();
  const add = (thread: Record<string, unknown>, source: "loaded" | "listed"): void => {
    const rawThreadId = normalizeRawThreadId(thread);
    if (!rawThreadId) return;
    const privateKey = privateSessionKey(input.endpoint, rawThreadId);
    const existing = byKey.get(privateKey);
    const turns = Array.isArray(thread.turns) ? thread.turns.length : 0;
    const ephemeral = thread.ephemeral === true;
    if (existing) {
      byKey.set(privateKey, {
        ...existing,
        loaded: existing.loaded || source === "loaded",
        listed: existing.listed || source === "listed",
        ephemeral: existing.ephemeral && ephemeral,
        turnCount: Math.max(existing.turnCount, turns),
        thread: { ...existing.thread, ...thread },
      });
      return;
    }
    byKey.set(privateKey, {
      endpoint: input.endpoint,
      endpointFingerprint: endpointFingerprint(input.endpoint),
      rawThreadId,
      privateKey,
      loaded: source === "loaded",
      listed: source === "listed",
      ephemeral,
      turnCount: turns,
      thread,
    });
  };
  for (const thread of input.loaded) add(thread, "loaded");
  for (const thread of input.listed) add(thread, "listed");
  return [...byKey.values()].sort((a, b) => a.privateKey.localeCompare(b.privateKey));
}

export async function discoverEndpointSessions(input: {
  readonly client: CodexAppServerClient;
  readonly endpoint: string;
  readonly manager: CodexManagerConfig;
}): Promise<EligibleSessionRow[]> {
  await input.client.initialize();
  const [loaded, listed] = await Promise.all([
    input.client.listLoadedThreads(),
    input.client.listThreads(),
  ]);
  const rows = reconcileThreadInventory({ endpoint: input.endpoint, loaded, listed });
  const out: EligibleSessionRow[] = [];
  for (const row of rows) {
    if (!row.loaded) {
      out.push({ ...row, eligible: false, readOk: false, resumeOk: false, reason: "not-loaded" });
      continue;
    }
    if (row.ephemeral && row.turnCount === 0 && !input.manager.exposeEphemeralLoadedSessions) {
      out.push({ ...row, eligible: false, readOk: false, resumeOk: false, reason: "hidden-ephemeral-no-turn" });
      continue;
    }
    try {
      await input.client.readThread(row.rawThreadId);
    } catch (err) {
      out.push({ ...row, eligible: false, readOk: false, resumeOk: false, reason: "read-failed", error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    try {
      await input.client.resumeThread(row.rawThreadId);
    } catch (err) {
      out.push({ ...row, eligible: false, readOk: true, resumeOk: false, reason: "resume-failed", error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    out.push({ ...row, eligible: true, readOk: true, resumeOk: true, reason: "eligible" });
  }
  return out;
}
