import { describe, expect, test } from "bun:test";
import { resolveCliCommand } from "../src/cli.js";

describe("CLI command dispatch", () => {
  test("routes nested attach subcommands through src/cli.ts", () => {
    expect(resolveCliCommand(["attach", "doctor", "--endpoint", "unix:///tmp/codex.sock", "--thread-id", "raw-fixture-thread", "--alias", "safe"])).toBe("attach:doctor");
    expect(resolveCliCommand(["attach", "start", "--endpoint", "unix:///tmp/codex.sock", "--thread-id", "raw-fixture-thread", "--alias", "safe"])).toBe("attach:start");
  });

  test("prints help before parsing invalid environment config", async () => {
    const proc = Bun.spawn(["bun", "src/cli.ts", "--help"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, SYNADIA_CODEX_MODE: "invalid-mode" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Usage: codex-agent");
  });

  test("prints config template before parsing invalid environment config", async () => {
    const proc = Bun.spawn(["bun", "src/cli.ts", "configure", "--print-template"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, SYNADIA_CODEX_MODE: "invalid-mode" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("[nats]");
    expect(stdout).toContain("[codex]");
  });
});
