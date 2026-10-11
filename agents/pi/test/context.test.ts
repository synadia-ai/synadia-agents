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

	test("NATS_CREDS connects with NATS_URL and a credentials file, no context needed", () => {
		expect(
			resolveConnectionSettings({}, { NATS_URL: "tls://connect.example:4222", NATS_CREDS: "/run/secrets/agent.creds" }),
		).toMatchObject({
			source: { url: "tls://connect.example:4222", creds: "/run/secrets/agent.creds" },
			contextLabel: "$NATS_URL",
		});
	});

	test("NATS_CREDENTIALS is NATS_CREDS's alias, NATS_CREDS winning, empty meaning unset", () => {
		expect(resolveConnectionSettings({}, { NATS_URL: "nats://a:4222", NATS_CREDENTIALS: "/b.creds" }).source).toEqual({
			url: "nats://a:4222",
			creds: "/b.creds",
		});
		expect(
			resolveConnectionSettings({}, { NATS_URL: "nats://a:4222", NATS_CREDS: "/c.creds", NATS_CREDENTIALS: "/b.creds" }).source,
		).toEqual({ url: "nats://a:4222", creds: "/c.creds" });
		expect(resolveConnectionSettings({}, { NATS_URL: "nats://a:4222", NATS_CREDS: "" }).source).toEqual({ url: "nats://a:4222" });
	});

	test("a context wins over NATS_URL and NATS_CREDS", () => {
		expect(
			resolveConnectionSettings({}, { NATS_CONTEXT: "prod", NATS_URL: "nats://a:4222", NATS_CREDS: "/c.creds" }).source,
		).toEqual({ context: "prod" });
		expect(resolveConnectionSettings({ context: "configured" }, { NATS_CREDS: "/c.creds" }).source).toEqual({ context: "configured" });
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
