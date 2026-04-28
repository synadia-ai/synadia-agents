<script setup lang="ts">
import { computed, ref } from "vue";
import MessageList from "./MessageList.vue";
import PromptArea from "./PromptArea.vue";
import { fileToAttachment, useBridge } from "../composables/useBridge.ts";
import {
  appendMessage,
  findMessage,
  findMessageByToolId,
  getSession,
  messagesFor,
  type Message,
} from "../stores/chat.ts";
import { bumpCcSessionCost } from "../stores/ccexec.ts";
import { randomUUID } from "../uuid.ts";
import type { DiscoveredAgentDTO } from "../wire.ts";

const props = defineProps<{ agent: DiscoveredAgentDTO }>();

const bridge = useBridge();
const error = ref<string | null>(null);

const isCcSession = computed(
  () => props.agent.metadata?.["spawner"] === "claude-code-headless",
);

const currentMessages = computed(() => messagesFor(props.agent.instanceId));

const busy = computed(
  () => getSession(props.agent.instanceId).activePromptId !== null,
);

const attachmentsOk = computed(
  () => props.agent.promptEndpoint.attachmentsOk === true,
);
const maxPayloadBytes = computed(() => props.agent.promptEndpoint.maxPayloadBytes);

async function onSubmit(text: string, files: File[]): Promise<void> {
  const agent = props.agent;
  const session = getSession(agent.instanceId);

  let attachments: Awaited<ReturnType<typeof fileToAttachment>>[] | undefined;
  if (files.length > 0) {
    try {
      attachments = await Promise.all(files.map(fileToAttachment));
    } catch (e) {
      error.value = `failed to read file: ${(e as Error).message}`;
      return;
    }
  }

  const userMsg = appendMessage(agent.instanceId, {
    id: randomUUID(),
    role: "user",
    content: text,
    streaming: false,
    timestamp: Date.now(),
  });
  if (attachments) {
    userMsg.attachments = attachments.map((a) => ({ filename: a.filename, base64: a.base64 }));
  }

  let currentAgentMsgId = randomUUID();
  appendMessage(agent.instanceId, {
    id: currentAgentMsgId,
    role: "agent",
    content: "",
    streaming: true,
    timestamp: Date.now(),
  });

  function newAgentBubble(): void {
    currentAgentMsgId = randomUUID();
    appendMessage(agent.instanceId, {
      id: currentAgentMsgId,
      role: "agent",
      content: "",
      streaming: true,
      timestamp: Date.now(),
    });
  }

  let promptId = "";
  promptId = bridge.prompt(agent.instanceId, text, attachments, {
    onResponse(chunk, responseAttachments) {
      const m = findMessage(agent.instanceId, currentAgentMsgId);
      if (!m) return;
      m.content += chunk;
      if (responseAttachments && responseAttachments.length > 0) {
        m.attachments = [...(m.attachments ?? []), ...responseAttachments];
      }
    },
    onStatus(status) {
      const m = findMessage(agent.instanceId, currentAgentMsgId);
      if (!m) return;
      if (status === "stopped") m.statusNote = "(stopped)";
    },
    onQuery(queryId, queryPrompt, queryAttachments) {
      const prev = findMessage(agent.instanceId, currentAgentMsgId);
      if (prev) prev.streaming = false;
      appendMessage(agent.instanceId, {
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
      const prev = findMessage(agent.instanceId, currentAgentMsgId);
      if (prev) prev.streaming = false;
      appendMessage(agent.instanceId, {
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
      const m = findMessageByToolId(agent.instanceId, toolUseId);
      if (m && m.tool) {
        m.tool.result = output;
        m.tool.isError = isError;
      }
    },
    onCost(turnCostUsd, totalCostUsd) {
      const m = findMessage(agent.instanceId, currentAgentMsgId);
      if (m) m.costUsd = turnCostUsd;
      // For claude-code-headless sessions the running total drives the
      // session-card cost line in the agent grid.
      if (isCcSession.value) bumpCcSessionCost(agent.name, totalCostUsd);
    },
    onDone() {
      const m = findMessage(agent.instanceId, currentAgentMsgId);
      if (m) m.streaming = false;
      session.activePromptId = null;
    },
    onError(message, code, details) {
      const m = findMessage(agent.instanceId, currentAgentMsgId);
      if (m) {
        const detail = code ? ` [${code}]` : "";
        const extra = details ? ` ${JSON.stringify(details)}` : "";
        m.error = `${message}${detail}${extra}`;
        m.streaming = false;
      }
      session.activePromptId = null;
    },
  });
  session.activePromptId = promptId;
}

function onQueryReply(message: Message, answer: string): void {
  if (message.replied) return;
  if (!message.promptId || !message.queryId) return;
  bridge.queryReply(message.promptId, message.queryId, answer);
  message.replied = true;
  message.replyValue = answer;
}

function onStop(): void {
  const s = getSession(props.agent.instanceId);
  if (s.activePromptId) bridge.cancel(s.activePromptId);
}
</script>

<template>
  <section class="chat-pane">
    <header class="chat-head">
      <div class="chat-title">
        <span class="chat-agent mono">{{ agent.agent }}</span>
        <span class="chat-name">{{ agent.session ?? agent.name }}</span>
        <span class="chat-owner mono">@{{ agent.owner }}</span>
      </div>
      <div class="chat-sub mono">{{ agent.promptEndpoint.subject }}</div>
    </header>
    <div v-if="error" class="error mono">{{ error }}</div>
    <MessageList :messages="currentMessages" @reply="onQueryReply" />
    <PromptArea
      :busy="busy"
      :disabled="false"
      :attachments-ok="attachmentsOk"
      :max-payload-bytes="maxPayloadBytes"
      @submit="onSubmit"
      @stop="onStop"
    />
  </section>
</template>

<style scoped>
.chat-pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--bg-deep);
}
.chat-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-md) var(--space-lg);
  background: var(--bg-primary);
  border-bottom: var(--border-subtle);
  flex-shrink: 0;
}
.chat-title {
  display: flex;
  align-items: baseline;
  gap: var(--space-sm);
}
.chat-agent {
  font-size: var(--text-xs);
  color: var(--accent-primary);
  background: var(--accent-glow);
  padding: 1px 6px;
  border-radius: var(--border-radius-sm);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.chat-name {
  color: var(--text-primary);
  font-weight: 600;
}
.chat-owner { color: var(--text-muted); font-size: var(--text-xs); }
.chat-sub {
  color: var(--text-dim);
  font-size: var(--text-xs);
}
.error {
  padding: var(--space-sm) var(--space-lg);
  font-size: var(--text-xs);
  color: var(--error);
  background: var(--error-dim);
  border-bottom: 1px solid rgba(248, 113, 113, 0.3);
}
</style>
