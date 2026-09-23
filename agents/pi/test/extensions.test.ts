// The extension point: naming and precedence, loading, and the fail-open
// composition of the loaded extensions (see `extensions/extensions.ts` and
// `agents/EXTENSIONS.md`). Modules are written to a temporary directory;
// no NATS is needed.
//
// Run with: bun test test/extensions.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@synadia-ai/agents";
import {
	AGENT_EXTENSIONS_VAR,
	PI_EXTENSIONS_VAR,
	composeExtensions,
	loadExtensions,
	resolveExtensionEntries,
	resolveExtensionSpecifier,
	type AgentExtension,
	type AgentExtensionContext,
	type LoadedExtension,
	type ServedRequest,
} from "../extensions/extensions.ts";

function recordingLogger(): Logger & { lines: string[] } {
	const lines: string[] = [];
	return {
		lines,
		debug: () => undefined,
		info: (m) => lines.push(`info ${m}`),
		warn: (m) => lines.push(`warn ${m}`),
		error: (m) => lines.push(`error ${m}`),
	};
}

const base: Omit<AgentExtensionContext, "options"> = {
	harness: "pi",
	plugin: { name: "@synadia-ai/nats-pi-channel", version: "0.0.0-test" },
	settings: {
		owner: "me",
		name: "session",
		senderIdentity: "off",
		minSenderTrust: "any",
		config: {},
	},
	logger: recordingLogger(),
};

const request: ServedRequest = Object.freeze({ id: "7", extras: { trace: "t" } });

function loaded(name: string, extension: Omit<AgentExtension, "name">): LoadedExtension {
	return { module: name, name, extension: { name, ...extension } };
}

async function delayTicks(n: number): Promise<void> {
	for (let i = 0; i < n; i++) await Promise.resolve();
}

describe("resolveExtensionEntries: the variables and the config field", () => {
	test("the config field is the fallback, as strings or { module, options }", () => {
		const warnings: string[] = [];
		const resolved = resolveExtensionEntries(
			["one", { module: "two", options: { level: 2 } }, { module: "three" }],
			{},
			(m) => warnings.push(m),
		);
		expect(resolved.source).toBe("config");
		expect(resolved.entries).toEqual([
			{ module: "one", options: {} },
			{ module: "two", options: { level: 2 } },
			{ module: "three", options: {} },
		]);
		expect(warnings).toEqual([]);
	});

	test("SYNADIA_AGENT_EXTENSIONS wins over the config field", () => {
		const resolved = resolveExtensionEntries(["from-config"], {
			[AGENT_EXTENSIONS_VAR]: "a, b ,,c",
		});
		expect(resolved.source).toBe(AGENT_EXTENSIONS_VAR);
		expect(resolved.entries.map((e) => e.module)).toEqual(["a", "b", "c"]);
	});

	test("SYNADIA_PI_EXTENSIONS wins over SYNADIA_AGENT_EXTENSIONS", () => {
		const resolved = resolveExtensionEntries(["from-config"], {
			[PI_EXTENSIONS_VAR]: "pi-only",
			[AGENT_EXTENSIONS_VAR]: "shared",
		});
		expect(resolved.source).toBe(PI_EXTENSIONS_VAR);
		expect(resolved.entries).toEqual([{ module: "pi-only", options: {} }]);
	});

	test("a variable that is set but empty names no extension and still wins", () => {
		const resolved = resolveExtensionEntries(["from-config"], { [PI_EXTENSIONS_VAR]: "" });
		expect(resolved.source).toBe(PI_EXTENSIONS_VAR);
		expect(resolved.entries).toEqual([]);
	});

	test("nothing named means no extensions", () => {
		expect(resolveExtensionEntries(undefined, {})).toEqual({ source: "none", entries: [] });
	});

	test("malformed config entries are reported and skipped, the rest kept", () => {
		const warnings: string[] = [];
		const resolved = resolveExtensionEntries(
			["ok", 42, { options: {} }, { module: "", options: {} }, { module: "bad-opts", options: "x" }, " "],
			{},
			(m) => warnings.push(m),
		);
		expect(resolved.entries.map((e) => e.module)).toEqual(["ok"]);
		expect(warnings).toHaveLength(5);
		const notArray = resolveExtensionEntries("not-an-array", {}, (m) => warnings.push(m));
		expect(notArray).toEqual({ source: "none", entries: [] });
		expect(warnings).toHaveLength(6);
	});
});

describe("resolveExtensionSpecifier: package names and absolute paths only", () => {
	test("a relative path is refused", () => {
		for (const spec of ["./ext.mjs", "../ext", ".", "~/ext"]) {
			expect(() => resolveExtensionSpecifier(spec)).toThrow(/relative paths are refused/);
		}
	});

	test("a package name passes through for the runtime to resolve", () => {
		expect(resolveExtensionSpecifier("@scope/pkg")).toBe("@scope/pkg");
		expect(resolveExtensionSpecifier("pkg/subpath")).toBe("pkg/subpath");
	});

	test("an empty specifier is refused", () => {
		expect(() => resolveExtensionSpecifier("  ")).toThrow(/empty/);
	});
});

describe("loadExtensions", () => {
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-ext-test-"));
		writeFileSync(
			join(dir, "good.mjs"),
			`export default function (ctx) {
				return { name: "good", seen: ctx, events: { promptAccepted() {} } };
			}`,
		);
		writeFileSync(join(dir, "throws.mjs"), `export default function () { throw new Error("boom"); }`);
		writeFileSync(join(dir, "nodefault.mjs"), `export const x = 1;`);
		writeFileSync(join(dir, "nameless.mjs"), `export default async function () { return {}; }`);
		writeFileSync(join(dir, "notobject.mjs"), `export default function () { return 42; }`);
		mkdirSync(join(dir, "pkg-main"));
		writeFileSync(join(dir, "pkg-main", "package.json"), JSON.stringify({ name: "pkg-main", main: "entry.mjs" }));
		writeFileSync(join(dir, "pkg-main", "entry.mjs"), `export default () => ({ name: "from-main" });`);
		mkdirSync(join(dir, "pkg-exports", "dist"), { recursive: true });
		writeFileSync(
			join(dir, "pkg-exports", "package.json"),
			JSON.stringify({ name: "pkg-exports", exports: { ".": { import: "./dist/index.mjs" } } }),
		);
		writeFileSync(join(dir, "pkg-exports", "dist", "index.mjs"), `export default () => ({ name: "from-exports" });`);
		mkdirSync(join(dir, "pkg-empty"));
		writeFileSync(join(dir, "pkg-empty", "package.json"), JSON.stringify({ name: "pkg-empty" }));
	});
	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("an absolute file path loads; the factory gets the context with the entry's options", async () => {
		const logger = recordingLogger();
		const result = await loadExtensions(
			[{ module: join(dir, "good.mjs"), options: { level: 3 } }],
			base,
			logger,
		);
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe("good");
		expect(result[0]!.module).toBe(join(dir, "good.mjs"));
		const seen = (result[0]!.extension as unknown as { seen: AgentExtensionContext }).seen;
		expect(seen.harness).toBe("pi");
		expect(seen.plugin).toEqual(base.plugin);
		expect(seen.settings).toEqual(base.settings);
		expect(seen.options).toEqual({ level: 3 });
		expect(seen.logger).toBe(base.logger);
		expect(logger.lines).toEqual([]);
	});

	test("an absolute package directory loads through its package.json: main, or exports", async () => {
		const logger = recordingLogger();
		const result = await loadExtensions(
			[
				{ module: join(dir, "pkg-main"), options: {} },
				{ module: join(dir, "pkg-exports"), options: {} },
			],
			base,
			logger,
		);
		expect(result.map((l) => l.name)).toEqual(["from-main", "from-exports"]);
		expect(logger.lines).toEqual([]);
	});

	test("a relative path is refused with one log line, and the rest still load", async () => {
		const logger = recordingLogger();
		const result = await loadExtensions(
			[
				{ module: "./good.mjs", options: {} },
				{ module: join(dir, "good.mjs"), options: {} },
			],
			base,
			logger,
		);
		expect(result.map((l) => l.name)).toEqual(["good"]);
		expect(logger.lines).toHaveLength(1);
		expect(logger.lines[0]).toMatch(/^error extension ".\/good.mjs" not loaded: .*relative paths are refused/);
	});

	test("a missing module is skipped with one log line", async () => {
		const logger = recordingLogger();
		const missingPath = join(dir, "missing.mjs");
		const result = await loadExtensions(
			[
				{ module: missingPath, options: {} },
				{ module: "no-such-package-for-the-pi-channel-test", options: {} },
				{ module: join(dir, "pkg-empty"), options: {} },
			],
			base,
			logger,
		);
		expect(result).toEqual([]);
		expect(logger.lines).toHaveLength(3);
		expect(logger.lines[0]).toMatch(/no such file or directory/);
		expect(logger.lines[1]).toMatch(/^error extension "no-such-package-for-the-pi-channel-test" not loaded: /);
		expect(logger.lines[2]).toMatch(/names no entry/);
	});

	test("a package name resolves from the plugin's location upward", async () => {
		// The SDK is installed next to the plugin and has no default export:
		// the failure is the export's, so the name was resolved and imported.
		const logger = recordingLogger();
		const result = await loadExtensions([{ module: "@synadia-ai/agents", options: {} }], base, logger);
		expect(result).toEqual([]);
		expect(logger.lines).toEqual([
			'error extension "@synadia-ai/agents" not loaded: the module has no default export function',
		]);
	});

	test("a factory that throws, exports nothing usable, or returns no object is logged once and skipped", async () => {
		const logger = recordingLogger();
		const result = await loadExtensions(
			[
				{ module: join(dir, "throws.mjs"), options: {} },
				{ module: join(dir, "nodefault.mjs"), options: {} },
				{ module: join(dir, "notobject.mjs"), options: {} },
				{ module: join(dir, "nameless.mjs"), options: {} },
			],
			base,
			logger,
		);
		// The nameless one loads, named by its specifier.
		expect(result.map((l) => l.name)).toEqual([join(dir, "nameless.mjs")]);
		expect(logger.lines).toEqual([
			`error extension "${join(dir, "throws.mjs")}" not loaded: boom`,
			`error extension "${join(dir, "nodefault.mjs")}" not loaded: the module has no default export function`,
			`error extension "${join(dir, "notobject.mjs")}" not loaded: the factory returned no extension object`,
		]);
	});
});

describe("composeExtensions: the hooks, in load order", () => {
	const r1 = { aroundRequest: (_c: unknown, next: () => Promise<void>) => next() };
	const r2 = { aroundRequest: (_c: unknown, next: () => Promise<void>) => next() };
	const r3 = { aroundRequest: (_c: unknown, next: () => Promise<void>) => next() };
	const p1 = { beforePrompt: () => undefined };
	const p2 = { beforePrompt: () => undefined };
	const t1 = { discoveryFields: () => undefined };
	const t2 = { discoveryFields: () => undefined };

	test("interceptors and tool extensions are concatenated in load order", () => {
		const composed = composeExtensions(
			[
				loaded("first", { requestInterceptors: [r1], promptInterceptors: [p1], toolExtensions: [t1] }),
				loaded("second", { requestInterceptors: [r2, r3], promptInterceptors: [p2], toolExtensions: [t2] }),
				loaded("third", {}),
			],
			recordingLogger(),
		);
		expect(composed.names).toEqual(["first", "second", "third"]);
		expect(composed.requestInterceptors).toEqual([r1, r2, r3]);
		expect(composed.promptInterceptors).toEqual([p1, p2]);
		expect(composed.toolExtensions).toEqual([t1, t2]);
	});

	test("heartbeat extras: none gives no provider; several merge, the later winning a clash", () => {
		expect(composeExtensions([loaded("a", {})], recordingLogger()).heartbeatExtras).toBeUndefined();
		const composed = composeExtensions(
			[
				loaded("a", { heartbeatExtras: () => ({ a: 1, shared: "a" }) }),
				loaded("b", { heartbeatExtras: () => ({ b: 2, shared: "b" }) }),
			],
			recordingLogger(),
		);
		expect(composed.heartbeatExtras!()).toEqual({ a: 1, b: 2, shared: "b" });
	});

	test("a throwing extras provider costs only its own extras and is logged once", () => {
		const logger = recordingLogger();
		const composed = composeExtensions(
			[
				loaded("a", { heartbeatExtras: () => ({ a: 1 }) }),
				loaded("boom", {
					heartbeatExtras: () => {
						throw new Error("no extras today");
					},
				}),
			],
			logger,
		);
		expect(composed.heartbeatExtras!()).toEqual({ a: 1 });
		expect(composed.heartbeatExtras!()).toEqual({ a: 1 });
		expect(logger.lines).toEqual(['warn extension "boom" heartbeatExtras failed: no extras today']);
	});
});

describe("composeExtensions: started and stopping are awaited and bounded", () => {
	test("started gets the handles; a hook that never settles is abandoned after the bound", async () => {
		const logger = recordingLogger();
		const handles = { agents: {}, service: {} } as never;
		let seen: unknown;
		const composed = composeExtensions(
			[
				loaded("quick", {
					async started(h) {
						seen = h;
					},
				}),
				loaded("stuck", { started: () => new Promise<void>(() => undefined) }),
			],
			logger,
			{ hookTimeoutMs: 50 },
		);
		const t0 = Date.now();
		await composed.started(handles);
		expect(Date.now() - t0).toBeLessThan(1_000);
		expect(seen).toBe(handles);
		expect(logger.lines).toEqual([
			'warn extension "stuck" started() did not finish within 50 ms; continuing without it',
		]);
	});

	test("a throwing or rejecting stopping is logged and does not stop the plugin", async () => {
		const logger = recordingLogger();
		let stopped = 0;
		const composed = composeExtensions(
			[
				loaded("sync-throw", {
					stopping() {
						throw new Error("sync");
					},
				}),
				loaded("rejects", { stopping: () => Promise.reject(new Error("async")) }),
				loaded("fine", {
					async stopping() {
						stopped++;
					},
				}),
			],
			logger,
		);
		await composed.stopping();
		expect(stopped).toBe(1);
		expect(logger.lines.sort()).toEqual([
			'warn extension "rejects" stopping() failed: async',
			'warn extension "sync-throw" stopping() failed: sync',
		]);
	});
});

describe("composeExtensions: PI's events, fail-open", () => {
	test("notifications reach every extension with the request; a throw is logged once per event name", () => {
		const logger = recordingLogger();
		const calls: string[] = [];
		const composed = composeExtensions(
			[
				loaded("a", {
					events: {
						promptAccepted: (r) => calls.push(`a.accepted ${r.id}`),
						promptEnded: (r, outcome, at) => calls.push(`a.ended ${r.id} ${outcome} ${at}`),
					},
				}),
				loaded("b", {
					events: {
						promptAccepted: () => {
							throw new Error("b fails");
						},
						promptEnded: (r) => calls.push(`b.ended ${r.id}`),
					},
				}),
			],
			logger,
		);
		composed.events.promptAccepted(request);
		composed.events.promptAccepted(request);
		composed.events.promptEnded(request, "ok", 123);
		expect(calls).toEqual(["a.accepted 7", "a.accepted 7", "a.ended 7 ok 123", "b.ended 7"]);
		expect(logger.lines).toEqual(['warn extension "b" promptAccepted failed: b fails']);
	});

	test("aroundInject: the wrapper's context is what run sees, and run's value comes back", () => {
		const als = new AsyncLocalStorage<string>();
		const composed = composeExtensions(
			[
				loaded("binder", {
					events: { aroundInject: (r, run) => als.run(`bound:${r.id}`, run) },
				}),
			],
			recordingLogger(),
		);
		const value = composed.events.aroundInject(request, () => `saw ${als.getStore()}`);
		expect(value).toBe("saw bound:7");
	});

	test("wrappers nest with the first loaded outermost", () => {
		const order: string[] = [];
		const composed = composeExtensions(
			[
				loaded("outer", {
					events: {
						aroundInject(_r, run) {
							order.push("outer>");
							const v = run();
							order.push("<outer");
							return v;
						},
					},
				}),
				loaded("inner", {
					events: {
						aroundInject(_r, run) {
							order.push("inner>");
							const v = run();
							order.push("<inner");
							return v;
						},
					},
				}),
			],
			recordingLogger(),
		);
		composed.events.aroundInject(request, () => order.push("step"));
		expect(order).toEqual(["outer>", "inner>", "step", "<inner", "<outer"]);
	});

	test("a wrapper that does not call run, or throws before it, has run called by the plugin, logged once", () => {
		const logger = recordingLogger();
		let runs = 0;
		const composed = composeExtensions(
			[
				loaded("forgets", { events: { aroundInject: (() => undefined) as never } }),
				loaded("throws-first", {
					events: {
						aroundInject() {
							throw new Error("before run");
						},
					},
				}),
			],
			logger,
		);
		expect(composed.events.aroundInject(request, () => ++runs)).toBe(1);
		expect(composed.events.aroundInject(request, () => ++runs)).toBe(2);
		expect(runs).toBe(2);
		// The first loaded is the outermost, so it is the first to be corrected.
		expect(logger.lines).toEqual([
			'warn extension "forgets" aroundInject returned without calling run; the plugin ran the step itself',
			'warn extension "throws-first" aroundInject failed: before run',
		]);
	});

	test("a wrapper that calls run twice, or throws after it, still yields one run and its value", () => {
		const logger = recordingLogger();
		let runs = 0;
		const composed = composeExtensions(
			[
				loaded("twice", {
					events: {
						aroundInject(_r, run) {
							run();
							return run();
						},
					},
				}),
				loaded("throws-after", {
					events: {
						aroundInject(_r, run) {
							run();
							throw new Error("after run");
						},
					},
				}),
			],
			logger,
		);
		expect(composed.events.aroundInject(request, () => ++runs)).toBe(1);
		expect(runs).toBe(1);
		expect(logger.lines).toEqual([
			'warn extension "throws-after" aroundInject failed: after run',
			'warn extension "twice" aroundInject called run more than once, or after the plugin had run the step itself; the extra call was ignored',
		]);
	});

	test("the step's own throw reaches the plugin even through a wrapper that swallows it", () => {
		const logger = recordingLogger();
		const composed = composeExtensions(
			[
				loaded("swallows", {
					events: {
						aroundInject(_r, run) {
							try {
								return run();
							} catch {
								return undefined as never;
							}
						},
					},
				}),
			],
			logger,
		);
		expect(() =>
			composed.events.aroundInject(request, () => {
				throw new Error("PI refused the injection");
			}),
		).toThrow("PI refused the injection");
		expect(logger.lines).toEqual([]);
	});

	test("a wrapper that returns something other than run's value is corrected and logged once", () => {
		const logger = recordingLogger();
		const composed = composeExtensions(
			[
				loaded("rewraps", {
					events: {
						aroundInject(_r, run) {
							run();
							return "something else" as never;
						},
					},
				}),
			],
			logger,
		);
		expect(composed.events.aroundInject(request, () => "run's")).toBe("run's");
		expect(composed.events.aroundInject(request, () => "run's")).toBe("run's");
		expect(logger.lines).toEqual([
			'warn extension "rewraps" aroundInject did not return run\'s value; the plugin used run\'s',
		]);
	});

	test("an async passthrough wrapper is within the contract: no warning, run's value unchanged", async () => {
		const logger = recordingLogger();
		const als = new AsyncLocalStorage<string>();
		let injected = 0;
		const composed = composeExtensions(
			[
				loaded("async-passthrough", {
					events: {
						// An async function returns a promise of its own around
						// run's; the plugin must not mistake that for a wrong value.
						aroundToolCall: (async (_r: unknown, _n: string, run: () => unknown) => run()) as never,
						aroundInject: (async (r: ServedRequest, run: () => unknown) =>
							als.run(`bound:${r.id}`, run)) as never,
					},
				}),
			],
			logger,
		);
		const result = Promise.resolve({ call_id: "c1", state: "done", reply: "ok" });
		const got = composed.events.aroundToolCall(request, "prompt_agent", () => result);
		expect(got).toBe(result);
		expect(await got).toEqual({ call_id: "c1", state: "done", reply: "ok" });
		// aroundInject's step returns nothing, as pi.sendUserMessage does; run
		// still ran once, synchronously, inside the wrapper's binding.
		let seen: string | undefined;
		composed.events.aroundInject(request, () => {
			injected++;
			seen = als.getStore();
		});
		expect(injected).toBe(1);
		expect(seen).toBe("bound:7");
		expect(logger.lines).toEqual([]);
	});

	test("a sync wrapper that returns a different plain value is still corrected and warned once", () => {
		const logger = recordingLogger();
		const composed = composeExtensions(
			[
				loaded("plain-wrong", {
					events: {
						aroundInject(_r, run) {
							run();
							return 42 as never;
						},
					},
				}),
			],
			logger,
		);
		expect(composed.events.aroundInject(request, () => "run's")).toBe("run's");
		expect(logger.lines).toEqual([
			'warn extension "plain-wrong" aroundInject did not return run\'s value; the plugin used run\'s',
		]);
	});

	test("an async wrapper that calls run only after an await: the plugin runs the step once, the late call is ignored", async () => {
		const logger = recordingLogger();
		let runs = 0;
		const composed = composeExtensions(
			[
				loaded("late", {
					events: {
						aroundInject: (async (_r: unknown, run: () => unknown) => {
							await Promise.resolve();
							return run();
						}) as never,
					},
				}),
			],
			logger,
		);
		expect(composed.events.aroundInject(request, () => ++runs)).toBe(1);
		await delayTicks(3);
		expect(runs).toBe(1);
		expect(logger.lines).toEqual([
			'warn extension "late" aroundInject returned without calling run; the plugin ran the step itself',
			'warn extension "late" aroundInject called run more than once, or after the plugin had run the step itself; the extra call was ignored',
		]);
	});

	test("aroundToolCall gets the request or undefined, the tool's name, and returns run's promise as is", async () => {
		const seen: Array<[string | undefined, string]> = [];
		const composed = composeExtensions(
			[
				loaded("tools", {
					events: {
						aroundToolCall(r, name, run) {
							seen.push([r?.id, name]);
							return run();
						},
					},
				}),
			],
			recordingLogger(),
		);
		const promise = Promise.resolve({ ok: true });
		expect(composed.events.aroundToolCall(request, "prompt_agent", () => promise)).toBe(promise);
		expect(composed.events.aroundToolCall(undefined, "discover_agents", () => promise)).toBe(promise);
		expect(seen).toEqual([
			["7", "prompt_agent"],
			[undefined, "discover_agents"],
		]);
	});

	test("providerHeaders merges every extension's headers, drops non-strings, logs a throw once", () => {
		const logger = recordingLogger();
		const composed = composeExtensions(
			[
				loaded("a", { events: { providerHeaders: (r) => ({ "x-request": r.id, "x-a": "1" }) } }),
				loaded("b", {
					events: { providerHeaders: () => ({ "x-a": "2", "x-bad": 3 as unknown as string }) },
				}),
				loaded("none", { events: { providerHeaders: () => undefined } }),
				loaded("boom", {
					events: {
						providerHeaders() {
							throw new Error("no headers");
						},
					},
				}),
			],
			logger,
		);
		expect(composed.events.providerHeaders(request)).toEqual({ "x-request": "7", "x-a": "2" });
		composed.events.providerHeaders(request);
		expect(logger.lines).toEqual(['warn extension "boom" providerHeaders failed: no headers']);
	});

	test("with no extension, every event is a no-op and every wrapper just runs its step", async () => {
		const composed = composeExtensions([], recordingLogger());
		expect(composed.names).toEqual([]);
		expect(composed.heartbeatExtras).toBeUndefined();
		composed.events.promptAccepted(request);
		composed.events.promptEnded(request, "timeout", 1);
		expect(composed.events.providerHeaders(request)).toEqual({});
		expect(composed.events.aroundInject(request, () => "ran")).toBe("ran");
		expect(await composed.events.aroundToolCall(undefined, "x", async () => "ran")).toBe("ran");
		await composed.started({} as never);
		await composed.stopping();
	});
});
