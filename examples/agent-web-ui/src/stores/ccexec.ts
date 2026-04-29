// Reactive state for the CC-Exec workspace (claude-code-headless control plane).
//
// Mirrors the shape of `piexec.ts` but typed for claude-code-headless: spawn
// descriptors / session summaries carry CC-specific fields (allowed_tools,
// permission_mode, max_turns) instead of PI's thinking_level. As with piexec,
// `selectedCcController` derives from `agentsState.selectedInstanceId` —
// clicking a controller card both selects it and routes spawn requests to it.

import { computed, reactive } from "vue";
import { agentsState, ccexecSessions } from "./agents.ts";
import type {
  CcExecSessionSummary,
  CcExecSpawnDescriptor,
} from "../wire.ts";
import type { FanoutRun } from "./piexec.ts";

export const ccexecState = reactive<{
  summaries: Map<string, CcExecSessionSummary>; // keyed by session_id
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
 * The currently selected claude-code-headless controller, or null when the
 * selected agent isn't a claude-code-headless-controller.
 */
export const selectedCcController = computed(() => {
  const id = agentsState.selectedInstanceId;
  if (!id) return null;
  const agent = agentsState.list.find((a) => a.instanceId === id);
  if (!agent) return null;
  if (agent.metadata?.["role"] !== "claude-code-headless-controller") return null;
  return agent;
});

/** Sessions belonging to the selected controller's owner. */
export const visibleCcSessions = computed(() => {
  const controller = selectedCcController.value;
  if (!controller) return [];
  return ccexecSessions.value.filter((a) => a.owner === controller.owner);
});

export function mergeCcSummaries(sessions: ReadonlyArray<CcExecSessionSummary>): void {
  const next = new Map<string, CcExecSessionSummary>();
  for (const s of sessions) next.set(s.session_id, s);
  ccexecState.summaries = next;
}

export function onCcSpawned(descriptor: CcExecSpawnDescriptor): void {
  ccexecState.summaries.set(descriptor.session_id, {
    session_id: descriptor.session_id,
    subject: descriptor.subject,
    heartbeat_subject: descriptor.heartbeat_subject,
    cwd: descriptor.cwd,
    model: descriptor.model,
    allowed_tools: descriptor.allowed_tools,
    permission_mode: descriptor.permission_mode,
    max_turns: descriptor.max_turns,
    max_lifetime_s: descriptor.max_lifetime_s,
    remaining_lifetime_s: descriptor.max_lifetime_s,
    active_request: false,
    queued_requests: 0,
    created_at: descriptor.created_at,
    last_activity: descriptor.created_at,
    total_cost_usd: descriptor.total_cost_usd,
    turn_count: descriptor.turn_count,
  });
}

/** Update the summary's running cost as `cost` events stream in for a session. */
export function bumpCcSessionCost(sessionId: string, totalCostUsd: number): void {
  const s = ccexecState.summaries.get(sessionId);
  if (!s) return;
  s.total_cost_usd = totalCostUsd;
}

export function onCcStopped(sessionId: string): void {
  ccexecState.summaries.delete(sessionId);
}

export function resetCcFanout(): void {
  ccexecState.fanoutRuns = [];
  ccexecState.fanoutRunning = false;
}

export function appendCcFanoutRun(run: FanoutRun): void {
  ccexecState.fanoutRuns.push(run);
}

export function findCcFanoutRun(id: string): FanoutRun | undefined {
  return ccexecState.fanoutRuns.find((r) => r.id === id);
}
