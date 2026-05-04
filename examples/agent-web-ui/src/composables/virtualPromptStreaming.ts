import {
  appendMessage,
  findMessage,
  findMessageByToolId,
  getSession,
} from "../stores/chat.ts";
import { agentsState } from "../stores/agents.ts";
import { bumpCcSessionCost } from "../stores/ccexec.ts";
import {
  appendVirtualMessage,
  findVirtualMessage,
  findVirtualMessageByToolId,
  getVirtualSession,
  trackVirtualPrompt,
  untrackVirtualPrompt,
  virtualTargetLabel,
} from "../stores/virtualSessions.ts";
import { useBridge } from "./useBridge.ts";
import { randomUUID } from "../uuid.ts";
import type { DiscoveredAgentDTO, WireAttachment } from "../wire.ts";

export type VirtualTurnReport = {
  /** Real prompts dispatched (one bridge.prompt per non-busy, online target). */
  ok: number;
  /** Targets skipped because they're already mid-prompt. */
  busy: number;
  /** Targets skipped because they're no longer in the discovered list. */
  offline: number;
  /** Stable id for this turn — every bubble produced shares it. */
  turnId: string;
};

/**
 * Fire one prompt against every locked target of a virtual session and
 * mirror each per-source stream into both the per-instance chat AND the
 * virtual transcript. Returns a report so the caller (the virtual chat
 * panel) can render an inline "sent to N of M" badge.
 *
 * The user prompt becomes one bubble in the virtual transcript (with an
 * optional matching user bubble in each per-instance chat). Each non-busy,
 * online target gets a streaming agent bubble in BOTH places, sharing the
 * `turnId` so future grouping/styling can locate them. Offline and busy
 * targets get a tiny synthetic placeholder bubble in the virtual transcript
 * only (no per-instance pollution since no prompt actually fires).
 */
export function startVirtualTurn(
  virtualId: string,
  text: string,
  attachments: WireAttachment[] | undefined,
): VirtualTurnReport {
  const turnId = randomUUID();
  const report: VirtualTurnReport = { ok: 0, busy: 0, offline: 0, turnId };

  const vs = getVirtualSession(virtualId);
  if (!vs) return report;

  // 1. The user prompt itself — one bubble at the top of the turn.
  const userMsgId = randomUUID();
  appendVirtualMessage(virtualId, {
    id: userMsgId,
    role: "user",
    content: text,
    streaming: false,
    timestamp: Date.now(),
    attachments: attachments?.map((a) => ({ filename: a.filename, base64: a.base64 })),
    turnId,
  });

  // 2. For each locked target: classify (online/offline/busy) and either
  //    fire a real stream or drop a synthetic placeholder.
  for (const targetId of vs.targets) {
    const agent = agentsState.list.find((a) => a.instanceId === targetId);
    if (!agent) {
      appendVirtualMessage(virtualId, {
        id: randomUUID(),
        role: "agent",
        content: "",
        streaming: false,
        timestamp: Date.now(),
        statusNote: "(offline — skipped)",
        sourceInstanceId: targetId,
        sourceLabel: `instanceId ${targetId.slice(0, 8)}…`,
        turnId,
      });
      report.offline += 1;
      continue;
    }

    if (getSession(targetId).activePromptId !== null) {
      appendVirtualMessage(virtualId, {
        id: randomUUID(),
        role: "agent",
        content: "",
        streaming: false,
        timestamp: Date.now(),
        statusNote: "(busy — skipped)",
        sourceInstanceId: targetId,
        sourceLabel: virtualTargetLabel(agent),
        turnId,
      });
      report.busy += 1;
      continue;
    }

    fanoutOneTarget(virtualId, agent, text, attachments, turnId);
    report.ok += 1;
  }

  return report;
}

/**
 * Fire one prompt against `agent` and tee every wire event into both:
 *   1. the agent's per-instance chat (so the agent's own ChatPanel
 *      shows the same response), and
 *   2. the virtual session transcript (the aggregate view).
 *
 * Mirrors the bubble lifecycle of `startPromptStream` (single-agent) +
 * an additional virtual-side mirror. The duplication is bounded: every
 * SDK callback handles two store writes, but the structure stays linear.
 */
function fanoutOneTarget(
  virtualId: string,
  agent: DiscoveredAgentDTO,
  text: string,
  attachments: WireAttachment[] | undefined,
  turnId: string,
): void {
  const bridge = useBridge();
  const instanceId = agent.instanceId;
  const sourceLabel = virtualTargetLabel(agent);
  const session = getSession(instanceId);
  const isCcSession =
    agent.agent === "cc-headless" && agent.metadata?.["role"] === "session";

  // ----- per-instance chat: user bubble + initial agent bubble -----
  const userMsg = appendMessage(instanceId, {
    id: randomUUID(),
    role: "user",
    content: text,
    streaming: false,
    timestamp: Date.now(),
  });
  if (attachments && attachments.length > 0) {
    userMsg.attachments = attachments.map((a) => ({ filename: a.filename, base64: a.base64 }));
  }

  let currentAgentMsgId = randomUUID();
  appendMessage(instanceId, {
    id: currentAgentMsgId,
    role: "agent",
    content: "",
    streaming: true,
    timestamp: Date.now(),
  });

  // ----- virtual transcript: initial agent bubble -----
  let currentVirtualMsgId = randomUUID();
  appendVirtualMessage(virtualId, {
    id: currentVirtualMsgId,
    role: "agent",
    content: "",
    streaming: true,
    timestamp: Date.now(),
    sourceInstanceId: instanceId,
    sourceLabel,
    turnId,
  });

  function newPerInstanceAgentBubble(): void {
    currentAgentMsgId = randomUUID();
    appendMessage(instanceId, {
      id: currentAgentMsgId,
      role: "agent",
      content: "",
      streaming: true,
      timestamp: Date.now(),
    });
  }
  function newVirtualAgentBubble(): void {
    currentVirtualMsgId = randomUUID();
    appendVirtualMessage(virtualId, {
      id: currentVirtualMsgId,
      role: "agent",
      content: "",
      streaming: true,
      timestamp: Date.now(),
      sourceInstanceId: instanceId,
      sourceLabel,
      turnId,
    });
  }

  let syncErrored = false;
  let promptId = "";
  promptId = bridge.prompt(instanceId, text, attachments, {
    onResponse(chunk, responseAttachments) {
      const m = findMessage(instanceId, currentAgentMsgId);
      if (m) {
        m.content += chunk;
        if (responseAttachments && responseAttachments.length > 0) {
          m.attachments = [...(m.attachments ?? []), ...responseAttachments];
        }
      }
      const vm = findVirtualMessage(virtualId, currentVirtualMsgId);
      if (vm) {
        vm.content += chunk;
        if (responseAttachments && responseAttachments.length > 0) {
          vm.attachments = [...(vm.attachments ?? []), ...responseAttachments];
        }
      }
    },
    onStatus(status) {
      const m = findMessage(instanceId, currentAgentMsgId);
      if (m && status === "stopped") m.statusNote = "(stopped)";
      const vm = findVirtualMessage(virtualId, currentVirtualMsgId);
      if (vm && status === "stopped") vm.statusNote = "(stopped)";
    },
    onQuery(queryId, queryPrompt, queryAttachments) {
      const prev = findMessage(instanceId, currentAgentMsgId);
      if (prev) prev.streaming = false;
      const prevV = findVirtualMessage(virtualId, currentVirtualMsgId);
      if (prevV) prevV.streaming = false;
      // Per-instance: queries are interactive so promptId is wired up.
      appendMessage(instanceId, {
        id: randomUUID(),
        role: "query",
        content: queryPrompt,
        streaming: false,
        timestamp: Date.now(),
        queryId,
        promptId,
        replied: false,
        attachments: queryAttachments,
      });
      // Virtual: queries from inside an aggregate are read-only — replying
      // back to a single source from the virtual chat is out of scope for
      // Phase 2. Render the prompt as a non-interactive query bubble.
      appendVirtualMessage(virtualId, {
        id: randomUUID(),
        role: "query",
        content: queryPrompt,
        streaming: false,
        timestamp: Date.now(),
        queryId,
        promptId,
        replied: true,
        sourceInstanceId: instanceId,
        sourceLabel,
        turnId,
        attachments: queryAttachments,
      });
      newPerInstanceAgentBubble();
      newVirtualAgentBubble();
    },
    onToolUse(toolUseId, toolName, input) {
      const prev = findMessage(instanceId, currentAgentMsgId);
      if (prev) prev.streaming = false;
      const prevV = findVirtualMessage(virtualId, currentVirtualMsgId);
      if (prevV) prevV.streaming = false;
      appendMessage(instanceId, {
        id: randomUUID(),
        role: "tool",
        content: "",
        streaming: false,
        timestamp: Date.now(),
        tool: { id: toolUseId, name: toolName, input },
      });
      appendVirtualMessage(virtualId, {
        id: randomUUID(),
        role: "tool",
        content: "",
        streaming: false,
        timestamp: Date.now(),
        tool: { id: toolUseId, name: toolName, input },
        sourceInstanceId: instanceId,
        sourceLabel,
        turnId,
      });
      newPerInstanceAgentBubble();
      newVirtualAgentBubble();
    },
    onToolResult(toolUseId, output, isError) {
      const m = findMessageByToolId(instanceId, toolUseId);
      if (m && m.tool) {
        m.tool.result = output;
        m.tool.isError = isError;
      }
      const vm = findVirtualMessageByToolId(virtualId, toolUseId);
      if (vm && vm.tool) {
        vm.tool.result = output;
        vm.tool.isError = isError;
      }
    },
    onCost(turnCostUsd, totalCostUsd) {
      const m = findMessage(instanceId, currentAgentMsgId);
      if (m) m.costUsd = turnCostUsd;
      const vm = findVirtualMessage(virtualId, currentVirtualMsgId);
      if (vm) vm.costUsd = turnCostUsd;
      if (isCcSession) bumpCcSessionCost(agent.name, totalCostUsd);
    },
    onDone() {
      const m = findMessage(instanceId, currentAgentMsgId);
      if (m) m.streaming = false;
      const vm = findVirtualMessage(virtualId, currentVirtualMsgId);
      if (vm) vm.streaming = false;
      session.activePromptId = null;
      untrackVirtualPrompt(virtualId, turnId, instanceId);
    },
    onError(message, code, details) {
      syncErrored = true;
      const detail = code ? ` [${code}]` : "";
      const extra = details ? ` ${JSON.stringify(details)}` : "";
      const formatted = `${message}${detail}${extra}`;
      const m = findMessage(instanceId, currentAgentMsgId);
      if (m) {
        m.error = formatted;
        m.streaming = false;
      }
      const vm = findVirtualMessage(virtualId, currentVirtualMsgId);
      if (vm) {
        vm.error = formatted;
        vm.streaming = false;
      }
      session.activePromptId = null;
      untrackVirtualPrompt(virtualId, turnId, instanceId);
    },
  });
  if (!syncErrored) {
    session.activePromptId = promptId;
    trackVirtualPrompt(virtualId, turnId, instanceId, promptId);
  }
}
