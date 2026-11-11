// The agent's description: free text that says what the agent does. It is
// registered as the NATS micro service's `description`, and the agents that
// discover this one read it when they choose whom to ask. Pure helpers,
// kept free of any NATS/SDK imports so they can be unit-tested in isolation
// (see `test/description.test.ts`), as `subject.ts` is.

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

// What a surrogate that is not part of a pair becomes: the replacement
// character. A text cut inside an emoji holds one, and so can a value that
// was not valid UTF-8; a reader that cannot encode it fails on the whole
// description.
const REPLACEMENT = "\ufffd";

/** Whether `point`, one step of a loop over code points, is half of a surrogate pair. */
function isLoneSurrogate(point: string): boolean {
  if (point.length !== 1) return false;
  const unit = point.charCodeAt(0);
  return unit >= 0xd800 && unit <= 0xdfff;
}

/** A text as cleaned. */
interface Cleaned {
  /** The cleaned text, of at most `DESCRIPTION_LIMIT` code points. */
  readonly line: string;
  /** The cleaned text was longer than the limit, and `line` is its cut. */
  readonly over: boolean;
}

/**
 * Clean `text` in one pass over its code points: a lone surrogate the
 * replacement character, every space-like code point a space, runs of
 * spaces one, none at either end, and nothing past the limit.
 *
 * The line is built only as far as the limit, and its code points are
 * counted as they are appended: no copy of the whole text is made, and
 * nothing is counted in a second pass. The pass ends at the first code
 * point that does not fit, so a text of any size costs what its first
 * `DESCRIPTION_LIMIT` code points cost. The one exception: space-like code
 * points add nothing to the line, so a run of them is read to its end
 * however long it is. Reading it builds nothing.
 */
function clean(text: string): Cleaned {
  let line = "";
  // The code points in `line`.
  let count = 0;
  // A space is owed once a space-like code point followed a word; it is
  // written with the next word, so none leads and none trails.
  let gap = false;
  for (const unit of text) {
    // First, before anything else: the loop hands a lone surrogate over as
    // a single UTF-16 unit.
    const point = isLoneSurrogate(unit) ? REPLACEMENT : unit;
    if (!KEPT.has(point) && SPACE_LIKE.test(point)) {
      gap = count > 0;
      continue;
    }
    // This code point, and before it the space it is owed. When the two do
    // not fit, the text is longer than the limit and the line is its cut:
    // with room for the space alone, the space would end the line, and a
    // trailing space goes.
    const needed = gap ? 2 : 1;
    if (count + needed > DESCRIPTION_LIMIT) return { line, over: true };
    line += gap ? ` ${point}` : point;
    count += needed;
    gap = false;
  }
  return { line, over: false };
}

/**
 * Clean a description for registration. It never refuses:
 *
 * 1. a surrogate that is not part of a pair becomes U+FFFD; then every code
 *    point of the categories Cc, Cf, Zl, Zp or Zs becomes U+0020, except
 *    U+200C and U+200D, which stay;
 * 2. runs of U+0020 collapse to one, and leading and trailing ones go;
 * 3. a result longer than 500 code points is cut to its first 500, and a
 *    trailing U+0020 goes again.
 *
 * Printable characters are never changed. Length is counted in code points,
 * never in bytes or UTF-16 units. An empty result means no description.
 *
 * The three steps are one pass that stops at the limit (`clean`): the
 * result is the same, and the work does not grow with the text.
 */
export function cleanDescription(text: string): string {
  return clean(text).line;
}

export interface ResolvedDescription {
  /** The description to register, cleaned; `undefined` when none is set and the default text applies. */
  readonly text: string | undefined;
  /** One line for the log, when the description in use is not the text as it was written. */
  readonly warning?: string;
}

/**
 * Resolve the description from its precedence chain, then clean the winner.
 *
 * Sources are passed highest-precedence first; the function itself is
 * source-agnostic, as `resolveOwner` is. The chain of this plugin:
 *
 *   1. `SYNADIA_PI_DESCRIPTION`  — per-agent env variable
 *   2. `SYNADIA_DESCRIPTION`     — env variable read by the pi, Claude Code
 *                                  and OpenClaw plugins
 *   3. `config.description`      — field in `~/.pi/agent/nats-channel.json`
 *
 * Env beats the config file, as for the owner and the session name, and it
 * is first-present-wins-then-clean, not a per-source cascade: a source that
 * is set wins even when it cleans to nothing, and then no description is
 * set. So an empty variable switches a config file's description off.
 *
 * It never throws: a description never stops the channel from starting. A
 * winner that is not text is ignored, and a winner cleaning changed is used
 * as cleaned; each comes with a `warning` to log once.
 *
 * A text over the limit is not read to its end, so its warning says that
 * it was longer than the limit, not by how much. It says "cleaned" as well
 * when what is registered is not how the text began; what was past the cut
 * is not looked at.
 */
export function resolveDescription(
  ...sources: ReadonlyArray<unknown>
): ResolvedDescription {
  const winner = sources.find((s) => s != null);
  if (winner === undefined) return { text: undefined };
  if (typeof winner !== "string") {
    return {
      text: undefined,
      warning:
        "the description is not text; it is ignored and the default is registered",
    };
  }
  const { line, over } = clean(winner);
  if (line === "") return { text: undefined };
  if (over) {
    return {
      text: line,
      warning: winner.startsWith(line)
        ? `the description was shortened: it had more than ${DESCRIPTION_LIMIT} characters and at most its first ${DESCRIPTION_LIMIT} are registered`
        : `the description was cleaned and shortened: it had more than ${DESCRIPTION_LIMIT} characters after cleaning and at most its first ${DESCRIPTION_LIMIT} are registered`,
    };
  }
  if (line !== winner) {
    return {
      text: line,
      warning:
        "the description was cleaned: it is registered as one line of plain text, in which each run of line breaks, tabs, spaces of any kind, control characters and invisible format characters (Unicode Cc and Cf, but not the zero width joiner and non-joiner) became one plain space, none stays at either end, and any half of a surrogate pair became U+FFFD",
    };
  }
  return { text: line };
}

/** What `/nats-configure description …` asks for. */
export type DescriptionCommand =
  | { readonly action: "set"; readonly text: string; readonly warning?: string }
  | { readonly action: "clear" }
  | { readonly action: "usage" };

/**
 * Read `/nats-configure description <text|clear>`: `rest` is what follows
 * the word `description`, spaces and all. The text is kept cleaned, as it
 * will be registered; the word `clear` alone removes the setting; nothing,
 * or nothing but spaces, asks for the usage line.
 */
export function parseDescriptionCommand(rest: string): DescriptionCommand {
  const described = resolveDescription(rest.trim());
  if (described.text === undefined) return { action: "usage" };
  if (described.text === "clear") return { action: "clear" };
  return {
    action: "set",
    text: described.text,
    ...(described.warning ? { warning: described.warning } : {}),
  };
}
