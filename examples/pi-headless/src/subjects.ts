// Subject builders + session-id sanitizer for pi-headless.
//
// Wire layout (v0.3 — verb-first per spec §2):
//   agents.prompt.pi.<owner>.<name>     → controller's prompt endpoint
//   agents.hb.pi.<owner>.<name>         → controller heartbeat
//   agents.status.pi.<owner>.<name>     → controller status (§8.7 (v0.3))
//   agents.prompt.pi.<owner>.<session>  → spawned session's prompt endpoint
//   agents.hb.pi.<owner>.<session>      → spawned session heartbeat
//   agents.status.pi.<owner>.<session>  → spawned session status
//
// Custom endpoints stay on a non-verb-first form so they're clearly
// application extensions (not protocol endpoints):
//   agents.pi.<owner>.<name>.spawn      → POST JSON → session descriptor
//   agents.pi.<owner>.<name>.stop       → POST {session_id} → ok
//   agents.pi.<owner>.<name>.list       → (empty) → {sessions:[...]}

export const AGENT_TOKEN = "pi";

export function controllerPromptSubject(owner: string, name: string): string {
  return `agents.prompt.${AGENT_TOKEN}.${owner}.${name}`;
}

export function controllerHeartbeatSubject(owner: string, name: string): string {
  return `agents.hb.${AGENT_TOKEN}.${owner}.${name}`;
}

export function controllerStatusSubject(owner: string, name: string): string {
  return `agents.status.${AGENT_TOKEN}.${owner}.${name}`;
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

export function sessionPromptSubject(owner: string, sessionId: string): string {
  return `agents.prompt.${AGENT_TOKEN}.${owner}.${sessionId}`;
}

export function sessionHeartbeatSubject(owner: string, sessionId: string): string {
  return `agents.hb.${AGENT_TOKEN}.${owner}.${sessionId}`;
}

export function sessionStatusSubject(owner: string, sessionId: string): string {
  return `agents.status.${AGENT_TOKEN}.${owner}.${sessionId}`;
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
  // crypto.getRandomValues is uniformly distributed and available in Bun and
  // Node ≥ 19 without an import. Math.random would give the same nominal 32
  // bits but with a biased distribution, so use the Web Crypto API instead.
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  const rand = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `sess-${rand}`;
}
