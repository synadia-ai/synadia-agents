import { describe, expect, it, vi } from "vitest";
import type * as Trace from "../../src/trace.js";

type TraceModule = typeof Trace;

/**
 * The ambient trace binding is written by the agent service and read by a
 * client used as a tool inside the handler, and the two can come from
 * different installed copies of `@synadia-ai/agents`: a nested `file:`
 * install, a harness pinning its own version, the ESM and CJS builds both
 * loaded. With one AsyncLocalStorage per copy the scope the service bound
 * is invisible to the client, and every child thread silently becomes a
 * root. So the storage lives on `globalThis` under a well-known symbol,
 * like the record counters, and whichever copy asks sees the one binding.
 */
describe("trace scope across module copies", () => {
  const scope = { threadId: "a".repeat(32), rootId: "b".repeat(32), turnCountHint: 0 };
  const options = { edgeSubject: "TRACE.edges" };

  // Two evaluations of the module: each `import()` after a registry reset
  // runs the module body again, the way a second installed copy would.
  async function twoCopies(): Promise<[TraceModule, TraceModule]> {
    vi.resetModules();
    const a = await import("../../src/trace.js");
    vi.resetModules();
    const b = await import("../../src/trace.js");
    return [a, b];
  }

  it("loads two distinct copies of the module", async () => {
    const [a, b] = await twoCopies();
    expect(a.bindActiveTrace).not.toBe(b.bindActiveTrace);
    expect(a.activeTrace).not.toBe(b.activeTrace);
  });

  it("a scope bound through one copy is the scope the other copy sees", async () => {
    const [a, b] = await twoCopies();
    expect(b.activeTrace()).toBeUndefined();
    a.bindActiveTrace(
      scope,
      () => {
        expect(b.activeTrace()).toBe(scope);
        expect(b.inheritedTraceOptions()).toBe(options);
        expect(a.activeTrace()).toBe(scope);
      },
      options,
    );
    expect(b.activeTrace()).toBeUndefined();
    expect(a.activeTrace()).toBeUndefined();
  });

  it("flows into awaited work started under one copy and read by the other", async () => {
    const [a, b] = await twoCopies();
    const seen = await a.bindActiveTrace(scope, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return b.activeTrace();
    });
    expect(seen).toBe(scope);
  });

  it("shares the record counters the same way", async () => {
    const [a, b] = await twoCopies();
    const before = b.traceRecordCounts();
    a.countTraceRecordPublished();
    a.countTraceRecordDropped();
    const after = b.traceRecordCounts();
    expect(after.published - before.published).toBe(1);
    expect(after.dropped - before.dropped).toBe(1);
  });
});
