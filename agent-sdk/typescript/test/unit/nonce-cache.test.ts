// Nonce set semantics (plan §2.5): keyed `(user, nonce)`, expiry anchored
// on the header `ts` (not on arrival), check-and-set, bounded by a cap
// with oldest-first eviction logged once, and second-bucketed sweeps.

import { describe, expect, it } from "vitest";
import type { Logger } from "@synadia-ai/agents";
import { NonceCache } from "../../src/identity/classify.js";

const U1 = "UAAA";
const U2 = "UBBB";

function collectingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (m) => {
        warnings.push(m);
      },
      error: () => undefined,
    },
  };
}

describe("NonceCache", () => {
  it("records once per (user, nonce); the same nonce from another user is distinct", () => {
    const c = new NonceCache({ replayWindowMs: 30_000 });
    const now = 1_000_000;
    expect(c.record(U1, "n1", now, now)).toBe(true);
    expect(c.record(U1, "n1", now, now)).toBe(false);
    expect(c.has(U1, "n1", now)).toBe(true);
    expect(c.record(U2, "n1", now, now)).toBe(true);
    expect(c.size).toBe(2);
  });

  it("expires at ts + window, not arrival + window", () => {
    const c = new NonceCache({ replayWindowMs: 30_000 });
    const arrival = 1_000_000;
    const ts = arrival + 29_000; // legal: 29 s in the future
    expect(c.record(U1, "future", ts, arrival)).toBe(true);
    // arrival + 31 s: an arrival-anchored cache would have evicted it.
    expect(c.has(U1, "future", arrival + 31_000)).toBe(true);
    expect(c.record(U1, "future", ts, arrival + 31_000)).toBe(false);
    // ts + window + 1 s: gone.
    expect(c.has(U1, "future", ts + 30_000 + 1_000)).toBe(false);
  });

  it("a header whose expiry has already passed is not stored (nothing to remember)", () => {
    const c = new NonceCache({ replayWindowMs: 30_000 });
    const now = 1_000_000;
    expect(c.record(U1, "stale", now - 60_000, now)).toBe(true);
    expect(c.size).toBe(0);
  });

  it("sweeps whole second-buckets", () => {
    const c = new NonceCache({ replayWindowMs: 1_000 });
    const t0 = 5_000_000;
    for (let i = 0; i < 10; i++) c.record(U1, `n${i}`, t0 + i * 100, t0);
    expect(c.size).toBe(10);
    c.sweep(t0 + 1_000); // expiries land in [t0+1000, t0+1900] → bucket not yet passed
    expect(c.size).toBe(10);
    c.sweep(t0 + 3_000);
    expect(c.size).toBe(0);
  });

  it("enforces the cap by evicting the oldest buckets and logs once", () => {
    const { logger, warnings } = collectingLogger();
    const c = new NonceCache({ replayWindowMs: 30_000, maxEntries: 5, logger });
    const t0 = 9_000_000;
    for (let i = 0; i < 8; i++) c.record(U1, `n${i}`, t0 + i * 1_000, t0);
    expect(c.size).toBeLessThanOrEqual(5);
    expect(c.has(U1, "n0", t0)).toBe(false); // oldest evicted
    expect(c.has(U1, "n7", t0)).toBe(true); // newest kept
    expect(warnings).toHaveLength(1);
  });
});
