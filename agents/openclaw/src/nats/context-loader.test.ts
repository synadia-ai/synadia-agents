import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadNatsContextFromFile } from "./context-loader.js";

describe("loadNatsContextFromFile (openclaw)", () => {
  let baseHome: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    baseHome = mkdtempSync(join(tmpdir(), "openclaw-ctx-"));
    mkdirSync(join(baseHome, ".config", "nats", "context"), { recursive: true });
    savedHome = process.env.HOME;
    process.env.HOME = baseHome;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  function writeContext(name: string, body: Record<string, unknown>): void {
    writeFileSync(
      join(baseHome, ".config", "nats", "context", `${name}.json`),
      JSON.stringify(body),
    );
  }

  it("returns the URL unchanged when context has no auth", () => {
    writeContext("plain", { url: "nats://nats.example.com:4222" });
    expect(loadNatsContextFromFile("plain")).toEqual({
      url: "nats://nats.example.com:4222",
    });
  });

  it("folds a token into URL userinfo so parseNatsUrl extracts it later", () => {
    writeContext("tok", { url: "nats://nats.example.com:4222", token: "abc123" });
    const out = loadNatsContextFromFile("tok");
    expect(out.url).toBe("nats://abc123@nats.example.com:4222");
  });

  it("folds user:password into URL userinfo", () => {
    writeContext("up", {
      url: "nats://nats.example.com:4222",
      user: "alice",
      password: "s3cret",
    });
    const out = loadNatsContextFromFile("up");
    expect(out.url).toBe("nats://alice:s3cret@nats.example.com:4222");
  });

  it("URL-encodes reserved chars in userinfo so it round-trips through parseNatsUrl", () => {
    writeContext("special", {
      url: "nats://host:4222",
      token: "to+ken@v1",
    });
    const out = loadNatsContextFromFile("special");
    // Should encode '+' as %2B and '@' as %40 inside userinfo
    expect(out.url).toContain("to%2Bken%40v1");
  });

  it("propagates a creds path (with ~ expansion)", () => {
    writeContext("creds", { url: "nats://host:4222", creds: "~/my/creds.txt" });
    const out = loadNatsContextFromFile("creds");
    expect(out.url).toBe("nats://host:4222");
    expect(out.credentials).toBe(join(baseHome, "my/creds.txt"));
  });

  it("supports comma-separated cluster URLs (userinfo applied to each entry)", () => {
    writeContext("cluster", {
      url: "nats://h1:4222,nats://h2:4222",
      token: "tok",
    });
    const out = loadNatsContextFromFile("cluster");
    expect(out.url).toBe("nats://tok@h1:4222,nats://tok@h2:4222");
  });

  it("throws on missing context file", () => {
    expect(() => loadNatsContextFromFile("nope")).toThrow(/not found/);
  });

  it("throws on malformed JSON", () => {
    writeFileSync(
      join(baseHome, ".config", "nats", "context", "bad.json"),
      "not-json",
    );
    expect(() => loadNatsContextFromFile("bad")).toThrow(/not valid JSON/);
  });

  it("throws when the context is missing 'url'", () => {
    writeContext("no-url", { token: "tok" });
    expect(() => loadNatsContextFromFile("no-url")).toThrow(/missing 'url'/);
  });
});
