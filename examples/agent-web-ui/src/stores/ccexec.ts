// Reactive state for the CC-Exec workspace (claude-code-headless control plane).
//
// Mirrors the shape of `piexec.ts` but typed for claude-code-headless: spawn
// descriptors / session summaries carry CC-specific fields (allowed_tools,
// permission_mode, max_turns) instead of PI's thinking_level. Discovery and
// chat surface remain shared with the rest of the UI; only the spawn / list /
// stop endpoints are CC-specific.

import { computed, reactive } from "vue";
import { ccexecControllers, ccexecSessions } from "./agents.ts";
import type {
  CcExecSessionSummary,
  CcExecSpawnDescriptor,
} from "../wire.ts";

export const ccexecState = reactive<{
  selectedControllerId: string | null;
  summaries: Map<string, CcExecSessionSummary>; // keyed by session_id
  refreshing: boolean;
  lastError: string | null;
}>({
  selectedControllerId: null,
  summaries: new Map(),
  refreshing: false,
  lastError: null,
});

export const selectedCcController = computed(() => {
  const id = ccexecState.selectedControllerId;
  if (!id) return null;
  return ccexecControllers.value.find((a) => a.instanceId === id) ?? null;
});

/** Auto-select the first controller if none is picked yet. */
export function autoPickCcController(): void {
  if (ccexecState.selectedControllerId) {
    const still = ccexecControllers.value.some(
      (a) => a.instanceId === ccexecState.selectedControllerId,
    );
    if (still) return;
  }
  const first = ccexecControllers.value[0];
  ccexecState.selectedControllerId = first?.instanceId ?? null;
}

/**
 * Sessions that belong to the selected controller's owner+agent tuple. Derived
 * live from `agentsState` so heartbeat liveness stays accurate even between
 * explicit `list` refreshes.
 */
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
