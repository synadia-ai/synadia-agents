// Unit tests for the bash-approval and ask-user-question helpers in
// `src/agent.ts`. The §7 query plumbing itself is exercised by the
// integration test ("ask round-trips through PromptResponse"); these
// tests focus on the token-parsing branches that the integration test
// can't easily reach.

import { describe, expect, test } from "bun:test";

import { bashApprovalViaNats } from "../src/agent.js";
import type { PromptResponse } from "@synadia-ai/agent-service";

interface RecordedAsk {
  readonly prompt: string;
  readonly timeoutMs: number | undefined;
}

/**
 * Build a stub `PromptResponse` whose `ask` returns the supplied reply
 * text. Records each `ask` call so tests can assert on the prompt the
 * caller saw.
 */
function makeStubResponse(replyText: string): {
  response: PromptResponse;
  asks: RecordedAsk[];
} {
  const asks: RecordedAsk[] = [];
  const response = {
    ask: async (prompt: string, opts?: { timeoutMs?: number }) => {
      asks.push({ prompt, timeoutMs: opts?.timeoutMs });
      return { prompt: replyText };
    },
  } as unknown as PromptResponse;
  return { response, asks };
}

describe("bashApprovalViaNats", () => {
  test.each([
    "yes",
    "y",
    "Y",
    "YES",
    "approve",
    "Approve",
    "allow",
    "ok",
    "okay",
    "1",
    "  yes  ",
  ])("approves on reply %p", async (reply) => {
    const { response, asks } = makeStubResponse(reply);
    const approve = bashApprovalViaNats(response, 10_000);
    const result = await approve({ command: "rm -rf /tmp/foo" });
    expect(result).toBe(false); // false = "no further approval needed", proceed
    expect(asks).toHaveLength(1);
    expect(asks[0]?.prompt).toContain("rm -rf /tmp/foo");
    expect(asks[0]?.prompt).toContain("requires approval");
    expect(asks[0]?.timeoutMs).toBe(10_000);
  });

  test.each(["no", "n", "deny", "decline", "stop", "", "   ", "anything-else"])(
    "denies (throws) on reply %p",
    async (reply) => {
      const { response } = makeStubResponse(reply);
      const approve = bashApprovalViaNats(response, 10_000);
      await expect(approve({ command: "rm -rf /tmp/foo" })).rejects.toThrow(/denied by user/);
    },
  );

  test("propagates a query timeout from PromptResponse.ask", async () => {
    const response = {
      ask: async () => {
        throw new Error("query timed out");
      },
    } as unknown as PromptResponse;
    const approve = bashApprovalViaNats(response, 10_000);
    await expect(approve({ command: "rm -rf /tmp/foo" })).rejects.toThrow(/query timed out/);
  });

  test("denial error includes the command and the user's reply for auditability", async () => {
    const { response } = makeStubResponse("definitely not");
    const approve = bashApprovalViaNats(response, 10_000);
    let caught: unknown;
    try {
      await approve({ command: "cat ~/.env" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain("cat ~/.env");
    expect(message).toContain("definitely not");
  });
});
