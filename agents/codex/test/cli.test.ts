import { describe, expect, test } from "bun:test";
import { resolveCliCommand } from "../src/cli.js";

describe("CLI command dispatch", () => {
  test("routes nested attach subcommands through src/cli.ts", () => {
    expect(resolveCliCommand(["attach", "doctor", "--endpoint", "unix:///tmp/codex.sock", "--thread-id", "raw-fixture-thread", "--alias", "safe"])).toBe("attach:doctor");
    expect(resolveCliCommand(["attach", "start", "--endpoint", "unix:///tmp/codex.sock", "--thread-id", "raw-fixture-thread", "--alias", "safe"])).toBe("attach:start");
  });
});
