import type { NatsConnection } from "@nats-io/nats-core";
import { AgentService, type AgentServiceOptions } from "@synadia-ai/agent-service";
import type { AcpBridgeClient } from "./bridge.js";
import { bridgePromptToAcp } from "./bridge.js";
import type { AcpChannelConfig } from "./config.js";
import { mappingFromConfig } from "./config.js";

export interface BuildAgentServiceOptionsInput {
  readonly nc: NatsConnection;
  readonly config: AcpChannelConfig;
  readonly version: string;
  readonly extraMetadata?: Record<string, string>;
}

export function buildAgentServiceOptions(input: BuildAgentServiceOptionsInput): AgentServiceOptions {
  const mapping = mappingFromConfig(input.config);
  return {
    nc: input.nc,
    agent: mapping.acp.agentId,
    subjectToken: mapping.subjectToken,
    owner: mapping.owner,
    name: mapping.session,
    session: mapping.session,
    description: `${mapping.acp.agentId} (ACP ${mapping.acp.mode}) session ${mapping.owner}/${mapping.session}`,
    version: input.version,
    attachmentsOk: false,
    heartbeatIntervalS: input.config.agent.heartbeatIntervalS,
    keepaliveIntervalS: input.config.agent.keepaliveIntervalS,
    extraMetadata: {
      acp_preset: mapping.acp.preset,
      acp_mode: mapping.acp.mode,
      permission_policy: mapping.acp.permissionPolicy,
      ...input.extraMetadata,
    },
  };
}

export function createAcpAgentService(
  input: BuildAgentServiceOptionsInput & { readonly client: AcpBridgeClient },
): AgentService {
  const service = new AgentService(buildAgentServiceOptions(input));
  const mapping = mappingFromConfig(input.config);
  service.onPrompt(async (envelope, response) => {
    await bridgePromptToAcp({ envelope, response, mapping, client: input.client });
  });
  return service;
}
