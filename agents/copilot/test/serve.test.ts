import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseServeArgs } from "../src/cli.js";
import { resolveServeSettings, resolveSettings } from "../src/config.js";
import type { ServedContext } from "../src/runtime.js";
import {
  DEFAULT_CONVERSATION,
  answerUserInput,
  conversationKey,
  decideServePermission,
  loadState,
  saveState,
} from "../src/serve.js";

function caller(verified: boolean, reply: string | Error, asked: string[] = []): ServedContext {
  return {
    sender: verified ? "verified $G.UABC" : "unsigned",
    verified,
    ask: async (prompt) => {
      asked.push(prompt);
      if (reply instanceof Error) throw reply;
      return reply;
    },
    enter: (fn) => fn(),
  };
}

const shell = { kind: "shell", fullCommandText: "rm -rf build" };
const query = { mode: "query" as const, timeoutMs: 1000 };

describe("decideServePermission", () => {
  test("a verified caller's yes approves once, and only once", async () => {
    const asked: string[] = [];
    expect(await decideServePermission(shell, caller(true, "yes", asked), query)).toEqual({ kind: "approve-once" });
    expect(asked[0]).toContain("rm -rf build");
  });

  test("anything but yes rejects", async () => {
    const d = await decideServePermission(shell, caller(true, "sure, go ahead"), query);
    expect(d.kind).toBe("reject");
  });

  test("an unverified caller is never asked", async () => {
    const asked: string[] = [];
    const d = await decideServePermission(shell, caller(false, "yes", asked), query);
    expect(d.kind).toBe("reject");
    expect(asked).toEqual([]);
  });

  test("no caller, no answer, deny mode and managed approval all reject", async () => {
    expect((await decideServePermission(shell, undefined, query)).kind).toBe("reject");
    expect((await decideServePermission(shell, caller(true, new Error("timed out")), query)).kind).toBe("reject");
    const asked: string[] = [];
    expect((await decideServePermission(shell, caller(true, "yes", asked), { ...query, mode: "deny" })).kind).toBe("reject");
    const managed = { ...shell, managedApprovalRequired: true };
    expect((await decideServePermission(managed, caller(true, "yes", asked), query)).kind).toBe("reject");
    expect(asked).toEqual([]);
  });
});

describe("answerUserInput", () => {
  test("a choice by number or by text is not freeform", async () => {
    const req = { question: "Which?", choices: ["red", "blue"] };
    expect(await answerUserInput(req, caller(false, "2"), 1000)).toEqual({ answer: "blue", wasFreeform: false });
    expect(await answerUserInput(req, caller(false, "RED"), 1000)).toEqual({ answer: "red", wasFreeform: false });
    expect(await answerUserInput(req, caller(false, "green"), 1000)).toEqual({ answer: "green", wasFreeform: true });
  });

  test("with no caller the model is told nobody is there", async () => {
    const r = await answerUserInput({ question: "?" }, undefined, 1000);
    expect(r.answer).toContain("not available");
  });
});

describe("conversationKey", () => {
  test("from the conversation extras, else the default", () => {
    expect(conversationKey(undefined)).toBe(DEFAULT_CONVERSATION);
    expect(conversationKey({ conversation: " a " })).toBe("a");
    expect(conversationKey({ conversation_id: "b" })).toBe("b");
    expect(conversationKey({ conversation: 7 })).toBe(DEFAULT_CONVERSATION);
  });
});

describe("serve settings", () => {
  const base = resolveSettings({}, { SYNADIA_COPILOT_OWNER: "me" });

  test("defaults: ask the verified caller, fleet tools off, no model override", () => {
    const s = resolveServeSettings({}, {}, base, "/work");
    expect(s).toMatchObject({ permissions: "query", agentTools: "off", cwd: "/work", maxSessions: 8 });
    expect(s.model).toBeUndefined();
    expect(s.reasoningEffort).toBeUndefined();
  });

  test("flags become settings", () => {
    const env = parseServeArgs(
      ["--model", "claude-haiku-4.5", "--permissions=deny", "--cwd", "/x", "--agent-tools", "blocking"],
      { SYNADIA_COPILOT_OWNER: "me" },
    );
    const s = resolveServeSettings({}, env, resolveSettings({}, env), "/work");
    expect(s).toMatchObject({ model: "claude-haiku-4.5", permissions: "deny", cwd: "/x", agentTools: "blocking" });
  });

  test("bad values are refused", () => {
    expect(() => parseServeArgs(["--nope", "1"], {})).toThrow("unknown option");
    expect(() => parseServeArgs(["--model"], {})).toThrow("needs a value");
    expect(() => resolveServeSettings({}, { SYNADIA_COPILOT_SERVE_PERMISSIONS: "approve" }, base)).toThrow();
    expect(() => resolveServeSettings({}, { SYNADIA_COPILOT_REASONING_EFFORT: "huge" }, base)).toThrow();
  });
});

test("state round-trips and tolerates a missing or broken file", () => {
  const dir = mkdtempSync(join(tmpdir(), "serve-state-"));
  try {
    const path = join(dir, "nested", "state.json");
    expect(loadState(path)).toEqual({});
    saveState(path, { default: "s-1" }, () => undefined);
    expect(loadState(path)).toEqual({ default: "s-1" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
