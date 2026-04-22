// Pure: parse the JSON body of a NATS context file into an intermediate
// shape the shell layer can translate into connection options. Unknown
// fields are preserved verbatim so future `nats` CLI additions pass
// through unchanged.

/** Intermediate shape of a context-file JSON object. Unknown fields preserved. */
export interface ContextFile {
  readonly description?: string;
  readonly url?: string;
  readonly token?: string;
  readonly user?: string;
  readonly password?: string;
  readonly creds?: string;
  readonly nkey?: string;
  readonly cert?: string;
  readonly key?: string;
  readonly ca?: string;
  readonly user_jwt?: string;
  readonly nsc?: string;
  readonly inbox_prefix?: string;
  readonly [extra: string]: unknown;
}

/** Raise via `src/context.ts`'s NatsContextInvalidError wrapper. */
export class ContextParseError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ContextParseError";
  }
}

export function parseContextFile(json: string): ContextFile {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new ContextParseError(`context file is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ContextParseError("context file must be a JSON object");
  }
  return raw as ContextFile;
}

/**
 * Reject context names that would escape the context directory. The `nats`
 * CLI only ever produces plain names matching `^[a-zA-Z0-9._-]+$`; we
 * allow the same set plus tolerate slightly more leniency for forward
 * compat, but always reject separators and `..`.
 */
export function assertValidContextName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new ContextParseError("context name must be a non-empty string");
  }
  if (
    name.includes("/") ||
    name.includes("\\") ||
    name === ".." ||
    name.split(/[\\/]/).includes("..")
  ) {
    throw new ContextParseError(`context name "${name}" contains illegal characters`);
  }
  if (name.startsWith(".")) {
    throw new ContextParseError(`context name "${name}" must not start with '.'`);
  }
}

/** Split the context's `url` field into individual server URLs. */
export function splitUrls(url: string): string[] {
  return url
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
