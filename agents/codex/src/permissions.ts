import type { JsonValue, ServerRequestHandlerInput } from "./codex-jsonrpc.js";
import { defaultServerRequestResponse } from "./codex-jsonrpc.js";
import { redactPrivateText } from "./redaction.js";

export interface CodexPermissionRequest {
  readonly kind: "command" | "file-change" | "permissions" | "tool-input" | "mcp-elicitation" | "unknown";
  readonly prompt: string;
  readonly params?: JsonValue;
  respond(decision: "approve" | "deny" | "cancel"): void;
}

export type PermissionRequestSink = (request: CodexPermissionRequest) => Promise<"approve" | "deny" | "cancel"> | "approve" | "deny" | "cancel";

export function permissionKind(method: string): CodexPermissionRequest["kind"] {
  if (method === "item/commandExecution/requestApproval") return "command";
  if (method === "item/fileChange/requestApproval") return "file-change";
  if (method === "item/permissions/requestApproval") return "permissions";
  if (method === "item/tool/requestUserInput") return "tool-input";
  if (method === "mcpServer/elicitation/request") return "mcp-elicitation";
  return "unknown";
}

export function permissionPrompt(input: ServerRequestHandlerInput): string {
  const kind = permissionKind(input.method);
  const compact = JSON.stringify(input.params ?? {});
  const redacted = redactPrivateText(compact).slice(0, 1200);
  return `Codex requests ${kind} approval. Reply approve to allow once; anything else denies. Details: ${redacted}`;
}

export async function resolvePermissionRequest(
  input: ServerRequestHandlerInput,
  opts: { readonly sink?: PermissionRequestSink; readonly timeoutMs?: number } = {},
): Promise<JsonValue> {
  if (!isApprovalMethod(input.method)) return defaultServerRequestResponse(input.method);
  const decision = opts.sink ? await withTimeout(opts.sink(makeRequest(input)), opts.timeoutMs ?? 30_000) : "cancel";
  return responseFor(input.method, decision);
}

function isApprovalMethod(method: string): boolean {
  return method === "item/commandExecution/requestApproval"
    || method === "item/fileChange/requestApproval"
    || method === "item/permissions/requestApproval"
    || method === "item/tool/requestUserInput"
    || method === "mcpServer/elicitation/request";
}

function makeRequest(input: ServerRequestHandlerInput): CodexPermissionRequest {
  let settled = false;
  let selected: "approve" | "deny" | "cancel" = "cancel";
  return {
    kind: permissionKind(input.method),
    prompt: permissionPrompt(input),
    params: input.params,
    respond(decision) {
      settled = true;
      selected = decision;
    },
    get decision() { return settled ? selected : "cancel"; },
  } as CodexPermissionRequest;
}

async function withTimeout(value: Promise<"approve" | "deny" | "cancel"> | "approve" | "deny" | "cancel", timeoutMs: number): Promise<"approve" | "deny" | "cancel"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timed = new Promise<"cancel">((resolve) => { timer = setTimeout(() => resolve("cancel"), timeoutMs); });
    return await Promise.race([Promise.resolve(value), timed]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function responseFor(method: string, decision: "approve" | "deny" | "cancel"): JsonValue {
  const responseDecision = decision === "approve" ? "accept" : decision === "deny" ? "decline" : "cancel";
  if (method === "item/commandExecution/requestApproval") return { decision: responseDecision };
  if (method === "item/fileChange/requestApproval") return { decision: responseDecision };
  if (method === "item/permissions/requestApproval") {
    return decision === "approve"
      ? { permissions: {}, scope: "turn", strictAutoReview: true }
      : null;
  }
  if (method === "item/tool/requestUserInput") return { answer: { type: "cancel" } };
  if (method === "mcpServer/elicitation/request") return { action: "cancel" };
  return null;
}
