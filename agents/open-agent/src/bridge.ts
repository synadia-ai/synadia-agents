// `runBridge` — wires `AgentService` up to a per-prompt `ToolLoopAgent`
// instance backed by a swappable sandbox.
//
// Same handler powers both the standalone CLI (LocalSandbox) and the
// Vercel example (VercelSandbox); the only difference is what
// `sandboxFactory` returns.

import type { NatsConnection } from "@nats-io/nats-core";
import {
  AgentService,
  type AgentServiceOptions,
} from "@synadia-ai/agent-service";
import {
  PROMPT_ENDPOINT_NAME,
  parseHumanBytes,
  SILENT_LOGGER,
  type Logger,
} from "@synadia-ai/agents";
import type { ModelMessage } from "ai";

import { buildBridgeAgent } from "./agent.js";
import { translatePart, type UIPart } from "./chunk-translator.js";
import { ConversationHistory } from "./history.js";
import { gatewayModelFactory, type ModelFactory } from "./model-factory.js";
import type { Sandbox } from "../vendor/sandbox/interface.js";
import type { SandboxState } from "../vendor/sandbox/factory.js";
import { defaultModelLabel } from "../vendor/agent/open-agent.js";
import { splitResponseText } from "@synadia-ai/agent-service";

/** A constructed sandbox plus the state shape the vendored tools resolve from. */
export interface SandboxBundle {
  readonly sandbox: Sandbox;
  readonly state: SandboxState;
}

export interface RunBridgeOptions {
  /** Pre-connected NATS handle. Caller retains ownership. */
  readonly nc: NatsConnection;
  /** §3.2 `metadata.owner`. */
  readonly owner: string;
  /** Instance name — 5th subject token (§2 v0.3). */
  readonly session: string;
  /** Lazy factory — invoked once on first prompt. */
  readonly sandboxFactory: (sessionId: string) => Promise<SandboxBundle>;
  /**
   * Wire model id passed to {@link modelFactory}. Default:
   * `anthropic/claude-opus-4.6` — the upstream open-agents
   * `defaultModelLabel`. Semantics depend on the active factory:
   *   - `gatewayModelFactory()`: a Vercel AI Gateway slug
   *     (`provider/model-id`).
   *   - `openRouterModelFactory()`: an OpenRouter model slug.
   */
  readonly modelId?: string;
  /**
   * Resolves a model id to a `LanguageModel`. Defaults to
   * {@link gatewayModelFactory} (Vercel AI Gateway). Pass
   * {@link openRouterModelFactory} or your own factory to swap providers.
   */
  readonly modelFactory?: ModelFactory;
  /** Cap on tool-loop steps. Defaults to 50. */
  readonly maxSteps?: number;
  /** Timeout (ms) for `ask_user_question` round-trips. Defaults to 5 minutes. */
  readonly askUserQuestionTimeoutMs?: number;
  /** Forward-compat: free-form description of the working directory. */
  readonly workingDirectoryHint?: string;
  /** Optional logger. Defaults to silent. */
  readonly logger?: Logger;
  /**
   * Forwarded to `AgentService` — useful for the integration test where
   * the broker negotiates a small `max_payload`. Defaults to `1MB`.
   */
  readonly maxPayload?: string;
  /** Pluggable hook for the integration test to inject a stub agent. */
  readonly agentFactory?: AgentFactory;
}

/**
 * Function building a streamed run for one prompt. Default implementation
 * uses the vendored `ToolLoopAgent`. Tests inject a stub.
 */
export type AgentFactory = (input: AgentFactoryInput) => Promise<AgentRun>;

export interface AgentFactoryInput {
  readonly history: ReadonlyArray<ModelMessage>;
  readonly sandbox: Sandbox;
  readonly sandboxState: SandboxState;
  readonly modelId: string;
  readonly modelFactory: ModelFactory;
  readonly maxSteps: number;
  readonly askUserQuestionTimeoutMs: number;
  readonly response: import("@synadia-ai/agent-service").PromptResponse;
}

export interface AgentRun {
  /** Iterable of UI parts to translate for the wire. */
  readonly stream: AsyncIterable<UIPart>;
  /** Resolves with messages appended after the run completes. */
  readonly waitForResult: () => Promise<ModelMessage[]>;
}

const DEFAULT_MAX_STEPS = 50;
const DEFAULT_ASK_USER_QUESTION_TIMEOUT_MS = 5 * 60_000;

/**
 * Start the bridge. Returns once `AgentService.start` has finished
 * (heartbeats running, endpoints registered). Call `stop()` to tear down.
 */
export async function runBridge(opts: RunBridgeOptions): Promise<{ stop: () => Promise<void> }> {
  const logger = opts.logger ?? SILENT_LOGGER;
  const modelId = opts.modelId ?? defaultModelLabel;
  const modelFactory = opts.modelFactory ?? gatewayModelFactory();
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const askUserQuestionTimeoutMs =
    opts.askUserQuestionTimeoutMs ?? DEFAULT_ASK_USER_QUESTION_TIMEOUT_MS;
  const agentFactory = opts.agentFactory ?? defaultAgentFactory;

  const history = new ConversationHistory();
  let cachedSandbox: SandboxBundle | null = null;
  const ensureSandbox = async (): Promise<SandboxBundle> => {
    if (cachedSandbox === null) {
      cachedSandbox = await opts.sandboxFactory(opts.session);
      logger.info("open-agent: sandbox ready", {
        type: cachedSandbox.state.type,
        workingDirectory: cachedSandbox.sandbox.workingDirectory,
      });
    }
    return cachedSandbox;
  };

  const serviceOptions: AgentServiceOptions = {
    nc: opts.nc,
    agent: "open-agent",
    owner: opts.owner,
    name: opts.session,
    description: `open-agent bridge for ${opts.owner}/${opts.session}`,
    version: "0.0.1",
    attachmentsOk: false,
    ...(opts.maxPayload !== undefined ? { maxPayload: opts.maxPayload } : {}),
  };

  const service = new AgentService(serviceOptions);

  // Compute payload budget once; AgentService clamps if needed.
  const advertisedMaxPayload = parseHumanBytes(opts.maxPayload ?? "1MB");

  service.onPrompt(async (envelope, response) => {
    history.append({ role: "user", content: envelope.prompt });
    const bundle = await ensureSandbox();

    const run = await agentFactory({
      history: history.snapshot(),
      sandbox: bundle.sandbox,
      sandboxState: bundle.state,
      modelId,
      modelFactory,
      maxSteps,
      askUserQuestionTimeoutMs,
      response,
    });

    let assistantTextBuffer = "";
    for await (const part of run.stream) {
      // Accumulate model-emitted text (text-delta) so we can persist a
      // single `{role:"assistant"}` turn into history. Tool I/O is not
      // round-tripped — v1 doesn't replay tool calls across prompts.
      if (part.type === "text-delta") {
        const delta = (part as { delta?: unknown }).delta;
        if (typeof delta === "string") assistantTextBuffer += delta;
      }
      const chunks = translatePart(part);
      for (const chunk of chunks) {
        if (chunk.type === "response" && chunk.text.length > 0) {
          // Long deltas — chunker handles UTF-8 + escape budget.
          const slices = splitResponseText(chunk.text, advertisedMaxPayload);
          for (const slice of slices) {
            await response.send({ type: "response", text: slice });
          }
        } else {
          await response.send(chunk);
        }
      }
    }

    if (assistantTextBuffer.length > 0) {
      history.append({ role: "assistant", content: assistantTextBuffer });
    }
    const trailingMessages = await run.waitForResult();
    if (trailingMessages.length > 0) {
      history.appendAll(trailingMessages);
    }
  });

  await service.start();
  logger.info("open-agent: bridge listening", {
    subject: service.subject.prompt,
    endpoint: PROMPT_ENDPOINT_NAME,
    owner: opts.owner,
    session: opts.session,
    workingDirectory: opts.workingDirectoryHint,
  });

  return {
    stop: async () => {
      await service.stop();
      if (cachedSandbox !== null) {
        try {
          await cachedSandbox.sandbox.stop();
        } catch (err) {
          logger.warn("open-agent: sandbox.stop threw", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        cachedSandbox = null;
      }
    },
  };
}

/** Default factory — wires the vendored ToolLoopAgent. */
const defaultAgentFactory: AgentFactory = async (input) => {
  const agent = buildBridgeAgent({
    response: input.response,
    modelId: input.modelId,
    modelFactory: input.modelFactory,
    maxSteps: input.maxSteps,
    askUserQuestionTimeoutMs: input.askUserQuestionTimeoutMs,
  });

  const result = await agent.stream({
    messages: [...input.history],
    options: {
      sandbox: {
        state: input.sandboxState,
        workingDirectory: input.sandbox.workingDirectory,
      },
    },
  });

  // The AI SDK's UIMessage shape is different from `ModelMessage`. We
  // re-derive the assistant turn from text-deltas during the stream and
  // append it once the iterator drains (see `runBridge`).
  const stream = result.toUIMessageStream() as unknown as AsyncIterable<UIPart>;

  return {
    stream,
    waitForResult: async () => [],
  };
};
