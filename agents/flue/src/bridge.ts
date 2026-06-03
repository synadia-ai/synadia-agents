import { ProtocolError, type RequestEnvelope } from "@synadia-ai/agents";
import type { Chunk } from "@synadia-ai/agent-service";
import type { FlueMapping } from "./config.js";

export interface BridgeResponse {
  send(chunk: string | Chunk): Promise<void>;
}

export interface FlueBridgeClient {
  prompt(
    input: {
      readonly message: string;
      readonly baseUrl: string;
      readonly agent: string;
      readonly instance: string;
      readonly session: string;
      readonly transport: string;
    },
    events?: {
      readonly onTextDelta?: (text: string) => Promise<void>;
    },
  ): Promise<unknown>;
}

export interface BridgePromptOptions {
  readonly envelope: RequestEnvelope;
  readonly response: BridgeResponse;
  readonly mapping: FlueMapping;
  readonly flueClient: FlueBridgeClient;
}

export async function bridgePromptToFlue(
  options: BridgePromptOptions,
): Promise<void> {
  const { envelope, response, mapping, flueClient } = options;
  if (envelope.attachments && envelope.attachments.length > 0) {
    throw new ProtocolError(
      "attachments are not supported by the Flue NATS channel v1",
    );
  }

  const target = mapping.flue;
  await response.send({
    type: "status",
    status: `connected to Flue ${target.agent}/${target.instance} via ${target.transport}`,
  });

  let streamed = false;
  const result = await flueClient.prompt(
    {
      message: envelope.prompt,
      baseUrl: target.baseUrl,
      agent: target.agent,
      instance: target.instance,
      session: target.session,
      transport: target.transport,
    },
    {
      onTextDelta: async (text) => {
        if (!text) return;
        streamed = true;
        await response.send({ type: "response", text });
      },
    },
  );

  const finalText = stringifyFlueResult(result);
  if (finalText) {
    await response.send({ type: "response", text: finalText });
  } else if (!streamed) {
    await response.send({ type: "response", text: "" });
  }
}

export function stringifyFlueResult(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  if (
    typeof result === "number" ||
    typeof result === "boolean" ||
    typeof result === "bigint"
  )
    return String(result);
  if (
    typeof result === "object" &&
    "text" in result &&
    typeof result.text === "string"
  )
    return result.text;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}
