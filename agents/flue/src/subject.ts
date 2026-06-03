// Pure subject-token helpers. Kept import-free for focused tests.

/**
 * Sanitize a subject token per protocol SHOULD rules: lowercase [a-z0-9_-],
 * replacing disallowed runs with a single dash and trimming edge dashes.
 */
export function sanitizeSubjectToken(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
}

/** Resolve owner precedence, then sanitize the selected value. */
export function resolveOwner(
  configOwner: string | undefined,
  envOwner: string | undefined,
  envUser: string | undefined,
): string {
  return sanitizeSubjectToken(configOwner ?? envOwner ?? envUser ?? "unknown") || "unknown";
}

export function requireSubjectToken(value: string, label: string): string {
  const token = sanitizeSubjectToken(value);
  if (!token) throw new Error(`${label} must contain at least one subject-safe character`);
  return token;
}
