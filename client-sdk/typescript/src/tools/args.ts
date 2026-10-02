// Parsing a tool call's arguments as the model produced them: the JSON text a
// chat-completions response carries, or that text already parsed. A model
// gets its arguments wrong now and then, so every problem comes back as
// words it can act on, never as a throw. Properties the definitions do not
// name are ignored: a host may add parameters of its own and read them
// before it hands the call on.

/** An argument problem, in words for the model. */
export class ArgsError {
  constructor(readonly error: string) {}
}

export interface DiscoverArgs {
  readonly agent?: string;
  readonly owner?: string;
  readonly name?: string;
}

export interface PromptArgs {
  readonly address: string;
  readonly prompt: string;
  readonly attachments: ReadonlyArray<string>;
  readonly label?: string;
  readonly wait: boolean;
}

export interface WaitArgs {
  readonly callIds: ReadonlyArray<string>;
  readonly timeoutMs?: number;
}

export interface AnswerArgs {
  readonly callId: string;
  readonly answer: string;
  readonly wait?: boolean;
}

export interface CallIdsArgs {
  readonly callIds: ReadonlyArray<string>;
}

type Fields = Record<string, unknown>;

/** The arguments as an object: `undefined` and empty text count as `{}`. */
export function argsObject(tool: string, args: unknown): Fields | ArgsError {
  let value = args;
  if (value === undefined || value === null || value === "") return {};
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return new ArgsError(`${tool}: the arguments are not valid JSON`);
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return new ArgsError(`${tool}: the arguments must be a JSON object`);
  }
  return value as Fields;
}

export function parseDiscoverArgs(args: unknown): DiscoverArgs | ArgsError {
  const fields = argsObject("discover_agents", args);
  if (isArgsError(fields)) return fields;
  const out: { agent?: string; owner?: string; name?: string } = {};
  for (const key of ["agent", "owner", "name"] as const) {
    const value = fields[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length === 0) {
      return new ArgsError(`discover_agents: "${key}" must be a non-empty string when given`);
    }
    out[key] = value;
  }
  return out;
}

export function parsePromptArgs(args: unknown): PromptArgs | ArgsError {
  const fields = argsObject("prompt_agent", args);
  if (isArgsError(fields)) return fields;
  const { address, prompt, attachments, label, wait } = fields;
  if (typeof address !== "string" || address.length === 0) {
    return new ArgsError('prompt_agent: "address" is required, as discover_agents returned it');
  }
  if (typeof prompt !== "string" || prompt.length === 0) {
    return new ArgsError('prompt_agent: "prompt" is required and must not be empty');
  }
  if (
    attachments !== undefined &&
    (!Array.isArray(attachments) ||
      !attachments.every((p) => typeof p === "string" && p.length > 0))
  ) {
    return new ArgsError('prompt_agent: "attachments" must be a list of file paths');
  }
  if (label !== undefined && (typeof label !== "string" || label.length === 0)) {
    return new ArgsError('prompt_agent: "label" must be a non-empty string when given');
  }
  if (wait !== undefined && typeof wait !== "boolean") {
    return new ArgsError('prompt_agent: "wait" must be true or false');
  }
  return {
    address,
    prompt,
    attachments: (attachments as string[] | undefined) ?? [],
    ...(label !== undefined ? { label } : {}),
    wait: wait ?? true,
  };
}

export function parseWaitArgs(args: unknown): WaitArgs | ArgsError {
  const fields = argsObject("wait_agent", args);
  if (isArgsError(fields)) return fields;
  const callIds = parseCallIds("wait_agent", fields["call_ids"]);
  if (isArgsError(callIds)) return callIds;
  const timeoutMs = fields["timeout_ms"];
  if (timeoutMs === undefined) return { callIds };
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 0) {
    return new ArgsError(
      'wait_agent: "timeout_ms" must be a whole number of milliseconds, 0 or more',
    );
  }
  return { callIds, timeoutMs };
}

export function parseAnswerArgs(args: unknown): AnswerArgs | ArgsError {
  const fields = argsObject("answer_agent", args);
  if (isArgsError(fields)) return fields;
  const { call_id: callId, answer, wait } = fields;
  if (typeof callId !== "string" || callId.length === 0) {
    return new ArgsError('answer_agent: "call_id" is required, as it came with the question');
  }
  if (typeof answer !== "string" || answer.length === 0) {
    return new ArgsError('answer_agent: "answer" is required and must not be empty');
  }
  if (wait !== undefined && typeof wait !== "boolean") {
    return new ArgsError('answer_agent: "wait" must be true or false');
  }
  return { callId, answer, ...(wait !== undefined ? { wait } : {}) };
}

export function parseCancelArgs(args: unknown): CallIdsArgs | ArgsError {
  const fields = argsObject("cancel_agent", args);
  if (isArgsError(fields)) return fields;
  const callIds = parseCallIds("cancel_agent", fields["call_ids"]);
  return isArgsError(callIds) ? callIds : { callIds };
}

/** `call_ids`: a non-empty list of non-empty strings, duplicates removed, order kept. */
function parseCallIds(tool: string, value: unknown): ReadonlyArray<string> | ArgsError {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((id) => typeof id === "string" && id.length > 0)
  ) {
    return new ArgsError(`${tool}: "call_ids" must be a non-empty list of call_id strings`);
  }
  return [...new Set(value as string[])];
}

export function isArgsError(value: unknown): value is ArgsError {
  return value instanceof ArgsError;
}
