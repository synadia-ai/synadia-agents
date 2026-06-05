import type { PermissionPolicy } from "./types.js";

export type OpenCodePermissionReply = "once" | "always" | "reject";

export interface PermissionDecision {
  readonly reply: OpenCodePermissionReply;
  readonly message?: string;
}

export function policyDecision(policy: PermissionPolicy): PermissionDecision | null {
  if (policy === "reject") return { reply: "reject", message: "Rejected by OpenCode NATS adapter permission_policy=reject" };
  return null;
}

export function mapQueryReplyToPermissionDecision(reply: string | undefined): PermissionDecision {
  const normalized = (reply ?? "").trim().toLowerCase();
  if (["always", "allow always", "yes always"].includes(normalized)) return { reply: "always" };
  if (["yes", "y", "once", "allow", "true"].includes(normalized)) return { reply: "once" };
  if (["no", "n", "deny", "reject", "false"].includes(normalized)) return { reply: "reject", message: "Rejected by protocol query reply" };
  return { reply: "reject", message: normalized ? "Rejected by ambiguous protocol query reply" : "Rejected by empty protocol query reply" };
}

export function formatPermissionQuestion(input: { readonly tool?: string; readonly action?: string; readonly description?: string }): string {
  const tool = input.tool ? ` for ${input.tool}` : "";
  const action = input.action ? ` (${input.action})` : "";
  const description = input.description ? `\n\n${input.description}` : "";
  return `OpenCode requests permission${tool}${action}. Reply yes/once, always, or no.${description}`;
}

export function permissionQuestionFromEvent(event: unknown): string {
  const permission = readPermission(event);
  if (!permission) return formatPermissionQuestion({ description: "OpenCode emitted a permission request without details." });
  const details: string[] = [];
  if (permission.id) details.push(`OpenCode permission id: ${permission.id}`);
  if (permission.sessionID) details.push(`OpenCode session id: ${permission.sessionID}`);
  if (permission.metadata && Object.keys(permission.metadata).length > 0) details.push(`Details: ${JSON.stringify(permission.metadata)}`);
  return formatPermissionQuestion({
    ...(permission.type ? { tool: permission.type } : {}),
    ...(permission.title ? { action: permission.title } : {}),
    ...(details.length > 0 ? { description: details.join("\n") } : {}),
  });
}

export function permissionIdsFromEvent(event: unknown): { sessionId: string; permissionId: string } | undefined {
  const permission = readPermission(event);
  if (!permission?.sessionID || !permission.id) return undefined;
  return { sessionId: permission.sessionID, permissionId: permission.id };
}

function readPermission(event: unknown): { id?: string; sessionID?: string; type?: string; title?: string; metadata?: Record<string, unknown> } | undefined {
  if (!isRecord(event)) return undefined;
  const payload = isRecord(event.properties) ? event.properties : isRecord(event.data) ? event.data : event;
  const metadata = isRecord(payload.metadata) ? payload.metadata : undefined;
  const id = readString(payload, "id") ?? readString(payload, "permissionID") ?? readString(payload, "permissionId");
  // OpenCode SDK/events have used both camelCase and session_id spellings in
  // nearby surfaces; accept the config/event alias but keep docs on
  // opencode_session_id for clarity.
  const sessionID = readString(payload, "sessionID") ?? readString(payload, "sessionId") ?? readString(payload, "session_id");
  const type = readString(payload, "type") ?? readString(payload, "permission");
  const title = readString(payload, "title") ?? (metadata ? readString(metadata, "description") : undefined);
  return {
    ...(id ? { id } : {}),
    ...(sessionID ? { sessionID } : {}),
    ...(type ? { type } : {}),
    ...(title ? { title } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
