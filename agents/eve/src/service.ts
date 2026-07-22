import type { NatsConnection } from "@nats-io/nats-core";
import {
  AgentService,
  type AgentServiceOptions,
} from "@synadia-ai/agent-service";
import type { EveBridgeClient } from "./bridge.js";
import { bridgePromptToEve } from "./bridge.js";
import type { EveChannelConfig } from "./config.js";
import { mappingFromConfig } from "./config.js";
import { SdkEveBridgeClient } from "./eve-client.js";

export interface BuildAgentServiceOptionsInput {
  readonly nc: NatsConnection;
  readonly config: EveChannelConfig;
  readonly version: string;
}

export function buildAgentServiceOptions(
  input: BuildAgentServiceOptionsInput,
): AgentServiceOptions {
  const mapping = mappingFromConfig(input.config);
  return {
    nc: input.nc,
    agent: "eve",
    subjectToken: mapping.subjectToken,
    owner: mapping.owner,
    name: mapping.name,
    session: mapping.name,
    description: `Eve agent at ${mapping.eve.baseUrl}`,
    version: input.version,
    attachmentsOk: true,
    heartbeatIntervalS: input.config.agent.heartbeatIntervalS,
    keepaliveIntervalS: input.config.agent.keepaliveIntervalS,
    extraMetadata: {
      eve_base_url: mapping.eve.baseUrl,
      // Advertise the auth *mode* only — the token itself never enters metadata.
      eve_auth: mapping.eve.authToken !== undefined ? "bearer" : "none",
    },
  };
}

export function createEveAgentService(
  input: BuildAgentServiceOptionsInput & {
    readonly eveClient?: EveBridgeClient;
  },
): AgentService {
  const service = new AgentService(buildAgentServiceOptions(input));
  const mapping = mappingFromConfig(input.config);
  const eveClient = input.eveClient ?? new SdkEveBridgeClient(mapping.eve);
  // One sidecar process = one Eve conversation. Serialize prompts so a
  // second caller can't interleave turns into the shared ClientSession.
  let queue: Promise<void> = Promise.resolve();
  service.onPrompt((envelope, response) => {
    const run = queue.then(() => bridgePromptToEve({ envelope, response, mapping, eveClient }));
    queue = run.catch(() => {});
    return run;
  });
  return service;
}
