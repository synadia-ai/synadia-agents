// Subject builders + session-id sanitizer for claude-code-headless.
//
// The controller lives at `agents.cc.<owner>.<name>` with three extra
// endpoints on `.spawn`, `.stop`, `.list`. Each spawned session lives at
// its own subject `agents.cc.<owner>.<session_id>` (registered by a
// `ReferenceAgent` from the SDK's testing subpath), which means callers
// can discover and prompt sessions using nothing but the standard
// protocol.
//
// The `cc` token is shared with `agents/claude-code/` (Claude Code as
// MCP-driven NATS client). They co-exist because the controller name
// and per-session ids disambiguate the 4th subject token.

export const AGENT_TOKEN = "cc";

export function controllerPromptSubject(owner: string, name: string): string {
  return `agents.${AGENT_TOKEN}.${owner}.${name}`;
}

export function controllerSpawnSubject(owner: string, name: string): string {
  return `${controllerPromptSubject(owner, name)}.spawn`;
}

export function controllerStopSubject(owner: string, name: string): string {
  return `${controllerPromptSubject(owner, name)}.stop`;
}

export function controllerListSubject(owner: string, name: string): string {
  return `${controllerPromptSubject(owner, name)}.list`;
}

export function controllerHeartbeatSubject(owner: string, name: string): string {
  return `${controllerPromptSubject(owner, name)}.heartbeat`;
}

export function sessionPromptSubject(owner: string, sessionId: string): string {
  return `agents.${AGENT_TOKEN}.${owner}.${sessionId}`;
}

export function sessionHeartbeatSubject(owner: string, sessionId: string): string {
  return `${sessionPromptSubject(owner, sessionId)}.heartbeat`;
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
  const rand = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
  return `sess-${rand}`;
}
