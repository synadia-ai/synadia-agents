import { describe, expect, test } from "bun:test";
import { resolveConnectionSettings } from "../extensions/nats-channel.ts";

describe("PI connection settings", () => {
	test("identity-free and permissive are independent defaults", () => {
		expect(resolveConnectionSettings({}, {})).toEqual({
			source: { url: "demo.nats.io" },
			contextLabel: "default",
			senderIdentity: "off",
			minSenderTrust: "any",
		});
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
