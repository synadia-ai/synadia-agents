import type { FlueChannelConfig } from "./config.js";

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly message: string;
}

export interface DoctorDeps {
  readonly fetch?: typeof fetch;
}

export async function runDoctorChecks(config: FlueChannelConfig, deps: DoctorDeps = {}): Promise<DoctorCheck[]> {
  const fetchImpl = deps.fetch ?? fetch;
  const checks: DoctorCheck[] = [];
  checks.push({ name: "config", ok: true, message: `agent flue/${config.agent.owner}/${config.agent.name}` });
  try {
    const url = new URL(`/agents/${encodeURIComponent(config.flue.agent)}/${encodeURIComponent(config.flue.instance)}`, config.flue.baseUrl);
    const res = await fetchImpl(url, { method: "GET" });
    const reachable = res.ok || res.status === 426 || res.status === 404 || res.status === 405;
    const methodNote = res.status === 405 ? " (reachable; GET probe method unsupported)" : "";
    checks.push({ name: "flue-http", ok: reachable, message: `${url.toString()} returned HTTP ${res.status}${methodNote}` });
  } catch (err) {
    checks.push({ name: "flue-http", ok: false, message: (err as Error).message });
  }
  return checks;
}

export function formatDoctorChecks(checks: readonly DoctorCheck[]): string {
  return checks.map((check) => `${check.ok ? "ok" : "fail"}	${check.name}	${check.message}`).join("\n");
}
