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

import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Svcm } from "@nats-io/services";

import {
  AgentSubject,
  SDK_PROTOCOL_VERSION,
  SERVICE_NAME,
  formatSender,
  parseHumanBytes,
  resolveNatsConnectionBundle,
  withAgentReconnectDefaults,
  type MinSenderTrust,
  type NatsConnectionBundle,
  type NatsConnectionSource,
} from "@synadia-ai/agents";
import {
  AgentService,
  DEFAULT_MAX_PAYLOAD,
  splitResponseText,
} from "@synadia-ai/agent-service";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { PiPromptQueue, type QueuedPiPrompt } from "./prompt-queue.ts";
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
 *  in the extension closure. */
const DEFAULT_MAX_PAYLOAD_BYTES_FALLBACK = parseHumanBytes(DEFAULT_MAX_PAYLOAD);

// AgentService owns the leading acknowledgement and keeps queued/active
// request streams alive while PI completes its event-driven turn.
const KEEPALIVE_INTERVAL_S = 20;

const QUEUED_PROMPT_TTL_MS = 30 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Config / paths
// ─────────────────────────────────────────────────────────────────────────────

const STATE_DIR = join(homedir(), ".pi", "agent");
const CONFIG_FILE = join(STATE_DIR, "nats-channel.json");
const ATTACHMENTS_ROOT = join(STATE_DIR, "attachments");
const DEFAULT_NATS_URL = "demo.nats.io";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SenderIdentityMode = "off" | "signed";

export type PiNatsConfig = {
  context?: string;
  sessionName?: string;
  owner?: string;
  senderIdentity?: SenderIdentityMode;
  minSenderTrust?: MinSenderTrust;
};

export type PiConnectionSettings = {
  readonly source: NatsConnectionSource;
  readonly contextLabel: string;
  readonly senderIdentity: SenderIdentityMode;
  readonly minSenderTrust: MinSenderTrust;
};

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

function parseChoice<T extends string>(
  name: string,
  value: string | undefined,
  fallback: T,
  allowed: readonly T[],
): T {
  if (value === undefined || value === "") return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(
    `${name} must be one of ${allowed.join(", ")}; got ${JSON.stringify(value)}`,
  );
}

/** Resolve source and independent outgoing-identity/inbound-trust modes. */
export function resolveConnectionSettings(
  config: PiNatsConfig,
  env: NodeJS.ProcessEnv = process.env,
): PiConnectionSettings {
  const context = env.NATS_CONTEXT ?? config.context;
  const url = env.NATS_URL;
  const source: NatsConnectionSource = context
    ? { context }
    : { url: url || DEFAULT_NATS_URL };
  return {
    source,
    contextLabel: context ?? (url ? "$NATS_URL" : "default"),
    senderIdentity: parseChoice(
      "NATS_SENDER_IDENTITY/senderIdentity",
      env.NATS_SENDER_IDENTITY ?? config.senderIdentity,
      "off",
      ["off", "signed"],
    ),
    minSenderTrust: parseChoice(
      "NATS_MIN_SENDER_TRUST/minSenderTrust",
      env.NATS_MIN_SENDER_TRUST ?? config.minSenderTrust,
      "any",
      ["any", "signed"],
    ),
  };
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
  const client = svcm.client({
    strategy: "stall",
    maxWait: 1000,
    maxMessages: 50,
  });

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
  let service: AgentService | undefined;
  let connectionBundle: NatsConnectionBundle | undefined;
  let promptSubject: string | undefined;
  let sessionName: string | undefined;
  let owner: string | undefined;
  let instanceId: string | undefined;
  let piCtx: ExtensionContext | undefined;
  let contextLabel: string | undefined;
  let senderIdentity: SenderIdentityMode = "off";
  let minSenderTrust: MinSenderTrust = "any";
  // Filled in after connect from `nc.info?.max_payload`; falls back to the
  // SDK's `DEFAULT_MAX_PAYLOAD` if the server INFO block is unavailable.
  let maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES_FALLBACK;
  let injectionRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let connectRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let wakeConnectRetry: (() => void) | undefined;
  let connectTask: Promise<void> | undefined;
  let pendingConnection: NatsConnection | undefined;
  let pendingConnectionBundle: NatsConnectionBundle | undefined;

  // Flipped by `cleanup()` so the status loop knows a subsequent `close`
  // is the result of our own drain, not a real outage. Without this,
  // every clean shutdown would notify the user that the agent is
  // "off-bus until restart" — true, but uselessly alarming.
  let shuttingDown = false;

  const promptQueue = new PiPromptQueue();

  // Expiration rejects the deferred handler. AgentService then emits the
  // error and mandatory terminator; a request is never silently forgotten.
  const pruneInterval = setInterval(() => {
    promptQueue.expireQueued(Date.now() - QUEUED_PROMPT_TTL_MS);
  }, 60_000);
  pruneInterval.unref();

  // ───────────────────────────────────────────────────────────────────────
  // Deferred AgentService handler + PI queue drain
  // ───────────────────────────────────────────────────────────────────────

  async function publishResponseText(
    request: QueuedPiPrompt,
    text: string,
  ): Promise<void> {
    if (text.length === 0) return;
    for (const slice of splitResponseText(text, maxPayloadBytes, {
      reserveBytes: 256,
    })) {
      await request.response.send({ type: "response", text: slice });
    }
  }

  function drainQueue(): void {
    if (promptQueue.active) return;
    if (!piCtx || !piCtx.isIdle()) return;

    while (promptQueue.queuedCount > 0) {
      const pending = promptQueue.takeNext();
      if (!pending) return;

      let finalPrompt: string;
      try {
        finalPrompt = stageAttachmentsIntoPrompt(
          pending.prompt,
          pending.attachments,
        );
      } catch (e) {
        promptQueue.failActive(
          new Error(`attachment staging failed: ${(e as Error).message}`),
        );
        continue;
      }

      try {
        // Sender metadata deliberately stays on PromptResponse and the safe
        // `/nats-status` diagnostic. It is never inserted into model input.
        pi.sendUserMessage(finalPrompt);
        return;
      } catch (e) {
        promptQueue.requeueActive();
        piCtx.ui.notify(
          `NATS: deferred injection (${(e as Error).message})`,
          "warning",
        );
        if (injectionRetryTimer) clearTimeout(injectionRetryTimer);
        injectionRetryTimer = setTimeout(drainQueue, 250);
        injectionRetryTimer.unref?.();
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
    attachments: QueuedPiPrompt["attachments"],
  ): string {
    if (attachments.length === 0) return prompt;
    if (!sessionName) throw new Error("session not initialized");
    const reqDir = join(ATTACHMENTS_ROOT, sessionName, randomUUID());
    mkdirSync(reqDir, { recursive: true });
    const paths: string[] = [];
    for (const a of attachments) {
      const target = join(reqDir, a.filename);
      writeFileSync(target, a.content);
      paths.push(target);
    }
    const list = paths.map((p) => `- ${p}`).join("\n");
    return `[Attachments available at the following absolute paths]\n${list}\n\n${prompt}`;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Status loop + cleanup
  // ───────────────────────────────────────────────────────────────────────

  async function startStatusLoop(
    conn: NatsConnection,
    ctx: ExtensionContext,
  ): Promise<void> {
    try {
      for await (const s of conn.status()) {
        switch (s.type) {
          case "disconnect":
            ctx.ui.setStatus("nats", "NATS: reconnecting…");
            ctx.ui.notify(
              `NATS disconnected from ${s.server} — retrying…`,
              "warning",
            );
            break;
          case "reconnect":
            if (promptSubject)
              ctx.ui.setStatus("nats", `NATS: ${promptSubject}`);
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

  function waitForConnectRetry(): Promise<void> {
    if (shuttingDown) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (connectRetryTimer) clearTimeout(connectRetryTimer);
        connectRetryTimer = undefined;
        wakeConnectRetry = undefined;
        resolve();
      };
      wakeConnectRetry = finish;
      connectRetryTimer = setTimeout(finish, 2_000);
      connectRetryTimer.unref?.();
    });
  }

  /** Close an owned connection before clearing its retained credential bytes. */
  async function closeConnectionBeforeWipe(
    conn: NatsConnection,
    bundle: NatsConnectionBundle,
  ): Promise<boolean> {
    try {
      await conn.drain();
    } catch {
      try {
        await conn.close();
      } catch {
        return false;
      }
    }
    bundle.wipe();
    return true;
  }

  async function cleanup(
    options: { waitForConnectTask?: boolean } = {},
  ): Promise<void> {
    shuttingDown = true;
    wakeConnectRetry?.();
    if (injectionRetryTimer) {
      clearTimeout(injectionRetryTimer);
      injectionRetryTimer = undefined;
    }
    // An external shutdown waits for the bounded initial connection attempt.
    // Internal startup failures skip this wait to avoid awaiting their own task.
    if (options.waitForConnectTask !== false) {
      await connectTask?.catch(() => undefined);
    }
    promptQueue.failAll("PI session shut down before the prompt completed");
    // Let AgentService observe every rejected deferred handler and publish
    // its error + terminator before the endpoint and connection disappear.
    await Promise.resolve();
    if (nc) {
      try {
        await nc.flush();
      } catch {}
    }
    if (service) {
      try {
        await service.stop();
      } catch {}
      service = undefined;
    }
    if (nc && connectionBundle) {
      const activeConnection = nc;
      const activeBundle = connectionBundle;
      if (await closeConnectionBeforeWipe(activeConnection, activeBundle)) {
        if (nc === activeConnection) nc = undefined;
        if (connectionBundle === activeBundle) connectionBundle = undefined;
      }
    } else if (nc) {
      try {
        await nc.drain();
        nc = undefined;
      } catch {
        // Retain the connection so a later cleanup attempt can retry.
      }
    }
    if (pendingConnection && pendingConnectionBundle) {
      const pending = pendingConnection;
      const pendingBundle = pendingConnectionBundle;
      if (await closeConnectionBeforeWipe(pending, pendingBundle)) {
        if (pendingConnection === pending) pendingConnection = undefined;
        if (pendingConnectionBundle === pendingBundle)
          pendingConnectionBundle = undefined;
      }
    } else if (!pendingConnection && pendingConnectionBundle && !connectTask) {
      // No connect operation can still hold this snapshot.
      pendingConnectionBundle.wipe();
      pendingConnectionBundle = undefined;
    }
    clearInterval(pruneInterval);
    // Remove the session's staged attachments directory.
    if (sessionName) {
      try {
        rmSync(join(ATTACHMENTS_ROOT, sessionName), {
          recursive: true,
          force: true,
        });
      } catch {}
    }
    piCtx?.ui.setStatus("nats", undefined);
  }

  // ───────────────────────────────────────────────────────────────────────
  // Event wiring
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Connect to NATS and register the microservice. Initial attempts are
   * bounded and retried here so session shutdown can always regain ownership
   * of the connection bundle. Once connected, the SDK's normal infinite
   * reconnect defaults take over.
   */
  async function connectAndRegister(
    settings: PiConnectionSettings,
    ctx: ExtensionContext,
    rawSession: string,
  ): Promise<void> {
    // Override only first-connect waiting. A rejected attempt has released
    // its internal connection, so its bundle can be wiped before retrying.
    // The live connection still inherits infinite reconnect behavior.
    let conn: NatsConnection | undefined;
    let failureReported = false;
    while (!shuttingDown && !conn) {
      let candidateBundle: NatsConnectionBundle | undefined;
      try {
        candidateBundle = await resolveNatsConnectionBundle(settings.source, {
          identity: settings.senderIdentity,
        });
        if (shuttingDown) {
          candidateBundle.wipe();
          return;
        }
        pendingConnectionBundle = candidateBundle;
        const candidateConnection = await connect(
          withAgentReconnectDefaults({
            ...candidateBundle.connectionOptions,
            name: `pi-${owner}`,
            waitOnFirstConnect: false,
            timeout: 2_000,
          }),
        );
        pendingConnection = candidateConnection;
        if (shuttingDown) {
          if (
            await closeConnectionBeforeWipe(
              candidateConnection,
              candidateBundle,
            )
          ) {
            pendingConnection = undefined;
            pendingConnectionBundle = undefined;
          }
          return;
        }
        conn = candidateConnection;
        nc = candidateConnection;
        connectionBundle = candidateBundle;
        pendingConnection = undefined;
        pendingConnectionBundle = undefined;
        if (conn.info?.max_payload) maxPayloadBytes = conn.info.max_payload;
      } catch (e) {
        // A rejected connect() owns no live connection. If it returned a
        // connection before later setup failed, close it before wiping.
        if (pendingConnection && pendingConnectionBundle) {
          const closed = await closeConnectionBeforeWipe(
            pendingConnection,
            pendingConnectionBundle,
          );
          if (!closed) return;
          pendingConnection = undefined;
          pendingConnectionBundle = undefined;
        } else if (pendingConnectionBundle) {
          pendingConnectionBundle.wipe();
          pendingConnectionBundle = undefined;
        }
        if (shuttingDown) return;
        if (!failureReported) {
          ctx.ui.notify(
            `NATS connection failed (${contextLabel}): ${(e as Error).message}; retrying`,
            "warning",
          );
          failureReported = true;
        }
        ctx.ui.setStatus("nats", "NATS: connecting…");
        await waitForConnectRetry();
      }
    }
    if (!conn || shuttingDown || nc !== conn) return;

    // Collision-detect the session name.
    try {
      sessionName = await resolveSessionName(conn, rawSession, owner!);
      if (shuttingDown || nc !== conn) return;
    } catch (e) {
      ctx.ui.notify(
        `NATS: session name resolution failed: ${(e as Error).message}`,
        "error",
      );
      await cleanup({ waitForConnectTask: false });
      return;
    }
    // AgentService owns protocol registration, sender admission before ack,
    // keep-alives, heartbeats/status, errors, and stream termination.
    let startingService: AgentService | undefined;
    try {
      const signer = connectionBundle?.signer;
      if (settings.senderIdentity === "signed" && !signer) {
        throw new Error(
          "signed sender identity resolved without a connection-bound signer",
        );
      }
      const agentService = new AgentService({
        nc: conn,
        agent: AGENT_ID,
        owner: owner!,
        name: sessionName,
        session: sessionName,
        version: SERVICE_VERSION,
        description: `PI agent (${sessionName}) in ${ctx.cwd}`,
        attachmentsOk: true,
        heartbeatIntervalS: HEARTBEAT_INTERVAL_S,
        keepaliveIntervalS: KEEPALIVE_INTERVAL_S,
        minSenderTrust: settings.minSenderTrust,
        ...(signer ? { identity: { signer } } : {}),
        extraMetadata: {
          cwd: ctx.cwd,
        },
      });
      startingService = agentService;
      agentService.onPrompt((envelope, response) => {
        const request = promptQueue.enqueue(envelope, response);
        drainQueue();
        return request.completion;
      });
      await agentService.start();
      if (shuttingDown || nc !== conn) {
        await agentService.stop();
        return;
      }
      service = agentService;
      promptSubject = agentService.subject.prompt;
      instanceId = agentService.instanceId;
    } catch (e) {
      try {
        await startingService?.stop();
      } catch {}
      ctx.ui.notify(
        `NATS: service registration failed: ${(e as Error).message}`,
        "error",
      );
      await cleanup({ waitForConnectTask: false });
      return;
    }

    // UI feedback.
    ctx.ui.setStatus("nats", `NATS: ${promptSubject}`);
    ctx.ui.notify(
      `Connected to NATS (${contextLabel}) as ${promptSubject} ` +
        `(sender_identity=${settings.senderIdentity}, min_sender_trust=${settings.minSenderTrust})`,
      "info",
    );

    // Monitor connection status.
    void startStatusLoop(conn, ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    piCtx = ctx;
    const config = loadConfig();

    // The shared SDK helper is the only context/credential reader. In signed
    // mode it derives NATS auth and the registration signer from one snapshot.
    let settings: PiConnectionSettings;
    try {
      settings = resolveConnectionSettings(config);
    } catch (e) {
      ctx.ui.notify(`NATS: ${(e as Error).message}`, "error");
      ctx.ui.setStatus("nats", "NATS: disconnected");
      return;
    }
    contextLabel = settings.contextLabel;
    senderIdentity = settings.senderIdentity;
    minSenderTrust = settings.minSenderTrust;

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

    // 3. Kick off connect + register in the background. The bounded retry
    //    loop keeps PI startup responsive when NATS is down while retaining
    //    an explicit task that session shutdown can await and clean up.
    ctx.ui.setStatus("nats", "NATS: connecting…");
    const task = connectAndRegister(settings, ctx, rawSession);
    connectTask = task;
    const clearTask = () => {
      if (connectTask === task) connectTask = undefined;
    };
    void task.then(clearTask, clearTask);
  });

  pi.on("message_update", async (event) => {
    if (!nc) return;
    const ame = event.assistantMessageEvent;
    if (ame.type !== "text_delta" || !ame.delta) return;
    const pending = promptQueue.active;
    if (!pending) return;
    try {
      await publishResponseText(pending, ame.delta);
    } catch (e) {
      piCtx?.ui.notify(
        `NATS: publish failed: ${(e as Error).message}`,
        "warning",
      );
    }
  });

  pi.on("agent_end", async () => {
    promptQueue.completeActive();
    // AgentService resumes from the deferred handler and emits the
    // terminator. Flush it before the next PI turn begins.
    await Promise.resolve();
    if (nc) {
      try {
        await nc.flush();
      } catch {}
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
      const active = promptQueue.active;
      const line = [
        `Connection: ${contextLabel}`,
        `Subject: ${promptSubject}`,
        `Service: ${SERVICE_NAME} v${SERVICE_VERSION}`,
        `Protocol: ${SDK_PROTOCOL_VERSION.major}.${SDK_PROTOCOL_VERSION.minor}`,
        `Instance: ${instanceId ?? "?"}`,
        `Session: ${sessionName}`,
        `Owner: ${owner}`,
        `Sender identity: ${senderIdentity}${service?.identity ? ` (${service.identity})` : ""}`,
        `Minimum sender trust: ${minSenderTrust}`,
        `Pending: ${promptQueue.size}`,
        `Queued: ${promptQueue.queuedCount}`,
        `Active: ${active?.id ?? "none"}`,
        `Active sender: ${active ? formatSender(active.response.sender) : "none"}`,
      ]
        .filter(Boolean)
        .join(" • ");
      ctx.ui.notify(line, "info");
    },
  });

  pi.registerCommand("nats-configure", {
    description:
      "Show or update NATS channel configuration (usage: /nats-configure [ <context> | session <name|clear> | owner <name|clear> | identity <off|signed> | trust <any|signed> ])",
    handler: async (args, ctx) => {
      const current = loadConfig();
      const tokens = args.trim().split(/\s+/).filter(Boolean);

      if (tokens.length === 0) {
        const lines = [
          `Context: ${current.context ?? "(default: demo.nats.io)"}`,
          `Owner: ${current.owner ?? "(default: $USER)"}`,
          `Session: ${current.sessionName ?? "(auto from cwd)"}`,
          `Sender identity: ${current.senderIdentity ?? "off"}`,
          `Minimum sender trust: ${current.minSenderTrust ?? "any"}`,
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
          ctx.ui.notify(
            "Usage: /nats-configure session <name|clear>",
            "warning",
          );
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
      } else if (tokens[0] === "identity") {
        if (!tokens[1]) {
          ctx.ui.notify(
            "Usage: /nats-configure identity <off|signed>",
            "warning",
          );
          return;
        }
        try {
          next.senderIdentity = parseChoice(
            "senderIdentity",
            tokens[1],
            "off",
            ["off", "signed"],
          );
          changed = true;
        } catch (e) {
          ctx.ui.notify(`NATS: ${(e as Error).message}`, "warning");
          return;
        }
      } else if (tokens[0] === "trust") {
        if (!tokens[1]) {
          ctx.ui.notify("Usage: /nats-configure trust <any|signed>", "warning");
          return;
        }
        try {
          next.minSenderTrust = parseChoice(
            "minSenderTrust",
            tokens[1],
            "any",
            ["any", "signed"],
          );
          changed = true;
        } catch (e) {
          ctx.ui.notify(`NATS: ${(e as Error).message}`, "warning");
          return;
        }
      } else {
        // Treat as a context switch. The shared bundle helper validates the
        // context and its auth/TLS files without retaining another snapshot.
        const newContext = tokens[0];
        let candidate: NatsConnectionBundle | undefined;
        try {
          candidate = await resolveNatsConnectionBundle({
            context: newContext,
          });
        } catch (e) {
          ctx.ui.notify(`NATS: ${(e as Error).message}`, "error");
          return;
        } finally {
          candidate?.wipe();
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
        ctx.ui.notify(
          `NATS: failed to save config: ${(e as Error).message}`,
          "error",
        );
        return;
      }

      ctx.ui.notify(
        "NATS config updated. Restart PI for changes to take effect.",
        "info",
      );
    },
  });
}
