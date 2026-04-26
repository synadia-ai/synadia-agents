<script setup lang="ts">
import { computed, onMounted, watch } from "vue";
import { useBridge, fileToAttachment } from "../../composables/useBridge.ts";
import { agentsState, piexecControllers, selectAgent } from "../../stores/agents.ts";
import {
  autoPickController,
  piexecState,
  selectedController,
} from "../../stores/piexec.ts";
import {
  appendMessage,
  findMessage,
  getSession,
  messagesFor,
  type Message,
} from "../../stores/chat.ts";

import ControllerSelector from "./ControllerSelector.vue";
import SpawnForm from "./SpawnForm.vue";
import SessionList from "./SessionList.vue";
import FanoutPanel from "./FanoutPanel.vue";
import MessageList from "../MessageList.vue";
import PromptArea from "../PromptArea.vue";
import { randomUUID } from "../../uuid.ts";

const bridge = useBridge();

const selected = computed(() => {
  const id = agentsState.selectedInstanceId;
  if (!id) return null;
  return agentsState.list.find((a) => a.instanceId === id) ?? null;
});

const isSessionSelected = computed(() => {
  const s = selected.value;
  if (!s) return false;
  return s.metadata?.["spawner"] === "pi-headless";
});

const currentMessages = computed(() =>
  selected.value && isSessionSelected.value ? messagesFor(selected.value.instanceId) : [],
);

const busy = computed(() => {
  const s = selected.value;
  if (!s) return false;
  return getSession(s.instanceId).activePromptId !== null;
});

const attachmentsOk = computed(
  () => selected.value?.promptEndpoint.attachmentsOk === true,
);
const maxPayloadBytes = computed(() => selected.value?.promptEndpoint.maxPayloadBytes);

// Auto-pick a controller on first load or when the list changes.
watch(
  () => piexecControllers.value.length,
  () => autoPickController(),
  { immediate: true },
);

onMounted(() => {
  autoPickController();
});

async function onSubmit(text: string, files: File[]): Promise<void> {
  const agent = selected.value;
  if (!agent || !isSessionSelected.value) return;
  const session = getSession(agent.instanceId);

  let attachments: Awaited<ReturnType<typeof fileToAttachment>>[] | undefined;
  if (files.length > 0) {
    try {
      attachments = await Promise.all(files.map(fileToAttachment));
    } catch (e) {
      piexecState.lastError = `failed to read file: ${(e as Error).message}`;
      return;
    }
  }

  appendMessage(agent.instanceId, {
    id: randomUUID(),
    role: "user",
    content: text,
    streaming: false,
    timestamp: Date.now(),
    ...(attachments
      ? {
          attachments: attachments.map((a) => ({ filename: a.filename, base64: a.base64 })),
        }
      : {}),
  });

  const agentMsgId = randomUUID();
  appendMessage(agent.instanceId, {
    id: agentMsgId,
    role: "agent",
    content: "",
    streaming: true,
    timestamp: Date.now(),
  });

  const promptId = bridge.prompt(agent.instanceId, text, attachments, {
    onResponse(chunk) {
      const m = findMessage(agent.instanceId, agentMsgId);
      if (m) m.content += chunk;
    },
    onStatus(status) {
      const m = findMessage(agent.instanceId, agentMsgId);
      if (m && status === "stopped") m.statusNote = "(stopped)";
    },
    onDone() {
      const m = findMessage(agent.instanceId, agentMsgId);
      if (m) m.streaming = false;
      session.activePromptId = null;
    },
    onError(message, code) {
      const m = findMessage(agent.instanceId, agentMsgId);
      if (m) {
        const detail = code ? ` [${code}]` : "";
        m.error = `${message}${detail}`;
        m.streaming = false;
      }
      session.activePromptId = null;
    },
  });
  session.activePromptId = promptId;
}

function onStop(): void {
  const agent = selected.value;
  if (!agent) return;
  const s = getSession(agent.instanceId);
  if (s.activePromptId) bridge.cancel(s.activePromptId);
}

function _onQueryReply(message: Message, answer: string): void {
  // Sessions may emit queries via pi tooling permission prompts; reuse chat
  // flow's reply primitive. No-op when message isn't a query.
  if (message.replied) return;
  if (!message.promptId || !message.queryId) return;
  bridge.queryReply(message.promptId, message.queryId, answer);
  message.replied = true;
  message.replyValue = answer;
}
</script>

<template>
  <ControllerSelector />
  <main class="grid">
    <section class="col-left">
      <SpawnForm @spawned="(d) => selectAgent(d.instance_id)" />
      <SessionList />
    </section>
    <section class="col-mid">
      <div v-if="!selectedController" class="placeholder">
        <h2>No pi-headless controller</h2>
        <p>
          Run <code class="mono">bun run start</code> in <code class="mono">examples/pi-headless</code> and hit Refresh.
        </p>
      </div>
      <div v-else-if="!selected || !isSessionSelected" class="placeholder">
        <h2>Pick a session</h2>
        <p>Spawn a session or click one in the list to prompt it.</p>
      </div>
      <template v-else>
        <header class="chat-head">
          <div class="title">
            <span class="agent-tag mono">pi</span>
            <span class="name">{{ selected.name }}</span>
            <span class="owner mono">@{{ selected.owner }}</span>
          </div>
          <div class="sub mono">{{ selected.promptEndpoint.subject }}</div>
        </header>
        <MessageList :messages="currentMessages" @reply="_onQueryReply" />
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
    <section class="col-right">
      <FanoutPanel />
    </section>
  </main>
</template>

<style scoped>
.grid {
  flex: 1;
  display: grid;
  grid-template-columns: 320px 1fr 440px;
  gap: 0;
  min-height: 0;
  overflow: hidden;
}
.col-left,
.col-mid,
.col-right {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}
.col-left {
  padding: var(--space-md);
  gap: var(--space-md);
  background: var(--bg-primary);
  border-right: var(--border-subtle);
  overflow-y: auto;
}
.col-mid {
  background: var(--bg-deep);
}
.col-right {
  padding: var(--space-md);
  background: var(--bg-primary);
  border-left: var(--border-subtle);
  overflow-y: auto;
}

.placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-2xl);
  color: var(--text-muted);
  text-align: center;
}
.placeholder h2 { color: var(--text-secondary); margin-bottom: var(--space-md); }
.placeholder p { font-size: var(--text-sm); max-width: 360px; line-height: var(--leading-relaxed); }
.placeholder code { color: var(--accent-primary); }

.chat-head {
  padding: var(--space-md) var(--space-lg);
  background: var(--bg-primary);
  border-bottom: var(--border-subtle);
}
.title {
  display: flex;
  align-items: baseline;
  gap: var(--space-sm);
}
.agent-tag {
  font-size: var(--text-xs);
  color: var(--accent-primary);
  background: var(--accent-glow);
  padding: 1px 6px;
  border-radius: var(--border-radius-sm);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.name {
  color: var(--text-primary);
  font-weight: 600;
}
.owner { color: var(--text-muted); font-size: var(--text-xs); }
.sub { color: var(--text-dim); font-size: var(--text-xs); margin-top: 2px; }
</style>
