// Subject builders + session-id sanitizer for pi-headless.
//
// The protocol subjects (`agents.{verb}.pi.<owner>.<token>`) are built via
// the SDK's `AgentSubject` so the wire layout has one source of truth across
// the SDK, agent harnesses, and examples. The `pi` subject token equals
// `metadata.agent` here (Appendix C: `pi` is both the canonical id and the
// conventional abbreviation), so `AgentSubject.new(...)` without a
// `subjectToken` override produces the right wire shape.
//
// Custom endpoints (spawn / stop / list) stay on a non-verb-first form so
// they're clearly application extensions, not protocol endpoints.

import { AgentSubject } from "@synadia-ai/agents";

export const AGENT_TOKEN = "pi";

function controllerSubject(owner: string, name: string): AgentSubject {
  return AgentSubject.new(AGENT_TOKEN, owner, name);
}

export function controllerPromptSubject(owner: string, name: string): string {
  return controllerSubject(owner, name).prompt;
}

export function controllerHeartbeatSubject(owner: string, name: string): string {
  return controllerSubject(owner, name).heartbeat;
}

export function controllerStatusSubject(owner: string, name: string): string {
  return controllerSubject(owner, name).status;
}

/** Custom endpoints — application-specific, NOT part of the v0.3 verb-first scheme. */
const customSubjectRoot = (owner: string, name: string): string =>
  `agents.${AGENT_TOKEN}.${owner}.${name}`;

export function controllerSpawnSubject(owner: string, name: string): string {
  return `${customSubjectRoot(owner, name)}.spawn`;
}

export function controllerStopSubject(owner: string, name: string): string {
  return `${customSubjectRoot(owner, name)}.stop`;
}

export function controllerListSubject(owner: string, name: string): string {
  return `${customSubjectRoot(owner, name)}.list`;
}

function sessionSubject(owner: string, sessionId: string): AgentSubject {
  return AgentSubject.new(AGENT_TOKEN, owner, sessionId);
}

export function sessionPromptSubject(owner: string, sessionId: string): string {
  return sessionSubject(owner, sessionId).prompt;
}

export function sessionHeartbeatSubject(owner: string, sessionId: string): string {
  return sessionSubject(owner, sessionId).heartbeat;
}

export function sessionStatusSubject(owner: string, sessionId: string): string {
  return sessionSubject(owner, sessionId).status;
}

// Tokens MUST follow §2.2: [a-z0-9_-], not starting with $, 1..63 chars.
// We lowercase, replace everything else with `-`, collapse repeats, and trim
// leading/trailing `-`. Empty input returns "" (caller decides what to do).
const TOKEN_ALLOW_RE = /[^a-z0-9_-]+/g;
const COLLAPSE_DASH_RE = /-{2,}/g;
const TRIM_DASH_RE = /^-+|-+$/g;

export function sanitizeToken(input: string): string {
  const s = input
    .toLowerCase()
    .replace(TOKEN_ALLOW_RE, "-")
    .replace(COLLAPSE_DASH_RE, "-")
    .replace(TRIM_DASH_RE, "");
  return s.slice(0, 63);
}

/**
 * Validate a user-supplied session_id against §2.2 rules. Returns the
 * sanitized form if it survives sanitization unchanged; otherwise returns
 * null along with a suggestion.
 */
export function validateSessionId(
  input: string,
): { ok: true; sessionId: string } | { ok: false; suggestion: string } {
  const s = sanitizeToken(input);
  if (s.length === 0) return { ok: false, suggestion: "" };
  if (s !== input) return { ok: false, suggestion: s };
  return { ok: true, sessionId: s };
}

/** Generate a short session id prefixed with `sess-`. URL-safe, 8 hex chars. */
export function generateSessionId(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  const rand = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `sess-${rand}`;
}
