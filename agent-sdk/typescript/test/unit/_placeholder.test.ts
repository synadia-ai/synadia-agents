// Placeholder test that exists only so tsc resolves "vitest" as a module
// (the test harness's `declare module "vitest"` augmentation needs at
// least one consumer of the module). Removed by Phase 2 once real test
// files arrive via `git mv`.
import { describe, it, expect } from "vitest";

describe("agent-sdk scaffold", () => {
  it("placeholder — replaced by moved tests in Phase 2", () => {
    expect(true).toBe(true);
  });
});
