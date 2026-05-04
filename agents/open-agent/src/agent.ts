// Per-prompt `ToolLoopAgent` factory.
//
// The vendored `openAgent` is a module-level singleton. We rebuild it for
// every prompt because the `ask_user_question` tool needs to capture the
// current request's `PromptResponse` in its closure to round-trip a
// mid-stream §7 query. Constructing a `ToolLoopAgent` is just JS object
// allocation — cheap.

import type { PromptResponse } from "@synadia-ai/agent-service";
import {
  stepCountIs,
  tool,
  ToolLoopAgent,
  type LanguageModel,
} from "ai";
import { z } from "zod";

import {
  bashTool,
  editFileTool,
  globTool,
  grepTool,
  readFileTool,
  skillTool,
  taskTool,
  todoWriteTool,
  webFetchTool,
  writeFileTool,
} from "../vendor/agent/tools/index.js";
import { addCacheControl } from "../vendor/agent/context-management/index.js";
import { buildSystemPrompt } from "../vendor/agent/system-prompt.js";
import {
  askUserQuestionInputSchema,
  type AskUserQuestionInput,
} from "../vendor/agent/tools/ask-user-question.js";
import type { AgentSandboxContext } from "../vendor/agent/open-agent.js";
import type { ModelFactory } from "./model-factory.js";

export interface BuildBridgeAgentOptions {
  readonly response: PromptResponse;
  /** Wire model id — semantics depend on the {@link ModelFactory} (Gateway slug, OpenRouter slug, etc.). */
  readonly modelId: string;
  readonly modelFactory: ModelFactory;
  readonly maxSteps: number;
  readonly askUserQuestionTimeoutMs: number;
}

const callOptionsSchema = z.object({
  sandbox: z.custom<AgentSandboxContext>(),
  /** Override the model for a single call. Same `modelId` shape as the bridge default. */
  model: z.string().optional(),
});

export type BridgeCallOptions = z.infer<typeof callOptionsSchema>;

/** Construct a `ToolLoopAgent` wired to a specific NATS request. */
export function buildBridgeAgent(opts: BuildBridgeAgentOptions) {
  const tools = {
    todo_write: todoWriteTool,
    read: readFileTool(),
    write: writeFileTool(),
    edit: editFileTool(),
    grep: grepTool(),
    glob: globTool(),
    bash: bashTool({
      needsApproval: bashApprovalViaNats(opts.response, opts.askUserQuestionTimeoutMs),
    }),
    task: taskTool,
    ask_user_question: askUserQuestionViaNats(opts.response, opts.askUserQuestionTimeoutMs),
    skill: skillTool,
    web_fetch: webFetchTool,
  };

  return new ToolLoopAgent({
    model: opts.modelFactory(opts.modelId),
    instructions: buildSystemPrompt({}),
    tools,
    stopWhen: stepCountIs(opts.maxSteps),
    callOptionsSchema,
    prepareStep: ({ messages, model }) => ({
      messages: addCacheControl({ messages, model }),
    }),
    prepareCall: ({ options, ...settings }) => {
      if (!options) {
        throw new Error("bridge agent requires call options with sandbox.");
      }
      const callModelId = options.model ?? opts.modelId;
      const callModel: LanguageModel = opts.modelFactory(callModelId);
      const sandbox = options.sandbox;
      const instructions = buildSystemPrompt({
        cwd: sandbox.workingDirectory,
        ...(sandbox.currentBranch !== undefined ? { currentBranch: sandbox.currentBranch } : {}),
        ...(sandbox.environmentDetails !== undefined
          ? { environmentDetails: sandbox.environmentDetails }
          : {}),
        modelId: callModelId,
      });
      return {
        ...settings,
        model: callModel,
        tools: addCacheControl({
          tools: settings.tools ?? tools,
          model: callModel,
        }),
        instructions,
        experimental_context: {
          sandbox,
          model: callModel,
          skills: [],
        },
      };
    },
  });
}

/**
 * Replace the upstream client-side `ask_user_question` tool with one that
 * round-trips through `PromptResponse.ask` — the spec §7 mid-stream query
 * mechanism. The model sees the same input/output shape; the bridge is the
 * one that talks to the caller.
 */
export function askUserQuestionViaNats(
  response: PromptResponse,
  timeoutMs: number,
) {
  return tool({
    description:
      "Ask the user one or more questions during execution. Each question has " +
      "a header, body, and 2-4 options. The user picks an option (by number, " +
      "letter, or substring) and the answer is returned.",
    inputSchema: askUserQuestionInputSchema,
    execute: async (input: AskUserQuestionInput) => {
      const reply = await response.ask(formatQuestion(input), { timeoutMs });
      return parseAnswer(reply.prompt, input);
    },
  });
}

function formatQuestion(input: AskUserQuestionInput): string {
  const lines: string[] = [];
  for (const [qi, q] of input.questions.entries()) {
    lines.push(`Q${qi + 1}. [${q.header}] ${q.question}`);
    for (const [oi, opt] of q.options.entries()) {
      lines.push(`  ${oi + 1}) ${opt.label} — ${opt.description}`);
    }
    if (q.multiSelect) {
      lines.push("  (multiple selections allowed; comma-separate)");
    }
  }
  lines.push(
    "Reply with the option number(s) or label(s). Use \"decline\" to skip.",
  );
  return lines.join("\n");
}

function parseAnswer(replyText: string, input: AskUserQuestionInput) {
  const trimmed = replyText.trim();
  if (trimmed.toLowerCase() === "decline") {
    return { declined: true as const };
  }

  const parts = trimmed.split(/\s*[,;\n]+\s*/).filter((s) => s.length > 0);
  const answers: Record<string, string | string[]> = {};

  for (const [qi, q] of input.questions.entries()) {
    const matches: string[] = [];
    for (const part of parts) {
      const match = matchOption(part, q.options);
      if (match !== undefined) matches.push(match);
      if (!q.multiSelect && matches.length > 0) break;
    }
    if (matches.length === 0) {
      // Best-effort: treat the entire reply as a freeform answer.
      answers[q.question] = trimmed;
    } else {
      answers[q.question] = q.multiSelect ? matches : (matches[0] as string);
    }
    // Consume `parts` greedily when the model asked one question.
    if (input.questions.length === 1 && qi === 0) break;
  }

  return { answers };
}

/**
 * Approval set used to decide whether the user has greenlit a dangerous
 * bash command. Anything outside this set — empty replies, "no",
 * "decline", or unparseable text — is treated as a denial.
 */
const BASH_APPROVAL_TOKENS: ReadonlySet<string> = new Set([
  "y",
  "yes",
  "approve",
  "approved",
  "allow",
  "ok",
  "okay",
  "1",
]);

/**
 * Wire the vendored `bashTool`'s `needsApproval` hook through the spec
 * §7 query mechanism. When the upstream `commandNeedsApproval` flags a
 * command as dangerous (`rm -rf`, `.env` references), we round-trip
 * through `PromptResponse.ask`:
 *
 *   - User replies with one of {y, yes, approve, allow, ok, 1} → return
 *     `false` (i.e. "no further approval needed") so the AI SDK
 *     proceeds to `bash.execute`.
 *   - Any other reply (or a query timeout) → throw, which the AI SDK
 *     surfaces as a `tool-output-error` UIPart. The model sees a
 *     denial and can pick a different approach.
 *
 * Returning `true` here would tell the AI SDK the call still needs
 * approval — and there's no UI to grant it from a NATS bridge, so
 * that path would deadlock. That's why a denial is signalled by
 * throwing rather than by returning `true`.
 */
export function bashApprovalViaNats(response: PromptResponse, timeoutMs: number) {
  return async ({ command }: { command: string }) => {
    const reply = await response.ask(
      `bash command requires approval — reply 'yes' to allow, anything else denies.\n\n  $ ${command}`,
      { timeoutMs },
    );
    const trimmed = reply.prompt.trim().toLowerCase();
    if (BASH_APPROVAL_TOKENS.has(trimmed)) return false;
    throw new Error(
      `bash command denied by user (reply: ${JSON.stringify(reply.prompt)}): ${command}`,
    );
  };
}

function matchOption(
  candidate: string,
  options: ReadonlyArray<{ label: string; description: string }>,
): string | undefined {
  const c = candidate.trim().toLowerCase();
  if (c.length === 0) return undefined;

  // Numeric (1-based)
  const n = Number.parseInt(c, 10);
  if (!Number.isNaN(n) && n >= 1 && n <= options.length) {
    return options[n - 1]?.label;
  }

  // Letter (a/b/c)
  if (/^[a-z]$/.test(c)) {
    const idx = c.charCodeAt(0) - "a".charCodeAt(0);
    if (idx >= 0 && idx < options.length) return options[idx]?.label;
  }

  // Substring against label
  for (const opt of options) {
    if (opt.label.toLowerCase().includes(c)) return opt.label;
  }
  return undefined;
}
