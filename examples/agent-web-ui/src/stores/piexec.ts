// Reactive state for the PI-Exec workspace.
//
// `selectedController` derives from the top-level `agentsState.selectedInstanceId`:
// clicking a controller card in the agent grid selects it for the right panel
// _and_ makes spawn / fan-out target it. There is no separate controller picker.
//
// `summaries` is the last `list` snapshot keyed by session_id; it merges with
// the live agent records in `agentsState.list` so session cards can show both
// controller-side bookkeeping (lifetime, queue depth) and protocol-side
// liveness (heartbeats).

import { computed, reactive } from "vue";
import { agentsState, piexecSessions } from "./agents.ts";
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
  summaries: Map<string, PiExecSessionSummary>; // keyed by session_id
  refreshing: boolean;
  lastError: string | null;
  fanoutRuns: FanoutRun[];
  fanoutRunning: boolean;
  rightPanelTab: "spawn" | "fanout";
}>({
  summaries: new Map(),
  refreshing: false,
  lastError: null,
  fanoutRuns: [],
  fanoutRunning: false,
  rightPanelTab: "spawn",
});

/**
 * The currently selected pi-headless controller, or null when the selected
 * agent isn't a pi-headless-controller (or nothing is selected).
 */
export const selectedController = computed(() => {
  const id = agentsState.selectedInstanceId;
  if (!id) return null;
  const agent = agentsState.list.find((a) => a.instanceId === id);
  if (!agent) return null;
  if (agent.metadata?.["role"] !== "pi-headless-controller") return null;
  return agent;
});

/**
 * Sessions belonging to the selected controller's owner. Kept as a derived
 * list so liveness updates from heartbeats stay accurate between explicit
 * `list` refreshes. (Currently only used as a polling indicator — sessions
 * render in the main agent grid, not inside the right panel.)
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
