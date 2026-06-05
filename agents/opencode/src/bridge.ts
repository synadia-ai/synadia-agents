import type { RequestEnvelope } from "@synadia-ai/agents";
import type { PromptResponse } from "@synadia-ai/agent-service";
import { rejectUnsupportedAttachments } from "./attachments.js";
import type { OpenCodeMapping } from "./types.js";
import { OpenCodeAdapterNotImplementedError } from "./types.js";

export interface OpenCodeBridgeClient {
  readonly mode: "managed" | "attached";
  prompt(prompt: OpenCodePromptRequest): AsyncIterable<OpenCodeBridgeEvent>;
  close?(): Promise<void>;
}

export interface OpenCodePromptRequest {
  readonly prompt: string;
  readonly sessionId?: string;
  readonly directory?: string;
  readonly workspace?: string;
  readonly model?: string;
  readonly agent?: string;
}

export type OpenCodeBridgeEvent =
  | { readonly type: "status"; readonly text: string }
  | { readonly type: "response"; readonly text: string }
  | { readonly type: "done" };

export interface BridgePromptInput {
  readonly envelope: RequestEnvelope;
  readonly response: PromptResponse;
  readonly mapping: OpenCodeMapping;
  readonly client: OpenCodeBridgeClient;
}

export async function bridgePromptToOpenCode(input: BridgePromptInput): Promise<void> {
  rejectUnsupportedAttachments(input.envelope);
  await input.response.send({ type: "status", status: `OpenCode ${input.mapping.opencode.mode} bridge selected` });
  const request: OpenCodePromptRequest = {
    prompt: input.envelope.prompt,
    ...optional("sessionId", input.mapping.opencode.sessionId),
    ...optional("directory", input.mapping.opencode.directory),
    ...optional("workspace", input.mapping.opencode.workspace),
    ...optional("model", input.mapping.opencode.model),
    ...optional("agent", input.mapping.opencode.agent),
  };
  for await (const event of input.client.prompt(request)) {
    if (event.type === "status") await input.response.send({ type: "status", status: event.text });
    if (event.type === "response") await input.response.send(event.text);
  }
}

function optional<K extends string>(key: K, value: string | undefined): Record<K, string> | Record<string, never> {
  return value ? { [key]: value } as Record<K, string> : {};
}

export function createPhase3UnimplementedClient(mode: "managed" | "attached"): OpenCodeBridgeClient {
  return {
    mode,
    async *prompt(): AsyncIterable<OpenCodeBridgeEvent> {
      throw new OpenCodeAdapterNotImplementedError(
        "OpenCode prompt execution is not implemented in this scaffold; wire the SDK client, SSE event stream, and permission handling before this service can be used.",
      );
    },
  };
}
