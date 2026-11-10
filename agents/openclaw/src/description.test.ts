// The agent's description (description.ts): the cleaning rule against its
// vectors, and what the gateway registers from the text an account
// resolved to. Pure: no OpenClaw install is needed.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  DESCRIPTION_LIMIT,
  cleanDescription,
  resolveDescription,
} from "./description.js";

interface CleanVector {
  name: string;
  in: string;
  out: string;
}
const vectors = JSON.parse(
  readFileSync(
    new URL("../test/fixtures/description-clean-vectors.json", import.meta.url),
    "utf8",
  ),
) as { limit: number; clean: CleanVector[] };

const codePoints = (text: string): number => Array.from(text).length;

describe("cleanDescription", () => {
  it("the limit is the vectors' limit", () => {
    expect(DESCRIPTION_LIMIT).toBe(vectors.limit);
    expect(vectors.clean.length).toBeGreaterThan(0);
  });

  it.each(vectors.clean)("vector: $name", (vector) => {
    expect(cleanDescription(vector.in)).toBe(vector.out);
  });

  it("cleaning a cleaned description changes nothing", () => {
    for (const vector of vectors.clean) {
      expect(cleanDescription(vector.out)).toBe(vector.out);
    }
  });

  it("length is counted in code points, and a cut never splits one", () => {
    const astral = "\u{1F44D}";
    const cleaned = cleanDescription(astral.repeat(DESCRIPTION_LIMIT + 5));
    expect(codePoints(cleaned)).toBe(DESCRIPTION_LIMIT);
    expect(cleaned).toBe(astral.repeat(DESCRIPTION_LIMIT));
  });

  it("one code point at a time: no space-like character hides behind the one before it", () => {
    // A global match over the whole string missed these on Bun 1.3.14,
    // whose engine paired a UTF-16 unit in U+F800..U+FBFF with the one
    // after it: a U+FEFF after the ligature U+FB01 stayed in place. Node,
    // which runs this suite, was right either way; the rule is the same.
    expect(cleanDescription("of\ufb01\ufeffce")).toBe("of\ufb01 ce");
    expect(cleanDescription("a\uf900\ufff9b")).toBe("a\uf900 b");
    const missed: string[] = [];
    for (let lead = 0xf800; lead <= 0xfbff; lead++) {
      const before = String.fromCharCode(lead);
      for (const hidden of ["\ufeff", "\ufff9", "\ufffa", "\ufffb"]) {
        if (cleanDescription(`a${before}${hidden}b`) !== `a${before} b`) {
          missed.push(`U+${lead.toString(16)} U+${hidden.charCodeAt(0).toString(16)}`);
        }
      }
    }
    expect(missed).toEqual([]);
  });
});

describe("resolveDescription", () => {
  it("the first source that is set wins", () => {
    expect(resolveDescription("first", "second")).toEqual({ text: "first" });
    expect(resolveDescription(undefined, "second")).toEqual({ text: "second" });
    expect(resolveDescription(null, undefined, "third")).toEqual({ text: "third" });
  });

  it("nothing set, or an empty text, means no description: the default text applies", () => {
    expect(resolveDescription()).toEqual({ text: undefined });
    expect(resolveDescription(undefined)).toEqual({ text: undefined });
    expect(resolveDescription("")).toEqual({ text: undefined });
    expect(resolveDescription("   ")).toEqual({ text: undefined });
    expect(resolveDescription("\u0000\u0007")).toEqual({ text: undefined });
  });

  it("a source that is set wins even when empty", () => {
    expect(resolveDescription("", "second")).toEqual({ text: undefined });
  });

  it("a description as written is used without a warning", () => {
    const text =
      "Keeps the logs of the orders server. Ask it what happened in a time range.";
    expect(resolveDescription(text)).toEqual({ text });
    expect(resolveDescription("a".repeat(DESCRIPTION_LIMIT))).toEqual({
      text: "a".repeat(DESCRIPTION_LIMIT),
    });
  });

  it("a description cleaning changed is used as cleaned, with one warning", () => {
    expect(resolveDescription("line one\nline  two\t")).toEqual({
      text: "line one line two",
      warning:
        "the description was cleaned: it is registered as one line, with single spaces and without control or invisible characters",
    });
  });

  it("a description over the limit is cut to it, and the warning names both lengths", () => {
    expect(resolveDescription("a".repeat(DESCRIPTION_LIMIT + 112))).toEqual({
      text: "a".repeat(DESCRIPTION_LIMIT),
      warning:
        "the description was shortened: it had 612 characters and its first 500 are registered",
    });
  });

  it("cleaned and shortened is still one warning, with the length after cleaning", () => {
    const resolved = resolveDescription(`${"abcd ".repeat(120)}\n`);
    expect(resolved.text).toBe(cleanDescription("abcd ".repeat(120)));
    expect(codePoints(resolved.text ?? "")).toBe(499);
    expect(resolved.warning).toBe(
      "the description was cleaned and shortened: it had 599 characters after cleaning and its first 500 are registered",
    );
  });

  it("the result is what cleanDescription gives, for every vector", () => {
    for (const vector of vectors.clean) {
      const resolved = resolveDescription(vector.in);
      expect(resolved.text).toBe(vector.out === "" ? undefined : vector.out);
      // A warning exactly when cleaning changed a description that is used.
      expect(resolved.warning !== undefined).toBe(
        vector.out !== "" && vector.out !== vector.in,
      );
    }
  });

  it("a value that is not text is ignored with a warning, and never throws", () => {
    for (const value of [42, true, ["a"], { text: "a" }]) {
      expect(resolveDescription(value)).toEqual({
        text: undefined,
        warning:
          "the description is not text; it is ignored and the default is registered",
      });
    }
  });
});
