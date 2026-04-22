import { describe, expect, it } from "vitest";
import { isErrorSignal, isTerminator } from "../../src/stream/terminator.js";

describe("isTerminator", () => {
  it("returns true for empty body + no headers", () => {
    expect(isTerminator({ data: new Uint8Array(0) })).toBe(true);
    expect(isTerminator({ data: new Uint8Array(0), headers: undefined })).toBe(true);
  });

  it("returns false when body is non-empty", () => {
    expect(isTerminator({ data: new Uint8Array([1]) })).toBe(false);
  });

  it("returns false when headers are present (even if empty body)", () => {
    const fakeHeaders = { has: () => true, get: () => "" };
    expect(isTerminator({ data: new Uint8Array(0), headers: fakeHeaders })).toBe(false);
  });
});

describe("isErrorSignal", () => {
  it("returns true when `Nats-Service-Error-Code` header is present via has()", () => {
    const h = { has: (k: string) => k === "Nats-Service-Error-Code" };
    expect(isErrorSignal({ data: new Uint8Array(0), headers: h })).toBe(true);
  });

  it("returns true when the header is available via get()", () => {
    const h = { get: (k: string) => (k === "Nats-Service-Error-Code" ? "429" : "") };
    expect(isErrorSignal({ data: new Uint8Array(0), headers: h })).toBe(true);
  });

  it("returns false when headers are absent", () => {
    expect(isErrorSignal({ data: new Uint8Array(0) })).toBe(false);
  });

  it("returns false when the error-code header is absent", () => {
    const h = { has: (k: string) => k === "Some-Other-Header" };
    expect(isErrorSignal({ data: new Uint8Array(0), headers: h })).toBe(false);
  });
});
