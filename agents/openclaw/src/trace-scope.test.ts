import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import {
  OPENCLAW_TRACE_SCOPE_KEY,
  newTraceId,
  openClawTraceScope,
  runWithTraceId,
  validTraceId,
  type OpenClawTraceContext,
} from "./trace-scope.js";

const ID = "9f2c4b1e8a7d33051c6e0b42d78a91f0";

describe("trace ids", () => {
  it("validTraceId accepts a W3C trace id and refuses anything else", () => {
    expect(validTraceId(ID)).toBe(true);
    for (const bad of [undefined, "", ID.toUpperCase(), ID.slice(1), "0".repeat(32)]) {
      expect(validTraceId(bad)).toBe(false);
    }
  });

  it("newTraceId mints a fresh valid id each time", () => {
    const a = newTraceId();
    const b = newTraceId();
    expect(validTraceId(a)).toBe(true);
    expect(validTraceId(b)).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("openClawTraceScope", () => {
  it("adopts OpenClaw's store when the global carries one", () => {
    const storage = new AsyncLocalStorage<OpenClawTraceContext | undefined>();
    const root = { [OPENCLAW_TRACE_SCOPE_KEY]: { marker: OPENCLAW_TRACE_SCOPE_KEY, storage } };
    expect(openClawTraceScope(root)).toBe(storage);
  });

  it("creates the store in OpenClaw's shape when the global is absent", () => {
    const root: Record<symbol, unknown> = {};
    const storage = openClawTraceScope(root);
    expect(storage).toBeInstanceOf(AsyncLocalStorage);
    const state = root[OPENCLAW_TRACE_SCOPE_KEY] as { marker: unknown; storage: unknown };
    expect(state.marker).toBe(OPENCLAW_TRACE_SCOPE_KEY);
    expect(state.storage).toBe(storage);
    // A second call finds the same store.
    expect(openClawTraceScope(root)).toBe(storage);
  });

  it("refuses a global of another shape rather than misusing it", () => {
    expect(openClawTraceScope({ [OPENCLAW_TRACE_SCOPE_KEY]: { storage: {} } })).toBeUndefined();
    expect(openClawTraceScope({ [OPENCLAW_TRACE_SCOPE_KEY]: 42 })).toBeUndefined();
  });
});

describe("runWithTraceId", () => {
  it("makes the id the active trace id for the callback and its awaits", async () => {
    const storage = new AsyncLocalStorage<OpenClawTraceContext | undefined>();
    const seen = await runWithTraceId(
      ID,
      async () => {
        await new Promise((r) => setTimeout(r, 5));
        return storage.getStore();
      },
      storage,
    );
    expect(seen?.traceId).toBe(ID);
    expect(seen?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(seen?.traceFlags).toBe("01");
    expect(Object.isFrozen(seen)).toBe(true);
    // Nothing leaks past the callback.
    expect(storage.getStore()).toBeUndefined();
  });

  it("runs the callback as-is without a usable id or store", async () => {
    const storage = new AsyncLocalStorage<OpenClawTraceContext | undefined>();
    expect(await runWithTraceId(undefined, async () => storage.getStore(), storage)).toBeUndefined();
    expect(await runWithTraceId("not a trace id", async () => storage.getStore(), storage)).toBeUndefined();
    expect(await runWithTraceId(ID, async () => "ran", undefined)).toBe("ran");
  });
});
