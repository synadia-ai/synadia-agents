// Unit tests for `LocalSandbox`. No NATS, no model — just confirms the
// `Sandbox` interface methods do what the bridge expects.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connectLocalSandbox } from "../vendor/sandbox/local.js";

describe("LocalSandbox", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-sandbox-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("writes and reads a file", async () => {
    const sandbox = await connectLocalSandbox({ type: "local", workingDirectory: dir });
    await sandbox.writeFile(join(dir, "hello.txt"), "Hello, world.\n", "utf-8");
    const read = await sandbox.readFile(join(dir, "hello.txt"), "utf-8");
    expect(read).toBe("Hello, world.\n");
  });

  test("readFileBuffer returns a Buffer with the same bytes", async () => {
    const sandbox = await connectLocalSandbox({ type: "local", workingDirectory: dir });
    await sandbox.writeFile(join(dir, "bytes.bin"), "abc", "utf-8");
    const buf = await sandbox.readFileBuffer(join(dir, "bytes.bin"));
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.toString()).toBe("abc");
  });

  test("stat reports file vs directory", async () => {
    const sandbox = await connectLocalSandbox({ type: "local", workingDirectory: dir });
    await sandbox.mkdir(join(dir, "sub"));
    await sandbox.writeFile(join(dir, "f.txt"), "x", "utf-8");
    const sFile = await sandbox.stat(join(dir, "f.txt"));
    const sDir = await sandbox.stat(join(dir, "sub"));
    expect(sFile.isFile()).toBe(true);
    expect(sFile.isDirectory()).toBe(false);
    expect(sDir.isDirectory()).toBe(true);
    expect(sDir.isFile()).toBe(false);
  });

  test("readdir returns Dirent[]", async () => {
    const sandbox = await connectLocalSandbox({ type: "local", workingDirectory: dir });
    await sandbox.writeFile(join(dir, "a.txt"), "", "utf-8");
    await sandbox.mkdir(join(dir, "b"));
    const entries = await sandbox.readdir(dir, { withFileTypes: true });
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(["a.txt", "b"]);
  });

  test("exec runs commands and captures stdout", async () => {
    const sandbox = await connectLocalSandbox({ type: "local", workingDirectory: dir });
    const result = await sandbox.exec("echo hi", dir, 10_000);
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hi");
    expect(result.stderr).toBe("");
  });

  test("exec reports a non-zero exit code", async () => {
    const sandbox = await connectLocalSandbox({ type: "local", workingDirectory: dir });
    const result = await sandbox.exec("exit 7", dir, 10_000);
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(7);
  });

  test("exec respects the timeout", async () => {
    const sandbox = await connectLocalSandbox({ type: "local", workingDirectory: dir });
    const result = await sandbox.exec("sleep 5", dir, 200);
    // Killed by signal — exitCode may be null or non-zero, success = false.
    expect(result.success).toBe(false);
  });

  test("env from state is exported to spawned commands", async () => {
    const sandbox = await connectLocalSandbox({
      type: "local",
      workingDirectory: dir,
      env: { OPEN_AGENT_TEST: "yes" },
    });
    const result = await sandbox.exec("echo $OPEN_AGENT_TEST", dir, 10_000);
    expect(result.stdout.trim()).toBe("yes");
  });

  test("parent-process credentials are NOT forwarded to subprocesses", async () => {
    // Simulate a credential that lives in the bridge's process env.
    process.env["OPEN_AGENT_FAKE_API_KEY"] = "supersecret";
    try {
      const sandbox = await connectLocalSandbox({ type: "local", workingDirectory: dir });
      const result = await sandbox.exec("printenv | grep -c OPEN_AGENT_FAKE_API_KEY || true", dir, 10_000);
      expect(result.stdout.trim()).toBe("0");
    } finally {
      delete process.env["OPEN_AGENT_FAKE_API_KEY"];
    }
  });

  test("PATH from parent IS forwarded so bash can find common utilities", async () => {
    const sandbox = await connectLocalSandbox({ type: "local", workingDirectory: dir });
    const result = await sandbox.exec("echo $PATH", dir, 10_000);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });

  test("readFile rejects paths outside the working directory", async () => {
    const sandbox = await connectLocalSandbox({ type: "local", workingDirectory: dir });
    await expect(sandbox.readFile("/etc/passwd", "utf-8")).rejects.toThrow(
      /outside the sandbox working directory/,
    );
  });

  test("writeFile rejects paths outside the working directory", async () => {
    const sandbox = await connectLocalSandbox({ type: "local", workingDirectory: dir });
    await expect(
      sandbox.writeFile("/tmp/open-agent-escape-attempt", "x", "utf-8"),
    ).rejects.toThrow(/outside the sandbox working directory/);
  });

  test("readFileBuffer rejects paths outside the working directory", async () => {
    const sandbox = await connectLocalSandbox({ type: "local", workingDirectory: dir });
    await expect(sandbox.readFileBuffer("/etc/hosts")).rejects.toThrow(
      /outside the sandbox working directory/,
    );
  });

  test("traversal via `..` is rejected even when the basename is workspace-relative", async () => {
    const sandbox = await connectLocalSandbox({ type: "local", workingDirectory: dir });
    await expect(
      sandbox.readFile(join(dir, "..", "..", "etc", "passwd"), "utf-8"),
    ).rejects.toThrow(/outside the sandbox working directory/);
  });

  test("exec rejects a cwd outside the working directory", async () => {
    const sandbox = await connectLocalSandbox({ type: "local", workingDirectory: dir });
    await expect(sandbox.exec("pwd", "/tmp", 10_000)).rejects.toThrow(
      /outside the sandbox working directory/,
    );
  });

  test("getState returns the original state object", async () => {
    const state = { type: "local" as const, workingDirectory: dir };
    const sandbox = await connectLocalSandbox(state);
    expect(sandbox.getState?.()).toEqual(state);
  });
});
