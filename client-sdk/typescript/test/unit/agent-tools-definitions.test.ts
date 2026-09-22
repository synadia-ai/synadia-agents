// The agent tools' definitions: the package's embedded copy
// (`src/tools/definitions.ts`) must equal `test-fixtures/agent-tools/`, the
// one place they are defined, so the model reads the same words from the
// TypeScript and the Python SDK. A subset of the tools shows the same
// definitions, less `wait` and with the blocking-only words when it has no
// `wait_agent`. Also the argument parsing, which turns every mistake a model
// makes into words, and the words each subset's results say about open
// calls, against a stand-in agent that keeps every call open.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AGENT_TOOL_NAMES,
  agentToolDefinitions,
  AgentTools,
  BLOCKING_AGENT_TOOLS,
  type AgentToolName,
  type Agents,
} from "../../src/index.js";
import {
  isArgsError,
  parseAnswerArgs,
  parseCancelArgs,
  parseDiscoverArgs,
  parsePromptArgs,
  parseWaitArgs,
} from "../../src/tools/args.js";

const FIXTURES_DIR = fileURLToPath(
  new URL("../../../../test-fixtures/agent-tools/", import.meta.url),
);
const NAMES: AgentToolName[] = [
  "discover_agents",
  "prompt_agent",
  "wait_agent",
  "answer_agent",
  "cancel_agent",
  "list_agent_calls",
];

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(`${FIXTURES_DIR}${name}.json`, "utf8")) as unknown;
}

interface Definition {
  readonly name: AgentToolName;
  readonly description: string;
  readonly parameters: { readonly properties: Record<string, unknown> };
}

const DEFINITIONS = (await Promise.all(NAMES.map((name) => fixture(name)))) as Definition[];
const BLOCKING = (await fixture("blocking")) as Record<string, string>;

/**
 * What a subset shows, by the contract's rule: the fixtures of the tools
 * offered and, without `wait_agent`, each without `wait` and with its
 * blocking-only description where it has one.
 */
function derived(offered: ReadonlyArray<AgentToolName>): Definition[] {
  return DEFINITIONS.filter((d) => offered.includes(d.name)).map((d) => {
    if (offered.includes("wait_agent")) return d;
    const { wait: _wait, ...properties } = d.parameters.properties;
    return {
      ...d,
      description: BLOCKING[d.name] ?? d.description,
      parameters: { ...d.parameters, properties },
    };
  });
}

/** Every subset of the six, the empty one too. */
const SUBSETS: AgentToolName[][] = Array.from({ length: 2 ** NAMES.length }, (_, mask) =>
  NAMES.filter((_name, i) => (mask & (2 ** i)) !== 0),
);

/**
 * A subset makes sense when it has a tool, prompt_agent for any that works
 * on calls, and answer_agent with prompt_agent.
 */
function sensible(tools: ReadonlyArray<AgentToolName>): boolean {
  if (tools.length === 0) return false;
  return tools.includes("prompt_agent")
    ? tools.includes("answer_agent")
    : tools.every((name) => name === "discover_agents");
}

/** Why a subset that makes no sense is refused. */
function refusal(tools: ReadonlyArray<AgentToolName>): RegExp {
  if (tools.length === 0) return /names no tool/;
  return tools.includes("prompt_agent")
    ? /prompt_agent without answer_agent, so a question .* would wait out its timeout/
    : /without prompt_agent/;
}

const BLOCKING_THREE: AgentToolName[] = ["discover_agents", "prompt_agent", "answer_agent"];
const agents = {} as Agents;

const ASKER = "agents.prompt.fake.o.asker";

/**
 * A client that finds one agent, at `ASKER`, which asks a question on every
 * prompt and then waits until the call is dropped: every call stays open.
 */
function askingAgents(): Agents {
  const asker = {
    promptSubject: ASKER,
    idSigVerified: false,
    prompt: () => {
      let drop!: () => void;
      const dropped = new Promise<void>((resolve) => (drop = resolve));
      return Promise.resolve({
        cancel: drop,
        async *[Symbol.asyncIterator]() {
          yield { type: "query", prompt: "may I?", reply: () => Promise.resolve() };
          await dropped;
        },
      });
    },
  };
  return { discover: () => Promise.resolve([asker]) } as unknown as Agents;
}

/**
 * The words about open calls, with one call open and room for one, by what
 * collects a call (wait_agent, or else answering its questions) and whether
 * cancel_agent stops one. No other tool changes them.
 */
const OPEN_CALL_WORDS: Record<string, { note: string; served: string; refusal: string }> = {
  "answer only": {
    note: "1 call you started is still open: answer its questions with answer_agent.",
    served:
      "1 call you started is still open. Calls end with the prompt you are answering: " +
      "answer its questions with answer_agent before you answer.",
    refusal:
      "all 1 tracked calls are still open; " +
      "answer their questions with answer_agent before you start another",
  },
  "answer or cancel": {
    note:
      "1 call you started is still open: " +
      "answer its questions with answer_agent, or stop it with cancel_agent.",
    served:
      "1 call you started is still open. Calls end with the prompt you are answering: " +
      "answer its questions with answer_agent before you answer.",
    refusal:
      "all 1 tracked calls are still open; answer their questions with answer_agent " +
      "or stop some with cancel_agent before you start another",
  },
  "wait only": {
    note: "1 call you started is still open: collect it with wait_agent.",
    served:
      "1 call you started is still open. Calls end with the prompt you are answering: " +
      "collect it with wait_agent before you answer.",
    refusal:
      "all 1 tracked calls are still open; collect some with wait_agent before you start another",
  },
  "wait or cancel": {
    note: "1 call you started is still open: collect it with wait_agent, or stop it with cancel_agent.",
    served:
      "1 call you started is still open. Calls end with the prompt you are answering: " +
      "collect it with wait_agent before you answer.",
    refusal:
      "all 1 tracked calls are still open; collect some with wait_agent " +
      "or stop some with cancel_agent before you start another",
  },
};

function openCallWords(tools: ReadonlyArray<AgentToolName>): (typeof OPEN_CALL_WORDS)[string] {
  const collect = tools.includes("wait_agent") ? "wait" : "answer";
  return OPEN_CALL_WORDS[`${collect} ${tools.includes("cancel_agent") ? "or cancel" : "only"}`]!;
}

describe("agent tool definitions", () => {
  it("equal the shared fixtures, in the contract's order", async () => {
    const expected = await Promise.all(NAMES.map((name) => fixture(name)));
    expect(agentToolDefinitions()).toEqual(expected);
  });

  it("are a fresh copy each time, so a host's change touches no one else", () => {
    const mine = agentToolDefinitions();
    (mine[0] as { description: string }).description = "changed";
    expect(agentToolDefinitions()[0]!.description).not.toBe("changed");
  });

  it("have a blocking-only description exactly where one mentions wait_agent", () => {
    const mentioning = DEFINITIONS.filter(
      (d) => d.name !== "wait_agent" && d.description.includes("wait_agent"),
    ).map((d) => d.name);
    expect(Object.keys(BLOCKING).sort()).toEqual([...mentioning].sort());
    for (const words of Object.values(BLOCKING)) {
      expect(words).not.toMatch(/wait_agent|wait (set to )?(true|false)/);
    }
  });

  it("sit next to a call result schema that names every field the helper produces", async () => {
    const call = (await fixture("prompt_agent.result")) as { properties: Record<string, unknown> };
    expect(Object.keys(call.properties).sort()).toEqual(
      [
        "attachments",
        "call_id",
        "call_ids",
        "error",
        "label",
        "open_calls",
        "open_calls_note",
        "partial_reply",
        "question",
        "remaining",
        "reply",
        "state",
      ].sort(),
    );
  });
});

describe("agent tool arguments", () => {
  it("take an object or its JSON text, and an empty call as {}", () => {
    expect(parseDiscoverArgs(undefined)).toEqual({});
    expect(parseDiscoverArgs("")).toEqual({});
    expect(parseDiscoverArgs('{"owner":"acme"}')).toEqual({ owner: "acme" });
    expect(parsePromptArgs({ address: "a", prompt: "p" })).toEqual({
      address: "a",
      prompt: "p",
      attachments: [],
      wait: true,
    });
  });

  it("ignore properties the definitions do not name", () => {
    expect(parseAnswerArgs({ call_id: "c", answer: "yes", request_id: "r" })).toEqual({
      callId: "c",
      answer: "yes",
    });
  });

  it("are not fooled by a model that passes an error field", () => {
    expect(parseDiscoverArgs({ error: "x" })).toEqual({});
  });

  it("turn every mistake into words", () => {
    const cases: Array<[unknown, RegExp]> = [
      [parsePromptArgs("{nope"), /not valid JSON/],
      [parsePromptArgs([]), /must be a JSON object/],
      [parsePromptArgs({ prompt: "p" }), /"address" is required/],
      [parsePromptArgs({ address: "a", prompt: "" }), /"prompt" is required/],
      [parsePromptArgs({ address: "a", prompt: "p", attachments: "f" }), /list of file paths/],
      [parsePromptArgs({ address: "a", prompt: "p", wait: "no" }), /"wait" must be true or false/],
      [parsePromptArgs({ address: "a", prompt: "p", label: "" }), /"label" must be/],
      [parseWaitArgs({ call_ids: [] }), /non-empty list/],
      [parseWaitArgs({ call_ids: ["a"], timeout_ms: -1 }), /"timeout_ms"/],
      [parseWaitArgs({ call_ids: ["a"], timeout_ms: 1.5 }), /"timeout_ms"/],
      [parseAnswerArgs({ call_id: "c" }), /"answer" is required/],
      [parseCancelArgs({ call_ids: [""] }), /non-empty list/],
      [parseDiscoverArgs({ owner: 3 }), /"owner" must be a non-empty string/],
    ];
    for (const [result, words] of cases) {
      expect(isArgsError(result)).toBe(true);
      expect((result as { error: string }).error).toMatch(words);
    }
  });

  it("drop repeated call ids, keeping the order", () => {
    expect(parseWaitArgs({ call_ids: ["b", "a", "b"], timeout_ms: 0 })).toEqual({
      callIds: ["b", "a"],
      timeoutMs: 0,
    });
  });
});

describe("the tools a helper offers", () => {
  it("are all six by default, as the fixtures define them", () => {
    expect(new AgentTools({ agents }).definitions).toEqual(DEFINITIONS);
  });

  it("show a subset as the fixtures define it; without wait_agent, nothing waits later", () => {
    for (const tools of SUBSETS.filter(sensible)) {
      expect(new AgentTools({ agents, tools }).definitions, tools.join(",")).toEqual(
        derived(tools),
      );
    }
    const blocking = new AgentTools({ agents, tools: BLOCKING_THREE }).definitions;
    expect(blocking.map((d) => d.name)).toEqual(BLOCKING_THREE);
    for (const d of blocking) {
      expect(Object.keys(d.parameters["properties"] as object)).not.toContain("wait");
      expect(d.description).not.toContain("wait_agent");
    }
  });

  it("name no tool outside the blocking three when those are offered", () => {
    // A model shown a tool's name it does not have would try to call it.
    const shown = JSON.stringify(new AgentTools({ agents, tools: BLOCKING_THREE }).definitions);
    for (const name of NAMES.filter((name) => !BLOCKING_THREE.includes(name))) {
      expect(shown, name).not.toContain(name);
    }
  });

  it("are named by exported constants: the six, and the blocking three construction accepts", () => {
    expect(AGENT_TOOL_NAMES).toEqual(NAMES);
    // The three section 5 names for an agent that runs no calls at once:
    // the smallest subset that makes sense and can discover and prompt.
    expect(BLOCKING_AGENT_TOOLS).toEqual(BLOCKING_THREE);
    const smallest = SUBSETS.filter(
      (tools) =>
        sensible(tools) && tools.includes("discover_agents") && tools.includes("prompt_agent"),
    ).sort((a, b) => a.length - b.length)[0];
    expect(BLOCKING_AGENT_TOOLS).toEqual(smallest);
    const blocking: ReadonlyArray<AgentToolName> = BLOCKING_AGENT_TOOLS;
    expect(AGENT_TOOL_NAMES.filter((name) => blocking.includes(name))).toEqual(blocking);
    expect(new AgentTools({ agents, tools: BLOCKING_AGENT_TOOLS }).definitions).toEqual(
      derived(BLOCKING_THREE),
    );
  });

  it("keep the contract's order and drop repeats, whatever the order given", () => {
    const tools = new AgentTools({
      agents,
      tools: ["answer_agent", "prompt_agent", "answer_agent", "discover_agents"],
    });
    expect(tools.definitions.map((d) => d.name)).toEqual(BLOCKING_THREE);
  });

  it("refuse a subset that makes no sense, at construction", () => {
    const refused = SUBSETS.filter((subset) => !sensible(subset));
    for (const tools of refused) {
      expect(() => new AgentTools({ agents, tools }), tools.join(",")).toThrow(refusal(tools));
    }
    expect(refused.filter((tools) => tools.includes("prompt_agent"))).toHaveLength(16);
    expect(
      () => new AgentTools({ agents, tools: ["prompt_agent", "ask_agent" as AgentToolName] }),
    ).toThrow(/"ask_agent", which is not one of/);
  });

  it("refuse a tool not offered, and wait false without wait_agent, in words", async () => {
    const tools = new AgentTools({ agents, tools: BLOCKING_THREE });
    for (const name of ["wait_agent", "cancel_agent", "list_agent_calls"]) {
      expect(await tools.execute(name, { call_ids: ["c"] })).toEqual({
        error: `the tool "${name}" is not offered; your tools are discover_agents, prompt_agent, answer_agent`,
      });
    }
    expect(await tools.execute("ask_agent")).toEqual({ error: 'unknown tool "ask_agent"' });
    expect(await tools.execute("prompt_agent", { address: "a", prompt: "p", wait: false })).toEqual(
      {
        error:
          'prompt_agent: "wait" cannot be false here; the call waits for the reply or a question',
      },
    );
    expect(await tools.execute("answer_agent", { call_id: "c", answer: "a", wait: false })).toEqual(
      {
        error:
          'answer_agent: "wait" cannot be false here; the call waits for the reply or the next question',
      },
    );
    // A result points the model only to tools offered.
    expect(await tools.execute("answer_agent", { call_id: "c", answer: "a" })).toEqual({
      error: '"c": no such call in your calls',
    });
    expect(
      await new AgentTools({ agents }).execute("answer_agent", { call_id: "c", answer: "a" }),
    ).toEqual({ error: '"c": no such call in your calls; list_agent_calls shows them' });
  });

  it("say what to do about open calls in words every subset that starts calls can act on", async () => {
    // prompt_agent always comes with answer_agent, so every subset that
    // starts a call can collect it: there are no words for having no way.
    const starting = SUBSETS.filter((tools) => sensible(tools) && tools.includes("prompt_agent"));
    expect(starting).toHaveLength(16);
    for (const tools of starting) {
      const words = openCallWords(tools);
      const t = new AgentTools({ agents: askingAgents(), tools, maxCalls: 1 });
      try {
        const asked = await t.execute("prompt_agent", { address: ASKER, prompt: "go" });
        expect(asked, tools.join(",")).toMatchObject({
          state: "input_required",
          open_calls: 1,
          open_calls_note: words.note,
        });
        expect(await t.execute("prompt_agent", { address: ASKER, prompt: "go" })).toEqual({
          error: words.refusal,
          open_calls: 1,
          open_calls_note: words.note,
        });
        await t.runInPromptScope(async () => {
          const served = await t.execute("prompt_agent", { address: ASKER, prompt: "go" });
          expect(served["open_calls_note"], tools.join(",")).toBe(words.served);
        });
      } finally {
        await t.close();
      }
    }
  });
});
