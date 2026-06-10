import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { checkOpenCodePluginInstallation, installOpenCodePlugin, renderPluginEnvTemplate, uninstallOpenCodePlugin } from "../src/plugin/install.js";

describe("plugin installer", () => {
  test("writes a thin wrapper and package dependency without secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-plugin-install-"));
    const result = installOpenCodePlugin({ directory: dir, owner: "team", session: "frontend" });
    expect(readFileSync(result.pluginPath, "utf8")).toContain("@synadia-ai/opencode-nats-channel/opencode-plugin");
    const packageJson = JSON.parse(readFileSync(result.packageJsonPath, "utf8"));
    expect(packageJson.dependencies["@synadia-ai/opencode-nats-channel"]).toMatch(/^\^\d+\.\d+\.\d+$/);
    const combined = readFileSync(result.pluginPath, "utf8") + readFileSync(result.packageJsonPath, "utf8") + renderPluginEnvTemplate(result.env);
    expect(combined).not.toMatch(/S[A-Z0-9]{57}/);
    expect(combined).not.toContain("NATS_CREDS=");
    expect(combined).toContain("OPENCODE_PERMISSION_TIMEOUT_MS='300000'");
    expect(combined).toContain("SYNADIA_OPENCODE_OWNER='team'");
    expect(combined).toContain("SYNADIA_OPENCODE_SESSION='frontend'");
  });

  test("uninstall removes only the generated wrapper", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-plugin-uninstall-"));
    const installed = installOpenCodePlugin({ directory: dir });
    expect(uninstallOpenCodePlugin(dir)).toEqual({ pluginPath: installed.pluginPath, removed: true });
    expect(uninstallOpenCodePlugin(dir).removed).toBe(false);
  });

  test("doctor check is read-only and reports missing dependency/wrapper", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-plugin-doctor-"));
    expect(checkOpenCodePluginInstallation(dir)).toMatchObject({ pluginInstalled: false, dependencyInstalled: false });
    installOpenCodePlugin({ directory: dir });
    expect(checkOpenCodePluginInstallation(dir)).toMatchObject({ pluginInstalled: true, dependencyInstalled: true });
  });
});
