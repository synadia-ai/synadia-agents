import type { RequestEnvelope } from "@synadia-ai/agents";
import type { PromptResponse } from "@synadia-ai/agent-service";
import { rejectUnsupportedAttachments } from "./attachments.js";
import type { AcpPermissionDecision } from "./permissions.js";
import type { AcpMapping, AcpPermissionPolicy } from "./types.js";

export interface AcpBridgeClient {
  readonly mode: "fake" | "managed";
  prompt(prompt: AcpPromptRequest): AsyncIterable<AcpBridgeEvent>;
  close?(): Promise<void>;
}

export interface AcpPromptRequest {
  readonly prompt: string;
  readonly publicSession: string;
  readonly permissionPolicy: AcpPermissionPolicy;
  readonly askPermission?: (prompt: string) => Promise<AcpPermissionDecision>;
}

export type AcpBridgeEvent =
  | { readonly type: "status"; readonly text: string }
  | { readonly type: "response"; readonly text: string }
  | { readonly type: "done" };

export interface BridgePromptInput {
  readonly envelope: RequestEnvelope;
  readonly response: PromptResponse;
  readonly mapping: AcpMapping;
  readonly client: AcpBridgeClient;
}

export async function bridgePromptToAcp(input: BridgePromptInput): Promise<void> {
  rejectUnsupportedAttachments(input.envelope);
  await input.response.send({ type: "status", status: `ACP ${input.client.mode} bridge selected (${input.mapping.acp.agentId})` });
  const request: AcpPromptRequest = {
    prompt: input.envelope.prompt,
    publicSession: input.mapping.session,
    permissionPolicy: input.mapping.acp.permissionPolicy,
    ...(input.mapping.acp.permissionPolicy === "query"
      ? { askPermission: (prompt: string) => askPermissionViaProtocol(input.response, prompt) }
      : {}),
  };
  for await (const event of input.client.prompt(request)) {
    if (event.type === "status") await input.response.send({ type: "status", status: event.text });
    if (event.type === "response") await input.response.send(event.text);
  }
}

async function askPermissionViaProtocol(response: PromptResponse, prompt: string): Promise<AcpPermissionDecision> {
  try {
    const reply = await response.ask(prompt, { timeoutMs: 30_000 });
    const normalized = reply.prompt.trim().toLowerCase();
    if (normalized === "approve" || normalized === "approved" || normalized === "yes" || normalized === "y") return "approve";
    if (normalized === "deny" || normalized === "decline" || normalized === "no" || normalized === "n") return "deny";
    return "cancel";
  } catch {
    return "cancel";
  }
}

export class FakeAcpBridgeClient implements AcpBridgeClient {
  readonly mode = "fake" as const;

  async *prompt(input: AcpPromptRequest): AsyncIterable<AcpBridgeEvent> {
    if (input.prompt.includes("explode")) throw new Error("fake ACP bridge exploded");
    yield { type: "status", text: `fake ACP session ${input.publicSession} ready` };
    yield { type: "response", text: `fake ACP response to ${input.prompt}` };
    yield { type: "done" };
  }
}
