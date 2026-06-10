import { reactive, computed } from "vue";
import type { DiscoveredAgentDTO } from "../wire.ts";
import { isVirtualId } from "./virtualSessions.ts";

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
  // If the previously selected agent vanished, clear selection — but
  // skip this for virtual-session ids (`virtual:<uuid>`) which are
  // UI-only entities not present in `list` and shouldn't be wiped on
  // every refresh. The prefix check goes through the canonical helper
  // exported from `virtualSessions.ts` so the prefix string lives in
  // exactly one place.
  const sel = agentsState.selectedInstanceId;
  if (sel && !isVirtualId(sel) && !list.some((a) => a.instanceId === sel)) {
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
  OPENCODE: "opencode",
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
  if (agent.agent === "opencode") return BUCKETS.OPENCODE;
  return BUCKETS.OTHER;
}

/**
 * Top-section ("Agents / Sessions") sort rank. Families ordered alphabetically
 * by their human label; within a family, the registered agent precedes its
 * headless sessions so a PI agent and its live PI sessions sit adjacent.
 *
 *   Claude Code → CC Headless Sessions → Hermes → Open Agent →
 *   OpenCode → OpenClaw → PI → PI Headless Sessions → Other
 *
 * Controller buckets are deliberately absent — they're sorted by the separate
 * `sortControllers` path. `Partial<>` lets us read with a sentinel fallback
 * so a future stray bucket sorts to the end instead of crashing.
 */
const PROMPTABLE_RANK: Partial<Record<Bucket, number>> = {
  [BUCKETS.CC_AGENT]: 1,
  [BUCKETS.CC_EXEC_SESSION]: 2,
  [BUCKETS.HERMES]: 3,
  [BUCKETS.OPEN_AGENT]: 4,
  [BUCKETS.OPENCODE]: 5,
  [BUCKETS.OPENCLAW]: 6,
  [BUCKETS.PI_AGENT]: 7,
  [BUCKETS.PI_EXEC_SESSION]: 8,
  [BUCKETS.OTHER]: 99,
};

function isController(bucket: Bucket): boolean {
  return bucket === BUCKETS.PI_EXEC_CONTROL || bucket === BUCKETS.CC_EXEC_CONTROL;
}

function byOwnerThenName(a: DiscoveredAgentDTO, b: DiscoveredAgentDTO): number {
  const o = a.owner.localeCompare(b.owner);
  if (o !== 0) return o;
  return a.name.localeCompare(b.name);
}

function sortPromptables(list: DiscoveredAgentDTO[]): DiscoveredAgentDTO[] {
  return [...list].sort((a, b) => {
    const ra = PROMPTABLE_RANK[bucketOf(a)] ?? 99;
    const rb = PROMPTABLE_RANK[bucketOf(b)] ?? 99;
    if (ra !== rb) return ra - rb;
    return byOwnerThenName(a, b);
  });
}

function sortControllers(list: DiscoveredAgentDTO[]): DiscoveredAgentDTO[] {
  // Controllers don't carry a family rank — there are at most a handful
  // online at once and they all belong to the same conceptual "Controllers"
  // group, so a flat owner→name sort is plenty.
  return [...list].sort(byOwnerThenName);
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
    out.push({ id: "controllers", label: "Controllers", agents: sortControllers(controllers) });
  }
  return out;
});
