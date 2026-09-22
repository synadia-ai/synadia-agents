// The agent tools' definitions: the package's embedded copy
// (`src/tools/definitions.ts`) must equal `test-fixtures/agent-tools/`, the
// one place they are defined, so the model reads the same words from the
// TypeScript and the Python SDK. Also the argument parsing, which turns
// every mistake a model makes into words.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentToolDefinitions, type AgentToolName } from "../../src/index.js";
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
