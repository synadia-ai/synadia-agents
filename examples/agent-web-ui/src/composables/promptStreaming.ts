import {
  appendMessage,
  findMessage,
  findMessageByToolId,
  getSession,
} from "../stores/chat.ts";
import { bumpCcSessionCost } from "../stores/ccexec.ts";
import { useBridge } from "./useBridge.ts";
import { randomUUID } from "../uuid.ts";
import type { DiscoveredAgentDTO, WireAttachment } from "../wire.ts";

/**
 * Fire a prompt against `agent`, mirroring every wire event into the
 * per-instance chat store: user bubble + agent bubble(s) + tool bubbles +
 * query bubbles + per-turn cost annotations + onError surfaces. The
 * returned promptId is also stamped on `getSession(instanceId).activePromptId`
 * so the chat panel's busy/stop UI works automatically, and so the
 * MultiSelectBar can detect "this agent is mid-prompt — skip it".
 *
 * Shared by `ChatPanel.onSubmit` (single-agent) and `MultiSelectBar.send`
 * (fan-out across N selected agents). Attachments must already be encoded —
 * file→WireAttachment conversion stays in the caller so it can surface
 * read errors in its own UI.
 */
export function startPromptStream(
  agent: DiscoveredAgentDTO,
  text: string,
  attachments: WireAttachment[] | undefined,
): string {
  const bridge = useBridge();
  const instanceId = agent.instanceId;
  const session = getSession(instanceId);
  const isCcSession =
    agent.agent === "cc-headless" && agent.metadata?.["role"] === "session";

  const userMsg = appendMessage(instanceId, {
    id: randomUUID(),
    role: "user",
    content: text,
    streaming: false,
    timestamp: Date.now(),
  });
  if (attachments && attachments.length > 0) {
    userMsg.attachments = attachments.map((a) => ({
      filename: a.filename,
      base64: a.base64,
    }));
  }

  let currentAgentMsgId = randomUUID();
  appendMessage(instanceId, {
    id: currentAgentMsgId,
    role: "agent",
    content: "",
    streaming: true,
    timestamp: Date.now(),
  });

  function newAgentBubble(): void {
    currentAgentMsgId = randomUUID();
    appendMessage(instanceId, {
      id: currentAgentMsgId,
      role: "agent",
      content: "",
      streaming: true,
      timestamp: Date.now(),
    });
  }

  // `bridge.prompt` invokes `onError` synchronously when the WebSocket is
  // closed at call time (see `useBridge.ts` — the send guard rejects the
  // payload before any async hop). The handler clears `activePromptId`,
  // but we must not then *re-stamp* it with the returned id below — that
  // would leave the session permanently flagged busy until reload, which
  // for fan-out would lock every targeted agent on a single network blip.
  let syncErrored = false;
  let promptId = "";
  promptId = bridge.prompt(instanceId, text, attachments, {
    onResponse(chunk, responseAttachments) {
      const m = findMessage(instanceId, currentAgentMsgId);
      if (!m) return;
      m.content += chunk;
      if (responseAttachments && responseAttachments.length > 0) {
        m.attachments = [...(m.attachments ?? []), ...responseAttachments];
      }
    },
    onStatus(status) {
      const m = findMessage(instanceId, currentAgentMsgId);
      if (!m) return;
      if (status === "stopped") m.statusNote = "(stopped)";
    },
    onQuery(queryId, queryPrompt, queryAttachments) {
      const prev = findMessage(instanceId, currentAgentMsgId);
      if (prev) prev.streaming = false;
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
      newAgentBubble();
    },
    onToolUse(toolUseId, toolName, input) {
      const prev = findMessage(instanceId, currentAgentMsgId);
      if (prev) prev.streaming = false;
      appendMessage(instanceId, {
        id: randomUUID(),
        role: "tool",
        content: "",
        streaming: false,
        timestamp: Date.now(),
        tool: { id: toolUseId, name: toolName, input },
      });
      newAgentBubble();
    },
    onToolResult(toolUseId, output, isError) {
      const m = findMessageByToolId(instanceId, toolUseId);
      if (m && m.tool) {
        m.tool.result = output;
        m.tool.isError = isError;
      }
    },
    onCost(turnCostUsd, totalCostUsd) {
      const m = findMessage(instanceId, currentAgentMsgId);
      if (m) m.costUsd = turnCostUsd;
      if (isCcSession) bumpCcSessionCost(agent.name, totalCostUsd);
    },
    onDone() {
      const m = findMessage(instanceId, currentAgentMsgId);
      if (m) m.streaming = false;
      session.activePromptId = null;
    },
    onError(message, code, details) {
      syncErrored = true;
      const m = findMessage(instanceId, currentAgentMsgId);
      if (m) {
        const detail = code ? ` [${code}]` : "";
        const extra = details ? ` ${JSON.stringify(details)}` : "";
        m.error = `${message}${detail}${extra}`;
        m.streaming = false;
      }
      session.activePromptId = null;
    },
  });
  if (!syncErrored) session.activePromptId = promptId;
  return promptId;
}
