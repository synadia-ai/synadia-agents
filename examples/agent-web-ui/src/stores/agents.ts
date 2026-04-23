import { reactive, computed } from "vue";
import type { DiscoveredAgentDTO } from "../wire.ts";

export const agentsState = reactive<{
  list: DiscoveredAgentDTO[];
  selectedInstanceId: string | null;
  lastDiscoveredAt: number | null;
  discovering: boolean;
}>({
  list: [],
  selectedInstanceId: null,
  lastDiscoveredAt: null,
  discovering: false,
});

export const selectedAgent = computed<DiscoveredAgentDTO | null>(() => {
  const id = agentsState.selectedInstanceId;
  if (!id) return null;
  return agentsState.list.find((a) => a.instanceId === id) ?? null;
});

export function selectAgent(instanceId: string | null): void {
  agentsState.selectedInstanceId = instanceId;
}

export function setAgents(list: DiscoveredAgentDTO[]): void {
  agentsState.list = list;
  agentsState.lastDiscoveredAt = Date.now();
  // If the previously selected agent vanished, clear selection.
  if (
    agentsState.selectedInstanceId &&
    !list.some((a) => a.instanceId === agentsState.selectedInstanceId)
  ) {
    agentsState.selectedInstanceId = null;
  }
}

/** Append an agent if not already present (by instanceId). No-op if dup. */
export function addAgent(dto: DiscoveredAgentDTO): void {
  if (agentsState.list.some((a) => a.instanceId === dto.instanceId)) return;
  agentsState.list = [...agentsState.list, dto];
}

/** Remove an agent by instanceId; also clears selection if it was selected. */
export function removeAgent(instanceId: string): void {
  const before = agentsState.list.length;
  agentsState.list = agentsState.list.filter((a) => a.instanceId !== instanceId);
  if (before === agentsState.list.length) return;
  if (agentsState.selectedInstanceId === instanceId) {
    agentsState.selectedInstanceId = null;
  }
}

/** Stable sort key: agent → owner → session/name. */
export function sortAgents(list: DiscoveredAgentDTO[]): DiscoveredAgentDTO[] {
  return [...list].sort((a, b) => {
    const byAgent = a.agent.localeCompare(b.agent);
    if (byAgent !== 0) return byAgent;
    const byOwner = a.owner.localeCompare(b.owner);
    if (byOwner !== 0) return byOwner;
    return a.name.localeCompare(b.name);
  });
}

/** Discovered pi-headless controllers (agents flagged via `metadata.role`). */
export const piexecControllers = computed<DiscoveredAgentDTO[]>(() =>
  agentsState.list.filter((a) => a.metadata?.["role"] === "pi-headless-controller"),
);

/** Discovered pi-headless sessions (spawned by a controller; identified via `metadata.spawner`). */
export const piexecSessions = computed<DiscoveredAgentDTO[]>(() =>
  agentsState.list.filter((a) => a.metadata?.["spawner"] === "pi-headless"),
);
