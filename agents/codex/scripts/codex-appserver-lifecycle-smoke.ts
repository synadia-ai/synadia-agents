#!/usr/bin/env bun
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerClient } from "../src/codex-app-server-client.js";

const codeHome = mkdtempSync(join(tmpdir(), "synadia-codex-lifecycle-"));
const client = CodexAppServerClient.spawn({
  command: process.env.SYNADIA_CODEX_BIN ?? "codex",
  env: { CODEX_HOME: codeHome },
});
try {
  const initialized = await client.initialize(15_000);
  if (!initialized.userAgent.includes("0.")) throw new Error("initialize did not return a Codex userAgent");
  if (initialized.codexHome.length === 0) throw new Error("initialize did not return codexHome");
  console.log(JSON.stringify({
    ok: true,
    check: "real codex app-server initialize/initialized over stdio",
    userAgent: initialized.userAgent.replace(/\([^)]*\)/g, "([REDACTED])"),
    codexHome: "[REDACTED]",
    platformFamily: initialized.platformFamily,
    platformOs: initialized.platformOs,
  }, null, 2));
} finally {
  await client.close();
  rmSync(codeHome, { recursive: true, force: true });
}
