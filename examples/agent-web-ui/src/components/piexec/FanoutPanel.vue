<script setup lang="ts">
import { computed, ref } from "vue";
import { useBridge } from "../../composables/useBridge.ts";
import { agentsState } from "../../stores/agents.ts";
import {
  appendFanoutRun,
  findFanoutRun,
  onSpawned,
  onStopped,
  piexecState,
  resetFanout,
  selectedController,
  type FanoutRun,
} from "../../stores/piexec.ts";
import FanoutRunCard from "./FanoutRunCard.vue";

const bridge = useBridge();

const prompt = ref("");
const cwdsText = ref("");
const stopAfterDone = ref(true);

const cwds = computed(() =>
  cwdsText.value
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
);

const disabled = computed(
  () =>
    !selectedController.value ||
    piexecState.fanoutRunning ||
    prompt.value.trim().length === 0 ||
    cwds.value.length === 0,
);

function resolveSession(instanceId: string, retries = 10, delayMs = 300): Promise<void> {
  return new Promise((resolve, reject) => {
    const tryOnce = async (remaining: number): Promise<void> => {
      if (agentsState.list.some((a) => a.instanceId === instanceId)) return resolve();
      if (remaining === 0) return reject(new Error(`session ${instanceId} not discoverable`));
      try {
        await bridge.discover(1500);
      } catch {
        /* swallow — retry */
      }
      setTimeout(() => void tryOnce(remaining - 1), delayMs);
    };
    void tryOnce(retries);
  });
}

async function runOne(run: FanoutRun, promptText: string): Promise<void> {
  const controller = selectedController.value;
  if (!controller) return;

  // 1. Spawn
  run.status = "spawning";
  let descriptor;
  try {
    descriptor = await bridge.piexecSpawn(controller.instanceId, { cwd: run.cwd });
    onSpawned(descriptor);
    run.sessionId = descriptor.session_id;
    run.instanceId = descriptor.instance_id;
  } catch (err) {
    run.status = "error";
    run.error = `spawn: ${(err as Error).message}`;
    return;
  }

  // 2. Wait for the session to be visible to the SDK, then prompt.
  try {
    await resolveSession(descriptor.instance_id);
  } catch (err) {
    run.status = "error";
    run.error = (err as Error).message;
    return;
  }

  run.status = "running";
  const promptId = bridge.prompt(descriptor.instance_id, promptText, undefined, {
    onResponse(chunk) {
      run.content += chunk;
    },
    onStatus(status) {
      if (status === "stopped") run.status = "stopped";
    },
    onDone() {
      if (run.status === "running") run.status = "done";
      void maybeStop();
    },
    onError(message) {
      run.status = "error";
      run.error = message;
      void maybeStop();
    },
  });
  run.promptId = promptId;

  async function maybeStop(): Promise<void> {
    if (!stopAfterDone.value) return;
    if (!run.sessionId) return;
    const c = selectedController.value;
    if (!c) return;
    try {
      await bridge.piexecStop(c.instanceId, run.sessionId);
      onStopped(run.sessionId);
    } catch {
      /* leave dangling — user can manually stop */
    }
  }
}

async function onSubmit(e: Event): Promise<void> {
  e.preventDefault();
  if (disabled.value) return;
  const controller = selectedController.value;
  if (!controller) return;

  const promptText = prompt.value;
  const targets = [...cwds.value];
  resetFanout();
  piexecState.fanoutRunning = true;
  piexecState.lastError = null;

  try {
    const runs: FanoutRun[] = targets.map((cwd) => ({
      id: crypto.randomUUID(),
      cwd,
      status: "pending",
      content: "",
    }));
    for (const r of runs) appendFanoutRun(r);

    await Promise.all(runs.map((r) => runOne(r, promptText)));
  } finally {
    piexecState.fanoutRunning = false;
  }
}

function onCancel(id: string): void {
  const run = findFanoutRun(id);
  if (!run || !run.promptId) return;
  bridge.cancel(run.promptId);
  run.status = "stopped";
}

function clearResults(): void {
  resetFanout();
}
</script>

<template>
  <section class="panel">
    <form class="form" @submit="onSubmit">
      <h3 class="heading">Fan-out</h3>
      <textarea
        v-model="prompt"
        class="prompt mono"
        rows="3"
        placeholder="Prompt sent to every cwd (plain text)"
        :disabled="!selectedController || piexecState.fanoutRunning"
      />
      <textarea
        v-model="cwdsText"
        class="cwds mono"
        rows="4"
        placeholder="one cwd per line&#10;/tmp/a&#10;/tmp/b"
        :disabled="!selectedController || piexecState.fanoutRunning"
      />
      <label class="checkbox">
        <input
          type="checkbox"
          v-model="stopAfterDone"
          :disabled="piexecState.fanoutRunning"
        />
        <span class="mono">stop sessions after each prompt finishes</span>
      </label>
      <div class="footer">
        <span class="count mono">{{ cwds.length }} target{{ cwds.length === 1 ? "" : "s" }}</span>
        <button
          type="button"
          class="btn ghost"
          :disabled="piexecState.fanoutRuns.length === 0 || piexecState.fanoutRunning"
          @click="clearResults"
        >Clear</button>
        <button type="submit" class="btn primary" :disabled="disabled">
          {{ piexecState.fanoutRunning ? "running…" : "Run fan-out" }}
        </button>
      </div>
    </form>

    <div v-if="piexecState.fanoutRuns.length > 0" class="grid">
      <FanoutRunCard
        v-for="r in piexecState.fanoutRuns"
        :key="r.id"
        :run="r"
        @cancel="onCancel"
      />
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
  padding-right: var(--space-xs);
}
.form {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  padding: var(--space-md);
  background: var(--bg-secondary);
  border: var(--border-subtle);
  border-radius: var(--border-radius);
}
.heading {
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-dim);
  font-family: var(--font-mono);
}
.prompt,
.cwds {
  padding: var(--space-sm) var(--space-md);
  background: var(--bg-primary);
  border: var(--border-subtle);
  border-radius: var(--border-radius);
  color: var(--text-primary);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  resize: vertical;
}
.prompt:focus,
.cwds:focus {
  outline: none;
  border-color: var(--accent-primary);
}
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

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: var(--space-sm);
}
</style>
