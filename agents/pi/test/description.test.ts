// Unit tests for the agent's description (description.ts): the cleaning
// rule against its vectors, the precedence chain, and the
// `/nats-configure description` command.
//
// A description is free text that says what the agent does; the agents that
// discover this one read it when they choose whom to ask. It is registered
// cleaned: one line, at most 500 code points. Precedence follows the order
// of the SYNADIA_* owner and name variables: SYNADIA_PI_DESCRIPTION →
// SYNADIA_DESCRIPTION (read by the pi, Claude Code and OpenClaw plugins) →
// config.description → the default text.
// resolveDescription itself is source-agnostic: callers pass sources
// highest-precedence first.
//
// Run with: bun test test/description.test.ts

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DESCRIPTION_LIMIT,
	cleanDescription,
	parseDescriptionCommand,
	resolveDescription,
} from "../extensions/description.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

type CleanVector = { name: string; in: string; out: string };
const vectors = JSON.parse(
	readFileSync(join(HERE, "fixtures", "description-clean-vectors.json"), "utf8"),
) as { limit: number; clean: CleanVector[] };

const codePoints = (text: string): number => Array.from(text).length;

describe("cleanDescription", () => {
	test("the limit is the vectors' limit", () => {
		expect(DESCRIPTION_LIMIT).toBe(vectors.limit);
		expect(vectors.clean.length).toBeGreaterThan(0);
	});

	for (const vector of vectors.clean) {
		test(`vector: ${vector.name}`, () => {
			expect(cleanDescription(vector.in)).toBe(vector.out);
		});
	}

	test("cleaning a cleaned description changes nothing", () => {
		for (const vector of vectors.clean) {
			expect(cleanDescription(vector.out)).toBe(vector.out);
		}
	});

	test("length is counted in code points, and a cut never splits one", () => {
		const astral = "\u{1F44D}";
		const cleaned = cleanDescription(astral.repeat(DESCRIPTION_LIMIT + 5));
		expect(codePoints(cleaned)).toBe(DESCRIPTION_LIMIT);
		expect(cleaned).toBe(astral.repeat(DESCRIPTION_LIMIT));
	});

	test("the zero width non-joiner and joiner stay, and are no reason for a warning", () => {
		// Persian spells with U+200C; an emoji sequence is joined by U+200D.
		const persian = "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645";
		const family = "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}";
		const text = `${persian} ${family}`;
		expect(cleanDescription(text)).toBe(text);
		expect(resolveDescription(text)).toEqual({ text });
		// Every other invisible format character still becomes a space.
		expect(cleanDescription("a\u200bb\u200ec\u2060d\ufeffe")).toBe("a b c d e");
	});

	test("one code point at a time: no space-like character hides behind the one before it", () => {
		// A global match over the whole string missed these on Bun 1.3.14,
		// whose engine paired a UTF-16 unit in U+F800..U+FBFF with the one
		// after it: a U+FEFF after the ligature U+FB01 stayed in place.
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
	test("per-agent env (SYNADIA_PI_DESCRIPTION) wins over everything below it", () => {
		expect(resolveDescription("per agent", "shared", "from config")).toEqual({
			text: "per agent",
		});
	});

	test("the shared env (SYNADIA_DESCRIPTION) wins over the config field", () => {
		expect(resolveDescription(undefined, "shared", "from config")).toEqual({
			text: "shared",
		});
	});

	test("the config field counts when no env variable is set", () => {
		expect(resolveDescription(undefined, undefined, "from config")).toEqual({
			text: "from config",
		});
	});

	test("nothing set means no description: the default text applies", () => {
		expect(resolveDescription(undefined, undefined, undefined)).toEqual({
			text: undefined,
		});
		expect(resolveDescription()).toEqual({ text: undefined });
	});

	test("a source that is set wins even when empty, and then no description is set", () => {
		// first-present-wins-then-clean, as resolveOwner: an empty variable
		// does NOT cascade to the config field, it switches its description off.
		expect(resolveDescription("", "shared", "from config")).toEqual({
			text: undefined,
		});
		expect(resolveDescription("   ", undefined, "from config")).toEqual({
			text: undefined,
		});
		expect(resolveDescription("\u0000\u0007", "shared")).toEqual({
			text: undefined,
		});
	});

	test("a null source is absent, as a missing one is", () => {
		expect(resolveDescription(null, undefined, "from config")).toEqual({
			text: "from config",
		});
	});

	test("a description as written is used without a warning", () => {
		const text =
			"Keeps the logs of the orders server. Ask it what happened in a time range.";
		expect(resolveDescription(text)).toEqual({ text });
		expect(resolveDescription("a".repeat(DESCRIPTION_LIMIT))).toEqual({
			text: "a".repeat(DESCRIPTION_LIMIT),
		});
	});

	test("a description cleaning changed is used as cleaned, with one warning", () => {
		const resolved = resolveDescription("line one\nline  two\t");
		expect(resolved.text).toBe("line one line two");
		expect(resolved.warning).toBe(
			"the description was cleaned: it is registered as one line of plain text, with one space wherever it had line breaks, tabs, control characters or several spaces",
		);
	});

	test("a description over the limit is cut to it, and the warning names both lengths", () => {
		const resolved = resolveDescription("a".repeat(DESCRIPTION_LIMIT + 112));
		expect(resolved.text).toBe("a".repeat(DESCRIPTION_LIMIT));
		expect(resolved.warning).toBe(
			"the description was shortened: it had 612 characters and its first 500 are registered",
		);
	});

	test("cleaned and shortened is still one warning, with the length after cleaning", () => {
		const resolved = resolveDescription(`${"abcd ".repeat(120)}\n`);
		expect(resolved.text).toBe(cleanDescription("abcd ".repeat(120)));
		expect(codePoints(resolved.text ?? "")).toBe(499);
		expect(resolved.warning).toBe(
			"the description was cleaned and shortened: it had 599 characters after cleaning and its first 500 are registered",
		);
	});

	test("the result is what cleanDescription gives, for every vector", () => {
		for (const vector of vectors.clean) {
			const resolved = resolveDescription(vector.in);
			expect(resolved.text).toBe(vector.out === "" ? undefined : vector.out);
			// A warning exactly when cleaning changed a description that is used.
			expect(resolved.warning !== undefined).toBe(
				vector.out !== "" && vector.out !== vector.in,
			);
		}
	});

	test("a value that is not text is ignored with a warning, and never throws", () => {
		for (const value of [42, true, ["a"], { text: "a" }]) {
			expect(resolveDescription(value, "shared")).toEqual({
				text: undefined,
				warning:
					"the description is not text; it is ignored and the default is registered",
			});
		}
	});
});

describe("parseDescriptionCommand", () => {
	test("the text after the word is the description, spaces and all", () => {
		expect(
			parseDescriptionCommand(" Keeps the logs. Ask it what happened."),
		).toEqual({ action: "set", text: "Keeps the logs. Ask it what happened." });
	});

	test("the text is kept cleaned, with the warning to show", () => {
		const asked = parseDescriptionCommand(" two  spaces\there ");
		expect(asked).toEqual({
			action: "set",
			text: "two spaces here",
			warning:
				"the description was cleaned: it is registered as one line of plain text, with one space wherever it had line breaks, tabs, control characters or several spaces",
		});
		const long = parseDescriptionCommand(` ${"a".repeat(501)}`);
		expect(long.action).toBe("set");
		expect(long.action === "set" && codePoints(long.text)).toBe(500);
		expect(long.action === "set" && long.warning).toMatch(/^the description was shortened: it had 501 characters/);
	});

	test("the word clear alone removes the setting", () => {
		expect(parseDescriptionCommand(" clear")).toEqual({ action: "clear" });
		expect(parseDescriptionCommand("  clear  ")).toEqual({ action: "clear" });
		// More than the word is a description.
		expect(parseDescriptionCommand(" clear the cache when asked")).toEqual({
			action: "set",
			text: "clear the cache when asked",
		});
	});

	test("no text asks for the usage line", () => {
		expect(parseDescriptionCommand("")).toEqual({ action: "usage" });
		expect(parseDescriptionCommand("   ")).toEqual({ action: "usage" });
	});
});

// The command itself, run by the extension against a config file in a
// throwaway home directory (the fixture refuses a home that was not
// redirected, so a developer's own config is never written).
describe("/nats-configure description", () => {
	const FIXTURE = join(HERE, "fixtures", "configure-command.mjs");

	function withHome(run: (home: string, configFile: string) => void): void {
		const home = mkdtempSync(join(tmpdir(), "pi-configure-home-"));
		try {
			run(home, join(home, ".pi", "agent", "nats-channel.json"));
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	}

	function configure(home: string, args: string): Array<{ line: string; level: string }> {
		const run = Bun.spawnSync([process.execPath, FIXTURE, args, home], {
			env: { ...process.env, HOME: home },
			stdout: "pipe",
			stderr: "pipe",
		});
		if (run.exitCode !== 0) {
			throw new Error(`configure-command exited ${run.exitCode}: ${run.stderr.toString()}`);
		}
		return JSON.parse(run.stdout.toString().trim().split("\n").at(-1) ?? "[]");
	}

	const readConfig = (path: string): Record<string, unknown> =>
		JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

	test("description <text> writes the cleaned text beside the other keys; clear removes it", () => {
		withHome((home, configFile) => {
			mkdirSync(dirname(configFile), { recursive: true });
			writeFileSync(configFile, JSON.stringify({ sessionName: "kept", owner: "team" }));

			expect(
				configure(home, "description Keeps the logs of the orders server. Reads only."),
			).toEqual([
				{ line: "NATS config updated. Restart PI for changes to take effect.", level: "info" },
			]);
			expect(readConfig(configFile)).toEqual({
				sessionName: "kept",
				owner: "team",
				description: "Keeps the logs of the orders server. Reads only.",
			});

			// The listing shows it.
			const [listing] = configure(home, "");
			expect(listing?.line).toContain(
				"Description: Keeps the logs of the orders server. Reads only.",
			);

			expect(configure(home, "description clear")).toEqual([
				{ line: "NATS config updated. Restart PI for changes to take effect.", level: "info" },
			]);
			expect(readConfig(configFile)).toEqual({ sessionName: "kept", owner: "team" });
			expect(configure(home, "")[0]?.line).toContain(
				"Description: (default: PI agent (<session>) in <cwd>)",
			);
		});
	});

	test("a text cleaning changed is saved as cleaned, with the warning", () => {
		withHome((home, configFile) => {
			const notified = configure(home, `description ${"a".repeat(510)}`);
			expect(notified).toEqual([
				{
					line: "NATS: the description was shortened: it had 510 characters and its first 500 are registered",
					level: "warning",
				},
				{ line: "NATS config updated. Restart PI for changes to take effect.", level: "info" },
			]);
			expect(readConfig(configFile)).toEqual({ description: "a".repeat(500) });
		});
	});

	test("description without a text prints the usage and writes nothing", () => {
		withHome((home, configFile) => {
			expect(configure(home, "description")).toEqual([
				{ line: "Usage: /nats-configure description <text|clear>", level: "warning" },
			]);
			expect(() => readFileSync(configFile, "utf8")).toThrow();
		});
	});
});
