import { describe, expect, test } from "bun:test";
import type { RequestEnvelope } from "@synadia-ai/agents";
import type { Chunk } from "@synadia-ai/agent-service";
import type { HandleMessageStreamEvent, InputRequest } from "eve/client";
import {
  MAX_HITL_ROUNDS,
  bridgePromptToEve,
  type BridgeResponse,
  type EveBridgeClient,
  type EveSendInput,
} from "../src/bridge.js";
import type { EveMapping } from "../src/config.js";

function mapping(): EveMapping {
  return {
    owner: "rene",
    name: "support",
    subjectToken: "eve",
    eve: {
      baseUrl: "http://127.0.0.1:2000",
      askTimeoutS: 1,
    },
  };
}

class FakeEveBridgeClient implements EveBridgeClient {
  readonly sends: EveSendInput[] = [];
  readonly #scripts: HandleMessageStreamEvent[][];

  constructor(scripts: HandleMessageStreamEvent[][]) {
    this.#scripts = scripts;
  }

  async send(input: EveSendInput): Promise<AsyncIterable<HandleMessageStreamEvent>> {
    this.sends.push(input);
    const events = this.#scripts.shift() ?? [];
    return (async function* () {
      for (const event of events) yield event;
    })();
  }

  sessionId(): string | undefined {
    return "fake-session";
  }
}

/** Records chunks; answers `ask` from a scripted queue ("TIMEOUT" throws like the SDK does). */
class RecordingResponse implements BridgeResponse {
  readonly chunks: Array<string | Chunk> = [];
  readonly askPrompts: string[] = [];
  readonly #askReplies: string[];

  constructor(askReplies: string[] = []) {
    this.#askReplies = askReplies;
  }

  async send(chunk: string | Chunk): Promise<void> {
    this.chunks.push(chunk);
  }

  async ask(prompt: string): Promise<RequestEnvelope> {
    this.askPrompts.push(prompt);
    const reply = this.#askReplies.shift();
    if (reply === undefined || reply === "TIMEOUT") throw new Error("query timed out");
    return { prompt: reply };
  }
}

const turn = (turnId = "t1") => ({ sequence: 1, stepIndex: 0, turnId });

const appended = (messageDelta: string): HandleMessageStreamEvent => ({
  type: "message.appended",
  data: { messageDelta, messageSoFar: messageDelta, ...turn() },
});

const completed = (
  message: string | null,
  finishReason: "stop" | "tool-calls" = "stop",
): HandleMessageStreamEvent => ({
  type: "message.completed",
  data: { finishReason, message, ...turn() },
});

const waiting = (): HandleMessageStreamEvent => ({
  type: "session.waiting",
  data: { continuationToken: "ct-1", wait: "next-user-message" },
});

const inputRequested = (requests: InputRequest[]): HandleMessageStreamEvent => ({
  type: "input.requested",
  data: { requests, ...turn() },
});

function approvalRequest(overrides: Partial<InputRequest> = {}): InputRequest {
  return {
    requestId: "req-1",
    prompt: "Run the deploy tool?",
    action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "deploy" },
    options: [
      { id: "approve", label: "Approve" },
      { id: "deny", label: "Deny" },
    ],
    display: "confirmation",
    ...overrides,
  };
}

async function run(
  client: FakeEveBridgeClient,
  response: RecordingResponse,
  envelope: RequestEnvelope = { prompt: "hello" },
): Promise<void> {
  await bridgePromptToEve({ envelope, response, mapping: mapping(), eveClient: client });
}

describe("bridgePromptToEve", () => {
  test("streams message deltas as response chunks without duplicating the terminal message", async () => {
    const client = new FakeEveBridgeClient([
      [
        { type: "session.started", data: {} },
        appended("hello "),
        appended("world"),
        completed("hello world"),
        waiting(),
      ],
    ]);
    const response = new RecordingResponse();
    await run(client, response);
    expect(response.chunks).toEqual([
      { type: "status", status: "eve session started" },
      { type: "response", text: "hello " },
      { type: "response", text: "world" },
    ]);
    expect(client.sends).toEqual([{ message: "hello" }]);
  });

  test("uses only the terminal message.completed when nothing streamed, skipping tool-calls boundaries", async () => {
    const client = new FakeEveBridgeClient([
      [
        completed("let me check", "tool-calls"),
        {
          type: "actions.requested",
          data: { actions: [{ callId: "c1", input: {}, kind: "tool-call", toolName: "get_weather" }], ...turn() },
        },
        {
          type: "action.result",
          data: {
            result: { callId: "c1", kind: "tool-result", output: { ok: true }, toolName: "get_weather" },
            status: "completed",
            ...turn(),
          },
        },
        completed("it is sunny"),
        waiting(),
      ],
    ]);
    const response = new RecordingResponse();
    await run(client, response);
    expect(response.chunks).toEqual([
      { type: "status", status: "eve actions: tool-call:get_weather" },
      { type: "status", status: "eve action result: get_weather (completed)" },
      { type: "response", text: "it is sunny" },
    ]);
  });

  test("includes action errors in action.result status chunks", async () => {
    const client = new FakeEveBridgeClient([
      [
        {
          type: "action.result",
          data: {
            error: { code: "TOOL_FAILED", message: "boom" },
            result: { callId: "c1", kind: "tool-result", output: "boom", toolName: "deploy", isError: true },
            status: "failed",
            ...turn(),
          },
        },
        completed("could not deploy"),
        waiting(),
      ],
    ]);
    const response = new RecordingResponse();
    await run(client, response);
    expect(response.chunks[0]).toEqual({
      type: "status",
      status: "eve action result: deploy (failed) — boom",
    });
  });

  test("bridges input.requested to a §7 ask and resumes with one inputResponses send", async () => {
    const client = new FakeEveBridgeClient([
      [inputRequested([approvalRequest()])],
      [appended("deployed"), waiting()],
    ]);
    const response = new RecordingResponse(["approve"]);
    await run(client, response);

    expect(client.sends).toEqual([
      { message: "hello" },
      { inputResponses: [{ requestId: "req-1", optionId: "approve" }] },
    ]);
    expect(response.askPrompts).toHaveLength(1);
    expect(response.askPrompts[0]).toContain("Run the deploy tool?");
    expect(response.askPrompts[0]).toContain("1. approve — Approve");
    expect(response.askPrompts[0]).toContain("2. deny — Deny");
    expect(response.askPrompts[0]).toContain("Reply with an option number, id, or label.");
    expect(response.askPrompts[0]).not.toContain("Freeform text is accepted.");
    expect(response.chunks).toContainEqual({
      type: "status",
      status: "eve requests operator input (1 pending)",
    });
  });

  test("asks sequentially for multiple requests in one event and answers them in a single send", async () => {
    const second = approvalRequest({
      requestId: "req-2",
      prompt: "Also restart the cache?",
      action: { callId: "call-2", input: {}, kind: "tool-call", toolName: "restart" },
    });
    const client = new FakeEveBridgeClient([
      [inputRequested([approvalRequest(), second])],
      [appended("both done"), waiting()],
    ]);
    // "2" resolves by 1-based option index → deny.
    const response = new RecordingResponse(["approve", "2"]);
    await run(client, response);

    expect(response.askPrompts).toHaveLength(2);
    expect(client.sends).toHaveLength(2);
    expect(client.sends[1]).toEqual({
      inputResponses: [
        { requestId: "req-1", optionId: "approve" },
        { requestId: "req-2", optionId: "deny" },
      ],
    });
  });

  test("re-asks once with a prefix when the reply matches no option", async () => {
    const client = new FakeEveBridgeClient([
      [inputRequested([approvalRequest()])],
      [appended("done"), waiting()],
    ]);
    const response = new RecordingResponse(["bogus", "approve"]);
    await run(client, response);

    expect(response.askPrompts).toHaveLength(2);
    expect(response.askPrompts[1]).toContain('Could not match "bogus" to an option.');
    expect(client.sends[1]).toEqual({
      inputResponses: [{ requestId: "req-1", optionId: "approve" }],
    });
  });

  test("auto-answers the deny-shaped option after two unresolvable replies", async () => {
    const client = new FakeEveBridgeClient([
      [inputRequested([approvalRequest()])],
      [appended("aborted"), waiting()],
    ]);
    const response = new RecordingResponse(["bogus", "still bogus"]);
    await run(client, response);

    expect(client.sends[1]).toEqual({
      inputResponses: [{ requestId: "req-1", optionId: "deny" }],
    });
    expect(response.chunks).toContainEqual({
      type: "status",
      status: 'eve input request could not be matched to an option; auto-answering "deny"',
    });
  });

  test("auto-answers the deny-shaped option when the ask times out", async () => {
    const client = new FakeEveBridgeClient([
      [inputRequested([approvalRequest()])],
      [appended("aborted"), waiting()],
    ]);
    const response = new RecordingResponse(["TIMEOUT"]);
    await run(client, response);

    expect(client.sends[1]).toEqual({
      inputResponses: [{ requestId: "req-1", optionId: "deny" }],
    });
    expect(response.chunks).toContainEqual({
      type: "status",
      status: 'eve input request timed out; auto-answering "deny"',
    });
  });

  test("fails the turn on ask timeout when the request has no deny-shaped option", async () => {
    const freeform = approvalRequest({ prompt: "What is the deploy tag?", display: "text" });
    const { options: _options, ...withoutOptions } = freeform;
    const client = new FakeEveBridgeClient([[inputRequested([withoutOptions as InputRequest])]]);
    const response = new RecordingResponse(["TIMEOUT"]);
    await expect(run(client, response)).rejects.toThrow(
      /timed out and has no deny-shaped option/,
    );
  });

  test.each(["step.failed", "turn.failed", "session.failed"] as const)(
    "throws a 500-shaped error on %s",
    async (type) => {
      const data =
        type === "session.failed"
          ? { code: "E_FATAL", message: "model exploded", sessionId: "s1" }
          : type === "turn.failed"
            ? { code: "E_FATAL", message: "model exploded", sequence: 1, turnId: "t1" }
            : { code: "E_FATAL", message: "model exploded", ...turn() };
      const client = new FakeEveBridgeClient([[{ type, data } as HandleMessageStreamEvent]]);
      const response = new RecordingResponse();
      await expect(run(client, response)).rejects.toThrow(
        `eve ${type} [E_FATAL]: model exploded`,
      );
    },
  );

  test("emits structured results as JSON response chunks", async () => {
    const client = new FakeEveBridgeClient([
      [
        {
          type: "result.completed",
          data: { result: { answer: "ok", count: 2 }, ...turn() },
        },
        waiting(),
      ],
    ]);
    const response = new RecordingResponse();
    await run(client, response);
    expect(response.chunks).toEqual([{ type: "response", text: '{"answer":"ok","count":2}' }]);
  });

  test("emits a single empty response for an empty turn", async () => {
    const client = new FakeEveBridgeClient([[waiting()]]);
    const response = new RecordingResponse();
    await run(client, response);
    expect(response.chunks).toEqual([{ type: "response", text: "" }]);
  });

  test("announces session completion as a status chunk", async () => {
    const client = new FakeEveBridgeClient([
      [appended("bye"), { type: "session.completed" }],
    ]);
    const response = new RecordingResponse();
    await run(client, response);
    expect(response.chunks).toContainEqual({
      type: "status",
      status: "eve session completed — next prompt starts a new session",
    });
  });

  test("converts attachments to inline data: URL file parts on the first send", async () => {
    const client = new FakeEveBridgeClient([[appended("got it"), waiting()]]);
    const response = new RecordingResponse();
    await run(client, response, {
      prompt: "see file",
      attachments: [{ filename: "note.txt", content: new TextEncoder().encode("ABC") }],
    });
    expect(client.sends).toEqual([
      {
        message: [
          { type: "text", text: "see file" },
          {
            type: "file",
            data: "data:text/plain;base64,QUJD",
            mediaType: "text/plain",
            filename: "note.txt",
          },
        ],
      },
    ]);
  });

  test("gives up after the HITL round ceiling", async () => {
    const scripts = Array.from({ length: MAX_HITL_ROUNDS + 1 }, () => [
      inputRequested([approvalRequest()]),
    ]);
    const client = new FakeEveBridgeClient(scripts);
    const response = new RecordingResponse(Array(MAX_HITL_ROUNDS).fill("approve"));
    await expect(run(client, response)).rejects.toThrow(/more than 8 rounds/);
    expect(client.sends).toHaveLength(MAX_HITL_ROUNDS + 1);
  });
});
