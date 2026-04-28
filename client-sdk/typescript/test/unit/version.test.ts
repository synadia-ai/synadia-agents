import { describe, expect, it } from "vitest";
import {
  compareProtocolVersion,
  InvalidProtocolVersionError,
  parseProtocolVersion,
  SDK_PROTOCOL_VERSION,
} from "../../src/version.js";

describe("parseProtocolVersion", () => {
  it("parses MAJOR.MINOR", () => {
    expect(parseProtocolVersion("0.1")).toEqual({ major: 0, minor: 1 });
    expect(parseProtocolVersion("1.2")).toEqual({ major: 1, minor: 2 });
  });

  it("drops patch/pre-release qualifiers", () => {
    expect(parseProtocolVersion("0.1.0")).toEqual({ major: 0, minor: 1 });
    expect(parseProtocolVersion("0.1.0-draft")).toEqual({ major: 0, minor: 1 });
    expect(parseProtocolVersion("1.2.3-rc.1")).toEqual({ major: 1, minor: 2 });
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseProtocolVersion("  0.1  ")).toEqual({ major: 0, minor: 1 });
  });

  it.each([[""], ["0"], ["x.y"], ["1."], [".1"], ["v0.1"]])(
    "rejects malformed input: %s",
    (input) => {
      expect(() => parseProtocolVersion(input)).toThrow(InvalidProtocolVersionError);
    },
  );
});

describe("compareProtocolVersion", () => {
  it("returns 'compatible' on exact MAJOR.MINOR match", () => {
    expect(compareProtocolVersion({ major: 0, minor: 3 })).toBe("compatible");
  });

  it("returns 'minor-drift' when MAJOR matches but MINOR differs", () => {
    expect(compareProtocolVersion({ major: 0, minor: 1 })).toBe("minor-drift");
    expect(compareProtocolVersion({ major: 0, minor: 2 })).toBe("minor-drift");
    expect(compareProtocolVersion({ major: 0, minor: 4 })).toBe("minor-drift");
  });

  it("returns 'incompatible' on different MAJOR", () => {
    expect(compareProtocolVersion({ major: 1, minor: 3 })).toBe("incompatible");
    expect(compareProtocolVersion({ major: 2, minor: 0 })).toBe("incompatible");
  });

  it("exposes SDK_PROTOCOL_VERSION matching the protocol this SDK speaks", () => {
    expect(SDK_PROTOCOL_VERSION).toEqual({ major: 0, minor: 3 });
  });
});
