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
			contextLabel: "context from-env from NATS_CONTEXT, NATS_URL unused",
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

	test("credentials without NATS_URL fail rather than go to the public default", () => {
		expect(() => resolveConnectionSettings({}, { NATS_CREDS: "/c.creds" })).toThrow(/without NATS_URL/);
		expect(() => resolveConnectionSettings({}, { NATS_CREDENTIALS: "/c.creds", NATS_URL: "" })).toThrow(/without NATS_URL/);
		// Word for word the Claude Code channel's message.
		expect(() => resolveConnectionSettings({}, { NATS_CREDS: "/c.creds" })).toThrow(
			/^invalid NATS_CREDS\/NATS_CREDENTIALS: set without NATS_URL; set NATS_URL to the server the credentials are for$/,
		);
	});

	test("a context wins over NATS_URL and NATS_CREDS", () => {
		expect(
			resolveConnectionSettings({}, { NATS_CONTEXT: "prod", NATS_URL: "nats://a:4222", NATS_CREDS: "/c.creds" }).source,
		).toEqual({ context: "prod" });
		// The config file's context is not read when the environment names a server.
		expect(() => resolveConnectionSettings({ context: "configured" }, { NATS_CREDS: "/c.creds" })).toThrow(/without NATS_URL/);
	});

	test("NATS_URL and credentials in the environment beat the config file's context", () => {
		expect(
			resolveConnectionSettings(
				{ context: "configured" },
				{ NATS_URL: "tls://connect.example:4222", NATS_CREDS: "/run/secrets/agent.creds" },
			),
		).toMatchObject({
			source: { url: "tls://connect.example:4222", creds: "/run/secrets/agent.creds" },
			contextLabel: "$NATS_URL",
		});
		expect(
			resolveConnectionSettings({ context: "configured" }, { NATS_URL: "nats://a:4222", NATS_CREDENTIALS: "/b.creds" }).source,
		).toEqual({ url: "nats://a:4222", creds: "/b.creds" });
	});

	test("NATS_URL alone beats the config file's context", () => {
		expect(resolveConnectionSettings({ context: "configured" }, { NATS_URL: "nats://localhost:4223" })).toMatchObject({
			source: { url: "nats://localhost:4223" },
			contextLabel: "$NATS_URL",
		});
	});

	test("the config file's context counts when the environment names no server", () => {
		expect(resolveConnectionSettings({ context: "configured" }, {})).toMatchObject({
			source: { context: "configured" },
			contextLabel: "context configured from ~/.pi/agent/nats-channel.json",
		});
		// Empty variables are unset.
		expect(
			resolveConnectionSettings({ context: "configured" }, { NATS_URL: "", NATS_CREDS: "", NATS_CREDENTIALS: "" }),
		).toMatchObject({
			source: { context: "configured" },
			contextLabel: "context configured from ~/.pi/agent/nats-channel.json",
		});
	});

	test("NATS_CONTEXT wins over the config file's context and names itself", () => {
		expect(resolveConnectionSettings({ context: "configured" }, { NATS_CONTEXT: "prod" })).toMatchObject({
			source: { context: "prod" },
			contextLabel: "context prod from NATS_CONTEXT",
		});
		expect(resolveConnectionSettings({}, { NATS_CONTEXT: "prod", NATS_CREDS: "/c.creds" })).toMatchObject({
			source: { context: "prod" },
			contextLabel: "context prod from NATS_CONTEXT, NATS_URL unused",
		});
	});

	test("an empty NATS_CONTEXT selects no context, not even the config file's", () => {
		expect(resolveConnectionSettings({ context: "configured" }, { NATS_CONTEXT: "" })).toMatchObject({
			source: { url: "demo.nats.io" },
			contextLabel: "default",
		});
		expect(
			resolveConnectionSettings({ context: "configured" }, { NATS_CONTEXT: "", NATS_URL: "nats://localhost:4222" }),
		).toMatchObject({
			source: { url: "nats://localhost:4222" },
			contextLabel: "$NATS_URL",
		});
		expect(() => resolveConnectionSettings({ context: "configured" }, { NATS_CONTEXT: "", NATS_CREDS: "/c.creds" })).toThrow(
			/without NATS_URL/,
		);
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
