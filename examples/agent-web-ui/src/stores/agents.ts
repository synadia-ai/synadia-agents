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
 * Coarse classification used by the agent grid to group cards. Order maps 1:1
 * with `BUCKET_ORDER` below.
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

export const BUCKET_ORDER: Bucket[] = [
  BUCKETS.PI_EXEC_SESSION,
  BUCKETS.PI_EXEC_CONTROL,
  BUCKETS.CC_EXEC_SESSION,
  BUCKETS.CC_EXEC_CONTROL,
  BUCKETS.PI_AGENT,
  BUCKETS.CC_AGENT,
  BUCKETS.OPENCLAW,
  BUCKETS.HERMES,
  BUCKETS.OPEN_AGENT,
  BUCKETS.OTHER,
];

export const BUCKET_LABELS: Record<Bucket, string> = {
  // Labels track the on-wire `agent` token + `metadata.role` so the UI
  // vocabulary stays one term away from the docs.
  [BUCKETS.PI_EXEC_SESSION]: "PI Headless Sessions",
  [BUCKETS.PI_EXEC_CONTROL]: "PI Headless Controllers",
  [BUCKETS.CC_EXEC_SESSION]: "Claude Code Headless Sessions",
  [BUCKETS.CC_EXEC_CONTROL]: "Claude Code Headless Controllers",
  [BUCKETS.PI_AGENT]: "PI Interactive",
  [BUCKETS.CC_AGENT]: "Claude Code",
  [BUCKETS.OPENCLAW]: "OpenClaw",
  [BUCKETS.HERMES]: "Hermes",
  [BUCKETS.OPEN_AGENT]: "Open Agent",
  [BUCKETS.OTHER]: "Other",
};

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

/** Returns sorted-by-bucket groups; empty buckets are omitted. */
export const agentsByBucket = computed<{ bucket: Bucket; label: string; agents: DiscoveredAgentDTO[] }[]>(() => {
  const map = new Map<Bucket, DiscoveredAgentDTO[]>();
  for (const b of BUCKET_ORDER) map.set(b, []);
  for (const agent of agentsState.list) {
    const list = map.get(bucketOf(agent));
    if (list) list.push(agent);
  }
  for (const list of map.values()) sortAgents(list).forEach(() => {}); // sortAgents returns a copy
  const out: { bucket: Bucket; label: string; agents: DiscoveredAgentDTO[] }[] = [];
  for (const b of BUCKET_ORDER) {
    const raw = map.get(b) ?? [];
    if (raw.length === 0) continue;
    out.push({ bucket: b, label: BUCKET_LABELS[b], agents: sortAgents(raw) });
  }
  return out;
});
