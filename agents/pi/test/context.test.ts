import { describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { activeTrace, bindActiveTrace } from "@synadia-ai/agents";
import {
	injectInScope,
	resolveConnectionSettings,
	traceOptionsFor,
} from "../extensions/nats-channel.ts";

describe("PI connection settings", () => {
	test("identity-free and permissive are independent defaults", () => {
		expect(resolveConnectionSettings({}, {})).toEqual({
			source: { url: "demo.nats.io" },
			contextLabel: "default",
			senderIdentity: "off",
			minSenderTrust: "any",
			tracing: "off",
		});
	});

	test("tracing is off by default; env beats config; other values are rejected", () => {
		expect(resolveConnectionSettings({ tracing: "on" }, {})).toMatchObject({ tracing: "on" });
		expect(resolveConnectionSettings({ tracing: "on" }, { NATS_TRACING: "off" })).toMatchObject({
			tracing: "off",
		});
		expect(() => resolveConnectionSettings({}, { NATS_TRACING: "yes" })).toThrow(
			"NATS_TRACING/tracing must be one of off, on",
		);
	});

	test("trace options are propagate-only when tracing is on", () => {
		expect(traceOptionsFor({ tracing: "off" })).toBeUndefined();
		expect(traceOptionsFor({ tracing: "on" })).toEqual({ edgeSubject: null });
	});

	test("a prompt is handed to PI in its own trace scope, never the injecting caller's", () => {
		const a = { threadId: "a".repeat(32), rootId: "a".repeat(32), turnCountHint: 0 };
		const b = { threadId: "b".repeat(32), rootId: "b".repeat(32), turnCountHint: 0 };
		// Injected from inside A's handler (the common case): PI sees B.
		expect(bindActiveTrace(a, () => injectInScope(b, () => activeTrace()))).toBe(b);
		// An untraced prompt injected from inside A's handler sees no scope,
		// where the runtime can snapshot the extension's own context.
		const neutral = bindActiveTrace(a, () => injectInScope(undefined, () => activeTrace()));
		if (typeof AsyncLocalStorage.snapshot === "function") expect(neutral).toBeUndefined();
		else expect(neutral).toBe(a);
	});

	test("context wins over URL and is passed to the shared bundle helper", () => {
		expect(
			resolveConnectionSettings(
				{ context: "configured" },
				{ NATS_CONTEXT: "from-env", NATS_URL: "nats://ignored:4222" },
			),
		).toMatchObject({
			source: { context: "from-env" },
			contextLabel: "from-env",
		});
	});

	test("URL is used only when no context is selected", () => {
		expect(resolveConnectionSettings({}, { NATS_URL: "nats://localhost:4223" })).toMatchObject({
			source: { url: "nats://localhost:4223" },
			contextLabel: "$NATS_URL",
		});
	});

	test("signed self identity does not imply signed-only admission", () => {
		expect(resolveConnectionSettings({ senderIdentity: "signed" }, {})).toMatchObject({
			senderIdentity: "signed",
			minSenderTrust: "any",
		});
	});

	test("signed-only admission does not require host self identity", () => {
		expect(resolveConnectionSettings({ minSenderTrust: "signed" }, {})).toMatchObject({
			senderIdentity: "off",
			minSenderTrust: "signed",
		});
	});

	test("environment overrides file modes", () => {
		expect(
			resolveConnectionSettings(
				{ senderIdentity: "off", minSenderTrust: "any" },
				{ NATS_SENDER_IDENTITY: "signed", NATS_MIN_SENDER_TRUST: "signed" },
			),
		).toMatchObject({ senderIdentity: "signed", minSenderTrust: "signed" });
	});

	test("invalid modes fail before connection", () => {
		expect(() => resolveConnectionSettings({}, { NATS_SENDER_IDENTITY: "maybe" })).toThrow(
			/NATS_SENDER_IDENTITY/,
		);
		expect(() => resolveConnectionSettings({}, { NATS_MIN_SENDER_TRUST: "verified" })).toThrow(
			/NATS_MIN_SENDER_TRUST/,
		);
	});
});
