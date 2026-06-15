import type { RequestEnvelope } from "@synadia-ai/agents";
import type { PromptResponse } from "@synadia-ai/agent-service";
import { rejectUnsupportedAttachments } from "./attachments.js";
import type { CodexMapping } from "./types.js";

export interface CodexBridgeClient {
  readonly mode: "fake" | "managed" | "attached" | "manager";
  prompt(prompt: CodexPromptRequest): AsyncIterable<CodexBridgeEvent>;
  close?(): Promise<void>;
}

export interface CodexPromptRequest {
  readonly prompt: string;
  readonly publicSession: string;
  readonly permissionPolicy: string;
}

export type CodexBridgeEvent =
  | { readonly type: "status"; readonly text: string }
  | { readonly type: "response"; readonly text: string }
  | { readonly type: "done" };

export interface BridgePromptInput {
  readonly envelope: RequestEnvelope;
  readonly response: PromptResponse;
  readonly mapping: CodexMapping;
  readonly client: CodexBridgeClient;
}

export async function bridgePromptToCodex(input: BridgePromptInput): Promise<void> {
  rejectUnsupportedAttachments(input.envelope);
  await input.response.send({ type: "status", status: `Codex ${input.client.mode} bridge selected` });
  const request: CodexPromptRequest = {
    prompt: input.envelope.prompt,
    publicSession: input.mapping.session,
    permissionPolicy: input.mapping.codex.permissionPolicy,
  };
  for await (const event of input.client.prompt(request)) {
    if (event.type === "status") await input.response.send({ type: "status", status: event.text });
    if (event.type === "response") await input.response.send(event.text);
  }
}

export class FakeCodexBridgeClient implements CodexBridgeClient {
  readonly mode = "fake" as const;

  async *prompt(input: CodexPromptRequest): AsyncIterable<CodexBridgeEvent> {
    if (input.prompt.includes("explode")) throw new Error("fake Codex bridge exploded");
    yield { type: "status", text: `fake Codex session ${input.publicSession} ready` };
    yield { type: "response", text: `fake Codex response to ${input.prompt}` };
    yield { type: "done" };
  }
}
