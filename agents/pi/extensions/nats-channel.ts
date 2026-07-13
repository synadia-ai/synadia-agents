/**
 * Synadia Agent Protocol for NATS channel for PI Agent.
 *
 * Implements the Synadia Agent Protocol for NATS v0.3 (see
 * `https://github.com/synadia-ai/synadia-agent-sdk-docs`). Every PI session becomes a
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

import {
	AgentSubject,
	PROMPT_QUEUE_GROUP,
	ProtocolError,
	SDK_PROTOCOL_VERSION,
	SERVICE_NAME,
	STATUS_QUEUE_GROUP,
	decodeEnvelope,
	formatHumanBytes,
	parseHumanBytes,
	parseNatsUrl,
	withAgentReconnectDefaults,
} from "@synadia-ai/agents";
import {
	DEFAULT_ATTACHMENTS_OK,
	DEFAULT_MAX_PAYLOAD,
	buildHeartbeatPayload,
	encodeChunk,
	encodeHeartbeatPayload,
	splitResponseText,
} from "@synadia-ai/agent-service";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { resolveOwner, sanitizeSubjectToken } from "./subject.ts";

// ─────────────────────────────────────────────────────────────────────────────
// PI-specific protocol constants
// ─────────────────────────────────────────────────────────────────────────────

const SERVICE_VERSION = "0.4.0";

// Heartbeat cadence on `agents.hb.pi.<owner>.<name>`. Locally pinned at
// 5s so the dashboard's stale-eviction loop (3× intervalS) drops a dead
// `pi` agent in ~15s instead of ~90s. The SDK's
// `DEFAULT_HEARTBEAT_INTERVAL_S` stays at 30s as a sensible third-party
// default — first-party harnesses opt into the snappier cadence.
// Exported so the smoke test asserts the advertised `interval_s` against
// this single source of truth (passes whether it's pinned at 5s or 30s).
export const HEARTBEAT_INTERVAL_S = 5;

// Spec §2, Appendix C: `pi` is both the canonical agent identifier and its
// conventional subject abbreviation, so `metadata.agent` and the wire
// subject's 3rd token are the same — no `subjectToken` override needed.
const AGENT_ID = "pi";

/** Fallback values used only when `nc.info.max_payload` isn't available.
 *  The live cap comes from the broker after connect — see `maxPayloadBytes`
 *  / `maxPayloadStr` in the extension closure. */
const DEFAULT_MAX_PAYLOAD_BYTES_FALLBACK = parseHumanBytes(DEFAULT_MAX_PAYLOAD);

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
	owner?: string;
};

// Matches NATS CLI context files at ~/.config/nats/context/<name>.json.
// Exported for unit tests (test/context.test.ts).
export type NatsContext = {
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

/** Attachment shape used for staging — distinct from the SDK's
 *  `RequestAttachment` so the staging step deals with already-vetted bytes
 *  under a `bytes` key (legacy pi name). Adapter at the decode boundary. */
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

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

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

// Exported for unit tests (test/context.test.ts).
export function contextToConnectOpts(ctx: NatsContext): NodeConnectionOptions {
	const opts: NodeConnectionOptions = { name: "pi-nats-channel" };

	// Parse the URL once; extracted userinfo serves as a fallback only when
	// no explicit context-file auth field is set (precedence below).
	// SDK's `parseNatsUrl` returns `NodeConnectionOptions` with `servers`,
	// plus optional `token`/`user`/`pass` from URL userinfo.
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

	// TLS triple: the context stores file *paths*; load their contents into
	// the standard `tls.cert`/`key`/`ca` options rather than passing the
	// Node-only `certFile`/`keyFile`/`caFile` helper fields, so mTLS
	// contexts work on runtimes whose transports don't expand the helper
	// fields (e.g. Bun). Mirrors the SDK's `loadContextOptions`.
	if (ctx.cert || ctx.key || ctx.ca || ctx.tls_first) {
		const tls: NonNullable<NodeConnectionOptions["tls"]> = {};
		if (ctx.cert) tls.cert = readTlsFile("cert", ctx.cert);
		if (ctx.key) tls.key = readTlsFile("key", ctx.key);
		if (ctx.ca) tls.ca = readTlsFile("ca", ctx.ca);
		if (ctx.tls_first) tls.handshakeFirst = true;
		opts.tls = tls;
	}

	if (ctx.inbox_prefix) opts.inboxPrefix = ctx.inbox_prefix;

	return opts;
}

function readTlsFile(field: string, path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch (err) {
		throw new Error(`failed to read TLS ${field} file ${path}`, { cause: err });
	}
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
 * Query existing `agents` service instances and pick the first candidate session
 * name whose `prompt` endpoint subject is free. Auto-suffixes `-2`, `-3`, …
 *
 * Only this owner/agent's subjects can collide with ours (different agent
 * identifiers don't share subjects), so we don't need to filter the discovery
 * response — `taken.has(...)` excludes other namespaces naturally.
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
	while (taken.has(AgentSubject.new(AGENT_ID, owner, candidate).prompt)) {
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
	// SDK's `DEFAULT_MAX_PAYLOAD` (1MB) if the server INFO block is unavailable.
	let maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES_FALLBACK;
	let maxPayloadStr = DEFAULT_MAX_PAYLOAD;
	let agentSubject: AgentSubject | undefined;

	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	let ackTimer: ReturnType<typeof setInterval> | undefined;

	// Flipped by `cleanup()` so the status loop knows a subsequent `close`
	// is the result of our own drain, not a real outage. Without this,
	// every clean shutdown would notify the user that the agent is
	// "off-bus until restart" — true, but uselessly alarming.
	let shuttingDown = false;

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

	/**
	 * Publish a status chunk on the reply subject (§6.4). Thin wrapper over
	 * the SDK's `encodeChunk` so the call sites stay legible.
	 */
	function publishStatus(replySubject: string, status: string): void {
		if (!nc) return;
		nc.publish(replySubject, encodeChunk({ type: "status", status }));
	}

	/**
	 * Publish response text as one or more `{type:"response",data:<text>}`
	 * chunks (§6.3). Uses the SDK's `splitResponseText` for the UTF-8-safe
	 * split — `reserveBytes: 256` matches the historical pi reserve so chunk
	 * granularity is unchanged from before the SDK migration.
	 */
	function publishResponseText(replySubject: string, text: string): void {
		if (!nc || text.length === 0) return;
		for (const slice of splitResponseText(text, maxPayloadBytes, { reserveBytes: 256 })) {
			nc.publish(replySubject, encodeChunk({ type: "response", text: slice }));
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
				publishStatus(replySubject, "ack");
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

		// SDK's `decodeEnvelope` throws ProtocolError on §5.1/§5.2/§5.3
		// violations (replaces the old `{ok:false, code, error}` shape).
		let envelope: ReturnType<typeof decodeEnvelope>;
		try {
			envelope = decodeEnvelope(msg.data);
		} catch (e) {
			const code = e instanceof ProtocolError ? 400 : 500;
			respondWithError(msg, code, (e as Error).message);
			return;
		}

		const sdkAttachments = envelope.attachments ?? [];
		if (sdkAttachments.length > 0 && !DEFAULT_ATTACHMENTS_OK) {
			respondWithError(msg, 400, "this agent does not accept attachments (attachments_ok=false)");
			return;
		}

		// Adapt the SDK's `RequestAttachment` (`{filename, content: Uint8Array}`)
		// to pi's local `DecodedAttachment` (`{filename, bytes: Uint8Array}`)
		// at the boundary so the staging code below stays unchanged.
		const attachments: DecodedAttachment[] = sdkAttachments.map((a) => ({
			filename: a.filename,
			bytes: a.content,
		}));

		const requestId = String(++requestCounter);
		pendingRequests.set(requestId, {
			msg,
			replySubject: msg.reply,
			prompt: envelope.prompt,
			attachments,
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
				publishStatus(pending.replySubject, "ack");
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

	function buildHeartbeatBytes(): Uint8Array {
		if (!agentSubject || !instanceId) {
			throw new Error("heartbeat called before service was registered");
		}
		return encodeHeartbeatPayload(
			buildHeartbeatPayload(agentSubject, HEARTBEAT_INTERVAL_S, instanceId, {
				session: sessionName,
			}),
		);
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
			msg.respond(buildHeartbeatBytes());
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
				nc.publish(heartbeatSubject, buildHeartbeatBytes());
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
					case "close":
						// Terminal — nats.js has stopped reconnecting (typically a
						// fatal auth error; `maxReconnectAttempts: -1` from
						// `withAgentReconnectDefaults` means we don't expect this
						// from transient drop-outs). Tell the operator so the UI
						// stops claiming we're still "reconnecting…".
						//
						// Skip the notification during our own shutdown — `drain()`
						// also emits `close`, and the operator already knows they
						// asked to exit.
						if (shuttingDown) break;
						ctx.ui.setStatus("nats", "NATS: disconnected");
						ctx.ui.notify(
							"NATS connection closed — agent is off-bus until restart",
							"warning",
						);
						break;
				}
			}
		} catch {
			// Status iterator ended.
		}
	}

	async function cleanup(): Promise<void> {
		shuttingDown = true;
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

	/**
	 * Connect to NATS and register the microservice. May block arbitrarily
	 * long: the SDK's `withAgentReconnectDefaults` sets `waitOnFirstConnect:
	 * true`, so when the broker is unreachable at startup `connect()` keeps
	 * retrying instead of throwing. Invoked from `session_start` via `void`
	 * (NOT awaited) so pi can finish plugin init even when NATS is down —
	 * see the comment in `session_start` for the deadlock this avoids.
	 */
	async function connectAndRegister(
		natsCtx: NatsContext,
		ctx: ExtensionContext,
		rawSession: string,
	): Promise<void> {
		// Connect to NATS. May block indefinitely while the broker is
		// unreachable; the operator sees "NATS: connecting…" in the
		// footer the whole time.
		try {
			const opts = contextToConnectOpts(natsCtx);
			opts.name = `pi-${owner}`;
			nc = await connect(withAgentReconnectDefaults(opts));
			if (nc.info?.max_payload) {
				maxPayloadBytes = nc.info.max_payload;
				maxPayloadStr = formatHumanBytes(maxPayloadBytes);
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

		// `session_shutdown` may have fired while we were stuck in the
		// wait-on-first-connect loop. If so, drop the freshly-opened
		// connection instead of registering on top of a shutdown.
		// Capture `nc` into a local before clearing the shared variable —
		// `cleanup()` may have already raced in between the connect
		// resolving and this guard, drained the connection, and zeroed
		// `nc`. Without the local-variable capture we'd be calling
		// `.close()` on `undefined` and silently swallowing a TypeError.
		if (shuttingDown) {
			const conn = nc;
			nc = undefined;
			if (conn) {
				try {
					await conn.close();
				} catch {}
			}
			return;
		}

		// Collision-detect the session name.
		try {
			sessionName = await resolveSessionName(nc, rawSession, owner!);
		} catch (e) {
			ctx.ui.notify(
				`NATS: session name resolution failed: ${(e as Error).message}`,
				"error",
			);
			await cleanup();
			return;
		}
		// `pi` is both the canonical agent identifier AND its conventional
		// subject abbreviation (Appendix C), so the SDK's default — wire
		// token equals `agent` — is what we want; no `subjectToken` override
		// needed.
		agentSubject = AgentSubject.new(AGENT_ID, owner!, sessionName);
		promptSubject = agentSubject.prompt;
		heartbeatSubject = agentSubject.heartbeat;
		statusSubject = agentSubject.status;

		// Register the microservice instance (§3).
		try {
			const svcm = new Svcm(nc);
			service = await svcm.add({
				name: SERVICE_NAME,
				version: SERVICE_VERSION,
				description: `PI agent (${sessionName}) in ${ctx.cwd}`,
				metadata: {
					agent: AGENT_ID,
					owner: owner!,
					session: sessionName,
					protocol_version: `${SDK_PROTOCOL_VERSION.major}.${SDK_PROTOCOL_VERSION.minor}`,
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
					attachments_ok: DEFAULT_ATTACHMENTS_OK ? "true" : "false",
				},
			});
			// §8.7 (v0.3): status request/response endpoint. Replies with a
			// freshly-built §8.3 heartbeat payload on every request — same
			// shape as the periodic heartbeat, different transport
			// (request/response instead of pub/sub).
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

		// Start heartbeat only AFTER service registration — so anyone who
		// discovers us via the beacon can resolve metadata via $SRV.INFO (§8.2).
		startHeartbeat();

		// UI feedback.
		ctx.ui.setStatus("nats", `NATS: ${promptSubject}`);
		ctx.ui.notify(
			`Connected to NATS (${serverUrl}) as ${promptSubject}`,
			"info",
		);

		// Monitor connection status.
		void startStatusLoop(nc, ctx);
	}

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

		// 2. Resolve owner + session base name via the SYNADIA_* identity
		//    convention shared across agents/*: per-agent env var >
		//    fleet-wide env var > legacy env alias > config file > derived
		//    fallback. Env beats the config file — uniform with flue,
		//    opencode, openclaw and pi's own session-name handling. (This
		//    flips the pre-SYNADIA owner precedence where `config.owner`
		//    won over `$NATS_PI_OWNER` — see CHANGELOG.) See
		//    `subject.ts#resolveOwner`.
		owner = resolveOwner(
			process.env.SYNADIA_PI_OWNER,
			process.env.SYNADIA_OWNER,
			process.env.NATS_PI_OWNER,
			config.owner,
			process.env.USER,
		);
		// First-present-wins-then-sanitize, mirroring resolveOwner: the
		// winning source is coerced into a legal subject token (pi's
		// coerce-via-sanitize convention) rather than passed through raw —
		// previously env values reached AgentSubject.new unsanitized. A
		// winner that sanitizes to empty falls back to "pi"; it does NOT
		// cascade to the next source.
		const rawSession =
			sanitizeSubjectToken(
				process.env.SYNADIA_PI_NAME ??
					process.env.SYNADIA_NAME ??
					process.env.NATS_SESSION_NAME ??
					config.sessionName ??
					basename(ctx.cwd),
			) || "pi";

		// 3. Kick off connect + register in the background — see
		//    `connectAndRegister` for the rationale. Awaiting it here would
		//    deadlock pi's plugin-init pipeline whenever the broker is
		//    unreachable at startup, because the SDK's resilient defaults
		//    (`waitOnFirstConnect: true`) make `connect()` retry forever
		//    instead of throwing. Pi serializes session_start handlers; the
		//    user would be unable to prompt their own session until NATS
		//    came up. Returning here lets pi finish booting; the NATS
		//    agent registers in the background once the broker is
		//    reachable.
		ctx.ui.setStatus("nats", "NATS: connecting…");
		void connectAndRegister(natsCtx, ctx, rawSession);
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
				`Protocol: ${SDK_PROTOCOL_VERSION.major}.${SDK_PROTOCOL_VERSION.minor}`,
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
			"Show or update NATS channel configuration (usage: /nats-configure [ <context> | session <name|clear> | owner <name|clear> ])",
		handler: async (args, ctx) => {
			const current = loadConfig();
			const tokens = args.trim().split(/\s+/).filter(Boolean);

			if (tokens.length === 0) {
				const lines = [
					`Context: ${current.context ?? "(default: demo.nats.io)"}`,
					`Owner: ${current.owner ?? "(default: $USER)"}`,
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
			} else if (tokens[0] === "owner") {
				if (tokens[1] === "clear") {
					delete next.owner;
					changed = true;
				} else if (tokens[1]) {
					// Note: the SYNADIA_PI_OWNER / SYNADIA_OWNER / NATS_PI_OWNER
					// env vars take precedence over this config field.
					next.owner = sanitizeSubjectToken(tokens[1]);
					changed = true;
				} else {
					ctx.ui.notify("Usage: /nats-configure owner <name|clear>", "warning");
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
