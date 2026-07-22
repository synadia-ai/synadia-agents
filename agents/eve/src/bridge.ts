import type { RequestEnvelope } from "@synadia-ai/agents";
import { splitResponseText, type Chunk } from "@synadia-ai/agent-service";
import { resolveTextToResponse } from "eve/client";
import type {
  ActionResultStreamEvent,
  ActionsRequestedStreamEvent,
  HandleMessageStreamEvent,
  InputOption,
  InputRequest,
  InputResponse,
} from "eve/client";
import type { UserContent } from "ai";
import { attachmentToFilePart } from "./attachments.js";
import type { EveMapping } from "./config.js";

/** One Eve turn's worth of input: the first send carries the user message, HITL resumes carry input responses. */
export interface EveSendInput {
  readonly message?: string | UserContent;
  readonly inputResponses?: readonly InputResponse[];
}

/**
 * Seam between the bridge and the Eve HTTP client. One `send` dispatches one
 * turn and resolves to that turn's event stream; the stream ends at the next
 * turn boundary (`session.waiting` / `session.completed` / `session.failed`).
 */
export interface EveBridgeClient {
  send(input: EveSendInput): Promise<AsyncIterable<HandleMessageStreamEvent>>;
  sessionId(): string | undefined;
}

/** Narrow view of the SDK's PromptResponse, for focused bridge tests. */
export interface BridgeResponse {
  send(chunk: string | Chunk): Promise<void>;
  ask(prompt: string, opts: { readonly timeoutMs: number }): Promise<RequestEnvelope>;
}

export interface BridgePromptOptions {
  readonly envelope: RequestEnvelope;
  readonly response: BridgeResponse;
  readonly mapping: EveMapping;
  readonly eveClient: EveBridgeClient;
  readonly maxPayloadBytes?: number;
}

/**
 * Ceiling on Eve→operator HITL round-trips inside a single protocol prompt.
 * Each round is one `input.requested` batch answered via §7 queries; a run
 * that keeps asking is a loop, not a conversation.
 */
export const MAX_HITL_ROUNDS = 8;

/**
 * Conservative fallback response-chunk budget: 1 MiB (default nats-server
 * max_payload) minus 4 KiB framing headroom. AgentService doesn't expose its
 * negotiated max_payload to handlers, so the bridge assumes the worst case.
 */
export const DEFAULT_MAX_PAYLOAD_BYTES = 1_048_576 - 4_096;

const DENY_OPTION_RE = /^(deny|no|cancel|reject|decline)$/i;

type EveAction = ActionsRequestedStreamEvent["data"]["actions"][number];
type EveActionResult = ActionResultStreamEvent["data"]["result"];

interface TurnFailure {
  readonly type: "step.failed" | "turn.failed" | "session.failed";
  readonly code: string;
  readonly message: string;
}

/** Build the Eve user message: plain prompt, or text + inline file parts. */
export function buildEveMessage(envelope: RequestEnvelope): string | UserContent {
  const attachments = envelope.attachments ?? [];
  if (attachments.length === 0) return envelope.prompt;
  return [
    { type: "text", text: envelope.prompt },
    ...attachments.map(attachmentToFilePart),
  ];
}

export async function bridgePromptToEve(options: BridgePromptOptions): Promise<void> {
  const { envelope, response, mapping, eveClient } = options;
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const askTimeoutMs = mapping.eve.askTimeoutS * 1000;

  let sawResponseText = false;
  let lastTerminalMessage: string | undefined;
  const structuredResults: unknown[] = [];

  const consumeTurn = async (
    stream: AsyncIterable<HandleMessageStreamEvent>,
  ): Promise<{ pendingInputs: InputRequest[]; failure: TurnFailure | undefined }> => {
    const pendingInputs: InputRequest[] = [];
    let failure: TurnFailure | undefined;
    for await (const event of stream) {
      switch (event.type) {
        case "session.started":
          await response.send({ type: "status", status: "eve session started" });
          break;
        case "message.appended":
          if (event.data.messageDelta) {
            sawResponseText = true;
            await response.send({ type: "response", text: event.data.messageDelta });
          }
          break;
        case "message.completed":
          // Terminal assistant text only — a `tool-calls` boundary is a
          // mid-turn message the model follows up on after tool results.
          if (event.data.finishReason !== "tool-calls" && event.data.message !== null) {
            lastTerminalMessage = event.data.message;
          }
          break;
        case "actions.requested":
          await response.send({
            type: "status",
            status: `eve actions: ${event.data.actions.map(actionLabel).join(", ")}`,
          });
          break;
        case "action.result": {
          const detail = event.data.error ? ` — ${event.data.error.message}` : "";
          await response.send({
            type: "status",
            status: `eve action result: ${actionResultLabel(event.data.result)} (${event.data.status})${detail}`,
          });
          break;
        }
        case "input.requested":
          await response.send({
            type: "status",
            status: `eve requests operator input (${event.data.requests.length} pending)`,
          });
          pendingInputs.push(...event.data.requests);
          break;
        case "subagent.called":
          await response.send({ type: "status", status: `eve subagent ${event.data.name} started` });
          break;
        case "compaction.requested":
          await response.send({ type: "status", status: "eve compacting session history" });
          break;
        case "authorization.required": {
          const webhook = event.data.webhookUrl ? ` — authorize at ${event.data.webhookUrl}` : "";
          await response.send({
            type: "status",
            status: `eve authorization required: ${event.data.name} (${event.data.description})${webhook}`,
          });
          break;
        }
        case "authorization.completed":
          await response.send({
            type: "status",
            status: `eve authorization ${event.data.name}: ${event.data.outcome}`,
          });
          break;
        case "result.completed":
          structuredResults.push(event.data.result);
          break;
        case "turn.cancelled":
          await response.send({ type: "status", status: "eve turn cancelled" });
          break;
        case "session.completed":
          await response.send({
            type: "status",
            status: "eve session completed — next prompt starts a new session",
          });
          break;
        case "step.failed":
        case "turn.failed":
        case "session.failed":
          failure = { type: event.type, code: event.data.code, message: event.data.message };
          break;
        default:
          // turn/step/message lifecycle, reasoning, subagent child events,
          // session.waiting boundary, and any future event types: skipped.
          break;
      }
      if (failure) break;
    }
    return { pendingInputs, failure };
  };

  let input: EveSendInput = { message: buildEveMessage(envelope) };
  let hitlRounds = 0;
  for (;;) {
    const stream = await eveClient.send(input);
    const { pendingInputs, failure } = await consumeTurn(stream);
    if (failure) {
      throw new Error(`eve ${failure.type} [${failure.code}]: ${failure.message}`);
    }
    if (pendingInputs.length === 0) break;
    hitlRounds += 1;
    if (hitlRounds > MAX_HITL_ROUNDS) {
      throw new Error(
        `eve requested operator input in more than ${MAX_HITL_ROUNDS} rounds for one prompt; giving up`,
      );
    }
    const inputResponses: InputResponse[] = [];
    for (const request of pendingInputs) {
      inputResponses.push(await askOperator(request, response, askTimeoutMs));
    }
    input = { inputResponses };
  }

  let emitted = sawResponseText;
  for (const result of structuredResults) {
    for (const piece of splitResponseText(JSON.stringify(result), maxPayloadBytes)) {
      emitted = true;
      await response.send({ type: "response", text: piece });
    }
  }
  if (!emitted) {
    await response.send({ type: "response", text: lastTerminalMessage ?? "" });
  }
}

/** Render one Eve HITL request as a §7 query prompt. */
export function formatInputRequestPrompt(request: InputRequest, prefix?: string): string {
  const lines: string[] = [];
  if (prefix) lines.push(prefix);
  lines.push(request.prompt);
  const options = request.options ?? [];
  options.forEach((option, index) => lines.push(`${index + 1}. ${option.id} — ${option.label}`));
  if (options.length > 0) lines.push("Reply with an option number, id, or label.");
  if (request.allowFreeform === true || options.length === 0) {
    lines.push("Freeform text is accepted.");
  }
  return lines.join("\n");
}

async function askOperator(
  request: InputRequest,
  response: BridgeResponse,
  timeoutMs: number,
): Promise<InputResponse> {
  let reply: RequestEnvelope;
  try {
    reply = await response.ask(formatInputRequestPrompt(request), { timeoutMs });
  } catch {
    return fallbackInputResponse(request, response, "timed out");
  }
  let resolved = resolveTextToResponse(reply.prompt, request);
  if (resolved !== undefined) return resolved;

  const prefix = `Could not match ${JSON.stringify(reply.prompt.trim())} to an option. Please answer again.`;
  try {
    reply = await response.ask(formatInputRequestPrompt(request, prefix), { timeoutMs });
  } catch {
    return fallbackInputResponse(request, response, "timed out");
  }
  resolved = resolveTextToResponse(reply.prompt, request);
  if (resolved !== undefined) return resolved;
  return fallbackInputResponse(request, response, "could not be matched to an option");
}

async function fallbackInputResponse(
  request: InputRequest,
  response: BridgeResponse,
  reason: string,
): Promise<InputResponse> {
  const deny = findDenyOption(request);
  if (deny === undefined) {
    throw new Error(`eve input request "${request.prompt}" ${reason} and has no deny-shaped option to fall back to`);
  }
  await response.send({
    type: "status",
    status: `eve input request ${reason}; auto-answering "${deny.id}"`,
  });
  return { requestId: request.requestId, optionId: deny.id };
}

function findDenyOption(request: InputRequest): InputOption | undefined {
  return (request.options ?? []).find(
    (option) => DENY_OPTION_RE.test(option.id) || DENY_OPTION_RE.test(option.label),
  );
}

function actionLabel(action: EveAction): string {
  switch (action.kind) {
    case "tool-call":
      return `tool-call:${action.toolName}`;
    case "subagent-call":
      return `subagent-call:${action.subagentName}`;
    case "remote-agent-call":
      return `remote-agent-call:${action.remoteAgentName}`;
    case "load-skill":
      return "load-skill";
  }
}

function actionResultLabel(result: EveActionResult): string {
  switch (result.kind) {
    case "tool-result":
      return result.toolName;
    case "subagent-result":
      return result.subagentName;
    case "load-skill-result":
      return result.name ?? "load-skill";
  }
}
