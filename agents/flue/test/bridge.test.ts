import { describe, expect, test } from "bun:test";
import { bridgePromptToFlue, type BridgeResponse, type FlueBridgeClient } from "../src/bridge.js";
import type { FlueMapping } from "../src/config.js";

function mapping(): FlueMapping {
  return {
    owner: "rene",
    name: "support",
    subjectToken: "flue",
    flue: {
      baseUrl: "http://127.0.0.1:3583",
      agent: "assistant",
      instance: "customer-123",
      session: "ticket-123",
      transport: "http-stream",
    },
  };
}

class RecordingResponse implements BridgeResponse {
  chunks: unknown[] = [];
  async send(chunk: unknown): Promise<void> { this.chunks.push(chunk); }
}

describe("bridgePromptToFlue", () => {
  test("sends status and final response for a string result", async () => {
    const response = new RecordingResponse();
    const client: FlueBridgeClient = { prompt: async () => "hello from flue" };
    await bridgePromptToFlue({ envelope: { prompt: "hello" }, response, mapping: mapping(), flueClient: client });
    expect(response.chunks).toEqual([
      { type: "status", status: "connected to Flue assistant/customer-123 via http-stream" },
      { type: "response", text: "hello from flue" },
    ]);
  });

  test("forwards streaming text deltas as response chunks without duplicating the final result", async () => {
    const response = new RecordingResponse();
    const client: FlueBridgeClient = {
      prompt: async (_input, events) => {
        await events?.onTextDelta?.("hello ");
        await events?.onTextDelta?.("stream");
        return "";
      },
    };

    await bridgePromptToFlue({ envelope: { prompt: "hello" }, response, mapping: mapping(), flueClient: client });

    expect(response.chunks).toEqual([
      { type: "status", status: "connected to Flue assistant/customer-123 via http-stream" },
      { type: "response", text: "hello " },
      { type: "response", text: "stream" },
    ]);
  });

  test("stringifies object results predictably", async () => {
    const response = new RecordingResponse();
    const client: FlueBridgeClient = { prompt: async () => ({ answer: "ok", count: 2 }) };
    await bridgePromptToFlue({ envelope: { prompt: "hello" }, response, mapping: mapping(), flueClient: client });
    expect(response.chunks.at(-1)).toEqual({ type: "response", text: '{"answer":"ok","count":2}' });
  });

  test("uses text from Flue sync result objects", async () => {
    const response = new RecordingResponse();
    const client: FlueBridgeClient = { prompt: async () => ({ text: "echo:hello", usage: { totalTokens: 1 } }) };
    await bridgePromptToFlue({ envelope: { prompt: "hello" }, response, mapping: mapping(), flueClient: client });
    expect(response.chunks.at(-1)).toEqual({ type: "response", text: "echo:hello" });
  });

  test("rejects attachments explicitly", async () => {
    const response = new RecordingResponse();
    const client: FlueBridgeClient = { prompt: async () => "should not be called" };
    await expect(bridgePromptToFlue({
      envelope: { prompt: "hello", attachments: [{ filename: "x.txt", content: new Uint8Array([1]) }] },
      response,
      mapping: mapping(),
      flueClient: client,
    })).rejects.toThrow("attachments are not supported");
  });
});
