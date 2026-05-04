import { computed, reactive } from "vue";
import { agentsState } from "./agents.ts";
import type { Message } from "./chat.ts";
import type { DiscoveredAgentDTO, WireAttachment } from "../wire.ts";
import { randomUUID } from "../uuid.ts";

/**
 * UI-only "virtual sessions" — synthetic right-panel conversations that
 * fan out every prompt to a locked set of real agents and aggregate the
 * streamed responses into a single transcript.
 *
 *  - Created from the multi-select bar by ticking
 *    "Stream all to a virtual session" before pressing Send.
 *  - Persistent for the page lifetime; cleared on reload.
 *  - Targets are locked at creation; a target that vanishes from
 *    discovery is silently skipped on subsequent prompts.
 *  - Lives entirely in the browser. The wire surface is unchanged —
 *    each prompt is N independent `bridge.prompt` calls under the hood.
 *
 * IDs use a `virtual:` prefix so the existing `agentsState.selectedInstanceId`
 * can address either a real agent (instanceId is a UUID) or a virtual
 * session (instanceId starts with `virtual:`). The right panel routes on
 * the prefix.
 */

export type VirtualMessage = Message & {
  /** instanceId of the real agent that produced this bubble. Absent on the
   *  user prompt and on synthetic "(busy)" / "(offline)" placeholders. */
  sourceInstanceId?: string;
  /** Cosmetic display label cached at message-create time, so historical
   *  bubbles still render meaningfully if the source agent later vanishes. */
  sourceLabel?: string;
  /** Per-turn group key. Every bubble produced by a single Send share one. */
  turnId?: string;
};

export type VirtualSession = {
  id: string;
  label: string;
  /** instanceIds of the real agents this virtual session fans out to.
   *  Captured at creation time and never mutated thereafter. */
  targets: string[];
  messages: VirtualMessage[];
  /** Active per-source promptIds keyed by `${turnId}:${sourceInstanceId}`,
   *  so the chat panel's Stop button can cancel the whole turn at once. */
  activePromptIds: Map<string, string>;
};

type VirtualSessionsState = {
  sessions: Map<string, VirtualSession>;
  counter: number;
};

export const virtualSessionsState = reactive<VirtualSessionsState>({
  sessions: new Map(),
  counter: 0,
});

const VIRTUAL_PREFIX = "virtual:";

export function isVirtualId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(VIRTUAL_PREFIX);
}

export const virtualSessionsList = computed<VirtualSession[]>(() =>
  Array.from(virtualSessionsState.sessions.values()),
);

export const selectedVirtualSession = computed<VirtualSession | null>(() => {
  const id = agentsState.selectedInstanceId;
  if (!id || !isVirtualId(id)) return null;
  return virtualSessionsState.sessions.get(id) ?? null;
});

/** Build a friendly per-target label like "@derek · CLAUDE-CODE". Falls
 *  back to the wire token uppercased if no friendlier mapping exists. */
export function virtualTargetLabel(agent: DiscoveredAgentDTO): string {
  const a = agent.agent;
  let display = a.toUpperCase();
  if (a === "claude-code" || a === "cc" || a === "ccc") display = "CLAUDE CODE";
  else if (a === "openclaw" || a === "oc") display = "OPENCLAW";
  else if (a === "pi") display = "PI";
  else if (a === "hermes") display = "HERMES";
  else if (a === "open-agent") display = "OPEN AGENT";
  else if (a === "pi-headless") display = "PI HEADLESS";
  else if (a === "cc-headless") display = "CC HEADLESS";
  const session = agent.session && agent.session !== agent.name ? ` ${agent.session}` : "";
  return `@${agent.owner} · ${display}${session}`;
}

/**
 * Create a new virtual session locked to `targetIds`. Returns the new
 * session id (with the `virtual:` prefix). Caller is responsible for
 * routing the right panel to it via `selectAgent(newId)` if desired.
 */
export function createVirtualSession(targetIds: string[]): string {
  virtualSessionsState.counter += 1;
  const id = `${VIRTUAL_PREFIX}${randomUUID()}`;
  const n = targetIds.length;
  const label = `Virtual #${virtualSessionsState.counter} (${n} agent${n === 1 ? "" : "s"})`;
  virtualSessionsState.sessions.set(id, {
    id,
    label,
    targets: [...targetIds],
    messages: [],
    activePromptIds: new Map(),
  });
  return id;
}

export function deleteVirtualSession(id: string): void {
  virtualSessionsState.sessions.delete(id);
  if (agentsState.selectedInstanceId === id) {
    agentsState.selectedInstanceId = null;
  }
}

export function getVirtualSession(id: string): VirtualSession | undefined {
  return virtualSessionsState.sessions.get(id);
}

export function appendVirtualMessage(
  virtualId: string,
  msg: VirtualMessage,
): VirtualMessage | undefined {
  const vs = virtualSessionsState.sessions.get(virtualId);
  if (!vs) return undefined;
  vs.messages.push(msg);
  return vs.messages[vs.messages.length - 1];
}

export function findVirtualMessage(
  virtualId: string,
  messageId: string,
): VirtualMessage | undefined {
  const vs = virtualSessionsState.sessions.get(virtualId);
  if (!vs) return undefined;
  return vs.messages.find((m) => m.id === messageId);
}

export function findVirtualMessageByToolId(
  virtualId: string,
  toolUseId: string,
): VirtualMessage | undefined {
  const vs = virtualSessionsState.sessions.get(virtualId);
  if (!vs) return undefined;
  return vs.messages.find((m) => m.role === "tool" && m.tool?.id === toolUseId);
}

/** Whether ANY turn in the virtual session is still in flight. */
export function isVirtualSessionActive(virtualId: string): boolean {
  const vs = virtualSessionsState.sessions.get(virtualId);
  if (!vs) return false;
  return vs.activePromptIds.size > 0;
}

/** Snapshot of currently-active per-source promptIds (for the Stop button). */
export function activePromptIdsOf(virtualId: string): string[] {
  const vs = virtualSessionsState.sessions.get(virtualId);
  if (!vs) return [];
  return [...vs.activePromptIds.values()];
}

/** Used by virtualPromptStreaming on stream init/teardown to track which
 *  per-source streams are still live for the Stop button. */
export function trackVirtualPrompt(
  virtualId: string,
  turnId: string,
  sourceInstanceId: string,
  promptId: string,
): void {
  const vs = virtualSessionsState.sessions.get(virtualId);
  if (!vs) return;
  vs.activePromptIds.set(`${turnId}:${sourceInstanceId}`, promptId);
}

export function untrackVirtualPrompt(
  virtualId: string,
  turnId: string,
  sourceInstanceId: string,
): void {
  const vs = virtualSessionsState.sessions.get(virtualId);
  if (!vs) return;
  vs.activePromptIds.delete(`${turnId}:${sourceInstanceId}`);
}

/** Re-export so the prompt-area can show attachment-handling badges. */
export type { WireAttachment };
