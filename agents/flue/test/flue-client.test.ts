import { afterEach, describe, expect, mock, test } from "bun:test";

const invoke = mock(async function* () {
  yield { type: "status", status: "started" };
  yield { type: "done" };
});

mock.module("@flue/sdk", () => ({
  createFlueClient: () => ({
    agents: {
      invoke,
      connect: () => { throw new Error("websocket not used in this test"); },
    },
  }),
}));

const { SdkFlueBridgeClient } = await import("../src/flue-client.js");

describe("SdkFlueBridgeClient", () => {
  afterEach(() => {
    invoke.mockClear();
  });

  test("does not leak raw Flue event arrays when HTTP stream has no text deltas", async () => {
    const client = new SdkFlueBridgeClient();

    const result = await client.prompt({
      message: "empty",
      baseUrl: "http://127.0.0.1:3583",
      agent: "echo",
      instance: "test",
      session: "session",
      transport: "http-stream",
    });

    expect(result).toBe("");
    expect(invoke).toHaveBeenCalledWith("echo", "test", {
      mode: "stream",
      payload: { message: "empty", session: "session" },
    });
  });
});
