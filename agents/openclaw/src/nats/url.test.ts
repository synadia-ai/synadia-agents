import { describe, expect, it } from "vitest";
import { parseNatsUrl } from "./url.js";

describe("parseNatsUrl (openclaw)", () => {
  it("returns bare server URL for input with no userinfo", () => {
    expect(parseNatsUrl("nats://nats.example.com:4222")).toEqual({
      servers: ["nats://nats.example.com:4222"],
    });
  });

  it("treats single userinfo component as a token (matches `nats` CLI)", () => {
    expect(parseNatsUrl("nats://abc123@nats.example.com:4222")).toEqual({
      servers: ["nats://nats.example.com:4222"],
      token: "abc123",
    });
  });

  it("splits user:password userinfo into user + pass", () => {
    expect(parseNatsUrl("nats://alice:s3cret@nats.example.com:4222")).toEqual({
      servers: ["nats://nats.example.com:4222"],
      user: "alice",
      pass: "s3cret",
    });
  });

  it("treats `user:` (explicit colon, empty password) as user:password, not token", () => {
    expect(parseNatsUrl("nats://alice:@nats.example.com:4222")).toEqual({
      servers: ["nats://nats.example.com:4222"],
      user: "alice",
      pass: "",
    });
  });

  it("URL-decodes percent-encoded userinfo", () => {
    // %2B → "+", %40 → "@"
    expect(parseNatsUrl("nats://to%2Bken%40v1@host:4222").token).toBe("to+ken@v1");
  });

  it("preserves tls://, ws://, wss:// schemes (and extracts credentials too)", () => {
    expect(parseNatsUrl("tls://tok@host:4443")).toEqual({
      servers: ["tls://host:4443"],
      token: "tok",
    });
    expect(parseNatsUrl("ws://tok@host:9222")).toEqual({
      servers: ["ws://host:9222"],
      token: "tok",
    });
    expect(parseNatsUrl("wss://tok@host:9222")).toEqual({
      servers: ["wss://host:9222"],
      token: "tok",
    });
  });

  it("accepts scheme-less host:port (treats as nats://)", () => {
    expect(parseNatsUrl("nats.example.com:4222").servers).toEqual([
      "nats://nats.example.com:4222",
    ]);
  });

  it("splits comma-separated cluster URLs (no userinfo)", () => {
    // The form `@nats-io/transport-node` accepts via `servers: string`.
    // Pre-fix this would crash because `new URL("a,b")` rejects commas.
    expect(parseNatsUrl("nats://h1:4222,nats://h2:4222")).toEqual({
      servers: ["nats://h1:4222", "nats://h2:4222"],
    });
  });

  it("accepts cluster URLs when userinfo is identical on every entry", () => {
    expect(
      parseNatsUrl("nats://tok@h1:4222,nats://tok@h2:4222"),
    ).toEqual({
      servers: ["nats://h1:4222", "nats://h2:4222"],
      token: "tok",
    });
  });

  it("throws when cluster URLs have mixed credentials", () => {
    expect(() =>
      parseNatsUrl("nats://tok1@h1:4222,nats://tok2@h2:4222"),
    ).toThrow(/mixed credentials/);
  });

  it("throws on empty input", () => {
    expect(() => parseNatsUrl("")).toThrow(/empty NATS URL/);
    expect(() => parseNatsUrl("   ,  ")).toThrow(/empty NATS URL/);
  });

  it("throws on unsupported scheme", () => {
    expect(() => parseNatsUrl("http://nats.example.com:4222")).toThrow(/unsupported/);
  });

  it("throws on hostless URL", () => {
    expect(() => parseNatsUrl("nats://")).toThrow(/missing a host/);
  });
});
