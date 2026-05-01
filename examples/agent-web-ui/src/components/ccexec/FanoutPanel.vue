<script setup lang="ts">
import { computed, ref } from "vue";
import { useBridge } from "../../composables/useBridge.ts";
import { agentsState } from "../../stores/agents.ts";
import {
  appendCcFanoutRun,
  ccexecState,
  findCcFanoutRun,
  onCcSpawned,
  onCcStopped,
  resetCcFanout,
  selectedCcController,
} from "../../stores/ccexec.ts";
import type { FanoutRun } from "../../stores/piexec.ts";
import { appendMessage, findMessage } from "../../stores/chat.ts";
import FanoutRunCard from "../piexec/FanoutRunCard.vue";
import { randomUUID } from "../../uuid.ts";

const bridge = useBridge();

const prompt = ref("");
const cwds = ref<string[]>([""]);
const stopAfterDone = ref(false);

const validCwds = computed(() =>
  cwds.value.map((c) => c.trim()).filter((c) => c.length > 0),
);

const disabled = computed(
  () =>
    !selectedCcController.value ||
    ccexecState.fanoutRunning ||
    prompt.value.trim().length === 0 ||
    validCwds.value.length === 0,
);

function addCwd(): void {
  cwds.value = [...cwds.value, ""];
}

function removeCwd(i: number): void {
  if (cwds.value.length === 1) {
    cwds.value = [""];
    return;
  }
  cwds.value = cwds.value.filter((_, idx) => idx !== i);
}

function resolveSession(instanceId: string, retries = 10, delayMs = 300): Promise<void> {
  return new Promise((resolve, reject) => {
    const tryOnce = async (remaining: number): Promise<void> => {
      if (agentsState.list.some((a) => a.instanceId === instanceId)) return resolve();
      if (remaining === 0) return reject(new Error(`session ${instanceId} not discoverable`));
      try {
        await bridge.discover();
      } catch {
        /* swallow — retry */
      }
      setTimeout(() => void tryOnce(remaining - 1), delayMs);
    };
    void tryOnce(retries);
  });
}

async function runOne(run: FanoutRun, promptText: string): Promise<void> {
  const controller = selectedCcController.value;
  if (!controller) return;

  run.status = "spawning";
  let descriptor;
  try {
    descriptor = await bridge.ccexecSpawn(controller.instanceId, { cwd: run.cwd });
    onCcSpawned(descriptor);
    run.sessionId = descriptor.session_id;
    run.instanceId = descriptor.instance_id;
  } catch (err) {
    run.status = "error";
    run.error = `spawn: ${(err as Error).message}`;
    return;
  }

  try {
    await resolveSession(descriptor.instance_id);
  } catch (err) {
    run.status = "error";
    run.error = (err as Error).message;
    return;
  }

  run.status = "running";

  // Mirror the streaming output into the per-session chat store so the
  // bubbles also appear when the user clicks the spawned session card —
  // not just inside the fan-out result card. Same shape as ChatPanel's
  // `onSubmit` uses, but driven from here since fan-out runs predate the
  // user navigating to the session.
  const sessionInstanceId = descriptor.instance_id;
  const userMsgId = randomUUID();
  const agentMsgId = randomUUID();
  appendMessage(sessionInstanceId, {
    id: userMsgId,
    role: "user",
    content: promptText,
    streaming: false,
    timestamp: Date.now(),
  });
  appendMessage(sessionInstanceId, {
    id: agentMsgId,
    role: "agent",
    content: "",
    streaming: true,
    timestamp: Date.now(),
  });

  const promptId = bridge.prompt(sessionInstanceId, promptText, undefined, {
    onResponse(chunk) {
      run.content += chunk;
      const m = findMessage(sessionInstanceId, agentMsgId);
      if (m) m.content += chunk;
    },
    onStatus(status) {
      if (status === "stopped") run.status = "stopped";
    },
    onDone() {
      if (run.status === "running") run.status = "done";
      const m = findMessage(sessionInstanceId, agentMsgId);
      if (m) m.streaming = false;
      void maybeStop();
    },
    onError(message) {
      run.status = "error";
      run.error = message;
      const m = findMessage(sessionInstanceId, agentMsgId);
      if (m) {
        m.streaming = false;
        m.error = message;
      }
      void maybeStop();
    },
  });
  run.promptId = promptId;

  async function maybeStop(): Promise<void> {
    if (!stopAfterDone.value) return;
    if (!run.sessionId) return;
    const c = selectedCcController.value;
    if (!c) return;
    try {
      await bridge.ccexecStop(c.instanceId, run.sessionId);
      onCcStopped(run.sessionId);
    } catch {
      /* leave dangling — user can manually stop */
    }
  }
}

async function onSubmit(e: Event): Promise<void> {
  e.preventDefault();
  if (disabled.value) return;
  const controller = selectedCcController.value;
  if (!controller) return;

  const promptText = prompt.value;
  const targets = [...validCwds.value];
  resetCcFanout();
  ccexecState.fanoutRunning = true;
  ccexecState.lastError = null;

  try {
    const runs: FanoutRun[] = targets.map((cwd) => ({
      id: randomUUID(),
      cwd,
      status: "pending",
      content: "",
    }));
    for (const r of runs) appendCcFanoutRun(r);

    await Promise.all(runs.map((r) => runOne(r, promptText)));
  } finally {
    ccexecState.fanoutRunning = false;
  }
}

function onCancel(id: string): void {
  const run = findCcFanoutRun(id);
  if (!run || !run.promptId) return;
  bridge.cancel(run.promptId);
  run.status = "stopped";
}

function clearResults(): void {
  resetCcFanout();
}
</script>

<template>
  <section class="panel">
    <form class="form" @submit="onSubmit">
      <p class="lede">Run the same prompt across multiple working directories in parallel. Each run spawns its own claude-code session against the selected controller.</p>

      <label class="field">
        <span class="field-label">Prompt</span>
        <textarea
          v-model="prompt"
          class="prompt mono"
          rows="3"
          placeholder="Run the test suite and report failures"
          :disabled="!selectedCcController || ccexecState.fanoutRunning"
        />
      </label>

      <div class="cwd-list">
        <span class="field-label">Working directories</span>
        <div
          v-for="(_, i) in cwds"
          :key="i"
          class="cwd-row"
        >
          <input
            v-model="cwds[i]"
            class="cwd-input mono"
            type="text"
            placeholder="/path/to/repo"
            autocomplete="off"
            :disabled="!selectedCcController || ccexecState.fanoutRunning"
          />
          <button
            type="button"
            class="cwd-remove"
            :disabled="ccexecState.fanoutRunning"
            title="Remove"
            @click="removeCwd(i)"
          >×</button>
        </div>
        <button
          type="button"
          class="cwd-add mono"
          :disabled="ccexecState.fanoutRunning"
          @click="addCwd"
        >+ add directory</button>
      </div>

      <label class="checkbox">
        <input
          type="checkbox"
          v-model="stopAfterDone"
          :disabled="ccexecState.fanoutRunning"
        />
        <span class="mono">stop sessions after each prompt finishes</span>
      </label>

      <div class="footer">
        <span class="count mono">{{ validCwds.length }} target{{ validCwds.length === 1 ? "" : "s" }}</span>
        <button
          type="button"
          class="btn ghost"
          :disabled="ccexecState.fanoutRuns.length === 0 || ccexecState.fanoutRunning"
          @click="clearResults"
        >Clear</button>
        <button type="submit" class="btn primary" :disabled="disabled">
          {{ ccexecState.fanoutRunning ? "running…" : `Run fan-out (${validCwds.length})` }}
        </button>
      </div>
    </form>

    <div v-if="ccexecState.fanoutRuns.length > 0" class="results">
      <h3 class="results-title">
        Results
        <span class="dim mono">{{ ccexecState.fanoutRuns.filter(r => r.status === 'done').length }} / {{ ccexecState.fanoutRuns.length }}</span>
      </h3>
      <div class="grid">
        <FanoutRunCard
          v-for="r in ccexecState.fanoutRuns"
          :key="r.id"
          :run="r"
          @cancel="onCancel"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-md);
}
.form {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  padding: var(--space-md);
  background: var(--bg-secondary);
  border: var(--border-subtle);
  border-radius: var(--border-radius);
}
.lede {
  font-size: var(--text-xs);
  color: var(--text-muted);
  margin: 0;
  line-height: var(--leading-normal);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}
.field-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.prompt,
.cwd-input {
  padding: var(--space-sm) var(--space-md);
  background: var(--bg-primary);
  border: var(--border-subtle);
  border-radius: var(--border-radius);
  color: var(--text-primary);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  width: 100%;
}
.prompt { resize: vertical; }
.prompt:focus,
.cwd-input:focus {
  outline: none;
  border-color: var(--accent-primary);
}

.cwd-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}
.cwd-row {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}
.cwd-row .cwd-input { flex: 1; }
.cwd-remove {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  border-radius: var(--border-radius-sm);
  color: var(--text-muted);
  font-size: 18px;
  line-height: 1;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.06);
  cursor: pointer;
  transition: all var(--transition-fast);
}
.cwd-remove:hover:not(:disabled) {
  background: var(--error-dim);
  color: var(--error);
  border-color: var(--error);
}
.cwd-remove:disabled { opacity: 0.4; cursor: not-allowed; }

.cwd-add {
  align-self: flex-start;
  font-size: var(--text-xs);
  color: var(--text-muted);
  padding: 4px 10px;
  border: 1px dashed rgba(255, 255, 255, 0.15);
  border-radius: var(--border-radius-sm);
  background: transparent;
  cursor: pointer;
  transition: all var(--transition-fast);
}
.cwd-add:hover:not(:disabled) {
  color: var(--accent-primary);
  border-color: var(--accent-primary);
  background: var(--accent-glow);
}
.cwd-add:disabled { opacity: 0.4; cursor: not-allowed; }

.checkbox {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  font-size: var(--text-xs);
  color: var(--text-muted);
}
.footer {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}
.count {
  flex: 1;
  font-size: var(--text-xs);
  color: var(--text-dim);
}
.btn {
  height: 30px;
  padding: 0 var(--space-md);
  border-radius: var(--border-radius);
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  cursor: pointer;
}
.btn.primary {
  background: var(--accent-gradient);
  color: white;
  border: none;
}
.btn.primary:hover:not(:disabled) { filter: brightness(1.1); }
.btn.primary:disabled { opacity: 0.4; cursor: not-allowed; }
.btn.ghost {
  background: transparent;
  color: var(--text-muted);
  border: var(--border-subtle);
}
.btn.ghost:hover:not(:disabled) { color: var(--text-primary); border-color: var(--accent-primary); }
.btn.ghost:disabled { opacity: 0.4; cursor: not-allowed; }

.results {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  padding: var(--space-md);
  background: var(--bg-secondary);
  border: var(--border-subtle);
  border-radius: var(--border-radius);
}
.results-title {
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  display: flex;
  align-items: baseline;
  gap: var(--space-sm);
  margin: 0;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--space-sm);
}
.dim { color: var(--text-dim); }
.mono { font-family: var(--font-mono); }
</style>
