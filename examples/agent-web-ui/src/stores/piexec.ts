// Reactive state for the PI-Exec workspace.
//
// - `selectedControllerId` is the user-picked pi-headless controller.
// - `summaries` is the last `list` snapshot, keyed by session_id. We merge
//   this with the live `agentsState.list` so the UI can show both
//   controller-side bookkeeping (lifetime, queue depth) and protocol-side
//   liveness (heartbeats).
// - `fanoutRuns` tracks in-progress fan-out cards.

import { computed, reactive } from "vue";
import { piexecControllers, piexecSessions } from "./agents.ts";
import type {
  PiExecSessionSummary,
  PiExecSpawnDescriptor,
} from "../wire.ts";

export type FanoutStatus = "pending" | "spawning" | "running" | "done" | "error" | "stopped";

export type FanoutRun = {
  id: string;
  cwd: string;
  status: FanoutStatus;
  content: string;
  error?: string;
  sessionId?: string;
  instanceId?: string;
  promptId?: string;
};

export const piexecState = reactive<{
  selectedControllerId: string | null;
  summaries: Map<string, PiExecSessionSummary>; // keyed by session_id
  refreshing: boolean;
  lastError: string | null;
  fanoutRuns: FanoutRun[];
  fanoutRunning: boolean;
}>({
  selectedControllerId: null,
  summaries: new Map(),
  refreshing: false,
  lastError: null,
  fanoutRuns: [],
  fanoutRunning: false,
});

export const selectedController = computed(() => {
  const id = piexecState.selectedControllerId;
  if (!id) return null;
  return piexecControllers.value.find((a) => a.instanceId === id) ?? null;
});

/** Auto-select the first controller if none is picked yet. */
export function autoPickController(): void {
  if (piexecState.selectedControllerId) {
    const still = piexecControllers.value.some(
      (a) => a.instanceId === piexecState.selectedControllerId,
    );
    if (still) return;
  }
  const first = piexecControllers.value[0];
  piexecState.selectedControllerId = first?.instanceId ?? null;
}

/**
 * Sessions that belong to the selected controller's owner+agent tuple. Derived
 * live from `agentsState` so heartbeat liveness stays accurate even between
 * explicit `list` refreshes.
 */
export const visibleSessions = computed(() => {
  const controller = selectedController.value;
  if (!controller) return [];
  return piexecSessions.value.filter((a) => a.owner === controller.owner);
});

export function mergeSummaries(sessions: ReadonlyArray<PiExecSessionSummary>): void {
  const next = new Map<string, PiExecSessionSummary>();
  for (const s of sessions) next.set(s.session_id, s);
  piexecState.summaries = next;
}

export function onSpawned(descriptor: PiExecSpawnDescriptor): void {
  piexecState.summaries.set(descriptor.session_id, {
    session_id: descriptor.session_id,
    subject: descriptor.subject,
    heartbeat_subject: descriptor.heartbeat_subject,
    cwd: descriptor.cwd,
    model: descriptor.model,
    thinking_level: descriptor.thinking_level,
    max_lifetime_s: descriptor.max_lifetime_s,
    remaining_lifetime_s: descriptor.max_lifetime_s,
    active_request: false,
    queued_requests: 0,
    created_at: descriptor.created_at,
    last_activity: descriptor.created_at,
  });
}

export function onStopped(sessionId: string): void {
  piexecState.summaries.delete(sessionId);
}

export function resetFanout(): void {
  piexecState.fanoutRuns = [];
  piexecState.fanoutRunning = false;
}

export function appendFanoutRun(run: FanoutRun): void {
  piexecState.fanoutRuns.push(run);
}

export function findFanoutRun(id: string): FanoutRun | undefined {
  return piexecState.fanoutRuns.find((r) => r.id === id);
}
