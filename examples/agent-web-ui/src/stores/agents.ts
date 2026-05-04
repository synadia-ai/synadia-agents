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

/** Discovered pi-headless controllers (agent token + role). */
export const piexecControllers = computed<DiscoveredAgentDTO[]>(() =>
  agentsState.list.filter(
    (a) => a.agent === "pi-headless" && a.metadata?.["role"] === "controller",
  ),
);

/** Discovered pi-headless sessions (agent token + role). */
export const piexecSessions = computed<DiscoveredAgentDTO[]>(() =>
  agentsState.list.filter(
    (a) => a.agent === "pi-headless" && a.metadata?.["role"] === "session",
  ),
);

/** Discovered claude-code-headless controllers (agent token + role). */
export const ccexecControllers = computed<DiscoveredAgentDTO[]>(() =>
  agentsState.list.filter(
    (a) => a.agent === "cc-headless" && a.metadata?.["role"] === "controller",
  ),
);

/** Discovered claude-code-headless sessions (agent token + role). */
export const ccexecSessions = computed<DiscoveredAgentDTO[]>(() =>
  agentsState.list.filter(
    (a) => a.agent === "cc-headless" && a.metadata?.["role"] === "session",
  ),
);

/**
 * Coarse classification used to colour cards (`AgentCard`) and to split the
 * grid into the two top-level sections (see `agentSections` below). The
 * tokens line up with the wire-level `agent` + `metadata.role` so the UI
 * vocabulary stays one term away from the spec.
 */
export const BUCKETS = {
  PI_EXEC_SESSION: "pi-exec-session",
  PI_EXEC_CONTROL: "pi-exec-control",
  CC_EXEC_SESSION: "cc-exec-session",
  CC_EXEC_CONTROL: "cc-exec-control",
  PI_AGENT: "pi-agent",
  CC_AGENT: "cc-agent",
  OPENCLAW: "openclaw",
  HERMES: "hermes",
  OPEN_AGENT: "open-agent",
  OTHER: "other",
} as const;

export type Bucket = (typeof BUCKETS)[keyof typeof BUCKETS];

export function bucketOf(agent: DiscoveredAgentDTO): Bucket {
  const role = agent.metadata?.["role"];
  if (agent.agent === "pi-headless") {
    return role === "controller" ? BUCKETS.PI_EXEC_CONTROL : BUCKETS.PI_EXEC_SESSION;
  }
  if (agent.agent === "cc-headless") {
    return role === "controller" ? BUCKETS.CC_EXEC_CONTROL : BUCKETS.CC_EXEC_SESSION;
  }
  // `agent.agent` carries the value of `metadata.agent` (per Appendix C of
  // the spec). Each runtime publishes its own canonical token — match the
  // actual values the runtimes set, plus the legacy short aliases that
  // some deployments still use (cc/ccc/oc).
  if (agent.agent === "pi") return BUCKETS.PI_AGENT;
  if (agent.agent === "claude-code" || agent.agent === "cc" || agent.agent === "ccc") {
    return BUCKETS.CC_AGENT;
  }
  if (agent.agent === "openclaw" || agent.agent === "oc") return BUCKETS.OPENCLAW;
  if (agent.agent === "hermes") return BUCKETS.HERMES;
  if (agent.agent === "open-agent") return BUCKETS.OPEN_AGENT;
  return BUCKETS.OTHER;
}

/**
 * Top-section ("Agents / Sessions") sort rank. Families ordered alphabetically
 * by their human label; within a family, the registered agent precedes its
 * headless sessions so a PI agent and its live PI sessions sit adjacent.
 *
 *   Claude Code → CC Headless Sessions → Hermes → Open Agent →
 *   OpenClaw → PI → PI Headless Sessions → Other
 *
 * Controller buckets are not in this section; they get -1 so a future stray
 * controller can't silently land in the wrong group.
 */
const PROMPTABLE_RANK: Record<Bucket, number> = {
  [BUCKETS.CC_AGENT]: 1,
  [BUCKETS.CC_EXEC_SESSION]: 2,
  [BUCKETS.HERMES]: 3,
  [BUCKETS.OPEN_AGENT]: 4,
  [BUCKETS.OPENCLAW]: 5,
  [BUCKETS.PI_AGENT]: 6,
  [BUCKETS.PI_EXEC_SESSION]: 7,
  [BUCKETS.OTHER]: 99,
  [BUCKETS.PI_EXEC_CONTROL]: -1,
  [BUCKETS.CC_EXEC_CONTROL]: -1,
};

function isController(bucket: Bucket): boolean {
  return bucket === BUCKETS.PI_EXEC_CONTROL || bucket === BUCKETS.CC_EXEC_CONTROL;
}

function sortPromptables(list: DiscoveredAgentDTO[]): DiscoveredAgentDTO[] {
  return [...list].sort((a, b) => {
    const ra = PROMPTABLE_RANK[bucketOf(a)];
    const rb = PROMPTABLE_RANK[bucketOf(b)];
    if (ra !== rb) return ra - rb;
    const byOwner = a.owner.localeCompare(b.owner);
    if (byOwner !== 0) return byOwner;
    return a.name.localeCompare(b.name);
  });
}

export type AgentSectionId = "promptables" | "controllers";

/**
 * Two-section view of the agent list:
 *  - `promptables` — every prompt-target (registered agents + headless
 *    sessions), one flat alphabetical grid.
 *  - `controllers` — pi-headless + cc-headless controller cards.
 *
 * Empty sections are omitted entirely so the grid doesn't show vacant
 * headers on a fresh dashboard.
 */
export const agentSections = computed<{ id: AgentSectionId; label: string; agents: DiscoveredAgentDTO[] }[]>(() => {
  const promptables: DiscoveredAgentDTO[] = [];
  const controllers: DiscoveredAgentDTO[] = [];
  for (const agent of agentsState.list) {
    if (isController(bucketOf(agent))) controllers.push(agent);
    else promptables.push(agent);
  }
  const out: { id: AgentSectionId; label: string; agents: DiscoveredAgentDTO[] }[] = [];
  if (promptables.length > 0) {
    out.push({ id: "promptables", label: "Agents / Sessions", agents: sortPromptables(promptables) });
  }
  if (controllers.length > 0) {
    out.push({ id: "controllers", label: "Controllers", agents: sortPromptables(controllers) });
  }
  return out;
});
