import { describe, expect, test } from "bun:test";
import { drainAndWipeConnection } from "../src/cli.js";

describe("CLI connection lifecycle", () => {
  test("wipes the shared connection bundle when draining rejects", async () => {
    const error = new Error("drain failed");
    let wiped = false;

    await expect(drainAndWipeConnection(
      { drain: () => Promise.reject(error) },
      { wipe: () => { wiped = true; } },
    )).rejects.toBe(error);
    expect(wiped).toBe(true);
  });
});
