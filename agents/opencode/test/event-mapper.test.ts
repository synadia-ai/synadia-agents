import { describe, expect, test } from "bun:test";
import { createEventMapperState, mapOpenCodeEvent } from "../src/event-mapper.js";

describe("event mapper", () => {
  test("maps delta text to response chunks", () => {
    expect(mapOpenCodeEvent({ type: "message.part.delta", data: { text: "hello" } })).toEqual({ type: "response", text: "hello" });
  });

  test("does not duplicate full updated part content", () => {
    const state = createEventMapperState();
    expect(mapOpenCodeEvent({ type: "message.part.updated", data: { messageId: "m1", partId: "p1", text: "hello" } }, state)).toEqual({ type: "response", text: "hello" });
    expect(mapOpenCodeEvent({ type: "message.part.updated", data: { messageId: "m1", partId: "p1", text: "hello world" } }, state)).toEqual({ type: "response", text: " world" });
    expect(mapOpenCodeEvent({ type: "message.part.updated", data: { messageId: "m1", partId: "p1", text: "hello world" } }, state)).toEqual({ type: "ignore" });
  });

  test("does not stringify raw event objects into response text", () => {
    expect(mapOpenCodeEvent({ type: "message.updated", data: { status: "done", nested: { bad: true } } })).toEqual({ type: "ignore" });
  });

  test("maps idle and errors", () => {
    expect(mapOpenCodeEvent({ type: "session.idle" })).toEqual({ type: "done" });
    expect(mapOpenCodeEvent({ type: "session.error", data: { message: "boom" } })).toEqual({ type: "error", text: "boom" });
  });
});
