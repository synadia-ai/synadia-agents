// The agent tools' definitions: what a model is shown (docs/agent-tools.md).
//
// A copy of `test-fixtures/agent-tools/<name>.json`, one entry per tool, in
// the order the contract lists them, and of `blocking.json`. A published
// package cannot read files outside its own directory, so the words are
// embedded here; `test/unit/agent-tools-definitions.test.ts` checks that
// they equal the fixtures. Change the fixtures first, then copy them here.

/** The six agent tools, by name. */
export type AgentToolName =
  | "discover_agents"
  | "prompt_agent"
  | "wait_agent"
  | "answer_agent"
  | "cancel_agent"
  | "list_agent_calls";

/**
 * One tool as a model is shown it: a name, the description it reads, and its
 * parameters as a JSON Schema. A host maps it to its own tool format (MCP's
 * `inputSchema`, a chat-completions `function`, ...) without changing a word.
 */
export interface AgentToolDefinition {
  readonly name: AgentToolName;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** The six agent tools, by name, in the contract's order. */
export const AGENT_TOOL_NAMES = [
  "discover_agents",
  "prompt_agent",
  "wait_agent",
  "answer_agent",
  "cancel_agent",
  "list_agent_calls",
] as const satisfies ReadonlyArray<AgentToolName>;

/**
 * The three an agent offers when it runs no calls at once, in the contract's
 * order: `new AgentTools({ agents, tools: BLOCKING_AGENT_TOOLS })`. Every
 * definition costs input tokens on every model call, and without
 * `wait_agent` nothing is detached (docs/agent-tools.md, section 5).
 */
export const BLOCKING_AGENT_TOOLS = [
  "discover_agents",
  "prompt_agent",
  "answer_agent",
] as const satisfies ReadonlyArray<AgentToolName>;

const DEFINITIONS: ReadonlyArray<AgentToolDefinition> = [
  {
    name: "discover_agents",
    description:
      "List the agents you can prompt, one entry per address. Each entry gives the address to use with prompt_agent, the agent's kind, owner and name, what it says it does, its identity and whether that identity is verified, whether it requires signed prompts or accepts attachments, and how many instances answer at the address. The filters are optional, exact and combined, one per token of the address `agents.prompt.<agent>.<owner>.<name>`; an agent known by what it does is found by `agent` or by calling without filters, which lists every agent. Call it before prompt_agent when you do not already know an address.",
    parameters: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          minLength: 1,
          description:
            "Only agents whose address has this first token after `agents.prompt`, their kind or role exactly as registered (for example `researcher` or `claude-code`).",
        },
        owner: {
          type: "string",
          minLength: 1,
          description:
            "Only agents whose address has this second token, their owner exactly as registered.",
        },
        name: {
          type: "string",
          minLength: 1,
          description:
            "Only agents whose address has this last token, their instance name (usually `main`); what an agent does or is called in a task is not its name.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "prompt_agent",
    description:
      "Send a prompt to one agent and get its reply. Use an address returned by discover_agents. Keep the prompt self-contained: the other agent sees nothing of your conversation. Do not prompt the agent that prompted you; answer it instead. By default the call waits for the complete reply. If the other agent asks a question while it works, you get the question and a call_id instead: answer it with answer_agent. With wait set to false the call returns at once with a call_id while the other agent works, and you collect the result later with wait_agent; use it to have several agents work at once. Calls you start while you are answering a prompt end with that prompt, so collect their results before you answer. The other agent runs on another machine, so never put a local file path in the prompt: attach the file instead (small files only, and only to an agent that accepts attachments). Files the other agent sends back are saved on this machine, and the result gives each file's path.",
    parameters: {
      type: "object",
      properties: {
        address: {
          type: "string",
          minLength: 1,
          description: "The agent's address, exactly as discover_agents returned it.",
        },
        prompt: {
          type: "string",
          minLength: 1,
          description: "The task for the other agent, complete in itself.",
        },
        attachments: {
          type: "array",
          items: {
            type: "string",
            minLength: 1,
          },
          description:
            "Optional paths of local files to send with the prompt, only from the directories you may send from, and only to an agent that accepts attachments (see discover_agents). The files travel inside the message, so keep them small.",
        },
        label: {
          type: "string",
          minLength: 1,
          description:
            "Optional short name for this call, shown in its results. It is never sent to the other agent.",
        },
        wait: {
          type: "boolean",
          description:
            "true (the default): wait for the reply or a question. false: return at once with a call_id, and collect the result with wait_agent.",
        },
      },
      required: ["address", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "wait_agent",
    description:
      "Wait for calls you started with prompt_agent. Returns the first of the given calls that finished or asked a question (the earliest, if several have), with remaining: the ids of the other given calls that are still open. A finished call's result can be fetched again, the same each time, until the call is dropped from list_agent_calls. If none of the calls is ready within timeout_ms, returns state running with the call_ids still running. A question is answered with answer_agent.",
    parameters: {
      type: "object",
      properties: {
        call_ids: {
          type: "array",
          items: {
            type: "string",
            minLength: 1,
          },
          minItems: 1,
          description: "The calls to wait for, as prompt_agent returned their call_id.",
        },
        timeout_ms: {
          type: "integer",
          minimum: 0,
          description:
            "How long to wait, in milliseconds; 0 checks without waiting. A longer wait than the configured limit is shortened to it, and the limit is the default.",
        },
      },
      required: ["call_ids"],
      additionalProperties: false,
    },
  },
  {
    name: "answer_agent",
    description:
      "Answer the question an agent asked while working on your call, using the call_id that came with the question. Then, by default, it goes on as the call was started: a call started with wait true waits for the reply or the agent's next question; a call started with wait false returns at once, and you collect the result with wait_agent. A permission question asks you to allow or deny an action the other agent wants to take: allow it only if the task you gave needs it; when unsure, deny. Answer promptly: the asking agent waits only so long, and a question still open when the prompt you are answering ends is refused.",
    parameters: {
      type: "object",
      properties: {
        call_id: {
          type: "string",
          minLength: 1,
          description: "The call_id that came with the question.",
        },
        answer: {
          type: "string",
          minLength: 1,
          description:
            "Your answer, in the form the question asks for (for a permission question, `yes` or `no`).",
        },
        wait: {
          type: "boolean",
          description:
            "true: wait for the reply or the next question. false: return at once. Defaults to the way the call was started.",
        },
      },
      required: ["call_id", "answer"],
      additionalProperties: false,
    },
  },
  {
    name: "cancel_agent",
    description:
      "Stop calls you started. Each open call becomes cancelled, and an open question gets a refusal. The result gives each call's state and the reply text received so far. The other agent is not told and may keep working; whatever it sends later is discarded. A call that already finished keeps its result.",
    parameters: {
      type: "object",
      properties: {
        call_ids: {
          type: "array",
          items: {
            type: "string",
            minLength: 1,
          },
          minItems: 1,
          description: "The calls to stop, as prompt_agent returned their call_id.",
        },
      },
      required: ["call_ids"],
      additionalProperties: false,
    },
  },
  {
    name: "list_agent_calls",
    description:
      "List the calls you started that are still tracked, oldest first: each with its call_id, label, address, state and times. Open calls are running, or input_required when a question waits for answer_agent. Finished calls are completed, failed, cancelled or expired; they are dropped, the longest finished first, when the list is full.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

/**
 * The six definitions, as a fresh copy on every call: a host may change its
 * copy (add a parameter of its own, say) without touching anyone else's.
 */
export function agentToolDefinitions(): AgentToolDefinition[] {
  return structuredClone(DEFINITIONS) as AgentToolDefinition[];
}

// The descriptions that mention `wait_agent`, as a model reads them when
// the helper offers no `wait_agent`.
const BLOCKING_DESCRIPTIONS: Readonly<Partial<Record<AgentToolName, string>>> = {
  prompt_agent:
    "Send a prompt to one agent and get its reply. Use an address returned by discover_agents. Keep the prompt self-contained: the other agent sees nothing of your conversation. Do not prompt the agent that prompted you; answer it instead. The call waits for the complete reply. If the other agent asks a question while it works, you get the question and a call_id instead: answer it with answer_agent. Calls you start while you are answering a prompt end with that prompt, so answer their questions before you answer. The other agent runs on another machine, so never put a local file path in the prompt: attach the file instead (small files only, and only to an agent that accepts attachments). Files the other agent sends back are saved on this machine, and the result gives each file's path.",
  answer_agent:
    "Answer the question an agent asked while working on your call, using the call_id that came with the question. Then it waits for the reply or the agent's next question. A permission question asks you to allow or deny an action the other agent wants to take: allow it only if the task you gave needs it; when unsure, deny. Answer promptly: the asking agent waits only so long, and a question still open when the prompt you are answering ends is refused.",
};

/**
 * The definitions of the tools offered, in the contract's order, as a fresh
 * copy. Without `wait_agent` nothing can be detached: each definition loses
 * its `wait` parameter, and a description that mentions `wait_agent` is
 * replaced by its blocking-only words. Nothing else changes.
 */
export function offeredToolDefinitions(offered: ReadonlySet<AgentToolName>): AgentToolDefinition[] {
  const definitions = agentToolDefinitions().filter((d) => offered.has(d.name));
  if (offered.has("wait_agent")) return definitions;
  return definitions.map((definition) => {
    delete (definition.parameters["properties"] as Record<string, unknown>)["wait"];
    if (!definition.description.includes("wait_agent")) return definition;
    const description = BLOCKING_DESCRIPTIONS[definition.name];
    if (description === undefined) {
      throw new Error(`AgentTools: no blocking-only description for ${definition.name}`);
    }
    return { ...definition, description };
  });
}
