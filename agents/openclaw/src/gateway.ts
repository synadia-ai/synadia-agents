import { join } from "node:path";
import type { NatsConnection } from "@nats-io/nats-core";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  formatSender,
  type Logger,
  type NatsConnectionBundle,
  type RequestEnvelope,
} from "@synadia-ai/agents";
import {
  AgentService,
  DEFAULT_ATTACHMENTS_OK,
  splitResponseText,
  type PromptResponse,
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
import { getNatsRuntime, setActiveConnection } from "./runtime.js";
import {
  cleanupAgentStaging,
  stageAttachmentsIntoPrompt,
} from "./attachments.js";

// Stage attachments under OpenClaw's media-access allowlist.
const ATTACHMENT_BASE_DIR = join(resolveStateDir(), "media", "nats-channel");
const HEARTBEAT_INTERVAL_S = 5;

// One OpenClaw channel account runs at a time.
let activeService: AgentService | null = null;
let activeNc: NatsConnection | null = null;
let activeBundle: NatsConnectionBundle | null = null;
let activeAgentName: string | null = null;

async function cleanupPrevious(): Promise<void> {
  if (activeService) {
    try {
      await activeService.stop();
    } catch {}
    activeService = null;
  }
  if (activeNc) {
    // Do not wipe or replace this connection's credential snapshot unless the
    // connection is definitely closed. drainConnection forces close on a
    // graceful-drain failure and throws only when even that close failed.
    await drainConnection(activeNc);
    activeNc = null;
  }
  // Reconnect authentication and the sender signer share this retained
  // snapshot. It is safe to wipe only after the NATS connection has closed.
  activeBundle?.wipe();
  activeBundle = null;
  if (activeAgentName) {
    cleanupAgentStaging(ATTACHMENT_BASE_DIR, activeAgentName);
    activeAgentName = null;
  }
  setActiveConnection(null, null, null);
}

export async function startNatsGateway(
  ctx: ChannelGatewayContext<ResolvedNatsAccount>,
): Promise<void> {
  const { account, cfg, abortSignal, channelRuntime } = ctx;
  const agentName = account.agentName;
  const sourceLabel =
    "context" in account.connectionSource
      ? `context ${JSON.stringify(account.connectionSource.context)}`
      : "configured URL";

  ctx.log?.info?.(
    `nats: gateway starting — oc/${account.owner}/${agentName} using ${sourceLabel} ` +
      `(accountId: ${account.accountId}, senderIdentity: ${account.senderIdentity}, ` +
      `minSenderTrust: ${account.minSenderTrust})`,
  );

  await cleanupPrevious();

  const connected = await connectToNats({
    source: account.connectionSource,
    senderIdentity: account.senderIdentity,
    name: `openclaw-${agentName}`,
  });
  activeNc = connected.nc;
  activeBundle = connected.bundle;
  activeAgentName = agentName;

  const service = new AgentService({
    nc: connected.nc,
    agent: AGENT_ID,
    subjectToken: SUBJECT_AGENT_TOKEN,
    owner: account.owner,
    name: agentName,
    session: DEFAULT_SESSION,
    description: account.description || `OpenClaw agent ${agentName}`,
    version: SERVICE_VERSION,
    attachmentsOk: DEFAULT_ATTACHMENTS_OK,
    heartbeatIntervalS: HEARTBEAT_INTERVAL_S,
    keepaliveIntervalS: ACK_KEEPALIVE_MS / 1_000,
    extraMetadata: {
      platform: "openclaw",
      description: account.description,
    },
    ...(connected.bundle.signer
      ? { identity: { signer: connected.bundle.signer } }
      : {}),
    minSenderTrust: account.minSenderTrust,
    logger: gatewayLogger(ctx),
  });
  activeService = service;

  const maxPayloadBytes = connected.nc.info?.max_payload ?? 1_048_576;
  service.onPrompt(async (envelope, response) => {
    await dispatchPromptToOpenClaw(
      ctx,
      account,
      cfg,
      channelRuntime,
      envelope,
      response,
      maxPayloadBytes,
    );
  });

  try {
    await service.start();
  } catch (error) {
    await cleanupPrevious();
    throw error;
  }

  setActiveConnection(connected.nc, agentName, account.owner);
  ctx.setStatus({
    ...ctx.getStatus(),
    running: true,
    connected: true,
    statusState: "running",
  });
  ctx.log?.info?.(
    `nats: "${agentName}" registered at ${service.subject.prompt} ` +
      `(instance_id=${service.instanceId}, identity=${service.identity ? "registered" : "off"})`,
  );

  return new Promise<void>((resolve) => {
    const stop = (): void => {
      cleanupPrevious()
        .then(
          () => ctx.log?.info?.(`nats: "${agentName}" stopped`),
          (err) => ctx.log?.error?.(`nats: shutdown error: ${String(err)}`),
        )
        .finally(resolve);
    };
    if (abortSignal.aborted) stop();
    else abortSignal.addEventListener("abort", stop, { once: true });
  });
}

export async function stopNatsGateway(
  _ctx: ChannelGatewayContext<ResolvedNatsAccount>,
): Promise<void> {
  await cleanupPrevious();
}

async function dispatchPromptToOpenClaw(
  ctx: ChannelGatewayContext<ResolvedNatsAccount>,
  account: ResolvedNatsAccount,
  cfg: Parameters<typeof dispatchInboundDirectDmWithRuntime>[0]["cfg"],
  channelRuntime: ChannelGatewayContext<ResolvedNatsAccount>["channelRuntime"],
  envelope: RequestEnvelope,
  response: PromptResponse,
  maxPayloadBytes: number,
): Promise<void> {
  // Sender identity stays structured metadata: it is visible in logs and on
  // PromptResponse, but is never interpolated into the model's prompt text.
  ctx.log?.info?.(
    `nats: incoming prompt sender=${formatSender(response.sender)}`,
  );

  const finalPrompt = stageAttachmentsIntoPrompt({
    baseDir: ATTACHMENT_BASE_DIR,
    agentName: account.agentName,
    prompt: envelope.prompt,
    attachments: (envelope.attachments ?? []).map((attachment) => ({
      filename: attachment.filename,
      bytes: attachment.content,
    })),
  });

  // Always enable block streaming in OpenClaw so partial text flows.
  if (!channelRuntime) {
    throw new Error("OpenClaw channel runtime is unavailable");
  }
  const directRuntime = channelRuntime as unknown as Parameters<
    typeof dispatchInboundDirectDmWithRuntime
  >[0]["runtime"]["channel"];
  const effectiveRuntime = {
    ...directRuntime,
    reply: {
      ...directRuntime.reply,
      dispatchReplyWithBufferedBlockDispatcher: (
        params: Parameters<
          typeof directRuntime.reply.dispatchReplyWithBufferedBlockDispatcher
        >[0],
      ) => {
        return directRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
          ...params,
          replyOptions: {
            ...params.replyOptions,
            disableBlockStreaming: false,
          },
        });
      },
    },
  };
  // Older OpenClaw releases accepted the narrow `{ channel }` runtime;
  // current releases require the full plugin runtime. The full object is
  // structurally valid for both, with only the reply helper overridden.
  const runtimeWithStreaming = {
    ...getNatsRuntime(),
    channel: effectiveRuntime,
  };

  await dispatchInboundDirectDmWithRuntime({
    cfg,
    runtime: runtimeWithStreaming,
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
      for (const slice of splitResponseText(text, maxPayloadBytes)) {
        await response.send(slice);
      }
    },
    onRecordError: (err) => {
      ctx.log?.error?.(`nats: session record error: ${String(err)}`);
    },
    onDispatchError: (err, info) => {
      ctx.log?.error?.(`nats: ${info.kind} dispatch error: ${String(err)}`);
    },
  });
}

function gatewayLogger(
  ctx: ChannelGatewayContext<ResolvedNatsAccount>,
): Logger {
  const appendContext = (
    message: string,
    data?: Record<string, unknown>,
  ): string =>
    data === undefined ? message : `${message} ${JSON.stringify(data)}`;
  return {
    debug: (message, data) =>
      ctx.log?.debug?.(`nats: ${appendContext(message, data)}`),
    info: (message, data) =>
      ctx.log?.info?.(`nats: ${appendContext(message, data)}`),
    warn: (message, data) =>
      ctx.log?.warn?.(`nats: ${appendContext(message, data)}`),
    error: (message, data) =>
      ctx.log?.error?.(`nats: ${appendContext(message, data)}`),
  };
}
