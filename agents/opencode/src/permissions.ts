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
  if (["no", "n", "deny", "reject", "false"].includes(normalized)) return { reply: "reject", message: "Rejected by protocol query reply" };
  return { reply: "once" };
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
  const metadata = permission.metadata && Object.keys(permission.metadata).length > 0
    ? JSON.stringify(permission.metadata)
    : undefined;
  return formatPermissionQuestion({
    ...(permission.type ? { tool: permission.type } : {}),
    ...(permission.title ? { action: permission.title } : {}),
    ...(metadata ? { description: metadata } : {}),
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
  const sessionID = readString(payload, "sessionID") ?? readString(payload, "sessionId") ?? readString(payload, "session_id");
  const type = readString(payload, "type");
  const title = readString(payload, "title");
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
