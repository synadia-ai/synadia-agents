<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import ConnectionBar from "./components/ConnectionBar.vue";
import AgentList from "./components/AgentList.vue";
import MessageList from "./components/MessageList.vue";
import PromptArea from "./components/PromptArea.vue";
import PiExecView from "./components/piexec/PiExecView.vue";
import CcExecView from "./components/ccexec/CcExecView.vue";
import { bridgeState } from "./stores/bridge.ts";
import {
  agentsState,
  ccexecControllers,
  piexecControllers,
  selectedAgent,
} from "./stores/agents.ts";
import {
  appendMessage,
  findMessage,
  getSession,
  messagesFor,
  type Message,
} from "./stores/chat.ts";
import { fileToAttachment, useBridge } from "./composables/useBridge.ts";
import { randomUUID } from "./uuid.ts";

type ViewMode = "chat" | "piexec" | "ccexec";
const STORAGE_KEY = "testui:view-mode";
const loadedMode =
  typeof localStorage !== "undefined"
    ? (localStorage.getItem(STORAGE_KEY) as ViewMode | null)
    : null;
const viewMode = ref<ViewMode>(
  loadedMode === "piexec" || loadedMode === "ccexec" ? loadedMode : "chat",
);
const piexecAvailable = computed(() => piexecControllers.value.length > 0);
const ccexecAvailable = computed(() => ccexecControllers.value.length > 0);

function setMode(mode: ViewMode): void {
  if (mode === "piexec" && !piexecAvailable.value) return;
  if (mode === "ccexec" && !ccexecAvailable.value) return;
  viewMode.value = mode;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* noop */
  }
}

// Fall back to chat when the active mode's controllers vanish; stay otherwise.
watch(piexecAvailable, (available) => {
  if (!available && viewMode.value === "piexec") viewMode.value = "chat";
});
watch(ccexecAvailable, (available) => {
  if (!available && viewMode.value === "ccexec") viewMode.value = "chat";
});

const bridge = useBridge();

// The active session's messages are looked up reactively via the selected agent.
const currentMessages = computed(() =>
  selectedAgent.value ? messagesFor(selectedAgent.value.instanceId) : [],
);

const busy = computed(() => {
  const ag = selectedAgent.value;
  if (!ag) return false;
  return getSession(ag.instanceId).activePromptId !== null;
});

const attachmentsOk = computed(() => selectedAgent.value?.promptEndpoint.attachmentsOk === true);
const maxPayloadBytes = computed(() => selectedAgent.value?.promptEndpoint.maxPayloadBytes);

const error = ref<string | null>(null);

async function refreshAgents(): Promise<void> {
  if (agentsState.discovering) return;
  agentsState.discovering = true;
  error.value = null;
  try {
    await bridge.discover();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    agentsState.discovering = false;
  }
}

// Auto-discover on first connect and after any reconnect.
watch(
  () => bridgeState.status,
  (newStatus, oldStatus) => {
    if (newStatus === "open" && oldStatus !== "open") {
      void refreshAgents();
    }
  },
  { immediate: true },
);

async function onSubmit(text: string, files: File[]): Promise<void> {
  const maybeAgent = selectedAgent.value;
  if (!maybeAgent) return;
  const agent = maybeAgent;
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

  let promptId = "";

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
      // Most status strings are not worth surfacing ("ack" is noise). Show a
      // friendly note only for the ones that carry end-user meaning.
      if (status === "stopped") m.statusNote = "(stopped)";
    },
    onQuery(queryId, queryPrompt, queryAttachments) {
      // Close the current agent bubble and emit the query as its own message
      // so it renders with an inline reply widget. Subsequent response chunks
      // go into a fresh agent bubble that follows the query chronologically.
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
  const agent = selectedAgent.value;
  if (!agent) return;
  const s = getSession(agent.instanceId);
  if (s.activePromptId) bridge.cancel(s.activePromptId);
}

onMounted(() => {
  // nothing further — connect() already ran via useBridge()
});
</script>

<template>
  <ConnectionBar @refresh="refreshAgents">
    <template #actions>
      <nav class="mode-toggle mono">
        <button
          type="button"
          class="mode-btn"
          :class="{ active: viewMode === 'chat' }"
          @click="setMode('chat')"
        >Chat</button>
        <button
          type="button"
          class="mode-btn"
          :class="{ active: viewMode === 'piexec' }"
          :disabled="!piexecAvailable"
          :title="piexecAvailable ? 'Spawn &amp; fan-out PI sessions' : 'start pi-headless to enable'"
          @click="setMode('piexec')"
        >PI Exec<span v-if="piexecAvailable" class="count">{{ piexecControllers.length }}</span></button>
        <button
          type="button"
          class="mode-btn"
          :class="{ active: viewMode === 'ccexec' }"
          :disabled="!ccexecAvailable"
          :title="ccexecAvailable ? 'Spawn Claude Code sessions' : 'start claude-code-headless to enable'"
          @click="setMode('ccexec')"
        >CC Exec<span v-if="ccexecAvailable" class="count">{{ ccexecControllers.length }}</span></button>
      </nav>
    </template>
  </ConnectionBar>
  <div v-if="error" class="global-error mono">{{ error }}</div>
  <PiExecView v-if="viewMode === 'piexec'" />
  <CcExecView v-else-if="viewMode === 'ccexec'" />
  <main v-else class="shell">
    <AgentList />
    <section class="chat-pane">
      <div v-if="!selectedAgent" class="chat-placeholder">
        <div class="placeholder-inner">
          <h2>Pick an agent to start</h2>
          <p>Agents are discovered via NATS $SRV.INFO — run an agent (e.g. <code>pi</code> with <code>nats-pi-channel</code>) and it will appear in the list.</p>
        </div>
      </div>
      <template v-else>
        <header class="chat-head">
          <div class="chat-title">
            <span class="chat-agent mono">{{ selectedAgent.agent }}</span>
            <span class="chat-name">{{ selectedAgent.session ?? selectedAgent.name }}</span>
            <span class="chat-owner mono">@{{ selectedAgent.owner }}</span>
          </div>
          <div class="chat-sub mono">{{ selectedAgent.promptEndpoint.subject }}</div>
        </header>
        <MessageList :messages="currentMessages" @reply="onQueryReply" />
        <PromptArea
          :busy="busy"
          :disabled="false"
          :attachments-ok="attachmentsOk"
          :max-payload-bytes="maxPayloadBytes"
          @submit="onSubmit"
          @stop="onStop"
        />
      </template>
    </section>
  </main>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: var(--sidebar-width) 1fr;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.global-error {
  padding: var(--space-sm) var(--space-lg);
  font-size: var(--text-xs);
  color: var(--error);
  background: var(--error-dim);
  border-bottom: 1px solid rgba(248, 113, 113, 0.3);
}

.chat-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--bg-deep);
}

.chat-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  padding: var(--space-2xl);
}
.placeholder-inner {
  max-width: 420px;
  text-align: center;
  color: var(--text-muted);
}
.placeholder-inner h2 {
  color: var(--text-secondary);
  margin-bottom: var(--space-md);
}
.placeholder-inner p {
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
}
.placeholder-inner code {
  font-family: var(--font-mono);
  color: var(--accent-primary);
  background: transparent;
  padding: 0;
}

.chat-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-md) var(--space-lg);
  background: var(--bg-primary);
  border-bottom: var(--border-subtle);
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

.mode-toggle {
  display: flex;
  gap: 2px;
  background: var(--bg-primary);
  border: var(--border-subtle);
  border-radius: var(--border-radius);
  padding: 2px;
}
.mode-btn {
  height: 26px;
  padding: 0 var(--space-md);
  font-size: var(--text-xs);
  background: transparent;
  color: var(--text-muted);
  border: none;
  border-radius: var(--border-radius-sm);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.mode-btn.active {
  background: var(--accent-gradient);
  color: white;
}
.mode-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.mode-btn .count {
  font-size: 10px;
  padding: 0 4px;
  border-radius: var(--border-radius-sm);
  background: rgba(255, 255, 255, 0.18);
}
</style>
