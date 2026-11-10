// The agent's description: free text that says what the agent does. It is
// registered as the NATS micro service's `description`, and the agents that
// discover this one read it when they choose whom to ask. Pure helpers,
// free of OpenClaw and NATS imports, so they are unit-tested in isolation
// (see `description.test.ts`).

/** The most code points a description holds. */
export const DESCRIPTION_LIMIT = 500;

// Every code point of the Unicode categories Cc, Cf, Zl, Zp and Zs: control
// characters, invisible format characters, line and paragraph separators,
// and spaces of every kind.
const SPACE_LIKE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]/gu;

/** One line: every space-like code point a space, runs of spaces one, none at either end. */
function toOneLine(text: string): string {
  return text
    .replace(SPACE_LIKE, " ")
    .replace(/ {2,}/g, " ")
    .replace(/^ | $/g, "");
}

/** The first `DESCRIPTION_LIMIT` code points of a line, without a trailing space. */
function cut(line: string): string {
  const points = Array.from(line);
  if (points.length <= DESCRIPTION_LIMIT) return line;
  return points.slice(0, DESCRIPTION_LIMIT).join("").replace(/ $/, "");
}

/**
 * Clean a description for registration. It never refuses:
 *
 * 1. every code point of the categories Cc, Cf, Zl, Zp or Zs becomes U+0020;
 * 2. runs of U+0020 collapse to one, and leading and trailing ones go;
 * 3. a result longer than 500 code points is cut to its first 500, and a
 *    trailing U+0020 goes again.
 *
 * Printable characters are never changed. Length is counted in code points,
 * never in bytes or UTF-16 units. An empty result means no description.
 */
export function cleanDescription(text: string): string {
  return cut(toOneLine(text));
}

export interface ResolvedDescription {
  /** The description to register, cleaned; `undefined` when none is set and the default text applies. */
  readonly text: string | undefined;
  /** One line for the log, when the description in use is not the text as it was written. */
  readonly warning?: string;
}

/**
 * Clean the description an account resolved to (`accounts.ts`: the
 * `SYNADIA_OPENCLAW_DESCRIPTION`, `SYNADIA_DESCRIPTION` and
 * `NATS_DESCRIPTION` variables, then the account's `description`), for the
 * gateway to register.
 *
 * Sources are passed highest-precedence first, and the first one that is
 * set wins even when it cleans to nothing: then no description is set. It
 * never throws: a description never stops the gateway from starting. A
 * winner that is not text is ignored, and a winner cleaning changed is used
 * as cleaned; each comes with a `warning` to log once.
 */
export function resolveDescription(
  ...sources: ReadonlyArray<unknown>
): ResolvedDescription {
  const winner = sources.find((source) => source != null);
  if (winner === undefined) return { text: undefined };
  if (typeof winner !== "string") {
    return {
      text: undefined,
      warning:
        "the description is not text; it is ignored and the default is registered",
    };
  }
  const line = toOneLine(winner);
  if (line === "") return { text: undefined };
  const length = Array.from(line).length;
  const cleaned = line !== winner;
  if (length > DESCRIPTION_LIMIT) {
    return {
      text: cut(line),
      warning: cleaned
        ? `the description was cleaned and shortened: it had ${length} characters after cleaning and its first ${DESCRIPTION_LIMIT} are registered`
        : `the description was shortened: it had ${length} characters and its first ${DESCRIPTION_LIMIT} are registered`,
    };
  }
  if (cleaned) {
    return {
      text: line,
      warning:
        "the description was cleaned: it is registered as one line, with single spaces and without control or invisible characters",
    };
  }
  return { text: line };
}
