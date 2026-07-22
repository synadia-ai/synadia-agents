import type { EveChannelConfig } from "./config.js";

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly message: string;
}

export interface DoctorDeps {
  readonly fetch?: typeof fetch;
}

export async function runDoctorChecks(config: EveChannelConfig, deps: DoctorDeps = {}): Promise<DoctorCheck[]> {
  const fetchImpl = deps.fetch ?? fetch;
  const checks: DoctorCheck[] = [];
  checks.push({
    name: "config",
    ok: true,
    message: `agent eve/${config.agent.owner}/${config.agent.name} → ${config.eve.baseUrl} (auth: ${config.eve.authToken !== undefined ? "bearer" : "none"})`,
  });

  const headers: Record<string, string> =
    config.eve.authToken !== undefined ? { authorization: `Bearer ${config.eve.authToken}` } : {};

  const healthUrl = new URL("/eve/v1/health", config.eve.baseUrl);
  try {
    const res = await fetchImpl(healthUrl, { method: "GET", headers });
    checks.push({ name: "eve-health", ok: res.ok, message: `${healthUrl.toString()} returned HTTP ${res.status}` });
  } catch (err) {
    checks.push({ name: "eve-health", ok: false, message: `${healthUrl.toString()}: ${(err as Error).message}` });
  }

  const infoUrl = new URL("/eve/v1/info", config.eve.baseUrl);
  try {
    const res = await fetchImpl(infoUrl, { method: "GET", headers });
    if (res.status === 401 || res.status === 403) {
      checks.push({
        name: "eve-info",
        ok: false,
        message: `${infoUrl.toString()} returned HTTP ${res.status} — reachable but unauthorized; set [eve] auth_token`,
      });
    } else if (!res.ok) {
      checks.push({ name: "eve-info", ok: false, message: `${infoUrl.toString()} returned HTTP ${res.status}` });
    } else {
      const payload: unknown = await res.json().catch(() => undefined);
      checks.push({ name: "eve-info", ok: true, message: describeAgentInfo(payload) });
    }
  } catch (err) {
    checks.push({ name: "eve-info", ok: false, message: `${infoUrl.toString()}: ${(err as Error).message}` });
  }

  return checks;
}

/** Best-effort summary of `/eve/v1/info` — never fails on shape drift. */
function describeAgentInfo(payload: unknown): string {
  if (payload !== null && typeof payload === "object") {
    const agent = (payload as { agent?: unknown }).agent;
    if (agent !== null && typeof agent === "object") {
      const name = (agent as { name?: unknown }).name;
      const model = (agent as { model?: unknown }).model;
      const modelId =
        model !== null && typeof model === "object" ? (model as { id?: unknown }).id : undefined;
      if (typeof name === "string") {
        return typeof modelId === "string" ? `agent "${name}" (model ${modelId})` : `agent "${name}"`;
      }
    }
  }
  return "reachable (agent info shape unrecognized)";
}

export function formatDoctorChecks(checks: readonly DoctorCheck[]): string {
  return checks.map((check) => `${check.ok ? "ok" : "fail"}\t${check.name}\t${check.message}`).join("\n");
}
