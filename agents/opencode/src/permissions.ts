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
