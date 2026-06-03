import type { RequestEnvelope } from "@synadia-ai/agents";
import type { Chunk } from "@synadia-ai/agent-service";
import type { FlueMapping } from "./config.js";

export interface BridgeResponse {
  send(chunk: string | Chunk): Promise<void>;
}

export interface FlueBridgeClient {
  prompt(input: {
    readonly message: string;
    readonly baseUrl: string;
    readonly agent: string;
    readonly instance: string;
    readonly session: string;
    readonly transport: string;
  }): Promise<unknown>;
}

export interface BridgePromptOptions {
  readonly envelope: RequestEnvelope;
  readonly response: BridgeResponse;
  readonly mapping: FlueMapping;
  readonly flueClient: FlueBridgeClient;
}

export async function bridgePromptToFlue(options: BridgePromptOptions): Promise<void> {
  const { envelope, response, mapping, flueClient } = options;
  if (envelope.attachments && envelope.attachments.length > 0) {
    throw new Error("attachments are not supported by the Flue NATS channel v1");
  }

  const target = mapping.flue;
  await response.send({
    type: "status",
    status: `connected to Flue ${target.agent}/${target.instance} via ${target.transport}`,
  });

  const result = await flueClient.prompt({
    message: envelope.prompt,
    baseUrl: target.baseUrl,
    agent: target.agent,
    instance: target.instance,
    session: target.session,
    transport: target.transport,
  });

  await response.send({ type: "response", text: stringifyFlueResult(result) });
}

export function stringifyFlueResult(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  if (typeof result === "number" || typeof result === "boolean" || typeof result === "bigint") return String(result);
  try { return JSON.stringify(result); } catch { return String(result); }
}
