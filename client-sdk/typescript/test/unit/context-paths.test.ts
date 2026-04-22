import { describe, expect, it } from "vitest";
import {
  expandTilde,
  resolveContextPaths,
  UnresolvedContextDirError,
} from "../../src/internal/context-paths.js";

describe("resolveContextPaths", () => {
  it("prefers $NATS_CONFIG_HOME when set", () => {
    const p = resolveContextPaths({ NATS_CONFIG_HOME: "/etc/nats", HOME: "/home/alice" });
    expect(p.baseDir).toBe("/etc/nats");
    expect(p.contextDir).toBe("/etc/nats/context");
    expect(p.selectionFile).toBe("/etc/nats/context.txt");
  });

  it("falls back to $XDG_CONFIG_HOME/nats", () => {
    const p = resolveContextPaths({
      XDG_CONFIG_HOME: "/home/alice/.local/config",
      HOME: "/home/alice",
    });
    expect(p.baseDir).toBe("/home/alice/.local/config/nats");
  });

  it("falls back to $HOME/.config/nats (Unix default)", () => {
    const p = resolveContextPaths({ HOME: "/home/alice" });
    expect(p.baseDir).toBe("/home/alice/.config/nats");
  });

  it("uses %APPDATA%/nats on Windows when nothing else is set", () => {
    const p = resolveContextPaths({
      APPDATA: "C:\\Users\\Alice\\AppData\\Roaming",
      platform: "win32",
    });
    expect(p.baseDir).toContain("nats");
  });

  it("throws UnresolvedContextDirError when nothing matches", () => {
    expect(() => resolveContextPaths({})).toThrow(UnresolvedContextDirError);
  });

  it("ignores empty-string env values", () => {
    expect(() =>
      resolveContextPaths({ NATS_CONFIG_HOME: "", XDG_CONFIG_HOME: "", HOME: "" }),
    ).toThrow(UnresolvedContextDirError);
  });

  it("returns frozen ContextPaths", () => {
    const p = resolveContextPaths({ HOME: "/home/alice" });
    expect(Object.isFrozen(p)).toBe(true);
  });
});

describe("expandTilde", () => {
  it("expands '~' to HOME", () => {
    expect(expandTilde("~", "/home/alice")).toBe("/home/alice");
  });

  it("expands '~/path/to/file' to HOME/path/to/file", () => {
    expect(expandTilde("~/.nkeys/prod.creds", "/home/alice")).toBe("/home/alice/.nkeys/prod.creds");
  });

  it("leaves absolute paths unchanged", () => {
    expect(expandTilde("/etc/nats/foo", "/home/alice")).toBe("/etc/nats/foo");
  });

  it("leaves relative paths unchanged", () => {
    expect(expandTilde("./creds", "/home/alice")).toBe("./creds");
  });

  it("leaves '~user/...' unchanged (not supported)", () => {
    expect(expandTilde("~bob/creds", "/home/alice")).toBe("~bob/creds");
  });

  it("is a no-op when home is empty", () => {
    expect(expandTilde("~/foo", undefined)).toBe("~/foo");
    expect(expandTilde("~/foo", "")).toBe("~/foo");
  });

  it("returns empty string for empty input", () => {
    expect(expandTilde("", "/home/alice")).toBe("");
  });
});
