// Subject builders + session-id sanitizer for pi-headless.
//
// Wire layout (verb-first throughout):
//
//   agents.prompt.pi-headless.<owner>.<name>     → controller's prompt endpoint
//   agents.hb.pi-headless.<owner>.<name>         → controller heartbeat
//   agents.status.pi-headless.<owner>.<name>     → controller status
//   agents.spawn.pi-headless.<owner>.<name>      → controller spawn endpoint
//   agents.stop.pi-headless.<owner>.<name>       → controller stop endpoint
//   agents.list.pi-headless.<owner>.<name>       → controller list endpoint
//   agents.prompt.pi-headless.<owner>.<session>  → spawned session prompt
//   agents.hb.pi-headless.<owner>.<session>      → spawned session heartbeat
//   agents.status.pi-headless.<owner>.<session>  → spawned session status
//
// `pi-headless` distinguishes this controller (and its spawned sessions) from
// the regular `pi` agent at `agents/pi/`. The wire layout is verb-first for
// every endpoint — the protocol-mandated verbs (`prompt`, `hb`, `status`)
// share the same `agents.<verb>.<agent>.<owner>.<name>` shape as the
// extension verbs (`spawn`, `stop`, `list`), so any tracer or audit layer
// can subscribe to `agents.<verb>.>` and parse identity positionally.

import type { NatsConnection } from "@nats-io/nats-core";
import { Svcm } from "@nats-io/services";
import { SERVICE_NAME } from "@synadia-ai/agents";

export const AGENT_TOKEN = "pi-headless";

function subject(verb: string, owner: string, name: string): string {
  return `agents.${verb}.${AGENT_TOKEN}.${owner}.${name}`;
}

export function controllerPromptSubject(owner: string, name: string): string {
  return subject("prompt", owner, name);
}

export function controllerHeartbeatSubject(owner: string, name: string): string {
  return subject("hb", owner, name);
}

export function controllerStatusSubject(owner: string, name: string): string {
  return subject("status", owner, name);
}

export function controllerSpawnSubject(owner: string, name: string): string {
  return subject("spawn", owner, name);
}

export function controllerStopSubject(owner: string, name: string): string {
  return subject("stop", owner, name);
}

export function controllerListSubject(owner: string, name: string): string {
  return subject("list", owner, name);
}

export function sessionPromptSubject(owner: string, sessionId: string): string {
  return subject("prompt", owner, sessionId);
}

export function sessionHeartbeatSubject(owner: string, sessionId: string): string {
  return subject("hb", owner, sessionId);
}

export function sessionStatusSubject(owner: string, sessionId: string): string {
  return subject("status", owner, sessionId);
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

/**
 * Probe `$SRV.INFO.agents` and pick the first controller name whose prompt
 * subject is unclaimed. Auto-suffixes `-2`, `-3`, … until a free slot is
 * found, so two pi-headless processes booted with the default `control`
 * land on `control` and `control-2` respectively. The probe is best-effort
 * (a small race window remains between discovery and svcm.add) — the
 * trade-off is acceptable for a developer convenience.
 */
export async function resolveControllerName(
  nc: NatsConnection,
  base: string,
  owner: string,
): Promise<string> {
  const svcm = new Svcm(nc);
  const client = svcm.client({ strategy: "stall", maxWait: 1000, maxMessages: 50 });

  const taken = new Set<string>();
  try {
    const iter = await client.info(SERVICE_NAME);
    for await (const si of iter) {
      for (const ep of si.endpoints ?? []) {
        taken.add(ep.subject);
      }
    }
  } catch {
    // No existing services or timeout — fine.
  }

  let candidate = base;
  let suffix = 2;
  while (taken.has(controllerPromptSubject(owner, candidate))) {
    candidate = `${base}-${suffix++}`;
  }
  return candidate;
}
