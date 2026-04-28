import { join } from "node:path";
import type { NatsConnection } from "@nats-io/nats-core";
import { Svcm } from "@nats-io/services";
import type { Service, ServiceHandler, ServiceMsg } from "@nats-io/services";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/direct-dm";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  ACK_KEEPALIVE_MS,
  AGENT_ID,
  ATTACHMENTS_OK,
  DEFAULT_SESSION,
  HEARTBEAT_INTERVAL_S,
  MAX_PAYLOAD_BYTES,
  MAX_PAYLOAD_STR,
  PROMPT_QUEUE_GROUP,
  PROTOCOL_VERSION,
  SERVICE_NAME,
  SERVICE_VERSION,
  STATUS_QUEUE_GROUP,
  buildHeartbeatPayload,
  connectToNats,
  drainConnection,
  heartbeatSubject,
  parseEnvelope,
  promptSubject,
  statusSubject,
  wrapResponseChunk,
  wrapStatusChunk,
} from "./nats/index.js";
import type { ResolvedNatsAccount } from "./types.js";
import { setActiveConnection } from "./runtime.js";
import {
  cleanupAgentStaging,
  stageAttachmentsIntoPrompt,
} from "./attachments.js";

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
  const subject = promptSubject(owner, agentName);
  const hbSubject = heartbeatSubject(owner, agentName);
  const stSubject = statusSubject(owner, agentName);

  ctx.log?.info?.(
    `nats: gateway starting — agents.prompt.oc.${owner}.${agentName} @ ${account.url} (accountId: ${account.accountId}, enabled: ${account.enabled})`,
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
      protocol_version: PROTOCOL_VERSION,
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
    subject,
    queue: PROMPT_QUEUE_GROUP,
    handler: buildPromptHandler(ctx, nc, account, cfg, channelRuntime),
    metadata: {
      max_payload: MAX_PAYLOAD_STR,
      attachments_ok: ATTACHMENTS_OK ? "true" : "false",
    },
  });

  // 4. §8.7 (v0.3) status request/response endpoint. Replies with the same
  //    JSON payload shape as a heartbeat (§8.3), freshly built per request.
  service.addEndpoint("status", {
    subject: stSubject,
    queue: STATUS_QUEUE_GROUP,
    handler: (err, msg: ServiceMsg) => {
      if (err) return;
      try {
        const payload = buildHeartbeatPayload({
          owner,
          session: DEFAULT_SESSION,
          instanceId,
          intervalS: HEARTBEAT_INTERVAL_S,
        });
        msg.respond(JSON.stringify(payload));
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
      const payload = buildHeartbeatPayload({
        owner,
        session: DEFAULT_SESSION,
        instanceId,
        intervalS: HEARTBEAT_INTERVAL_S,
      });
      nc.publish(hbSubject, JSON.stringify(payload));
    } catch {
      // best effort — the connection status loop surfaces real failures
    }
  };
  publishHeartbeat(); // emit one immediately so discovery is prompt
  activeHeartbeat = setInterval(publishHeartbeat, HEARTBEAT_INTERVAL_S * 1000);
  activeHeartbeat.unref?.();

  ctx.log?.info?.(
    `nats: "${agentName}" registered at ${subject} (instance_id=${instanceId})`,
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
): ServiceHandler {
  return (err, msg) => {
    if (err || !msg.reply) return;

    // §5.4: enforce max_payload locally.
    if (msg.data.byteLength > MAX_PAYLOAD_BYTES) {
      respondWithError(nc, msg, 400, `payload exceeds max_payload (${MAX_PAYLOAD_STR})`);
      return;
    }

    const parsed = parseEnvelope(msg.data);
    if (!parsed.ok) {
      respondWithError(nc, msg, parsed.code, parsed.error);
      return;
    }

    // Stage attachments (if any) and build the augmented prompt text handed
    // to OpenClaw's pipeline. Staging failures → 500 (envelope was valid, we
    // just couldn't process it) per spec §9.2.
    let finalPrompt: string;
    try {
      finalPrompt = stageAttachmentsIntoPrompt({
        baseDir: ATTACHMENT_BASE_DIR,
        agentName: account.agentName,
        prompt: parsed.prompt,
        attachments: parsed.attachments,
      });
    } catch (e) {
      respondWithError(nc, msg, 500, `attachment staging failed: ${(e as Error).message}`);
      return;
    }

    const reply = msg.reply;

    // §6.4: ack as soon as the request is accepted so the caller's inactivity
    // timer resets before the first response chunk arrives.
    nc.publish(reply, wrapStatusChunk("ack"));
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
        // §6.3: each response chunk is a typed JSON object.
        nc.publish(reply, wrapResponseChunk(text));
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
      nc.publish(reply, wrapStatusChunk("ack"));
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
