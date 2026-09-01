#!/usr/bin/env bun
/** Claude Code channel host for the Synadia Agent Protocol for NATS v0.3. */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import {
  Agents,
  IdentityError,
  NatsContextError,
  formatSender,
  parseHumanBytes,
  resolveNatsConnectionBundle,
  withAgentReconnectDefaults,
  type NatsConnectionBundle,
  type RequestEnvelope,
} from "@synadia-ai/agents";
import {
  AgentService,
  DEFAULT_MAX_PAYLOAD,
  PromptResponse,
  splitResponseText,
} from "@synadia-ai/agent-service";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  loadConfig,
  resolveRuntimeSettings,
  type NatsChannelConfig,
} from "./src/config.js";

const AGENT_ID = "claude-code";
const AGENT_SUBJECT_TOKEN = "cc";
const HEARTBEAT_INTERVAL_S = 5;
const KEEPALIVE_INTERVAL_S = 30;
const PERMISSION_TIMEOUT_MS = 120_000;
const REQUEST_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_PAYLOAD_BYTES = parseHumanBytes(DEFAULT_MAX_PAYLOAD);
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT =
  basename(MODULE_DIR) === "runtime" ? dirname(MODULE_DIR) : MODULE_DIR;

function loadPluginVersion(): string {
  const manifest = JSON.parse(
    readFileSync(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"),
  ) as { version?: unknown };
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("invalid plugin descriptor version");
  }
  return manifest.version;
}

type Deferred = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly settled: () => boolean;
};

type PendingRequest = {
  readonly response: PromptResponse;
  readonly sender: string;
  readonly createdAt: number;
  readonly completion: Deferred;
  readonly handlerClosed: Deferred;
  readonly attachmentDir?: string;
};

type StagedAttachment = { readonly filename: string; readonly path: string };

function deferred(): Deferred {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  let done = false;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  // Expiry/shutdown can reject while the handler is still sending its MCP
  // notification. Suppress only that transient unhandled-rejection report;
  // awaiting the original promise below still observes the rejection.
  promise.catch(() => undefined);
  return {
    promise,
    resolve() {
      if (done) return;
      done = true;
      resolvePromise();
    },
    reject(error) {
      if (done) return;
      done = true;
      rejectPromise(error);
    },
    settled: () => done,
  };
}

function sanitizeSessionName(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
}

function logEvent(
  event: string,
  fields: Readonly<Record<string, unknown>> = {},
): void {
  process.stderr.write(`nats channel: ${event} ${JSON.stringify(fields)}\n`);
}

const protocolLogger = {
  debug(message: string, context?: Readonly<Record<string, unknown>>) {
    logEvent(message, safeProtocolContext(context));
  },
  warn(message: string, context?: Readonly<Record<string, unknown>>) {
    logEvent(`warning: ${message}`, safeProtocolContext(context));
  },
  error(message: string, context?: Readonly<Record<string, unknown>>) {
    logEvent(`error: ${message}`, safeProtocolContext(context));
  },
};

/** Keep only public identity/protocol fields; never serialize arbitrary errors or headers. */
function safeProtocolContext(
  context?: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!context) return {};
  const safe: Record<string, unknown> = {};
  for (const key of [
    "subject",
    "sender",
    "code",
    "maxPayload",
    "serverMaxPayload",
  ]) {
    const value = context[key];
    if (typeof value === "string" || typeof value === "number")
      safe[key] = value;
  }
  return safe;
}

async function resolveSessionName(
  nc: NatsConnection,
  base: string,
  owner: string,
): Promise<string> {
  const client = new Agents({ nc });
  const taken = new Set<string>();
  try {
    const found = await client.discover({
      timeoutMs: 1000,
      filter: { agent: AGENT_ID, owner },
    });
    for (const agent of found) taken.add(agent.name);
  } catch {
    // No existing services or a discovery timeout is fine; registration still validates collisions.
  } finally {
    await client.close();
  }

  let candidate = base;
  let suffix = 2;
  while (taken.has(candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}

function stageAttachments(
  root: string,
  requestId: string,
  attachments: RequestEnvelope["attachments"],
): StagedAttachment[] {
  if (!attachments || attachments.length === 0) return [];
  const dir = join(root, requestId);
  mkdirSync(dir, { recursive: true });
  try {
    return attachments.map((attachment, index) => {
      const safeBase = basename(attachment.filename).replace(/^\.+/, "_");
      const safeName = safeBase.length > 0 ? safeBase : `file-${index}`;
      const path = join(dir, safeName);
      writeFileSync(path, attachment.content);
      return { filename: attachment.filename, path };
    });
  } catch {
    rmSync(dir, { recursive: true, force: true });
    throw new Error("attachment staging failed");
  }
}

function cleanupAttachments(root: string, requestId: string): void {
  try {
    rmSync(join(root, requestId), { recursive: true, force: true });
  } catch {
    // Best effort during request completion and shutdown.
  }
}

function interpretPermissionReply(raw: string): "allow" | "deny" {
  const text = raw.trim();
  if (/^(y|yes|allow)$/i.test(text)) return "allow";
  if (/^(n|no|deny)$/i.test(text)) return "deny";
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as { behavior?: string; prompt?: string };
      if (parsed.behavior === "allow" || parsed.behavior === "deny")
        return parsed.behavior;
      if (typeof parsed.prompt === "string")
        return interpretPermissionReply(parsed.prompt);
    } catch {
      // Unknown replies deny below.
    }
  }
  return "deny";
}

function resolveOwner(config: NatsChannelConfig): string {
  return (
    (process.env.SYNADIA_CLAUDE_CODE_OWNER ??
      process.env.SYNADIA_OWNER ??
      config.owner ??
      sanitizeSessionName(process.env.USER ?? "unknown")) ||
    "unknown"
  );
}

function resolveRawSessionName(config: NatsChannelConfig): string {
  return (
    (process.env.SYNADIA_CLAUDE_CODE_NAME ??
      process.env.SYNADIA_NAME ??
      process.env.NATS_SESSION_NAME ??
      config.sessionName ??
      sanitizeSessionName(basename(process.env.CLAUDE_CWD ?? ""))) ||
    "default"
  );
}

function startupDescription(error: unknown): string {
  if (error instanceof IdentityError || error instanceof NatsContextError)
    return error.message;
  if (error instanceof Error && error.message.startsWith("invalid "))
    return error.message;
  return `startup failed (${error instanceof Error ? error.name : "unknown error"})`;
}

async function closeConnectionBeforeWipe(
  nc: NatsConnection | undefined,
  bundle: NatsConnectionBundle,
  drain: boolean,
): Promise<boolean> {
  if (nc) {
    try {
      if (drain) {
        try {
          await nc.drain();
        } catch {
          await nc.close();
        }
      } else {
        await nc.close();
      }
    } catch {
      // Reconnect authentication may still reference the retained bytes.
      return false;
    }
  }
  bundle.wipe();
  return true;
}

async function run(): Promise<void> {
  const pluginVersion = loadPluginVersion();
  const stateDir =
    process.env.NATS_STATE_DIR ??
    join(homedir(), ".claude", "channels", "nats");
  const attachmentRoot = join(stateDir, "attachments");
  mkdirSync(attachmentRoot, { recursive: true });

  const config = loadConfig(join(stateDir, "config.json"));
  const settings = resolveRuntimeSettings(config, process.env);
  let bundle: NatsConnectionBundle | undefined;
  let nc: NatsConnection | undefined;
  let service: AgentService | undefined;
  let mcp: Server | undefined;

  try {
    bundle = await resolveNatsConnectionBundle(settings.connectionSource, {
      identity: settings.senderIdentity,
    });
    bundle.connectionOptions.name = "claude-code-nats-channel";
    logEvent("connecting", {
      source: settings.connectionLabel,
      senderIdentity: settings.senderIdentity,
      minSenderTrust: settings.minSenderTrust,
    });
    nc = await connect(withAgentReconnectDefaults(bundle.connectionOptions));

    const owner = resolveOwner(config);
    const sessionName = await resolveSessionName(
      nc,
      resolveRawSessionName(config),
      owner,
    );
    const maxPayloadBytes = nc.info?.max_payload ?? DEFAULT_MAX_PAYLOAD_BYTES;
    const pendingRequests = new Map<string, PendingRequest>();
    let requestCounter = 0;
    let lastActiveRequestId: string | undefined;
    let shuttingDown = false;

    const removePending = (requestId: string): void => {
      const pending = pendingRequests.get(requestId);
      if (!pending) return;
      if (pending.attachmentDir) cleanupAttachments(attachmentRoot, requestId);
      pendingRequests.delete(requestId);
      if (lastActiveRequestId === requestId) {
        lastActiveRequestId = Array.from(pendingRequests.keys()).at(-1);
      }
    };

    mcp = new Server(
      { name: "nats-channel", version: pluginVersion },
      {
        capabilities: {
          tools: {},
          experimental: {
            "claude/channel": {},
            "claude/channel/permission": {},
          },
        },
        instructions: [
          `NATS channel listening on agents.prompt.${AGENT_SUBJECT_TOKEN}.${owner}.${sessionName}.`,
          "",
          "The sender communicates via NATS, not this session. Anything they should see must be sent with the reply tool.",
          "",
          'Messages arrive as <channel source="nats" request_id="..." session="..." ts="...">. Attachment paths, when present, are listed at the start of the message.',
          "",
          "Use request_info only when sender identity is relevant; identity is never inserted into the incoming message automatically.",
          "",
          "Use reply with the request_id. done=false streams an intermediate response; done=true completes the request.",
        ].join("\n"),
      },
    );

    service = new AgentService({
      nc,
      agent: AGENT_ID,
      subjectToken: AGENT_SUBJECT_TOKEN,
      owner,
      name: sessionName,
      session: sessionName,
      description: `Claude Code — ${sessionName}`,
      version: pluginVersion,
      attachmentsOk: true,
      heartbeatIntervalS: HEARTBEAT_INTERVAL_S,
      keepaliveIntervalS: KEEPALIVE_INTERVAL_S,
      minSenderTrust: settings.minSenderTrust,
      logger: protocolLogger,
      ...(settings.senderIdentity === "signed"
        ? { identity: { signer: bundle.signer! } }
        : {}),
    });

    service.onPrompt(async (envelope, response) => {
      if (shuttingDown) throw new Error("channel shutting down");
      const requestId = String(++requestCounter);
      const staged = stageAttachments(
        attachmentRoot,
        requestId,
        envelope.attachments,
      );
      const completion = deferred();
      const handlerClosed = deferred();
      const pending: PendingRequest = {
        response,
        sender: formatSender(response.sender),
        createdAt: Date.now(),
        completion,
        handlerClosed,
        ...(staged.length > 0
          ? { attachmentDir: join(attachmentRoot, requestId) }
          : {}),
      };
      pendingRequests.set(requestId, pending);
      lastActiveRequestId = requestId;

      logEvent("prompt admitted", { requestId, sender: pending.sender });
      const content =
        staged.length > 0
          ? `[Attachments available at the following absolute paths]\n${staged.map((item) => `- ${item.path}`).join("\n")}\n\n${envelope.prompt}`
          : envelope.prompt;

      try {
        try {
          await mcp!.notification({
            method: "notifications/claude/channel",
            params: {
              content,
              // Sender identity is deliberately absent: primitive meta values become
              // model-visible <channel> attributes in Claude Code.
              meta: {
                request_id: requestId,
                session: sessionName,
                ts: new Date().toISOString(),
              },
            },
          });
        } catch {
          completion.resolve();
          throw new Error("channel delivery failed");
        }
        await completion.promise;
      } finally {
        removePending(requestId);
        handlerClosed.resolve();
      }
    });

    if (settings.permissionMode === "query") {
      mcp.setNotificationHandler(
        z.object({
          method: z.literal("notifications/claude/channel/permission_request"),
          params: z.object({
            request_id: z.string(),
            tool_name: z.string(),
            description: z.string(),
            input_preview: z.string(),
          }),
        }),
        async ({ params }) => {
          const active = lastActiveRequestId
            ? pendingRequests.get(lastActiveRequestId)
            : undefined;
          let behavior: "allow" | "deny" = "deny";
          if (!active) {
            logEvent("permission denied without active request", {
              tool: params.tool_name,
            });
          } else {
            const prompt =
              `${params.tool_name}: ${params.description}` +
              (params.input_preview ? `\n\n${params.input_preview}` : "") +
              `\n\nReply 'yes' to allow or 'no' to deny.`;
            try {
              const answer = await active.response.ask(prompt, {
                timeoutMs: PERMISSION_TIMEOUT_MS,
              });
              behavior = interpretPermissionReply(answer.prompt);
            } catch {
              logEvent("permission query timed out", {
                tool: params.tool_name,
              });
            }
          }
          await mcp!.notification({
            method: "notifications/claude/channel/permission",
            params: { request_id: params.request_id, behavior },
          });
        },
      );
    }

    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "reply",
          description:
            "Reply over NATS. done=false streams; done=true completes the request.",
          inputSchema: {
            type: "object",
            properties: {
              request_id: {
                type: "string",
                description: "The inbound channel request_id.",
              },
              text: { type: "string", description: "Response text." },
              done: { type: "boolean", default: true },
            },
            required: ["request_id", "text"],
          },
        },
        {
          name: "request_info",
          description:
            "Inspect the safely classified NATS sender for an active request.",
          inputSchema: {
            type: "object",
            properties: {
              request_id: {
                type: "string",
                description: "The inbound channel request_id.",
              },
            },
            required: ["request_id"],
          },
        },
      ],
    }));

    mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      const requestId =
        typeof args.request_id === "string" ? args.request_id : "";
      const pending = pendingRequests.get(requestId);
      if (!pending || pending.completion.settled()) {
        return {
          content: [{ type: "text", text: "request is not active" }],
          isError: true,
        };
      }

      if (request.params.name === "request_info") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                request_id: requestId,
                sender: pending.sender,
              }),
            },
          ],
        };
      }

      if (request.params.name !== "reply" || typeof args.text !== "string") {
        return {
          content: [{ type: "text", text: "invalid tool arguments" }],
          isError: true,
        };
      }

      const done = args.done !== false;
      if (args.text.length > 0) {
        for (const slice of splitResponseText(args.text, maxPayloadBytes)) {
          await pending.response.send(slice);
        }
      }
      logEvent("response sent", {
        requestId,
        bytes: Buffer.byteLength(args.text),
        done,
      });
      if (done) pending.completion.resolve();
      return {
        content: [{ type: "text", text: done ? "sent and completed" : "sent" }],
      };
    });

    const ttlTimer = setInterval(() => {
      const cutoff = Date.now() - REQUEST_TTL_MS;
      for (const [requestId, pending] of pendingRequests) {
        if (pending.createdAt >= cutoff || pending.completion.settled())
          continue;
        logEvent("request expired", { requestId, sender: pending.sender });
        pending.completion.reject(new Error("request expired"));
      }
    }, 60_000);
    ttlTimer.unref();

    // Claude must be ready to receive channel notifications before NATS advertises
    // the prompt endpoint; otherwise a just-discovered caller can lose a prompt.
    await mcp.connect(new StdioServerTransport());
    await service.start();
    logEvent("service registered", {
      instanceId: service.instanceId,
      subject: service.subject.prompt,
      identity: service.identity ?? "off",
      minSenderTrust: service.minSenderTrust,
    });

    let shutdownPromise: Promise<void> | undefined;
    const shutdown = (): Promise<void> => {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        shuttingDown = true;
        clearInterval(ttlTimer);
        logEvent("shutting down");
        await service!.stop().catch(() => undefined);

        const closed = Array.from(
          pendingRequests.values(),
          (pending) => pending.handlerClosed.promise,
        );
        for (const pending of pendingRequests.values()) {
          pending.completion.reject(new Error("channel shutting down"));
        }
        await Promise.allSettled(closed);
        // Let AgentService turn rejected handlers into their error frame + terminator.
        await Promise.resolve();
        await Promise.resolve();
        await nc!.flush().catch(() => undefined);
        await mcp!.close().catch(() => undefined);
        if (!(await closeConnectionBeforeWipe(nc, bundle!, true))) {
          throw new Error(
            "NATS connection did not close; retained credentials were not wiped",
          );
        }
      })();
      const attempt = shutdownPromise;
      void attempt.catch(() => {
        if (shutdownPromise === attempt) shutdownPromise = undefined;
      });
      return shutdownPromise;
    };

    const requestShutdown = (): void => {
      void shutdown().catch(() =>
        logEvent("shutdown incomplete; NATS close may be retried"),
      );
    };
    process.stdin.on("end", requestShutdown);
    process.stdin.on("close", requestShutdown);
    process.on("SIGTERM", requestShutdown);
    process.on("SIGINT", requestShutdown);

    void (async () => {
      for await (const status of nc!.status()) {
        if (status.type === "disconnect") logEvent("disconnected");
        if (status.type === "reconnect") logEvent("reconnected");
        if (status.type === "error") logEvent("connection error");
      }
    })();
  } catch (error) {
    await service?.stop().catch(() => undefined);
    await mcp?.close().catch(() => undefined);
    if (bundle) await closeConnectionBeforeWipe(nc, bundle, false);
    throw error;
  }
}

run().catch((error) => {
  process.stderr.write(`nats channel: ${startupDescription(error)}\n`);
  process.exitCode = 1;
});
