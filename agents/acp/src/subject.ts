const SUBJECT_TOKEN_RE = /^[a-z0-9_-]+$/;

/**
 * Best-effort sanitizer for derived defaults only. User/config-supplied
 * subject tokens are validated with requireSubjectToken instead of silently
 * rewriting onto a different route.
 */
export function sanitizeDerivedSubjectToken(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
}

export function requireSubjectToken(value: string, label: string): string {
  if (!value) throw new Error(`${label} must not be empty`);
  if (!SUBJECT_TOKEN_RE.test(value)) {
    throw new Error(`${label} must match ${SUBJECT_TOKEN_RE.source}`);
  }
  return value;
}

export function buildPromptSubject(subjectToken: string, owner: string, session: string): string {
  return `agents.prompt.${requireSubjectToken(subjectToken, "agent.subject_token")}.${requireSubjectToken(owner, "agent.owner")}.${requireSubjectToken(session, "agent.session")}`;
}

export function buildStatusSubject(subjectToken: string, owner: string, session: string): string {
  return `agents.status.${requireSubjectToken(subjectToken, "agent.subject_token")}.${requireSubjectToken(owner, "agent.owner")}.${requireSubjectToken(session, "agent.session")}`;
}

export function buildHeartbeatSubject(subjectToken: string, owner: string, session: string): string {
  return `agents.hb.${requireSubjectToken(subjectToken, "agent.subject_token")}.${requireSubjectToken(owner, "agent.owner")}.${requireSubjectToken(session, "agent.session")}`;
}
