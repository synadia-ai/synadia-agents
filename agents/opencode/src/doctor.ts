import type { OpenCodeChannelConfig } from "./config.js";
import { buildPromptSubject } from "./subject.js";

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly message: string;
}

export interface DoctorDeps {
  readonly fetch?: typeof fetch;
  readonly dynamicImport?: (specifier: string) => Promise<unknown>;
  readonly commandExists?: (command: string) => Promise<boolean>;
}

export async function runDoctorChecks(config: OpenCodeChannelConfig, deps: DoctorDeps = {}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  checks.push({ name: "config", ok: true, message: `agent opencode/${config.agent.owner}/${config.agent.name} mode=${config.opencode.mode}` });
  checks.push({ name: "subject", ok: true, message: buildPromptSubject(config.agent.subjectToken, config.agent.owner, config.agent.name) });
  checks.push({ name: "nats", ok: true, message: redact(`url=${config.nats.url ?? ""} context=${config.nats.context ?? ""} creds=${config.nats.creds ?? ""}`) });

  const dynamicImport = deps.dynamicImport ?? ((specifier: string) => import(specifier));
  try {
    await dynamicImport("@opencode-ai/sdk");
    checks.push({ name: "opencode-sdk", ok: true, message: "@opencode-ai/sdk importable" });
  } catch (err) {
    checks.push({ name: "opencode-sdk", ok: false, message: (err as Error).message });
  }

  if (config.opencode.mode === "attached") {
    checks.push(await probeAttachedServer(config, deps.fetch ?? fetch));
  } else {
    const commandExists = deps.commandExists ?? defaultCommandExists;
    const binary = config.opencode.opencodePath ?? "opencode";
    const ok = await commandExists(binary);
    checks.push({ name: "opencode-binary", ok, message: ok ? `${binary} found` : `${binary} not found on PATH` });
  }

  if (config.opencode.permissionPolicy === "query") {
    checks.push({ name: "permission-policy", ok: true, message: "query policy selected; Phase 4 must bridge permission events to protocol queries" });
  } else {
    checks.push({ name: "permission-policy", ok: true, message: `${config.opencode.permissionPolicy} policy selected` });
  }
  return checks;
}

async function probeAttachedServer(config: OpenCodeChannelConfig, fetchImpl: typeof fetch): Promise<DoctorCheck> {
  const baseUrl = config.opencode.baseUrl;
  if (!baseUrl) return { name: "opencode-http", ok: false, message: "attached mode requires baseUrl" };
  try {
    const url = new URL("/event", baseUrl);
    const res = await fetchImpl(url, { method: "GET" });
    const reachable = res.ok || res.status === 405;
    const methodNote = res.status === 405 ? " (reachable; GET probe method unsupported)" : "";
    return { name: "opencode-http", ok: reachable, message: `${url.toString()} returned HTTP ${res.status}${methodNote}` };
  } catch (err) {
    return { name: "opencode-http", ok: false, message: (err as Error).message };
  }
}

async function defaultCommandExists(command: string): Promise<boolean> {
  const proc = Bun.spawn(["/usr/bin/env", "sh", "-c", `command -v ${JSON.stringify(command)} >/dev/null 2>&1`]);
  const code = await proc.exited;
  return code === 0;
}

export function formatDoctorChecks(checks: readonly DoctorCheck[]): string {
  return checks.map((check) => `${check.ok ? "ok" : "fail"}\t${check.name}\t${check.message}`).join("\n");
}

export function redact(value: string): string {
  return value
    .replace(/(password=)[^\s]+/gi, "$1[REDACTED]")
    .replace(/(creds=)[^\s]+/gi, "$1[REDACTED]")
    .replace(/S[A-Z0-9]{57}/g, "[REDACTED]");
}
