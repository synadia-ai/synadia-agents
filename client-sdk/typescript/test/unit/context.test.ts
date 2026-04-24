// Unit tests for the `loadNatsContext` helper.
//
// Each test materialises a fresh `$NATS_CONFIG_HOME` directory with the
// context JSON file(s) it needs and runs the helper against it. The temp
// dir is cleaned up after each test; env vars (`NATS_CONFIG_HOME`,
// `NATS_CONTEXT`) are saved and restored so tests stay independent.
//
// We don't exercise the `credsAuthenticator` / `jwtAuthenticator` internals
// — only that the helper picks the right auth strategy and populates
// `connectionOptions.authenticator` when it should.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNatsContext } from "../../src/context.js";

let configHome = "";
let savedEnv: { configHome: string | undefined; context: string | undefined } = {
  configHome: undefined,
  context: undefined,
};

beforeEach(async () => {
  savedEnv = {
    configHome: process.env["NATS_CONFIG_HOME"],
    context: process.env["NATS_CONTEXT"],
  };
  configHome = await mkdtemp(join(tmpdir(), "nats-ctx-test-"));
  process.env["NATS_CONFIG_HOME"] = configHome;
  delete process.env["NATS_CONTEXT"];
  await mkdir(join(configHome, "context"), { recursive: true });
});

afterEach(async () => {
  if (savedEnv.configHome !== undefined) process.env["NATS_CONFIG_HOME"] = savedEnv.configHome;
  else delete process.env["NATS_CONFIG_HOME"];
  if (savedEnv.context !== undefined) process.env["NATS_CONTEXT"] = savedEnv.context;
  else delete process.env["NATS_CONTEXT"];
  await rm(configHome, { recursive: true, force: true });
});

async function writeContext(name: string, body: Record<string, unknown>): Promise<void> {
  await writeFile(
    join(configHome, "context", `${name}.json`),
    JSON.stringify(body),
    "utf8",
  );
}

describe("loadNatsContext", () => {
  it("parses url-only context", async () => {
    await writeContext("local", { url: "nats://127.0.0.1:4222" });
    const ctx = await loadNatsContext("local");
    expect(ctx.name).toBe("local");
    expect([...ctx.servers]).toEqual(["nats://127.0.0.1:4222"]);
    expect(ctx.connectionOptions).toEqual({});
    expect(ctx.description).toBeUndefined();
  });

  it("comma-splits multiple servers", async () => {
    await writeContext("cluster", {
      url: "nats://a:4222, nats://b:4222,nats://c:4222",
    });
    const ctx = await loadNatsContext("cluster");
    expect([...ctx.servers]).toEqual([
      "nats://a:4222",
      "nats://b:4222",
      "nats://c:4222",
    ]);
  });

  it("sets token/user/password auth fields", async () => {
    await writeContext("basic", {
      url: "nats://x:4222",
      token: "t0k",
      user: "alice",
      password: "secret",
      inbox_prefix: "_MY_INBOX",
      description: "test",
    });
    const ctx = await loadNatsContext("basic");
    expect(ctx.connectionOptions.token).toBe("t0k");
    expect(ctx.connectionOptions.user).toBe("alice");
    expect(ctx.connectionOptions.pass).toBe("secret");
    expect(ctx.connectionOptions.inboxPrefix).toBe("_MY_INBOX");
    expect(ctx.description).toBe("test");
  });

  it("sets jwtAuthenticator when `user_jwt` is present", async () => {
    await writeContext("jwt", {
      url: "nats://x:4222",
      user_jwt: "eyJhbGciOiJlZDI1NTE5In0.payload.sig",
    });
    const ctx = await loadNatsContext("jwt");
    expect(ctx.connectionOptions.authenticator).toBeDefined();
    // user/pass/token should NOT be set when jwt auth is chosen
    expect(ctx.connectionOptions.user).toBeUndefined();
    expect(ctx.connectionOptions.token).toBeUndefined();
  });

  it("uses credsAuthenticator when `creds` is present (takes precedence over user_jwt)", async () => {
    const credsPath = join(configHome, "fake.creds");
    await writeFile(credsPath, "-----BEGIN NATS USER JWT-----\nfake\n-----END NATS USER JWT-----\n");
    await writeContext("creds", {
      url: "nats://x:4222",
      creds: credsPath,
      user_jwt: "ignored-because-creds-wins",
      token: "also-ignored",
    });
    const ctx = await loadNatsContext("creds");
    expect(ctx.connectionOptions.authenticator).toBeDefined();
    expect(ctx.connectionOptions.token).toBeUndefined();
  });

  it("reads the current selection from context.txt", async () => {
    await writeContext("prod", { url: "nats://prod:4222" });
    await writeFile(join(configHome, "context.txt"), "prod\n", "utf8");
    const ctx = await loadNatsContext("current");
    expect(ctx.name).toBe("prod");
    expect([...ctx.servers]).toEqual(["nats://prod:4222"]);
  });

  it("$NATS_CONTEXT overrides context.txt", async () => {
    await writeContext("prod", { url: "nats://prod:4222" });
    await writeContext("staging", { url: "nats://staging:4222" });
    await writeFile(join(configHome, "context.txt"), "prod\n", "utf8");
    process.env["NATS_CONTEXT"] = "staging";
    const ctx = await loadNatsContext("current");
    expect(ctx.name).toBe("staging");
    expect([...ctx.servers]).toEqual(["nats://staging:4222"]);
  });

  it("throws a friendly error when the context file is missing", async () => {
    await expect(loadNatsContext("no-such-ctx")).rejects.toThrow(/not found/);
  });

  it("throws when `url` is missing", async () => {
    await writeContext("bad", { token: "t" });
    await expect(loadNatsContext("bad")).rejects.toThrow(/missing `url`/);
  });

  it("throws when the context JSON is malformed", async () => {
    await writeFile(join(configHome, "context", "broken.json"), "{not valid", "utf8");
    await expect(loadNatsContext("broken")).rejects.toThrow(/not valid JSON/);
  });
});
