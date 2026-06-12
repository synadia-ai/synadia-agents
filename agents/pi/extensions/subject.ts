// Pure subject-token helpers, kept free of any NATS/SDK imports so they can
// be unit-tested in isolation (see `test/owner.test.ts`). The channel
// extension (`nats-channel.ts`) imports from here rather than defining these
// inline, mirroring the pure-module pattern used by `agents/openclaw`.

/**
 * Sanitize a subject token per spec §2.2 SHOULD rules: [a-z0-9_-], lowercase,
 * no leading/trailing dashes. Replaces disallowed characters with `-`.
 */
export function sanitizeSubjectToken(s: string): string {
	return s
		.replace(/[^a-zA-Z0-9_-]/g, "-")
		.toLowerCase()
		.replace(/^-+|-+$/g, "");
}

/**
 * Resolve the SAP `owner` subject token (4th token in
 * `agents.prompt.pi.<owner>.<name>`) from its precedence chain, then sanitize
 * the winner into a legal subject token.
 *
 * Sources are passed highest-precedence first; the function itself is
 * source-agnostic. The conventional chain — the `SYNADIA_*` identity
 * convention shared across `agents/*`, so a service-account / deployment /
 * SOE-scoped owner is expressible instead of being forced to `$USER` — is:
 *
 *   1. `SYNADIA_PI_OWNER`  — per-agent env override
 *   2. `SYNADIA_OWNER`     — fleet-wide env override
 *   3. `NATS_PI_OWNER`     — legacy env alias (pre-`SYNADIA_*` scheme)
 *   4. `config.owner`      — explicit field in `~/.pi/agent/nats-channel.json`
 *   5. `$USER`             — existing default; unchanged for everyone else
 *   6. `"unknown"`         — last-resort fallback
 *
 * Env beats the config file — uniform with flue, opencode, openclaw,
 * open-agent, and pi's own session-name handling. (Previously
 * `config.owner` won over `$NATS_PI_OWNER`; see CHANGELOG.)
 *
 * A winner that sanitizes to the empty string (e.g. all-punctuation) falls
 * back to `"unknown"` so the subject token is always non-empty. Note this is
 * first-present-wins-then-sanitize, not a per-source cascade: the first
 * *present* source wins even if it sanitizes to empty — it does NOT fall
 * through to the next source. This keeps a misconfigured explicit owner
 * visible as `unknown` rather than silently re-resolving the session under
 * a different identity.
 */
export function resolveOwner(
	...sources: Array<string | undefined>
): string {
	return (
		sanitizeSubjectToken(sources.find((s) => s != null) ?? "unknown") ||
		"unknown"
	);
}
