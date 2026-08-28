import type { NatsConnection } from "@nats-io/nats-core";
import type { RequestEnvelope } from "@synadia-ai/agents";
import {
  AgentService,
  type AgentServiceOptions,
} from "@synadia-ai/agent-service";
import type { BridgeResponse, EveBridgeClient } from "./bridge.js";
import { bridgePromptToEve } from "./bridge.js";
import type { EveChannelConfig, EveMapping } from "./config.js";
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

/**
 * One sidecar process = one Eve conversation: prompts are chained onto a
 * FIFO queue so a second caller can't interleave turns into the shared
 * `ClientSession`. A rejected prompt still rejects for its own caller
 * (the SDK turns that into a 500) without poisoning the queue for the
 * next one.
 */
export function createSerializedPromptHandler(deps: {
  readonly mapping: EveMapping;
  readonly eveClient: EveBridgeClient;
  /** Broker `max_payload` lookup, read per prompt (`nc.info` is populated once connected). */
  readonly brokerMaxPayload?: () => number | undefined;
}): (envelope: RequestEnvelope, response: BridgeResponse) => Promise<void> {
  let queue: Promise<void> = Promise.resolve();
  return (envelope, response) => {
    // Split oversized response chunks against the broker's negotiated
    // max_payload rather than the bridge's conservative 1 MiB fallback,
    // so a broker configured below the default doesn't reject large
    // structured results.
    const brokerCap = deps.brokerMaxPayload?.();
    const run = queue.then(() =>
      bridgePromptToEve({
        envelope,
        response,
        mapping: deps.mapping,
        eveClient: deps.eveClient,
        ...(typeof brokerCap === "number" && brokerCap > 0 ? { maxPayloadBytes: brokerCap } : {}),
      }),
    );
    queue = run.catch(() => {});
    return run;
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
  service.onPrompt(
    createSerializedPromptHandler({
      mapping,
      eveClient,
      brokerMaxPayload: () => input.nc.info?.max_payload,
    }),
  );
  return service;
}
