// Unit tests for owner-token precedence (resolveOwner).
//
// The SAP `owner` subject token (4th token in `agents.prompt.pi.<owner>.<name>`)
// must be caller-overridable so service-account / deployment / SOE-scoped
// owners are expressible, with `$USER` kept only as a last-resort default.
// Precedence follows the SYNADIA_* identity convention shared across
// agents/*: SYNADIA_PI_OWNER → SYNADIA_OWNER → NATS_PI_OWNER (legacy) →
// config.owner → $USER → "unknown", with the result sanitized into a legal
// subject token. resolveOwner itself is source-agnostic — callers pass
// sources highest-precedence first.
//
// Run with: bun test test/owner.test.ts

import { test, expect } from "bun:test";
import { resolveOwner } from "../extensions/subject.ts";

test("per-agent env (SYNADIA_PI_OWNER) wins over everything below it", () => {
	expect(
		resolveOwner("per-agent", "fleet", "legacy", "from-config", "from-user"),
	).toBe("per-agent");
});

test("fleet-wide env (SYNADIA_OWNER) wins over legacy env, config, and $USER", () => {
	expect(
		resolveOwner(undefined, "fleet", "legacy", "from-config", "from-user"),
	).toBe("fleet");
});

test("legacy NATS_PI_OWNER env wins over config.owner — env beats config", () => {
	// The precedence flip (see CHANGELOG): before the SYNADIA_* scheme the
	// config-file owner won over $NATS_PI_OWNER. Env-beats-config is uniform
	// with flue, opencode, openclaw, and pi's own session-name handling.
	expect(
		resolveOwner(undefined, undefined, "legacy", "from-config", "from-user"),
	).toBe("legacy");
});

test("config.owner wins over $USER when no env override is set", () => {
	expect(
		resolveOwner(undefined, undefined, undefined, "from-config", "from-user"),
	).toBe("from-config");
});

test("falls back to $USER when no override is set anywhere", () => {
	expect(
		resolveOwner(undefined, undefined, undefined, undefined, "from-user"),
	).toBe("from-user");
});

test("falls back to 'unknown' when nothing is set", () => {
	expect(resolveOwner(undefined, undefined, undefined, undefined, undefined)).toBe(
		"unknown",
	);
});

test("sanitizes an override into a legal lowercase subject token", () => {
	expect(resolveOwner("Service Account/Prod")).toBe("service-account-prod");
});

test("an override that sanitizes to empty falls back to 'unknown'", () => {
	expect(resolveOwner("///")).toBe("unknown");
});

test("a present-but-empty-sanitizing source does NOT cascade to lower sources", () => {
	// first-present-wins-then-sanitize semantics: a defined-but-all-punctuation
	// top-priority override resolves to "unknown" rather than falling through
	// to lower sources — a misconfigured explicit owner stays visible instead
	// of silently re-resolving the session under a different identity.
	expect(resolveOwner("///", "svc-account", undefined, undefined, "alice")).toBe(
		"unknown",
	);
});
