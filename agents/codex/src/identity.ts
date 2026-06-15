import { createHash, createHmac } from "node:crypto";
import { requireSubjectToken, sanitizeDerivedSubjectToken } from "./subject.js";

export interface CodexSessionIdentityInput {
  readonly endpoint: string;
  readonly rawThreadId: string;
  readonly explicitAlias?: string;
  readonly salt?: string;
}

export function endpointFingerprint(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex").slice(0, 16);
}

export function privateSessionKey(endpoint: string, rawThreadId: string): string {
  return `${endpointFingerprint(endpoint)}\0${rawThreadId}`;
}

export function derivePublicSessionAlias(input: CodexSessionIdentityInput): string {
  if (input.explicitAlias) return requireSubjectToken(input.explicitAlias, "manager.session_alias");
  const material = `${endpointFingerprint(input.endpoint)}\0${input.rawThreadId}`;
  const salt = input.salt ?? "synadia-codex-agent";
  const digest = createHmac("sha256", salt).update(material).digest("hex").slice(0, 12);
  return requireSubjectToken(sanitizeDerivedSubjectToken(`session-${digest}`), "manager.derived_session_alias");
}

export function normalizeRawThreadId(thread: Record<string, unknown>): string | undefined {
  const id = thread.id ?? thread.threadId ?? thread.sessionId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}
