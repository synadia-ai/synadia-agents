import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPluginVersion } from "../src/plugin-version.js";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("loadPluginVersion", () => {
  test("reads a valid plugin version", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-plugin-version-"));
    try {
      const path = join(dir, "plugin.json");
      writeFileSync(path, JSON.stringify({ version: "1.2.3" }));
      expect(loadPluginVersion(path)).toBe("1.2.3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports a missing plugin descriptor as invalid", () => {
    const path = join(
      tmpdir(),
      `missing-claude-plugin-${crypto.randomUUID()}.json`,
    );
    expect(() => loadPluginVersion(path)).toThrow(
      "invalid .claude-plugin/plugin.json: cannot read file",
    );
  });

  test("the bundled server surfaces the invalid descriptor at startup", () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "claude-plugin-cache-"));
    try {
      mkdirSync(join(cacheRoot, "runtime"));
      const server = join(cacheRoot, "runtime", "server.js");
      copyFileSync(join(pluginRoot, "runtime", "server.js"), server);

      const result = Bun.spawnSync([process.execPath, server]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain(
        "nats channel: invalid .claude-plugin/plugin.json: cannot read file",
      );
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test("reports an unreadable plugin descriptor as invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-plugin-version-"));
    try {
      const blockingFile = join(dir, "not-a-directory");
      writeFileSync(blockingFile, "file");
      expect(() =>
        loadPluginVersion(join(blockingFile, "plugin.json")),
      ).toThrow("invalid .claude-plugin/plugin.json: cannot read file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports malformed JSON and invalid versions", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-plugin-version-"));
    try {
      const path = join(dir, "plugin.json");
      writeFileSync(path, "{");
      expect(() => loadPluginVersion(path)).toThrow(
        "invalid .claude-plugin/plugin.json: expected valid JSON",
      );

      writeFileSync(path, "null");
      expect(() => loadPluginVersion(path)).toThrow(
        "invalid .claude-plugin/plugin.json: expected an object",
      );

      writeFileSync(path, JSON.stringify({ version: "" }));
      expect(() => loadPluginVersion(path)).toThrow(
        "invalid .claude-plugin/plugin.json: expected a non-empty string version",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
