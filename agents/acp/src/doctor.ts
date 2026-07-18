import { spawnSync } from "node:child_process";
import { buildPromptSubject } from "./subject.js";
import type { AcpChannelConfig } from "./types.js";

export interface DoctorBinaryCheck {
  readonly ok: boolean;
  readonly version?: string;
  readonly error?: string;
}

export interface DoctorReport {
  readonly identity: {
    readonly owner: string;
    readonly session: string;
    readonly subjectToken: string;
    readonly promptSubject: string;
  };
  readonly acp: {
    readonly preset: string;
    readonly agentId: string;
    readonly mode: string;
    readonly bin: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly permissionPolicy: string;
    readonly agentHome: string;
  };
  readonly nats: {
    readonly target: string;
    readonly credsConfigured: boolean;
  };
  readonly binary: DoctorBinaryCheck;
}

/** Probe `<bin> --version` without starting a full ACP session (no auth side effects). */
export function checkBinary(bin: string): DoctorBinaryCheck {
  try {
    const result = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5_000 });
    if (result.error) return { ok: false, error: result.error.message };
    if (result.status !== 0) {
      return { ok: false, error: `exit code ${result.status}${result.stderr ? `: ${result.stderr.trim().slice(0, 200)}` : ""}` };
    }
    return { ok: true, version: result.stdout.trim().slice(0, 120) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function runDoctor(config: AcpChannelConfig): DoctorReport {
  const { agent, acp, nats } = config;
  return {
    identity: {
      owner: agent.owner,
      session: agent.session,
      subjectToken: agent.subjectToken,
      promptSubject: buildPromptSubject(agent.subjectToken, agent.owner, agent.session),
    },
    acp: {
      preset: acp.preset,
      agentId: acp.agentId,
      mode: acp.mode,
      bin: acp.bin,
      args: acp.args,
      cwd: acp.cwd,
      permissionPolicy: acp.permissionPolicy,
      agentHome: acp.agentHome ?? (acp.homeEnvVar !== undefined ? `(ephemeral temp dir via ${acp.homeEnvVar})` : "(agent default)"),
    },
    nats: {
      target: nats.context ? `context:${nats.context}` : nats.url ?? "nats://127.0.0.1:4222",
      credsConfigured: nats.creds !== undefined,
    },
    binary: checkBinary(acp.bin),
  };
}
