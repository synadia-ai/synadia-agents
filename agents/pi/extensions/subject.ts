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
 * Precedence — highest first — mirrors Synadia's own open-agent reference
 * (`agents/open-agent/src/cli.ts`), so a service-account / deployment /
 * SOE-scoped owner is expressible instead of being forced to `$USER`:
 *
 *   1. `config.owner`     — explicit field in `~/.pi/agent/nats-channel.json`
 *   2. `NATS_PI_OWNER`    — dedicated env override (cf. open-agent's
 *                           `OPEN_AGENT_OWNER`); do not overload `$USER`
 *   3. `$USER`            — existing default; unchanged for everyone else
 *   4. `"unknown"`        — last-resort fallback
 *
 * A winner that sanitizes to the empty string (e.g. all-punctuation) also
 * falls back to `"unknown"` so the subject token is always non-empty.
 */
export function resolveOwner(
	configOwner: string | undefined,
	envOwner: string | undefined,
	envUser: string | undefined,
): string {
	return (
		sanitizeSubjectToken(configOwner ?? envOwner ?? envUser ?? "unknown") ||
		"unknown"
	);
}
