// The agent tools' definitions: the package's embedded copy
// (`src/tools/definitions.ts`) must equal `test-fixtures/agent-tools/`, the
// one place they are defined, so the model reads the same words from the
// TypeScript and the Python SDK. A subset of the tools shows the same
// definitions, less `wait` and with the blocking-only words when it has no
// `wait_agent`. Also the argument parsing, which turns every mistake a model
// makes into words.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  agentToolDefinitions,
  AgentTools,
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
});
