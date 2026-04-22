// NATS subject-token validation per spec §2.2.
//
// Normative rules (MUST):
//   - Token MUST NOT begin with `$`.
//   - Token MUST conform to NATS subject naming rules — no whitespace,
//     `.`, `*`, `>`, or NUL.
//
// Recommended rules (SHOULD) — exposed via {@link isRecommendedToken}:
//   - Characters restricted to [a-z0-9_-].
//   - Length 1–63.

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
