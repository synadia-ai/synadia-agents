import type { NatsConnection } from "@nats-io/nats-core";
import { AgentService, type AgentServiceOptions } from "@synadia-ai/agent-service";
import type { OpenCodeBridgeClient } from "./bridge.js";
import { bridgePromptToOpenCode } from "./bridge.js";
import type { OpenCodeChannelConfig } from "./config.js";
import { mappingFromConfig } from "./config.js";

export interface BuildAgentServiceOptionsInput {
  readonly nc: NatsConnection;
  readonly config: OpenCodeChannelConfig;
  readonly version: string;
}

function safeOrigin(baseUrl: string | undefined): string {
  if (!baseUrl) return "";
  try { return new URL(baseUrl).origin; } catch { return "invalid-url"; }
}

function safeDirectoryLabel(directory: string | undefined): string {
  if (!directory) return "";
  return directory.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? "";
}

export function buildAgentServiceOptions(input: BuildAgentServiceOptionsInput): AgentServiceOptions {
  const mapping = mappingFromConfig(input.config);
  return {
    nc: input.nc,
    agent: "opencode",
    subjectToken: mapping.subjectToken,
    owner: mapping.owner,
    name: mapping.name,
    session: mapping.name,
    description: `OpenCode ${mapping.opencode.mode} session ${mapping.owner}/${mapping.name}`,
    version: input.version,
    attachmentsOk: false,
    heartbeatIntervalS: input.config.agent.heartbeatIntervalS,
    keepaliveIntervalS: input.config.agent.keepaliveIntervalS,
    extraMetadata: {
      opencode_mode: mapping.opencode.mode,
      opencode_directory: safeDirectoryLabel(mapping.opencode.directory),
      opencode_workspace: mapping.opencode.workspace ?? "",
      opencode_base_url_origin: safeOrigin(mapping.opencode.baseUrl),
      permission_policy: mapping.opencode.permissionPolicy,
    },
  };
}

export function createOpenCodeAgentService(
  input: BuildAgentServiceOptionsInput & { readonly client: OpenCodeBridgeClient },
): AgentService {
  const service = new AgentService(buildAgentServiceOptions(input));
  const mapping = mappingFromConfig(input.config);
  service.onPrompt(async (envelope, response) => {
    await bridgePromptToOpenCode({ envelope, response, mapping, client: input.client });
  });
  return service;
}
