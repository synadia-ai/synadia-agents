import type { NatsConnection } from "@nats-io/nats-core";
import {
  AgentService,
  type AgentServiceOptions,
} from "@synadia-ai/agent-service";
import type { FlueBridgeClient } from "./bridge.js";
import { bridgePromptToFlue } from "./bridge.js";
import type { FlueChannelConfig } from "./config.js";
import { mappingFromConfig } from "./config.js";
import { SdkFlueBridgeClient } from "./flue-client.js";

export interface BuildAgentServiceOptionsInput {
  readonly nc: NatsConnection;
  readonly config: FlueChannelConfig;
  readonly version: string;
}

export function buildAgentServiceOptions(
  input: BuildAgentServiceOptionsInput,
): AgentServiceOptions {
  const mapping = mappingFromConfig(input.config);
  return {
    nc: input.nc,
    agent: "flue",
    subjectToken: mapping.subjectToken,
    owner: mapping.owner,
    name: mapping.name,
    session: mapping.name,
    description: `Flue agent ${mapping.flue.agent}/${mapping.flue.instance}`,
    version: input.version,
    attachmentsOk: false,
    heartbeatIntervalS: input.config.agent.heartbeatIntervalS,
    keepaliveIntervalS: input.config.agent.keepaliveIntervalS,
    extraMetadata: {
      flue_base_url: mapping.flue.baseUrl,
      flue_agent: mapping.flue.agent,
      flue_instance: mapping.flue.instance,
      flue_session: mapping.flue.session,
      flue_transport: mapping.flue.transport,
    },
  };
}

export function createFlueAgentService(
  input: BuildAgentServiceOptionsInput & {
    readonly flueClient?: FlueBridgeClient;
  },
): AgentService {
  const service = new AgentService(buildAgentServiceOptions(input));
  const mapping = mappingFromConfig(input.config);
  const flueClient = input.flueClient ?? new SdkFlueBridgeClient();
  service.onPrompt(async (envelope, response) => {
    await bridgePromptToFlue({ envelope, response, mapping, flueClient });
  });
  return service;
}
