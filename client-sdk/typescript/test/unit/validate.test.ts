import { describe, expect, it } from "vitest";
import { PayloadTooLargeError, PromptEmptyError, ValidationError } from "../../src/errors.js";
import { assertPromptNonEmpty, assertWithinMaxPayload } from "../../src/prompt/validate.js";
import { buildEndpointInfo } from "../../src/discovery/endpoint-info.js";

describe("assertPromptNonEmpty", () => {
  it("accepts non-empty prompts", () => {
    expect(() => assertPromptNonEmpty("hello")).not.toThrow();
    expect(() => assertPromptNonEmpty(" ")).not.toThrow(); // whitespace is non-empty
  });

  it("rejects the empty string with PromptEmptyError", () => {
    expect(() => assertPromptNonEmpty("")).toThrow(PromptEmptyError);
  });

  it("PromptEmptyError extends ValidationError", () => {
    try {
      assertPromptNonEmpty("");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
    }
  });
});

describe("assertWithinMaxPayload", () => {
  const endpoint = buildEndpointInfo({
    name: "prompt",
    subject: "agents.ref.alice.echo",
    metadata: { max_payload: "1KB" },
  });

  it("passes when size is under the limit", () => {
    expect(() => assertWithinMaxPayload(512, endpoint)).not.toThrow();
  });

  it("passes when size equals the limit", () => {
    expect(() => assertWithinMaxPayload(1024, endpoint)).not.toThrow();
  });

  it("throws PayloadTooLargeError with limit + actual when over", () => {
    try {
      assertWithinMaxPayload(1025, endpoint);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PayloadTooLargeError);
      const e = err as PayloadTooLargeError;
      expect(e.limit).toBe(1024);
      expect(e.actual).toBe(1025);
    }
  });

  it("is a no-op when the endpoint declared no limit", () => {
    const noLimit = buildEndpointInfo({ name: "prompt", subject: "agents.ref.alice.echo" });
    expect(() => assertWithinMaxPayload(100_000_000, noLimit)).not.toThrow();
  });

  describe("connection limit", () => {
    const noLimit = buildEndpointInfo({ name: "prompt", subject: "agents.ref.alice.echo" });
    const eightMb = buildEndpointInfo({
      name: "prompt",
      subject: "agents.ref.alice.echo",
      metadata: { max_payload: "8MB" },
    });
    const oneMb = 1024 * 1024;

    it("uses connection limit alone when endpoint silent", () => {
      expect(() => assertWithinMaxPayload(2 * oneMb, noLimit, oneMb)).toThrow(PayloadTooLargeError);
    });

    it("picks the smaller of endpoint and connection (connection is binding)", () => {
      // Agent advertises 8MB but caller's broker caps at 1MB.
      expect(() => assertWithinMaxPayload(2 * oneMb, eightMb, oneMb)).toThrow(PayloadTooLargeError);
      try {
        assertWithinMaxPayload(2 * oneMb, eightMb, oneMb);
      } catch (err) {
        expect((err as PayloadTooLargeError).limit).toBe(oneMb);
      }
    });

    it("picks the smaller of endpoint and connection (endpoint is binding)", () => {
      // Reverse: agent advertises 1KB, caller's broker would allow 8MB.
      expect(() => assertWithinMaxPayload(2048, endpoint, 8 * 1024 * 1024)).toThrow(
        PayloadTooLargeError,
      );
      try {
        assertWithinMaxPayload(2048, endpoint, 8 * 1024 * 1024);
      } catch (err) {
        expect((err as PayloadTooLargeError).limit).toBe(1024);
      }
    });

    it("connection 0 / undefined behaves as 'not declared'", () => {
      expect(() => assertWithinMaxPayload(100_000_000, noLimit, 0)).not.toThrow();
      expect(() => assertWithinMaxPayload(100_000_000, noLimit, undefined)).not.toThrow();
    });
  });
});
