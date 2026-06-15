import { spawnSync } from "node:child_process";
import type { CodexChannelConfig } from "./types.js";
import { buildPromptSubject } from "./subject.js";

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface DoctorReport {
  readonly phase: "managed-app-server" | "attached-endpoint";
  readonly checks: readonly DoctorCheck[];
  readonly nats: Record<string, unknown>;
  readonly agent: Record<string, unknown>;
  readonly codex: Record<string, unknown>;
}

export async function runDoctor(config: CodexChannelConfig): Promise<DoctorReport> {
  const version = spawnSync(config.codex.codexBin, ["--version"], { encoding: "utf8" });
  const subject = buildPromptSubject(config.agent.subjectToken, config.agent.owner, config.agent.session);
  const checks: DoctorCheck[] = [
    { name: "codex --version", ok: version.status === 0, detail: redact((version.stdout || version.stderr || "not available").trim()) },
    { name: "nats source", ok: Boolean(config.nats.context || config.nats.url), detail: config.nats.context ? "context" : safeOrigin(config.nats.url ?? "") },
    { name: "computed subject", ok: true, detail: subject },
    { name: "max payload", ok: true, detail: "discovered from NATS connection at runtime" },
    { name: "permission callback", ok: config.codex.permissionPolicy === "query", detail: config.codex.permissionPolicy === "query" ? "adapter-owned query mode requested" : `policy=${config.codex.permissionPolicy}` },
    { name: "redaction", ok: redactionScan(config, subject), detail: "doctor report hides CODEX_HOME, endpoint, thread id, creds" },
  ];
  return {
    phase: config.codex.mode === "attached" ? "attached-endpoint" : "managed-app-server",
    checks,
    nats: {
      source: config.nats.context ? "context" : "url",
      url: config.nats.url ? safeOrigin(config.nats.url) : undefined,
      context: config.nats.context || undefined,
      creds: config.nats.creds ? "[REDACTED]" : undefined,
    },
    agent: { ...config.agent, promptSubject: subject },
    codex: {
      mode: config.codex.mode,
      codexBin: config.codex.codexBin,
      codeHome: config.codex.codeHome ? "[REDACTED]" : undefined,
      endpoint: config.codex.endpoint ? "[REDACTED]" : undefined,
      endpointAuth: config.codex.endpointAuth ? "[REDACTED]" : undefined,
      threadId: config.codex.threadId ? "[REDACTED]" : undefined,
      publicAlias: config.codex.publicAlias,
      permissionPolicy: config.codex.permissionPolicy,
    },
  };
}

export function redact(value: string): string {
  return value
    .replace(/\/Users\/[A-Za-z0-9._-]+/g, "/Users/[REDACTED]")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED-email]")
    .replace(/S[A-Z0-9]{57}/g, "[REDACTED-nkey]");
}

function safeOrigin(value: string): string {
  try {
    const url = new URL(value);
    return url.origin === "null" ? `${url.protocol}//${url.host}` : url.origin;
  } catch {
    return "invalid-url";
  }
}

function redactionScan(config: CodexChannelConfig, subject: string): boolean {
  const publicText = JSON.stringify({ subject, owner: config.agent.owner, session: config.agent.session });
  return !publicText.includes(config.codex.threadId ?? "\u0000")
    && !publicText.includes(config.codex.endpoint ?? "\u0000")
    && !publicText.includes(config.codex.codeHome ?? "\u0000");
}
