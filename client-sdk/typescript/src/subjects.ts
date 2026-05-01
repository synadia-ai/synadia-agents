// Subject construction and validation per protocol §2.
//
// Wire layout (v0.3): `agents.{verb}.{agent}.{owner}.{name}` where `verb`
// is one of the protocol-reserved verbs `prompt` / `hb` (heartbeat,
// abbreviated for wire economy) / `status` (plus `attachments` reserved
// for the future §5.5 endpoint). The 5th token is the instance name.
//
// Token validation (assertValidToken / isRecommendedToken) is enforced
// only at MUST-rule level — anything NATS-safe is accepted. Callers that
// want stricter SHOULD-rule conformance use `isRecommendedToken`.
//
// `AgentSubject.new(...)` is the canonical entry point: validates the
// three identifying tokens and exposes `.prompt`, `.heartbeat`, `.status`
// getters that build the v0.3 verb-first subjects. Centralised so the
// verb-first wire shape lives in exactly one place across the SDK,
// agents, and examples.

const FORBIDDEN_CHARS = /[.*>\s\0]/;
const RECOMMENDED_CHARS = /^[a-z0-9_-]+$/;

export class InvalidSubjectTokenError extends Error {
  constructor(
    public readonly role: string,
    public readonly token: string,
    reason: string,
  ) {
    super(`invalid ${role} token "${token}": ${reason}`);
    this.name = "InvalidSubjectTokenError";
  }
}

/** Throws {@link InvalidSubjectTokenError} when the token violates MUST rules. */
export function assertValidToken(token: string, role: string): void {
  if (token.length === 0) {
    throw new InvalidSubjectTokenError(role, token, "must not be empty");
  }
  if (token.startsWith("$")) {
    throw new InvalidSubjectTokenError(role, token, "must not begin with '$'");
  }
  if (FORBIDDEN_CHARS.test(token)) {
    throw new InvalidSubjectTokenError(
      role,
      token,
      "must not contain whitespace, '.', '*', '>', or NUL",
    );
  }
}

/** @returns true iff the token is within the spec's SHOULD character set. */
export function isRecommendedToken(token: string): boolean {
  return token.length >= 1 && token.length <= 63 && RECOMMENDED_CHARS.test(token);
}

/** Subject root (§2). */
export const SUBJECT_ROOT = "agents";

// §2 (v0.3) reserved verbs. `prompt` / `hb` / `status` are wired up by
// this SDK; `attachments` is reserved for the future §5.5 endpoint. The
// heartbeat verb is the abbreviation `hb` on the wire (§8.1) — kept
// short because heartbeat traffic dominates per-account subject volume.
export const VERB_PROMPT = "prompt";
export const VERB_HEARTBEAT = "hb";
export const VERB_STATUS = "status";
export const VERB_ATTACHMENTS = "attachments";

export const RESERVED_VERBS: ReadonlySet<string> = new Set([
  VERB_PROMPT,
  VERB_HEARTBEAT,
  VERB_STATUS,
  VERB_ATTACHMENTS,
]);

/** Number of tokens in a v0.3 agent subject: `agents.{verb}.{agent}.{owner}.{name}`. */
const SUBJECT_TOKEN_COUNT = 5;

/**
 * Optional construction knobs for {@link AgentSubject.new}.
 */
export interface AgentSubjectOptions {
  /**
   * Override the wire token used in the subject's 3rd position. Defaults
   * to `agent` (i.e. `metadata.agent` and the subject token are the same).
   *
   * Allows callers to advertise a long, canonical name in `metadata.agent`
   * (e.g. `"claude-code"`, `"openclaw"`) while keeping the subject's 3rd
   * token short for wire-economy reasons (e.g. `"cc"`, `"oc"`). Both
   * tokens are validated against §2 MUST rules independently.
   */
  readonly subjectToken?: string;
}

/**
 * The three identifying tokens of an agent, validated against §2 MUST rules.
 *
 * Construct via {@link AgentSubject.new} — direct construction bypasses
 * validation and SHOULD NOT be used by callers.
 */
export class AgentSubject {
  private constructor(
    public readonly agent: string,
    public readonly owner: string,
    public readonly name: string,
    public readonly subjectToken: string,
  ) {}

  /**
   * Validate the identifying tokens and return an {@link AgentSubject}.
   *
   * `agent` carries the canonical agent identifier (the value that goes
   * into `$SRV.INFO` `metadata.agent`). `opts.subjectToken`, if given,
   * is the wire token used in the subject's 3rd position; when omitted,
   * the subject token equals `agent`.
   *
   * Throws {@link InvalidSubjectTokenError} when any token violates §2
   * MUST rules.
   */
  static new(
    agent: string,
    owner: string,
    name: string,
    opts: AgentSubjectOptions = {},
  ): AgentSubject {
    assertValidToken(agent, "agent");
    assertValidToken(owner, "owner");
    assertValidToken(name, "name");
    const subjectToken = opts.subjectToken ?? agent;
    if (subjectToken !== agent) {
      assertValidToken(subjectToken, "subjectToken");
    }
    return new AgentSubject(agent, owner, name, subjectToken);
  }

  /** The agent's prompt subject — `agents.prompt.{subjectToken}.{owner}.{name}` (§2 v0.3). */
  get prompt(): string {
    return `${SUBJECT_ROOT}.${VERB_PROMPT}.${this.subjectToken}.${this.owner}.${this.name}`;
  }

  /** The agent's heartbeat subject — `agents.hb.{subjectToken}.{owner}.{name}` (§8.1 v0.3). */
  get heartbeat(): string {
    return `${SUBJECT_ROOT}.${VERB_HEARTBEAT}.${this.subjectToken}.${this.owner}.${this.name}`;
  }

  /** The agent's status request/response subject — `agents.status.{subjectToken}.{owner}.{name}` (§8.7 (v0.3)). */
  get status(): string {
    return `${SUBJECT_ROOT}.${VERB_STATUS}.${this.subjectToken}.${this.owner}.${this.name}`;
  }
}

/** True iff `subject` matches `agents.hb.{agent}.{owner}.{name}` (§8.1 v0.3). */
export function isHeartbeatSubject(subject: string): boolean {
  const parts = subject.split(".");
  return (
    parts.length === SUBJECT_TOKEN_COUNT && parts[0] === SUBJECT_ROOT && parts[1] === VERB_HEARTBEAT
  );
}

export interface ParseAgentSubjectOptions {
  /** Verb to require in token 2. Defaults to `VERB_PROMPT`. */
  readonly verb?: string;
}

/**
 * Parse an `agents.{verb}.{agent}.{owner}.{name}` subject into an
 * {@link AgentSubject}.
 *
 * Returns `null` when the subject has the wrong root, is the wrong verb
 * (default `prompt`), or fails token validation. Pass a different `verb`
 * to parse heartbeat / status subjects through the same helper.
 *
 * **Note on the canonical agent identifier.** The 3rd subject token is
 * the *wire token* — for harnesses that set `subjectToken` to an
 * abbreviation (e.g. `"cc"` for `claude-code`, `"oc"` for `openclaw`),
 * `AgentSubject.agent` returned here is the abbreviation, **not** the
 * canonical `metadata.agent` value. The canonical name only lives in
 * `$SRV.INFO.metadata.agent`; callers that need it should use
 * `Agents.lookupInstance(instanceId)` (or `Agents.discover()`) and read
 * `AgentInfo.agent`. Filtering on `subject.agent` matches the wire token,
 * filtering on `AgentInfo.agent` matches the canonical identifier.
 */
export function parseAgentSubject(
  subject: string,
  opts: ParseAgentSubjectOptions = {},
): AgentSubject | null {
  const verb = opts.verb ?? VERB_PROMPT;
  const parts = subject.split(".");
  if (parts.length !== SUBJECT_TOKEN_COUNT || parts[0] !== SUBJECT_ROOT || parts[1] !== verb) {
    return null;
  }
  const [, , agent, owner, name] = parts;
  if (agent === undefined || owner === undefined || name === undefined) return null;
  try {
    return AgentSubject.new(agent, owner, name);
  } catch {
    return null;
  }
}
