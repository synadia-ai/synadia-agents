// Unit tests for owner-token precedence (resolveOwner).
//
// The SAP `owner` subject token (4th token in `agents.prompt.pi.<owner>.<name>`)
// must be caller-overridable so service-account / deployment / SOE-scoped
// owners are expressible, with `$USER` kept only as a last-resort default.
// Precedence mirrors Synadia's own open-agent reference
// (`agents/open-agent/src/cli.ts`): config.owner → NATS_PI_OWNER → $USER →
// "unknown", with the result sanitized into a legal subject token.
//
// Run with: bun test test/owner.test.ts

import { test, expect } from "bun:test";
import { resolveOwner } from "../extensions/subject.ts";

test("config.owner wins over the NATS_PI_OWNER env and $USER", () => {
	expect(resolveOwner("from-config", "from-env", "from-user")).toBe("from-config");
});

test("NATS_PI_OWNER env wins over $USER when config.owner is unset", () => {
	expect(resolveOwner(undefined, "from-env", "from-user")).toBe("from-env");
});

test("falls back to $USER when neither config.owner nor NATS_PI_OWNER is set", () => {
	expect(resolveOwner(undefined, undefined, "from-user")).toBe("from-user");
});

test("falls back to 'unknown' when nothing is set", () => {
	expect(resolveOwner(undefined, undefined, undefined)).toBe("unknown");
});

test("sanitizes an override into a legal lowercase subject token", () => {
	expect(resolveOwner("Service Account/Prod", undefined, undefined)).toBe(
		"service-account-prod",
	);
});

test("an override that sanitizes to empty falls back to 'unknown'", () => {
	expect(resolveOwner("///", undefined, undefined)).toBe("unknown");
});
