import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SendTurnPayload, SessionState } from "eve/client";

// Import the real module BEFORE mocking so pure helpers (resolveTextToResponse,
// createDataUrlFilePart) stay real for every other suite even if the module
// mock leaks across test files — only `Client` is replaced.
const actual = await import("eve/client");

const sessionState: { sessionId?: string; streamIndex: number } = { streamIndex: 0 };
const sessionSend = mock(async (_payload: SendTurnPayload) => {
  sessionState.sessionId = "sess-1";
  return (async function* () {})();
});
const sessionFactory = mock(() => ({
  send: sessionSend,
  get state(): SessionState {
    return sessionState as SessionState;
  },
}));
const clientCtor = mock((_options: unknown) => {});

mock.module("eve/client", () => ({
  ...actual,
  Client: class FakeClient {
    constructor(options: unknown) {
      clientCtor(options);
      return { session: sessionFactory } as unknown as FakeClient;
    }
  },
}));

const { SdkEveBridgeClient } = await import("../src/eve-client.js");

describe("SdkEveBridgeClient", () => {
  afterEach(() => {
    clientCtor.mockClear();
    sessionFactory.mockClear();
    sessionSend.mockClear();
    sessionSend.mockImplementation(async (_payload: SendTurnPayload) => {
      sessionState.sessionId = "sess-1";
      return (async function* () {})();
    });
    delete sessionState.sessionId;
  });

  test("creates the Client lazily with host and bearer auth, reusing one session", async () => {
    const client = new SdkEveBridgeClient({
      baseUrl: "http://127.0.0.1:2000",
      authToken: "tok-1",
      askTimeoutS: 120,
    });
    expect(clientCtor).not.toHaveBeenCalled();
    expect(client.sessionId()).toBeUndefined();

    await client.send({ message: "hi" });
    await client.send({ message: "again" });

    expect(clientCtor).toHaveBeenCalledTimes(1);
    expect(clientCtor).toHaveBeenCalledWith({
      host: "http://127.0.0.1:2000",
      auth: { bearer: "tok-1" },
    });
    expect(sessionFactory).toHaveBeenCalledTimes(1);
    expect(sessionSend).toHaveBeenCalledTimes(2);
    expect(client.sessionId()).toBe("sess-1");
  });

  test("omits auth entirely for local unauthenticated eve dev", async () => {
    const client = new SdkEveBridgeClient({ baseUrl: "http://127.0.0.1:2000", askTimeoutS: 120 });
    await client.send({ message: "hi" });
    expect(clientCtor).toHaveBeenCalledWith({ host: "http://127.0.0.1:2000" });
  });

  test("sends message and inputResponses payload shapes, dropping empty fields", async () => {
    const client = new SdkEveBridgeClient({ baseUrl: "http://127.0.0.1:2000", askTimeoutS: 120 });
    await client.send({ message: "hi" });
    await client.send({ inputResponses: [{ requestId: "r1", optionId: "approve" }] });
    await client.send({ message: "next", inputResponses: [] });

    expect(sessionSend.mock.calls[0]?.[0]).toEqual({ message: "hi" });
    expect(sessionSend.mock.calls[1]?.[0]).toEqual({
      inputResponses: [{ requestId: "r1", optionId: "approve" }],
    });
    expect(sessionSend.mock.calls[2]?.[0]).toEqual({ message: "next" });
  });

  test("wraps transport failures with the eve base URL", async () => {
    sessionSend.mockImplementation(async () => {
      throw new Error("fetch failed");
    });
    const client = new SdkEveBridgeClient({ baseUrl: "http://127.0.0.1:9999", askTimeoutS: 120 });
    await expect(client.send({ message: "hi" })).rejects.toThrow(
      "eve server unreachable at http://127.0.0.1:9999: fetch failed",
    );
  });
});
