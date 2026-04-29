import { describe, expect, it } from "vitest";
import { parseNatsUrl } from "./url.js";

describe("parseNatsUrl (openclaw)", () => {
  it("returns bare server URL for input with no userinfo", () => {
    expect(parseNatsUrl("nats://nats.example.com:4222")).toEqual({
      servers: "nats://nats.example.com:4222",
    });
  });

  it("treats single userinfo component as a token (matches `nats` CLI)", () => {
    expect(parseNatsUrl("nats://abc123@nats.example.com:4222")).toEqual({
      servers: "nats://nats.example.com:4222",
      token: "abc123",
    });
  });

  it("splits user:password userinfo into user + pass", () => {
    expect(parseNatsUrl("nats://alice:s3cret@nats.example.com:4222")).toEqual({
      servers: "nats://nats.example.com:4222",
      user: "alice",
      pass: "s3cret",
    });
  });

  it("treats `user:` (explicit colon, empty password) as user:password, not token", () => {
    expect(parseNatsUrl("nats://alice:@nats.example.com:4222")).toEqual({
      servers: "nats://nats.example.com:4222",
      user: "alice",
      pass: "",
    });
  });

  it("URL-decodes percent-encoded userinfo", () => {
    // %2B → "+", %40 → "@"
    expect(parseNatsUrl("nats://to%2Bken%40v1@host:4222").token).toBe("to+ken@v1");
  });

  it("preserves tls://, ws://, wss:// schemes", () => {
    expect(parseNatsUrl("tls://tok@host:4443").servers).toBe("tls://host:4443");
    expect(parseNatsUrl("ws://tok@host:9222").servers).toBe("ws://host:9222");
    expect(parseNatsUrl("wss://tok@host:9222").servers).toBe("wss://host:9222");
  });

  it("accepts scheme-less host:port (treats as nats://)", () => {
    expect(parseNatsUrl("nats.example.com:4222").servers).toBe(
      "nats://nats.example.com:4222",
    );
  });

  it("throws on unsupported scheme", () => {
    expect(() => parseNatsUrl("http://nats.example.com:4222")).toThrow(/unsupported/);
  });

  it("throws on hostless URL", () => {
    expect(() => parseNatsUrl("nats://")).toThrow(/missing a host/);
  });
});
