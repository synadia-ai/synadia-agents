// `runBridge` — wires `AgentService` up to a single gemini-cli child
// process running in `--acp` mode. v0.1 is single-session.

import type { NatsConnection } from "@nats-io/nats-core";
import {
  AgentService,
  splitResponseText,
  type AgentServiceOptions,
} from "@synadia-ai/agent-service";
import {
  PROMPT_ENDPOINT_NAME,
  parseHumanBytes,
  SILENT_LOGGER,
  type Logger,
} from "@synadia-ai/agents";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";

import {
  buildChildEnv,
  defaultLaunchCommand,
  startAcpClient,
  type AcpClient,
} from "./acp-client.js";
import { translateSessionUpdate } from "./chunk-translator.js";

export const AGENT_TOKEN = "gemini";

export interface RunBridgeOptions {
  readonly nc: NatsConnection;
  readonly owner: string;
  readonly session: string;
  readonly cwd: string;
  readonly command?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly logger?: Logger;
  readonly maxPayload?: string;
}

export interface BridgeHandle {
  stop(): Promise<void>;
}

function validateSubjectToken(value: string, name: string): void {
  if (value.length === 0 || /[.*>\s]/.test(value)) {
    throw new Error(
      `${name} must be non-empty and must not contain NATS special characters ` +
        `(. * > or whitespace); got: ${JSON.stringify(value)}`,
    );
  }
}

export async function runBridge(opts: RunBridgeOptions): Promise<BridgeHandle> {
  validateSubjectToken(opts.owner, "owner");
  validateSubjectToken(opts.session, "session");

  const logger = opts.logger ?? SILENT_LOGGER;
  const command = opts.command ?? defaultLaunchCommand();
  const env = opts.env ?? buildChildEnv(process.env);

  let acp: AcpClient | null = null;
  let acpPromise: Promise<AcpClient> | null = null;
  let promptAbort: AbortController | null = null;
  let activeContext: ActivePromptContext | null = null;

  const advertisedMaxPayload = parseHumanBytes(opts.maxPayload ?? "1MB");

  // TODO(v0.2): relay ACP permission requests as Synadia §7 query chunks.
  const onPermissionRequest = async (
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> => {
    logger.warn?.("gemini bridge: permission requested — denying (v0.1)", {
      sessionId: request.sessionId,
      toolCallId: request.toolCall.toolCallId,
    });
    return { outcome: { outcome: "cancelled" } };
  };

  const onSessionUpdate = async (notification: SessionNotification): Promise<void> => {
    if (activeContext === null) return;
    const chunks = translateSessionUpdate(notification.update);
    for (const chunk of chunks) {
      try {
        if (chunk.type === "response" && chunk.text.length > 0) {
          const slices = splitResponseText(chunk.text, advertisedMaxPayload);
          for (const slice of slices) {
            await activeContext.response.send({ type: "response", text: slice });
          }
        } else {
          await activeContext.response.send(chunk);
        }
      } catch (err) {
        logger.warn?.("gemini bridge: chunk send failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  const ensureAcp = (): Promise<AcpClient> => {
    if (acpPromise === null) {
      acpPromise = startAcpClient({
        command,
        env,
        cwd: opts.cwd,
        onSessionUpdate,
        onPermissionRequest,
        ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
      }).then((client) => {
        acp = client;
        return client;
      });
    }
    return acpPromise;
  };

  const serviceOptions: AgentServiceOptions = {
    nc: opts.nc,
    agent: AGENT_TOKEN,
    owner: opts.owner,
    name: opts.session,
    description: `${AGENT_TOKEN} ACP bridge for ${opts.owner}/${opts.session}`,
    version: "0.0.1",
    attachmentsOk: false,
    ...(opts.maxPayload !== undefined ? { maxPayload: opts.maxPayload } : {}),
  };

  const service = new AgentService(serviceOptions);

  service.onPrompt(async (envelope, response) => {
    const client = await ensureAcp();
    const abort = new AbortController();
    promptAbort = abort;
    activeContext = { response };
    try {
      const result = await client.prompt(envelope.prompt, abort.signal);
      logger.info?.("gemini bridge: prompt completed", {
        stopReason: result.stopReason,
      });
    } finally {
      activeContext = null;
      if (promptAbort === abort) promptAbort = null;
    }
  });

  await service.start();
  logger.info?.("gemini bridge: listening", {
    subject: service.subject.prompt,
    endpoint: PROMPT_ENDPOINT_NAME,
    owner: opts.owner,
    session: opts.session,
    cwd: opts.cwd,
  });

  return {
    stop: async (): Promise<void> => {
      await service.stop();
      if (acp !== null) {
        try {
          if (promptAbort !== null) {
            promptAbort.abort();
            await acp.cancel();
          }
          await acp.close();
        } catch (err) {
          logger.warn?.("gemini bridge: acp.close threw", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        acp = null;
      }
    },
  };
}

interface ActivePromptContext {
  readonly response: import("@synadia-ai/agent-service").PromptResponse;
}
