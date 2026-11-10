// The agent's description: free text that says what the agent does. It is
// registered as the NATS micro service's `description`, and the agents that
// discover this one read it when they choose whom to ask. Pure helpers,
// free of OpenClaw and NATS imports, so they are unit-tested in isolation
// (see `description.test.ts`).

/** The most code points a description holds. */
export const DESCRIPTION_LIMIT = 500;

// One code point of the Unicode categories Cc, Cf, Zl, Zp or Zs: a control
// character, an invisible format character, a line or paragraph separator,
// or a space of any kind. Anchored, and tested against one code point at a
// time: a global match over a whole string misses characters on an engine
// that pairs UTF-16 units wrongly (Bun 1.3.14 leaves a U+FEFF that follows
// U+FB01 in place).
const SPACE_LIKE = /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]$/u;

// The two format characters that stay as they are: U+200C, the zero width
// non-joiner, and U+200D, the zero width joiner. Persian and the Indic
// scripts are spelled with them, and emoji sequences are joined by U+200D.
const KEPT = new Set(["\u200c", "\u200d"]);

/** One line: every space-like code point a space, runs of spaces one, none at either end. */
function toOneLine(text: string): string {
  let line = "";
  // A space is owed once a space-like code point followed a word; it is
  // written with the next word, so none leads and none trails.
  let gap = false;
  for (const point of text) {
    if (!KEPT.has(point) && SPACE_LIKE.test(point)) {
      gap = line !== "";
      continue;
    }
    if (gap) line += " ";
    gap = false;
    line += point;
  }
  return line;
}

/** The first `DESCRIPTION_LIMIT` code points of a line, without a trailing space. */
function cut(line: string): string {
  const points = Array.from(line);
  if (points.length <= DESCRIPTION_LIMIT) return line;
  const kept = points.slice(0, DESCRIPTION_LIMIT);
  if (kept[kept.length - 1] === " ") kept.pop();
  return kept.join("");
}

/**
 * Clean a description for registration. It never refuses:
 *
 * 1. every code point of the categories Cc, Cf, Zl, Zp or Zs becomes U+0020,
 *    except U+200C and U+200D, which stay;
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
        "the description was cleaned: it is registered as one line of plain text, with one space wherever it had line breaks, tabs, control characters or several spaces",
    };
  }
  return { text: line };
}
