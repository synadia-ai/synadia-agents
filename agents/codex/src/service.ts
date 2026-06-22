import type { NatsConnection } from "@nats-io/nats-core";
import { AgentService, type AgentServiceOptions } from "@synadia-ai/agent-service";
import type { CodexBridgeClient } from "./bridge.js";
import { bridgePromptToCodex } from "./bridge.js";
import type { CodexChannelConfig } from "./config.js";
import { mappingFromConfig } from "./config.js";

export interface BuildAgentServiceOptionsInput {
  readonly nc: NatsConnection;
  readonly config: CodexChannelConfig;
  readonly version: string;
  readonly extraMetadata?: Record<string, string>;
}

export function buildAgentServiceOptions(input: BuildAgentServiceOptionsInput): AgentServiceOptions {
  const mapping = mappingFromConfig(input.config);
  return {
    nc: input.nc,
    agent: "codex",
    subjectToken: mapping.subjectToken,
    owner: mapping.owner,
    name: mapping.session,
    session: mapping.session,
    description: `Codex ${mapping.codex.mode} session ${mapping.owner}/${mapping.session}`,
    version: input.version,
    attachmentsOk: false,
    heartbeatIntervalS: input.config.agent.heartbeatIntervalS,
    keepaliveIntervalS: input.config.agent.keepaliveIntervalS,
    extraMetadata: {
      codex_mode: mapping.codex.mode,
      permission_policy: mapping.codex.permissionPolicy,
      permission_mode: mapping.codex.mode === "attached" ? "external-owner" : mapping.codex.permissionPolicy,
      manager_enabled: String(mapping.manager.enabled),
      ...input.extraMetadata,
    },
  };
}

export function createCodexAgentService(
  input: BuildAgentServiceOptionsInput & { readonly client: CodexBridgeClient },
): AgentService {
  const service = new AgentService(buildAgentServiceOptions(input));
  const mapping = mappingFromConfig(input.config);
  service.onPrompt(async (envelope, response) => {
    await bridgePromptToCodex({ envelope, response, mapping, client: input.client });
  });
  return service;
}
