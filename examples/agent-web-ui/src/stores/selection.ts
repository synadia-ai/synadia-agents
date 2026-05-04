import { computed, reactive, watch } from "vue";
import { agentsState } from "./agents.ts";

/**
 * Multi-select state for the agent grid. A `Set<instanceId>` of cards the
 * user has ticked via the per-card selection circle, used by the floating
 * MultiSelectBar to fan out a single prompt to N agents/sessions at once.
 *
 * Orthogonal to `agentsState.selectedInstanceId` (which drives the right
 * panel — what's "open in chat"). The two interactions don't share state,
 * so a user can keep one chat open while ticking other cards for fan-out.
 */
export const selectionState = reactive({
  ids: new Set<string>(),
});

export const selectedCount = computed(() => selectionState.ids.size);

export function isSelected(instanceId: string): boolean {
  return selectionState.ids.has(instanceId);
}

export function toggleSelection(instanceId: string): void {
  if (selectionState.ids.has(instanceId)) {
    selectionState.ids.delete(instanceId);
  } else {
    selectionState.ids.add(instanceId);
  }
}

export function clearSelection(): void {
  selectionState.ids.clear();
}

// Drop selections for agents that vanished from discovery. The watch fires
// whenever the list changes; we diff against the current set so a normal
// list refresh that returns the same agents is a no-op. Selections survive
// transient empties (controller hiccup, brief disconnect) only because the
// list itself doesn't churn — if the bridge clears the list, selection
// follows it down.
watch(
  () => agentsState.list.map((a) => a.instanceId).join(","),
  () => {
    const present = new Set(agentsState.list.map((a) => a.instanceId));
    for (const id of [...selectionState.ids]) {
      if (!present.has(id)) selectionState.ids.delete(id);
    }
  },
);
