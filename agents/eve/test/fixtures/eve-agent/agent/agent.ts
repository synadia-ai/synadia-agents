import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

// Deterministic fixture for scripts/real-eve-smoke.ts: no provider key
// needed. Echoes the last user message and the 1-based turn count so the
// smoke can assert session continuity across two prompts.
export default defineAgent({
  model: mockModel(
    ({ lastUserMessage, userMessageCount }) => `echo:${lastUserMessage} (turn ${userMessageCount})`,
  ),
  // mockModel's identity has no AI Gateway metadata; give the compaction
  // compiler an explicit context window so `eve dev` accepts the fixture.
  modelContextWindowTokens: 128_000,
});
