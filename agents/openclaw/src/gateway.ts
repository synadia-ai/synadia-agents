import { join } from "node:path";
import type { NatsConnection } from "@nats-io/nats-core";
import { Svcm } from "@nats-io/services";
import type { Service, ServiceHandler, ServiceMsg } from "@nats-io/services";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/direct-dm";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
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
} from "@synadia-ai/agents";
import {
  DEFAULT_ATTACHMENTS_OK,
  DEFAULT_HEARTBEAT_INTERVAL_S,
  DEFAULT_MAX_PAYLOAD,
  buildHeartbeatPayload,
  encodeChunk,
  encodeHeartbeatPayload,
  splitResponseText,
} from "@synadia-ai/agent-service";
import {
  ACK_KEEPALIVE_MS,
  AGENT_ID,
  DEFAULT_SESSION,
  SERVICE_VERSION,
  SUBJECT_AGENT_TOKEN,
} from "./nats/index.js";
import { connectToNats, drainConnection } from "./nats/connection.js";
import type { ResolvedNatsAccount } from "./types.js";
import { setActiveConnection } from "./runtime.js";
import { cleanupAgentStaging, stageAttachmentsIntoPrompt } from "./attachments.js";

// Stage attachments under `<stateDir>/media/nats-channel/…` so OpenClaw's
// media-access allowlist (openclaw/src/media/local-roots.ts → `<stateDir>/media`)
// accepts the paths we hand to image/pdf tools. Resolved once per process.
const ATTACHMENT_BASE_DIR = join(resolveStateDir(), "media", "nats-channel");

// ─────────────────────────────────────────────────────────────────────────────
// Gateway state (module-level; one account runs at a time)
// ─────────────────────────────────────────────────────────────────────────────

let activeService: Service | null = null;
let activeNc: NatsConnection | null = null;
let activeHeartbeat: ReturnType<typeof setInterval> | null = null;
let activeAgentName: string | null = null;
const activeAckTimers = new Map<string, ReturnType<typeof setInterval>>();

async function cleanupPrevious(): Promise<void> {
  for (const t of activeAckTimers.values()) clearInterval(t);
  activeAckTimers.clear();
  if (activeHeartbeat) {
    clearInterval(activeHeartbeat);
    activeHeartbeat = null;
  }
  if (activeService) {
    try {
      await activeService.stop();
    } catch {}
    activeService = null;
  }
  if (activeNc) {
    try {
      await drainConnection(activeNc);
    } catch {}
    activeNc = null;
  }
  if (activeAgentName) {
    cleanupAgentStaging(ATTACHMENT_BASE_DIR, activeAgentName);
    activeAgentName = null;
  }
  setActiveConnection(null, null, null);
}

// ─────────────────────────────────────────────────────────────────────────────
// Gateway start/stop
// ─────────────────────────────────────────────────────────────────────────────

export async function startNatsGateway(
  ctx: ChannelGatewayContext<ResolvedNatsAccount>,
): Promise<void> {
  const { account, cfg, abortSignal, channelRuntime } = ctx;
  const agentName = account.agentName;
  const owner = account.owner;
  // Long canonical name in `metadata.agent` (`openclaw`); short `oc` token
  // in the wire subject — Appendix C convention. SDK's `AgentSubject`
  // owns the subject layout via the `subjectToken` option (commit a87f334).
  const subject = AgentSubject.new(AGENT_ID, owner, agentName, {
    subjectToken: SUBJECT_AGENT_TOKEN,
  });

  ctx.log?.info?.(
    `nats: gateway starting — ${subject.prompt} @ ${account.url} (accountId: ${account.accountId}, enabled: ${account.enabled})`,
  );

  await cleanupPrevious();

  // 1. Connect to NATS
  const nc = await connectToNats({
    url: account.url,
    credentials: account.credentials,
    name: `openclaw-${agentName}`,
  });
  activeNc = nc;
  activeAgentName = agentName;
  setActiveConnection(nc, agentName, owner);
  ctx.setStatus({ state: "running" });

  // Server-negotiated max_payload (§2.1). Reflects this user/account's real
  // limit, so we use it for endpoint metadata advertisement and §5.4
  // local enforcement. Falls back to the SDK's `DEFAULT_MAX_PAYLOAD` (1MB)
  // if `INFO` is unavailable.
  const maxPayloadBytes = nc.info?.max_payload ?? parseHumanBytes(DEFAULT_MAX_PAYLOAD);
  const maxPayloadStr = nc.info?.max_payload
    ? formatHumanBytes(maxPayloadBytes)
    : DEFAULT_MAX_PAYLOAD;
  ctx.log?.info?.(`nats: server max_payload=${maxPayloadStr}`);

  // 2. Register the shared `agents` service (spec §3).
  const svc = new Svcm(nc);
  const service = await svc.add({
    name: SERVICE_NAME,
    version: SERVICE_VERSION,
    description: account.description || `OpenClaw agent ${agentName}`,
    metadata: {
      agent: AGENT_ID,
      owner,
      session: DEFAULT_SESSION,
      protocol_version: `${SDK_PROTOCOL_VERSION.major}.${SDK_PROTOCOL_VERSION.minor}`,
      // Supplementary (tolerated per §3.2, useful for tools).
      platform: "openclaw",
      description: account.description,
    },
  });
  activeService = service;
  const instanceId = service.info().id;

  // 3. The `prompt` endpoint. Subject is the canonical default
  //    `agents.prompt.oc.<owner>.<name>`; metadata advertises capabilities per §2.1.
  service.addEndpoint("prompt", {
    subject: subject.prompt,
    queue: PROMPT_QUEUE_GROUP,
    handler: buildPromptHandler(
      ctx,
      nc,
      account,
      cfg,
      channelRuntime,
      maxPayloadBytes,
      maxPayloadStr,
    ),
    metadata: {
      max_payload: maxPayloadStr,
      attachments_ok: DEFAULT_ATTACHMENTS_OK ? "true" : "false",
    },
  });

  // 4. §8.7 (v0.3) status request/response endpoint. Replies with the same
  //    JSON payload shape as a heartbeat (§8.3), freshly built per request.
  service.addEndpoint("status", {
    subject: subject.status,
    queue: STATUS_QUEUE_GROUP,
    handler: (err, msg: ServiceMsg) => {
      if (err) return;
      try {
        const payload = buildHeartbeatPayload(subject, DEFAULT_HEARTBEAT_INTERVAL_S, instanceId, {
          session: DEFAULT_SESSION,
        });
        msg.respond(encodeHeartbeatPayload(payload));
      } catch (e) {
        try {
          msg.respondError(500, `status handler error: ${(e as Error).message}`);
        } catch {
          // best effort
        }
      }
    },
  });

  // 5. Heartbeat — starts AFTER registration so callers discovering via the
  //    beacon can resolve metadata via $SRV.INFO (spec §8.2).
  const publishHeartbeat = (): void => {
    try {
      const payload = buildHeartbeatPayload(subject, DEFAULT_HEARTBEAT_INTERVAL_S, instanceId, {
        session: DEFAULT_SESSION,
      });
      nc.publish(subject.heartbeat, encodeHeartbeatPayload(payload));
    } catch {
      // best effort — the connection status loop surfaces real failures
    }
  };
  publishHeartbeat(); // emit one immediately so discovery is prompt
  activeHeartbeat = setInterval(publishHeartbeat, DEFAULT_HEARTBEAT_INTERVAL_S * 1000);
  activeHeartbeat.unref?.();

  ctx.log?.info?.(
    `nats: "${agentName}" registered at ${subject.prompt} (instance_id=${instanceId})`,
  );

  // 5. Stay alive until abort
  return new Promise<void>((resolve) => {
    abortSignal.addEventListener("abort", () => {
      cleanupPrevious()
        .then(
          () => ctx.log?.info?.(`nats: "${agentName}" stopped`),
          (err) => ctx.log?.error?.(`nats: shutdown error: ${String(err)}`),
        )
        .finally(resolve);
    });
  });
}

export async function stopNatsGateway(
  _ctx: ChannelGatewayContext<ResolvedNatsAccount>,
): Promise<void> {
  await cleanupPrevious();
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt handler — translates one NATS request into one OpenClaw dispatch
// ─────────────────────────────────────────────────────────────────────────────

function buildPromptHandler(
  ctx: ChannelGatewayContext<ResolvedNatsAccount>,
  nc: NatsConnection,
  account: ResolvedNatsAccount,
  cfg: Parameters<typeof dispatchInboundDirectDmWithRuntime>[0]["cfg"],
  channelRuntime: ChannelGatewayContext<ResolvedNatsAccount>["channelRuntime"],
  maxPayloadBytes: number,
  maxPayloadStr: string,
): ServiceHandler {
  return (err, msg) => {
    if (err || !msg.reply) return;

    // §5.4: enforce max_payload locally.
    if (msg.data.byteLength > maxPayloadBytes) {
      respondWithError(nc, msg, 400, `payload exceeds max_payload (${maxPayloadStr})`);
      return;
    }

    // SDK's `decodeEnvelope` throws ProtocolError on §5.1 / §5.2 / §5.3
    // violations; everything else (e.g. JSON.parse failures) is normalised
    // by SDK into the same error type. Treat both as 400 per §9.1.
    let envelope: ReturnType<typeof decodeEnvelope>;
    try {
      envelope = decodeEnvelope(msg.data);
    } catch (e) {
      const code = e instanceof ProtocolError ? 400 : 500;
      respondWithError(nc, msg, code, (e as Error).message);
      return;
    }

    // Stage attachments (if any) and build the augmented prompt text handed
    // to OpenClaw's pipeline. Staging failures → 500 (envelope was valid, we
    // just couldn't process it) per spec §9.2. SDK delivers attachments as
    // `{filename, content: Uint8Array}`; openclaw's stager expects the same
    // shape under the legacy `bytes` key, so adapt at the boundary.
    let finalPrompt: string;
    try {
      finalPrompt = stageAttachmentsIntoPrompt({
        baseDir: ATTACHMENT_BASE_DIR,
        agentName: account.agentName,
        prompt: envelope.prompt,
        attachments: (envelope.attachments ?? []).map((a) => ({
          filename: a.filename,
          bytes: a.content,
        })),
      });
    } catch (e) {
      respondWithError(nc, msg, 500, `attachment staging failed: ${(e as Error).message}`);
      return;
    }

    const reply = msg.reply;

    // §6.4: ack as soon as the request is accepted so the caller's inactivity
    // timer resets before the first response chunk arrives.
    nc.publish(reply, encodeChunk({ type: "status", status: "ack" }));
    startAckKeepalive(nc, reply);

    // Always enable block streaming in OpenClaw so partial text flows.
    const effectiveRuntime = {
      ...channelRuntime,
      reply: {
        ...channelRuntime.reply,
        dispatchReplyWithBufferedBlockDispatcher: (params: Record<string, unknown>) => {
          return channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
            ...params,
            replyOptions: {
              ...(params.replyOptions as Record<string, unknown> | undefined),
              disableBlockStreaming: false,
            },
          });
        },
      },
    };

    dispatchInboundDirectDmWithRuntime({
      cfg,
      runtime: { channel: effectiveRuntime },
      channel: "nats",
      channelLabel: "NATS",
      accountId: account.accountId,
      peer: { kind: "direct", id: "remote" },
      senderId: "remote",
      senderAddress: "nats:remote",
      recipientAddress: `nats:${account.agentName}`,
      conversationLabel: "remote",
      rawBody: finalPrompt,
      messageId: `nats-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      commandAuthorized: true,
      deliver: async (payload) => {
        const text = payload.text ?? "";
        if (!text) return;
        // §6.3: each response chunk is a typed JSON object. OpenClaw's
        // streaming usually delivers small rendered blocks, but guard
        // against an oversize block reaching the broker by encoding
        // first, fast-pathing if it fits, and falling back to the SDK's
        // UTF-8-safe splitter if not. Mirrors pi/claude-code so all
        // three harnesses behave the same on long deliveries.
        const bytes = encodeChunk({ type: "response", text });
        if (bytes.byteLength <= maxPayloadBytes) {
          nc.publish(reply, bytes);
        } else {
          for (const slice of splitResponseText(text, maxPayloadBytes)) {
            nc.publish(reply, encodeChunk({ type: "response", text: slice }));
          }
        }
      },
      onRecordError: (err) => {
        ctx.log?.error?.(`nats: session record error: ${String(err)}`);
      },
      onDispatchError: (err, info) => {
        ctx.log?.error?.(`nats: ${info.kind} dispatch error: ${String(err)}`);
      },
    })
      .then(() => {
        stopAckKeepalive(reply);
        // §6.5 terminator: empty body + no headers.
        try {
          nc.publish(reply, "");
        } catch {}
      })
      .catch((dispatchErr) => {
        stopAckKeepalive(reply);
        ctx.log?.error?.(`nats: dispatch failed: ${String(dispatchErr)}`);
        // §9.3: emit the error-headered signal then the terminator.
        respondWithError(nc, msg, 500, `dispatch failed: ${String(dispatchErr)}`);
      });
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Spec helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Spec §9.3: an error during a stream is emitted as a header-only message on
 * the reply subject, followed by the empty-body-no-headers terminator. Two
 * messages, not one.
 */
function respondWithError(
  nc: NatsConnection,
  msg: ServiceMsg,
  code: number,
  description: string,
): void {
  try {
    msg.respondError(code, description);
  } catch {
    // best effort — usually tearing down
  }
  if (msg.reply) {
    stopAckKeepalive(msg.reply);
    try {
      nc.publish(msg.reply, "");
    } catch {}
  }
}

function startAckKeepalive(nc: NatsConnection, reply: string): void {
  stopAckKeepalive(reply);
  const timer = setInterval(() => {
    try {
      nc.publish(reply, encodeChunk({ type: "status", status: "ack" }));
    } catch {}
  }, ACK_KEEPALIVE_MS);
  timer.unref?.();
  activeAckTimers.set(reply, timer);
}

function stopAckKeepalive(reply: string): void {
  const t = activeAckTimers.get(reply);
  if (t) {
    clearInterval(t);
    activeAckTimers.delete(reply);
  }
}
