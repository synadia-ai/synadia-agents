/**
 * Per-agent presets for ACP-speaking coding agents.
 *
 * A preset bundles the spawn command, subject-token defaults, and the
 * `SYNADIA_<AGENT>_*` env-var prefix for one agent. The generic bridge is the
 * same for every preset — only identity and process bootstrap differ.
 *
 * `agentId` is the canonical identifier advertised as `metadata.agent`
 * (spec Appendix C); `subjectToken` is the wire subject's 3rd token. They
 * differ only when the canonical name is longer than the conventional
 * abbreviation (mirrors `claude-code` / `cc`).
 */
export interface AcpAgentPreset {
  /** Preset key used by `--agent <key>`. */
  readonly key: string;
  /** Canonical agent identifier (`metadata.agent`). */
  readonly agentId: string;
  /** Default 3rd subject token. */
  readonly subjectToken: string;
  /** Default binary to spawn. */
  readonly bin: string;
  /** Default args that put the binary in ACP-over-stdio mode. */
  readonly args: readonly string[];
  /** Env var the agent reads its home/state dir from, if it has one. */
  readonly homeEnvVar?: string;
  /** Per-agent identity env var prefix (`SYNADIA_GROK`, ...). */
  readonly envPrefix: string;
  readonly description: string;
}

export const ACP_PRESETS: readonly AcpAgentPreset[] = [
  {
    key: "grok",
    agentId: "grok",
    subjectToken: "grok",
    bin: "grok",
    args: ["agent", "stdio"],
    homeEnvVar: "GROK_HOME",
    envPrefix: "SYNADIA_GROK",
    description: "Grok Build (xAI) — native ACP via `grok agent stdio`",
  },
  {
    key: "gemini",
    agentId: "gemini-cli",
    subjectToken: "gemini",
    bin: "gemini",
    args: ["--experimental-acp"],
    envPrefix: "SYNADIA_GEMINI",
    description: "Gemini CLI (Google) — native ACP via `gemini --experimental-acp`",
  },
];

export function resolvePreset(key: string): AcpAgentPreset | undefined {
  return ACP_PRESETS.find((preset) => preset.key === key);
}

export function presetKeys(): string {
  return [...ACP_PRESETS.map((preset) => preset.key), "custom"].join(", ");
}
