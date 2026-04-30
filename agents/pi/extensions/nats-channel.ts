/**
 * NATS Agent Protocol channel for PI Agent.
 *
 * Implements the NATS Agent Protocol v0.3 (see
 * `https://github.com/synadia-ai/nats-agent-sdk-docs`). Every PI session becomes a
 * spec-compliant agent instance: discoverable via `$SRV.PING/INFO`,
 * addressable at `agents.prompt.pi.{owner}.{name}`, emitting typed response
 * chunks and a periodic heartbeat on `agents.hb.pi.{owner}.{name}`.
 *
 * v0.3 breaking changes from v0.2 (this release):
 *   - Subjects move to verb-first: `agents.{verb}.{a}.{o}.{n}` (5 tokens).
 *     prompt → `agents.prompt.pi.{o}.{n}`, heartbeat → `agents.hb.pi.{o}.{n}`.
 *   - New request/response `status` endpoint at `agents.status.pi.{o}.{n}`,
 *     replies with the same payload shape as a heartbeat (§8.3).
 *   - `metadata.protocol_version` `"0.2"` → `"0.3"`.
 *
 * Attachments: inline per spec §5.1/§5.2. Each `{filename, content}` is
 * base64-decoded (strict RFC 4648 §4 — standard alphabet, padded, no
 * whitespace, no URL-safe), the filename is sanitized, bytes are staged on
 * disk at `<STATE_DIR>/attachments/<session>/<uuid>-<filename>`, and their
 * absolute paths are prepended to the prompt text handed to PI. The staging
 * directory is removed on session shutdown. Spec §5.5's artifact endpoint is
 * still the long-term home for large files; this inline path is the
 * small-file story for v0.3.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";

import {
	connect,
	credsAuthenticator,
	jwtAuthenticator,
	nkeyAuthenticator,
	tokenAuthenticator,
	usernamePasswordAuthenticator,
	type NatsConnection,
} from "@nats-io/transport-node";
import type { NodeConnectionOptions } from "@nats-io/transport-node";
import { Svcm } from "@nats-io/services";
import type { Service, ServiceMsg } from "@nats-io/services";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ─────────────────────────────────────────────────────────────────────────────
// Protocol constants (mirror @synadia-ai/agents spec)
// ─────────────────────────────────────────────────────────────────────────────

// Spec §3.1: the service name is the bare token `agents`. Subject-safe as-is,
// so no compact/canonical split needed.
const SERVICE_NAME = "agents";
// Spec §3.3: the `prompt` endpoint MUST be registered with this queue group.
const PROMPT_QUEUE_GROUP = "agents";
// §8.7 (v0.3): the `status` endpoint shares the prompt's queue group so callers
// load-balance to one responder per logical agent.
const STATUS_QUEUE_GROUP = "agents";
const SERVICE_VERSION = "0.3.0";
const PROTOCOL_VERSION = "0.3";

// Spec §2, Appendix C: `pi` is both the canonical agent identifier and its
// conventional subject abbreviation.
const AGENT_ID = "pi";

// Spec §2.1: endpoint capability metadata advertised on the `prompt` endpoint.
// The actual values used at runtime come from `nc.info.max_payload` after
// connect — that's the negotiated limit for this user/account, so it's also
// what we advertise and enforce on inbound requests. These constants are
// fallbacks for the (rare) case where `INFO` is unavailable.
export const DEFAULT_MAX_PAYLOAD_STR = "1MB";
export const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024; // base-1024, matching NATS server convention
const ATTACHMENTS_OK = true;

/** Format a byte count back into the §2.1 `\d+(B|KB|MB|GB)` grammar (base-1024). */
export function formatMaxPayloadString(bytes: number): string {
	if (bytes >= 1024 ** 3 && bytes % 1024 ** 3 === 0) return `${bytes / 1024 ** 3}GB`;
	if (bytes >= 1024 ** 2 && bytes % 1024 ** 2 === 0) return `${bytes / 1024 ** 2}MB`;
	if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024}KB`;
	return `${bytes}B`;
}

// Spec §8.2: default 30s cadence.
const HEARTBEAT_INTERVAL_S = 30;

// Keep-alive `ack` status emitted during long tool runs so the caller's
// inactivity timer (§6.6, typically 60s) doesn't fire before text_delta output.
const ACK_KEEPALIVE_MS = 20_000;

// ─────────────────────────────────────────────────────────────────────────────
// Config / paths
// ─────────────────────────────────────────────────────────────────────────────

const STATE_DIR = join(homedir(), ".pi", "agent");
const CONFIG_FILE = join(STATE_DIR, "nats-channel.json");
const ATTACHMENTS_ROOT = join(STATE_DIR, "attachments");
const NATS_CONTEXT_DIR = join(homedir(), ".config", "nats", "context");

const DEFAULT_CONTEXT: NatsContext = {
	url: "demo.nats.io",
	description: "NATS demo server (no auth)",
};

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type PiNatsConfig = {
	context?: string;
	sessionName?: string;
};

// Matches NATS CLI context files at ~/.config/nats/context/<name>.json.
type NatsContext = {
	description?: string;
	url?: string;
	token?: string;
	user?: string;
	password?: string;
	creds?: string;
	nkey?: string;
	cert?: string;
	key?: string;
	ca?: string;
	tls_first?: boolean;
	inbox_prefix?: string;
	user_jwt?: string;
	user_seed?: string;
	socks_proxy?: string;
};

type DecodedAttachment = {
	filename: string; // sanitized basename
	bytes: Uint8Array;
};

type PendingRequest = {
	msg: ServiceMsg;
	replySubject: string;
	prompt: string;
	attachments: DecodedAttachment[];
	createdAt: number;
};

type ParsedEnvelope =
	| { ok: true; prompt: string; attachments: DecodedAttachment[] }
	| { ok: false; code: 400; error: string };

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sanitize a subject token per spec §2.2 SHOULD rules: [a-z0-9_-], lowercase,
 * no leading/trailing dashes. Replaces disallowed characters with `-`.
 */
function sanitizeSubjectToken(s: string): string {
	return s
		.replace(/[^a-zA-Z0-9_-]/g, "-")
		.toLowerCase()
		.replace(/^-+|-+$/g, "");
}

function loadNatsContext(name: string): NatsContext {
	// Reject names that would escape the context directory. `$NATS_CONTEXT`
	// is set by deployers, not random users, but a clear error beats a
	// stale-file `no 'url' field` message at 3am, and the cost is one
	// guard. Mirrors the validation in
	// `agents/openclaw/src/nats/context-loader.ts`.
	if (
		!name ||
		name.includes("/") ||
		name.includes("\\") ||
		name.includes("\0") ||
		name === ".." ||
		name.startsWith(".")
	) {
		throw new Error(
			`NATS context name ${JSON.stringify(name)} is invalid (must not contain path separators or start with '.')`,
		);
	}
	const contextFile = join(NATS_CONTEXT_DIR, `${name}.json`);
	try {
		return JSON.parse(readFileSync(contextFile, "utf8")) as NatsContext;
	} catch (err) {
		throw new Error(
			`NATS context "${name}" not found at ${contextFile} (${(err as Error).message})`,
		);
	}
}

// Parse a NATS URL into a partial `NodeConnectionOptions`, extracting
// credentials from `userinfo` if present. Without this, a URL like
// `nats://TOKEN@host:port` would silently drop the token because
// `@nats-io/transport-node` doesn't parse credentials from URLs (the
// `nats` CLI does, which is the UX gap this closes). Inlined per the
// repo CLAUDE.md "Agents do NOT depend on the SDK" rule —
// byte-equivalent of `@synadia-ai/agents`'s `parseNatsUrl`. Supports
// comma-separated cluster URLs (the form `@nats-io/transport-node`
// accepts via `servers: string`).
type ParsedSingle = { server: string; token?: string; user?: string; pass?: string };
function parseSingleNatsUrl(part: string, original: string): ParsedSingle {
	const withScheme = /^[a-z]+:\/\//i.test(part) ? part : `nats://${part}`;
	let parsed: URL;
	try {
		parsed = new URL(withScheme);
	} catch (e) {
		throw new Error(`invalid NATS URL ${JSON.stringify(original)}: ${(e as Error).message}`);
	}
	if (!/^(nats|tls|ws|wss):$/.test(parsed.protocol)) {
		throw new Error(`unsupported scheme "${parsed.protocol}" in NATS URL ${JSON.stringify(original)}`);
	}
	if (!parsed.host) {
		throw new Error(`NATS URL ${JSON.stringify(original)} is missing a host`);
	}
	const out: ParsedSingle = { server: `${parsed.protocol}//${parsed.host}` };
	// WHATWG `URL` squashes `nats://user@host` and `nats://user:@host` into
	// `password === ""`; sniff raw input for a colon to recover the intent.
	const userinfoMatch = withScheme.match(/^[a-z]+:\/\/([^/@]*)@/i);
	const hasColonSeparator = (userinfoMatch?.[1] ?? "").includes(":");
	if (hasColonSeparator) {
		out.user = decodeURIComponent(parsed.username);
		out.pass = decodeURIComponent(parsed.password);
	} else if (parsed.username !== "") {
		out.token = decodeURIComponent(parsed.username);
	}
	return out;
}
function parseNatsUrl(url: string): { servers: string[]; token?: string; user?: string; pass?: string } {
	const parts = url.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
	if (parts.length === 0) {
		throw new Error(`empty NATS URL: ${JSON.stringify(url)}`);
	}
	const parsedAll = parts.map((p) => parseSingleNatsUrl(p, url));
	const first = parsedAll[0]!;
	// Mixed userinfo across cluster entries can't be expressed in one
	// ConnectionOptions — fail loudly rather than silently drop credentials.
	for (const p of parsedAll.slice(1)) {
		if (p.token !== first.token || p.user !== first.user || p.pass !== first.pass) {
			throw new Error(`NATS URL has mixed credentials across server entries: ${url}`);
		}
	}
	const out: { servers: string[]; token?: string; user?: string; pass?: string } = {
		servers: parsedAll.map((p) => p.server),
	};
	if (first.token !== undefined) out.token = first.token;
	if (first.user !== undefined) out.user = first.user;
	if (first.pass !== undefined) out.pass = first.pass;
	return out;
}

function contextToConnectOpts(ctx: NatsContext): NodeConnectionOptions {
	const opts: NodeConnectionOptions = { name: "pi-nats-channel" };

	// Parse the URL once; extracted userinfo serves as a fallback only when
	// no explicit context-file auth field is set (precedence below).
	const urlOpts = ctx.url ? parseNatsUrl(ctx.url) : null;
	if (urlOpts) {
		opts.servers = urlOpts.servers;
	}

	// Auth precedence: explicit context fields > URL userinfo. So a context
	// file with `token: "abc"` wins over `url: "nats://xyz@host:port"`.
	if (ctx.creds) {
		opts.authenticator = credsAuthenticator(readFileSync(ctx.creds));
	} else if (ctx.nkey) {
		opts.authenticator = nkeyAuthenticator(readFileSync(ctx.nkey));
	} else if (ctx.user_jwt && ctx.user_seed) {
		const seed = new TextEncoder().encode(ctx.user_seed);
		opts.authenticator = jwtAuthenticator(ctx.user_jwt, seed);
	} else if (ctx.token) {
		opts.authenticator = tokenAuthenticator(ctx.token);
	} else if (ctx.user) {
		opts.authenticator = usernamePasswordAuthenticator(ctx.user, ctx.password ?? "");
	} else if (urlOpts?.token) {
		opts.authenticator = tokenAuthenticator(urlOpts.token);
	} else if (urlOpts?.user !== undefined) {
		opts.authenticator = usernamePasswordAuthenticator(urlOpts.user, urlOpts.pass ?? "");
	}

	if (ctx.cert || ctx.key || ctx.ca) {
		opts.tls = {
			certFile: ctx.cert || undefined,
			keyFile: ctx.key || undefined,
			caFile: ctx.ca || undefined,
			handshakeFirst: ctx.tls_first || undefined,
		};
	}

	if (ctx.inbox_prefix) opts.inboxPrefix = ctx.inbox_prefix;

	return opts;
}

function loadConfig(): PiNatsConfig {
	try {
		return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as PiNatsConfig;
	} catch {
		return {};
	}
}

function saveConfig(cfg: PiNatsConfig): void {
	mkdirSync(STATE_DIR, { recursive: true });
	writeFileSync(CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}

/**
 * Strict RFC 4648 §4 base64 per spec §5.2: standard alphabet, padded, no
 * whitespace, no URL-safe. `Buffer.from(_, "base64")` is tolerant of all
 * three relaxations, so we validate the shape first and only decode if it
 * passes.
 */
const STRICT_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeStrictBase64(s: string): Uint8Array | null {
	if (s.length % 4 !== 0) return null;
	if (!STRICT_BASE64.test(s)) return null;
	return new Uint8Array(Buffer.from(s, "base64"));
}

/**
 * Validate a caller-supplied filename. Strict: rejects anything that isn't a
 * plain basename. We deliberately do NOT auto-normalize (`basename("../x")`
 * → `x`) because silently rewriting the name would hide the caller's intent
 * and let a buggy SDK ship structured paths we've quietly flattened.
 */
function sanitizeFilename(raw: string): string | null {
	if (raw.length === 0 || raw.length > 255) return null;
	if (raw.includes("\0")) return null;
	if (raw.includes("/") || raw.includes("\\")) return null;
	if (raw === "." || raw === "..") return null;
	// A name equal to its basename, not composed of only dots (e.g. "...").
	if (basename(raw) !== raw) return null;
	return raw;
}

/**
 * Parse a request payload per spec §5.1 / §5.3.
 *
 * 1. Zero-byte → 400.
 * 2. Skip leading UTF-8 whitespace (0x09/0x0A/0x0D/0x20).
 * 3. If the next byte is `{`: parse JSON; require a string `prompt` field.
 *    When `attachments_ok` is true, decode each attachment's base64 content
 *    and sanitize its filename here so the handler only deals with vetted,
 *    in-memory bytes.
 * 4. Otherwise: promote the raw payload to `{prompt: <payload>}`.
 *
 * Unknown envelope fields (e.g. `from`) are tolerated and silently ignored by
 * us — spec §5.6 requires decoders to preserve them on relay; since we don't
 * relay, we just don't inspect them.
 */
function parseEnvelope(data: Uint8Array): ParsedEnvelope {
	if (data.byteLength === 0) {
		return { ok: false, code: 400, error: "empty payload" };
	}

	let i = 0;
	while (
		i < data.byteLength &&
		(data[i] === 0x09 || data[i] === 0x0a || data[i] === 0x0d || data[i] === 0x20)
	) {
		i++;
	}
	if (i === data.byteLength) {
		return { ok: false, code: 400, error: "empty payload after whitespace" };
	}

	if (data[i] === 0x7b /* '{' */) {
		const text = new TextDecoder().decode(data);
		let obj: unknown;
		try {
			obj = JSON.parse(text);
		} catch {
			return { ok: false, code: 400, error: "invalid JSON envelope" };
		}
		if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
			return { ok: false, code: 400, error: "envelope must be a JSON object" };
		}
		const rec = obj as Record<string, unknown>;
		if (typeof rec.prompt !== "string" || rec.prompt.length === 0) {
			return { ok: false, code: 400, error: "envelope missing non-empty string 'prompt'" };
		}

		const decoded: DecodedAttachment[] = [];
		if (rec.attachments !== undefined) {
			if (!Array.isArray(rec.attachments)) {
				return { ok: false, code: 400, error: "attachments must be an array" };
			}
			for (let idx = 0; idx < rec.attachments.length; idx++) {
				const a = rec.attachments[idx];
				if (typeof a !== "object" || a === null || Array.isArray(a)) {
					return { ok: false, code: 400, error: `attachment[${idx}] must be an object` };
				}
				const ar = a as Record<string, unknown>;
				if (typeof ar.filename !== "string") {
					return { ok: false, code: 400, error: `attachment[${idx}] missing string 'filename'` };
				}
				if (typeof ar.content !== "string") {
					return { ok: false, code: 400, error: `attachment[${idx}] missing string 'content'` };
				}
				const safeName = sanitizeFilename(ar.filename);
				if (safeName === null) {
					return {
						ok: false,
						code: 400,
						error: `attachment[${idx}] has unsafe filename`,
					};
				}
				const bytes = decodeStrictBase64(ar.content);
				if (bytes === null) {
					return {
						ok: false,
						code: 400,
						error: `attachment[${idx}] has invalid base64 content`,
					};
				}
				decoded.push({ filename: safeName, bytes });
			}
		}
		return { ok: true, prompt: rec.prompt, attachments: decoded };
	}

	// Plain-text shorthand (§5.1).
	const text = new TextDecoder().decode(data);
	return { ok: true, prompt: text, attachments: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Subject helpers
// ─────────────────────────────────────────────────────────────────────────────

// Subject helpers (§2 v0.3 — verb-first). Mirrors the SDK's `AgentSubject`
// helper but inlined here per the agents/* convention of staying on raw
// `@nats-io/*` rather than depending on `@synadia-ai/agents`.
function buildPromptSubject(owner: string, name: string): string {
	return `agents.prompt.${AGENT_ID}.${owner}.${name}`;
}

function buildHeartbeatSubject(owner: string, name: string): string {
	return `agents.hb.${AGENT_ID}.${owner}.${name}`;
}

function buildStatusSubject(owner: string, name: string): string {
	return `agents.status.${AGENT_ID}.${owner}.${name}`;
}

/**
 * Query existing `agents` service instances and pick the first candidate session
 * name whose `prompt` endpoint subject is free. Auto-suffixes `-2`, `-3`, …
 *
 * Only this owner/agent's subjects can collide with ours (different agent
 * identifiers don't share subjects), so we don't need to filter the discovery
 * response — `taken.has(buildPromptSubject(owner, candidate))` excludes other
 * namespaces naturally.
 */
async function resolveSessionName(
	nc: NatsConnection,
	base: string,
	owner: string,
): Promise<string> {
	const svcm = new Svcm(nc);
	const client = svcm.client({ strategy: "stall", maxWait: 1000, maxMessages: 50 });

	const taken = new Set<string>();
	try {
		const iter = await client.info(SERVICE_NAME);
		for await (const si of iter) {
			for (const ep of si.endpoints ?? []) {
				taken.add(ep.subject);
			}
		}
	} catch {
		// No existing services or timeout — fine.
	}

	let candidate = base;
	let suffix = 2;
	while (taken.has(buildPromptSubject(owner, candidate))) {
		candidate = `${base}-${suffix++}`;
	}
	return candidate;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension default export
// ─────────────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let nc: NatsConnection | undefined;
	let service: Service | undefined;
	let promptSubject: string | undefined;
	let heartbeatSubject: string | undefined;
	let statusSubject: string | undefined;
	let sessionName: string | undefined;
	let owner: string | undefined;
	let instanceId: string | undefined;
	let piCtx: ExtensionContext | undefined;
	let contextLabel: string | undefined;
	let serverUrl: string | undefined;
	// Filled in after connect from `nc.info?.max_payload`; falls back to the
	// 1MB defaults if the server INFO block is unavailable.
	let maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES;
	let maxPayloadStr = DEFAULT_MAX_PAYLOAD_STR;

	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	let ackTimer: ReturnType<typeof setInterval> | undefined;

	const pendingRequests = new Map<string, PendingRequest>();
	const requestQueue: string[] = [];
	let activeRequestId: string | null = null;
	let requestCounter = 0;

	// Prune pending requests older than 30 min (skip the active one).
	const pruneInterval = setInterval(() => {
		const cutoff = Date.now() - 30 * 60 * 1000;
		for (const [id, req] of pendingRequests) {
			if (id === activeRequestId) continue;
			if (req.createdAt < cutoff) pendingRequests.delete(id);
		}
	}, 60_000);
	pruneInterval.unref();

	// ───────────────────────────────────────────────────────────────────────
	// Chunk publishing (§6)
	// ───────────────────────────────────────────────────────────────────────

	/** Publish a typed chunk `{type, data}` to the reply subject (§6.2). */
	function publishTypedChunk(replySubject: string, type: string, data: unknown): void {
		if (!nc) return;
		nc.publish(replySubject, JSON.stringify({ type, data }));
	}

	/**
	 * Publish response text as one or more `{type:"response",data:<text>}`
	 * chunks. If the encoded JSON would exceed the server's max_payload,
	 * split the TEXT at UTF-8 codepoint boundaries and emit multiple chunks
	 * — never split JSON mid-object.
	 */
	function publishResponseText(replySubject: string, text: string): void {
		if (!nc || text.length === 0) return;
		const serverMax = maxPayloadBytes;
		// Reserve for the `{"type":"response","data":""}` wrapper + JSON escapes.
		const reserve = 256;
		const textBudget = Math.max(1, serverMax - reserve);

		const bytes = new TextEncoder().encode(text);
		if (bytes.byteLength <= textBudget) {
			publishTypedChunk(replySubject, "response", text);
			return;
		}

		let offset = 0;
		while (offset < bytes.byteLength) {
			let end = Math.min(offset + textBudget, bytes.byteLength);
			// Back off to a UTF-8 codepoint boundary (continuation bytes are 10xxxxxx).
			if (end < bytes.byteLength) {
				while (end > offset && (bytes[end]! & 0xc0) === 0x80) end--;
				if (end === offset) end = Math.min(offset + textBudget, bytes.byteLength);
			}
			const sub = new TextDecoder().decode(bytes.subarray(offset, end));
			publishTypedChunk(replySubject, "response", sub);
			offset = end;
		}
	}

	/**
	 * Publish the end-of-stream terminator: zero-byte body AND no headers
	 * (§6.5). `nc.publish(subject, "")` with no options satisfies both.
	 */
	async function publishTerminator(replySubject: string): Promise<void> {
		if (!nc) return;
		try {
			nc.publish(replySubject, "");
			await nc.flush();
		} catch {
			// best effort — usually disconnecting
		}
	}

	function startAckKeepalive(replySubject: string): void {
		stopAckKeepalive();
		ackTimer = setInterval(() => {
			if (!nc) return;
			try {
				publishTypedChunk(replySubject, "status", "ack");
			} catch {
				// best effort
			}
		}, ACK_KEEPALIVE_MS);
		ackTimer.unref?.();
	}

	function stopAckKeepalive(): void {
		if (ackTimer) {
			clearInterval(ackTimer);
			ackTimer = undefined;
		}
	}

	// ───────────────────────────────────────────────────────────────────────
	// Inbound handler + queue drain
	// ───────────────────────────────────────────────────────────────────────

	function handleNatsMessage(err: Error | null, msg: ServiceMsg): void {
		if (err) {
			piCtx?.ui.notify(`NATS handler error: ${err.message}`, "error");
			return;
		}
		if (!msg.reply) {
			// Pub-only delivery can't receive a stream — silently drop.
			return;
		}

		// §5.4 local enforcement.
		if (msg.data.byteLength > maxPayloadBytes) {
			respondWithError(msg, 400, `payload exceeds max_payload (${maxPayloadStr})`);
			return;
		}

		const parsed = parseEnvelope(msg.data);
		if (!parsed.ok) {
			respondWithError(msg, parsed.code, parsed.error);
			return;
		}

		if (parsed.attachments.length > 0 && !ATTACHMENTS_OK) {
			respondWithError(msg, 400, "this agent does not accept attachments (attachments_ok=false)");
			return;
		}

		const requestId = String(++requestCounter);
		pendingRequests.set(requestId, {
			msg,
			replySubject: msg.reply,
			prompt: parsed.prompt,
			attachments: parsed.attachments,
			createdAt: Date.now(),
		});
		requestQueue.push(requestId);
		drainQueue();
	}

	/**
	 * Respond with a spec §9 error — `respondError` sets the header message,
	 * then we publish the empty terminator per §9.3 / §6.5.
	 */
	function respondWithError(msg: ServiceMsg, code: number, description: string): void {
		try {
			msg.respondError(code, description);
		} catch (e) {
			piCtx?.ui.notify(`NATS: respondError failed: ${(e as Error).message}`, "warning");
		}
		if (msg.reply && nc) {
			try {
				nc.publish(msg.reply, "");
			} catch {
				// best effort
			}
		}
	}

	function drainQueue(): void {
		if (activeRequestId) return;
		if (!piCtx || !piCtx.isIdle()) return;

		while (requestQueue.length > 0) {
			const next = requestQueue.shift()!;
			const pending = pendingRequests.get(next);
			if (!pending) continue;

			// Stage attachments to disk and prepend their absolute paths to the
			// prompt. Staging failures (disk full, permission denied) surface to
			// the caller as 500 so they can distinguish them from validation
			// errors — envelope was well-formed, we just couldn't process it.
			let finalPrompt: string;
			try {
				finalPrompt = stageAttachmentsIntoPrompt(pending.prompt, pending.attachments);
			} catch (e) {
				respondWithError(pending.msg, 500, `attachment staging failed: ${(e as Error).message}`);
				pendingRequests.delete(next);
				continue;
			}

			activeRequestId = next;
			try {
				// Tell the caller work has been accepted — resets their inactivity
				// timer before the first text_delta (§6.4).
				publishTypedChunk(pending.replySubject, "status", "ack");
				startAckKeepalive(pending.replySubject);
				pi.sendUserMessage(finalPrompt);
				return;
			} catch (e) {
				activeRequestId = null;
				stopAckKeepalive();
				requestQueue.unshift(next);
				piCtx.ui.notify(
					`NATS: deferred injection (${(e as Error).message})`,
					"warning",
				);
				return;
			}
		}
	}

	/**
	 * Write each attachment to `<ATTACHMENTS_ROOT>/<session>/<uuid>-<filename>`
	 * and prepend an "[Attachments]" block to the prompt listing their absolute
	 * paths. Returns the augmented prompt.
	 *
	 * Each call uses a fresh UUID subdir so concurrent-looking callers (shouldn't
	 * happen — we serialize — but defense in depth) can't collide. The parent
	 * `<session>` dir is removed on session_shutdown; we don't clean per-request
	 * because follow-up turns in the same session may still reference the paths.
	 */
	function stageAttachmentsIntoPrompt(
		prompt: string,
		attachments: DecodedAttachment[],
	): string {
		if (attachments.length === 0) return prompt;
		if (!sessionName) throw new Error("session not initialized");
		const reqDir = join(ATTACHMENTS_ROOT, sessionName, randomUUID());
		mkdirSync(reqDir, { recursive: true });
		const paths: string[] = [];
		for (const a of attachments) {
			const target = join(reqDir, a.filename);
			writeFileSync(target, a.bytes);
			paths.push(target);
		}
		const list = paths.map((p) => `- ${p}`).join("\n");
		return `[Attachments available at the following absolute paths]\n${list}\n\n${prompt}`;
	}

	// ───────────────────────────────────────────────────────────────────────
	// Heartbeat (§8)
	// ───────────────────────────────────────────────────────────────────────

	function heartbeatPayload(): string {
		return JSON.stringify({
			agent: AGENT_ID,
			owner,
			session: sessionName,
			instance_id: instanceId,
			ts: new Date().toISOString(),
			interval_s: HEARTBEAT_INTERVAL_S,
		});
	}

	/**
	 * §8.7 (v0.3) status endpoint handler. Replies with the same JSON payload
	 * shape as a heartbeat (§8.3), freshly built per request — future PRs can
	 * extend the response with richer agent metadata in one place.
	 */
	function handleStatusRequest(err: Error | null, msg: ServiceMsg): void {
		if (err) {
			piCtx?.ui.notify(`NATS status handler error: ${err.message}`, "error");
			return;
		}
		try {
			msg.respond(heartbeatPayload());
		} catch (e) {
			try {
				msg.respondError(500, `status handler error: ${(e as Error).message}`);
			} catch {
				// connection may already be gone
			}
		}
	}

	function startHeartbeat(): void {
		stopHeartbeat();
		if (!nc || !heartbeatSubject) return;
		const publish = (): void => {
			if (!nc || !heartbeatSubject) return;
			try {
				nc.publish(heartbeatSubject, heartbeatPayload());
			} catch {
				// best effort — status loop surfaces real connectivity issues
			}
		};
		// Emit one immediately so callers discovering us don't wait a full cadence.
		publish();
		heartbeatTimer = setInterval(publish, HEARTBEAT_INTERVAL_S * 1000);
		heartbeatTimer.unref?.();
	}

	function stopHeartbeat(): void {
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
		}
	}

	// ───────────────────────────────────────────────────────────────────────
	// Status loop + cleanup
	// ───────────────────────────────────────────────────────────────────────

	async function startStatusLoop(conn: NatsConnection, ctx: ExtensionContext): Promise<void> {
		try {
			for await (const s of conn.status()) {
				switch (s.type) {
					case "disconnect":
						ctx.ui.setStatus("nats", "NATS: reconnecting…");
						ctx.ui.notify(`NATS disconnected from ${s.server} — retrying…`, "warning");
						break;
					case "reconnect":
						if (promptSubject) ctx.ui.setStatus("nats", `NATS: ${promptSubject}`);
						ctx.ui.notify(`NATS reconnected to ${s.server}`, "info");
						break;
					case "error":
						ctx.ui.notify(`NATS error: ${s.error.message}`, "error");
						break;
				}
			}
		} catch {
			// Status iterator ended.
		}
	}

	async function cleanup(): Promise<void> {
		stopHeartbeat();
		stopAckKeepalive();
		if (service) {
			try {
				await service.stop();
			} catch {}
			service = undefined;
		}
		if (nc) {
			try {
				await nc.drain();
			} catch {}
			nc = undefined;
		}
		clearInterval(pruneInterval);
		// Remove the session's staged attachments directory.
		if (sessionName) {
			try {
				rmSync(join(ATTACHMENTS_ROOT, sessionName), { recursive: true, force: true });
			} catch {}
		}
		piCtx?.ui.setStatus("nats", undefined);
	}

	// ───────────────────────────────────────────────────────────────────────
	// Event wiring
	// ───────────────────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		piCtx = ctx;
		const config = loadConfig();

		// 1. Resolve NATS context. Resolution order (matches pi-headless +
		//    the @synadia-ai/agents examples for cross-agent UX consistency):
		//    1. $NATS_CONTEXT env var
		//    2. config-file `context` field (set via /nats-channel:configure)
		//    3. $NATS_URL env var (raw URL; userinfo extracted via parseNatsUrl
		//       at connect time)
		//    4. built-in default (demo.nats.io, no auth)
		const ctxName = process.env.NATS_CONTEXT ?? config.context;
		const envUrl = process.env.NATS_URL;
		let natsCtx: NatsContext;
		try {
			if (ctxName) {
				natsCtx = loadNatsContext(ctxName);
			} else if (envUrl) {
				natsCtx = { url: envUrl, description: "from $NATS_URL" };
			} else {
				natsCtx = DEFAULT_CONTEXT;
			}
		} catch (e) {
			ctx.ui.notify(`NATS: ${(e as Error).message}`, "error");
			ctx.ui.setStatus("nats", "NATS: disconnected");
			return;
		}
		contextLabel = ctxName ?? (envUrl ? "$NATS_URL" : "default");
		serverUrl = natsCtx.url ?? "demo.nats.io";

		// 2. Resolve owner + session base name
		owner = sanitizeSubjectToken(process.env.USER ?? "unknown") || "unknown";
		const rawSession =
			(process.env.NATS_SESSION_NAME ??
				config.sessionName ??
				sanitizeSubjectToken(basename(ctx.cwd))) || "pi";

		// 3. Connect to NATS
		try {
			const opts = contextToConnectOpts(natsCtx);
			opts.name = `pi-${owner}`;
			nc = await connect(opts);
			if (nc.info?.max_payload) {
				maxPayloadBytes = nc.info.max_payload;
				maxPayloadStr = formatMaxPayloadString(maxPayloadBytes);
			}
		} catch (e) {
			ctx.ui.notify(
				`NATS connection failed (${serverUrl}): ${(e as Error).message}`,
				"error",
			);
			ctx.ui.setStatus("nats", "NATS: disconnected");
			nc = undefined;
			return;
		}

		// 4. Collision-detect the session name
		try {
			sessionName = await resolveSessionName(nc, rawSession, owner);
		} catch (e) {
			ctx.ui.notify(
				`NATS: session name resolution failed: ${(e as Error).message}`,
				"error",
			);
			await cleanup();
			return;
		}
		promptSubject = buildPromptSubject(owner, sessionName);
		heartbeatSubject = buildHeartbeatSubject(owner, sessionName);
		statusSubject = buildStatusSubject(owner, sessionName);

		// 5. Register the microservice instance (§3)
		try {
			const svcm = new Svcm(nc);
			service = await svcm.add({
				name: SERVICE_NAME,
				version: SERVICE_VERSION,
				description: `PI agent (${sessionName}) in ${ctx.cwd}`,
				metadata: {
					agent: AGENT_ID,
					owner,
					session: sessionName,
					protocol_version: PROTOCOL_VERSION,
					// Supplementary — preserved but not spec-normative.
					cwd: ctx.cwd,
				},
				queue: "",
			});
			service.addEndpoint("prompt", {
				subject: promptSubject,
				queue: PROMPT_QUEUE_GROUP,
				handler: handleNatsMessage,
				metadata: {
					max_payload: maxPayloadStr,
					attachments_ok: ATTACHMENTS_OK ? "true" : "false",
				},
			});
			// §8.7 (v0.3): status request/response endpoint. Replies with a
			// freshly-built §8.3 heartbeat payload on every request — same shape
			// as the periodic heartbeat, different transport (request/response
			// instead of pub/sub).
			service.addEndpoint("status", {
				subject: statusSubject,
				queue: STATUS_QUEUE_GROUP,
				handler: handleStatusRequest,
			});
			instanceId = service.info().id;
		} catch (e) {
			ctx.ui.notify(`NATS: service registration failed: ${(e as Error).message}`, "error");
			await cleanup();
			return;
		}

		// 6. Start heartbeat only AFTER service registration — so anyone who
		//    discovers us via the beacon can resolve metadata via $SRV.INFO (§8.2).
		startHeartbeat();

		// 7. UI feedback
		ctx.ui.setStatus("nats", `NATS: ${promptSubject}`);
		ctx.ui.notify(
			`Connected to NATS (${serverUrl}) as ${promptSubject}`,
			"info",
		);

		// 8. Monitor connection status
		void startStatusLoop(nc, ctx);
	});

	pi.on("message_update", async (event) => {
		if (!nc || !activeRequestId) return;
		const ame = event.assistantMessageEvent;
		if (ame.type !== "text_delta" || !ame.delta) return;
		const pending = pendingRequests.get(activeRequestId);
		if (!pending) return;
		try {
			publishResponseText(pending.replySubject, ame.delta);
		} catch (e) {
			piCtx?.ui.notify(`NATS: publish failed: ${(e as Error).message}`, "warning");
		}
	});

	pi.on("agent_end", async () => {
		stopAckKeepalive();
		if (nc && activeRequestId) {
			const pending = pendingRequests.get(activeRequestId);
			if (pending) {
				await publishTerminator(pending.replySubject);
				pendingRequests.delete(activeRequestId);
			}
			activeRequestId = null;
		}
		drainQueue();
	});

	pi.on("session_shutdown", async () => {
		await cleanup();
	});

	// ───────────────────────────────────────────────────────────────────────
	// Commands
	// ───────────────────────────────────────────────────────────────────────

	pi.registerCommand("nats-status", {
		description: "Show NATS channel status",
		handler: async (_args, ctx) => {
			if (!nc || !promptSubject) {
				ctx.ui.notify("NATS: not connected", "warning");
				return;
			}
			const line = [
				`Server: ${serverUrl} (${contextLabel})`,
				`Subject: ${promptSubject}`,
				`Service: ${SERVICE_NAME} v${SERVICE_VERSION}`,
				`Protocol: ${PROTOCOL_VERSION}`,
				`Instance: ${instanceId ?? "?"}`,
				`Session: ${sessionName}`,
				`Owner: ${owner}`,
				`Pending: ${pendingRequests.size}`,
				`Queued: ${requestQueue.length}`,
				`Active: ${activeRequestId ?? "none"}`,
			]
				.filter(Boolean)
				.join(" • ");
			ctx.ui.notify(line, "info");
		},
	});

	pi.registerCommand("nats-configure", {
		description:
			"Show or update NATS channel configuration (usage: /nats-configure [ <context> | session <name|clear> ])",
		handler: async (args, ctx) => {
			const current = loadConfig();
			const tokens = args.trim().split(/\s+/).filter(Boolean);

			if (tokens.length === 0) {
				const lines = [
					`Context: ${current.context ?? "(default: demo.nats.io)"}`,
					`Session: ${current.sessionName ?? "(auto from cwd)"}`,
				];
				ctx.ui.notify(`NATS config — ${lines.join(" • ")}`, "info");
				return;
			}

			const next: PiNatsConfig = { ...current };
			let changed = false;

			if (tokens[0] === "session") {
				if (tokens[1] === "clear") {
					delete next.sessionName;
					changed = true;
				} else if (tokens[1]) {
					next.sessionName = sanitizeSubjectToken(tokens[1]);
					changed = true;
				} else {
					ctx.ui.notify("Usage: /nats-configure session <name|clear>", "warning");
					return;
				}
			} else {
				// Treat as a context switch — validate by loading first.
				const newContext = tokens[0];
				try {
					loadNatsContext(newContext);
				} catch (e) {
					ctx.ui.notify(`NATS: ${(e as Error).message}`, "error");
					return;
				}
				next.context = newContext;
				changed = true;
			}

			if (!changed) {
				ctx.ui.notify("NATS: no changes", "info");
				return;
			}

			try {
				saveConfig(next);
			} catch (e) {
				ctx.ui.notify(`NATS: failed to save config: ${(e as Error).message}`, "error");
				return;
			}

			ctx.ui.notify(
				"NATS config updated. Restart PI for changes to take effect.",
				"info",
			);
		},
	});
}
