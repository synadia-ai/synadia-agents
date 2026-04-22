// Integration test for `loadNatsContext` — creates a fake `~/.config/nats`
// layout in a tempdir and verifies the loader resolves names, parses the
// file, expands `~`, reads the creds file bytes, and builds correctly
// shaped connection options.
//
// This suite does NOT open a NATS connection; it only exercises the file
// system + auth-translation logic. Connection-level integration lives in
// `context-connect.test.ts` (M-ctx.3).

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ContextSelector,
  loadNatsContext,
  type NatsContext,
  NatsContextInvalidError,
  NatsContextNotFoundError,
  NatsContextNotSelectedError,
} from "../../src/index.js";

describe("loadNatsContext", () => {
  let root: string;
  let contextDir: string;
  let selectionFile: string;
  let credsFile: string;

  beforeAll(async () => {
    root = await mkdtemp(joinPath(tmpdir(), "agents-ctx-"));
    contextDir = joinPath(root, "nats", "context");
    selectionFile = joinPath(root, "nats", "context.txt");
    await mkdir(contextDir, { recursive: true });

    // A fake creds file the loader will read.
    credsFile = joinPath(root, "prod.creds");
    await writeFile(
      credsFile,
      "-----BEGIN NATS USER JWT-----\nfake-jwt\n------END NATS USER JWT------\n",
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeContext(name: string, body: Record<string, unknown>): Promise<void> {
    await writeFile(joinPath(contextDir, `${name}.json`), JSON.stringify(body, null, 2));
  }

  function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return { NATS_CONFIG_HOME: joinPath(root, "nats"), ...extra };
  }

  async function load(
    selector: ContextSelector,
    extraEnv: Record<string, string> = {},
  ): Promise<NatsContext> {
    return loadNatsContext(selector, env(extraEnv));
  }

  describe("loading by name", () => {
    it("loads a minimal url-only context", async () => {
      await writeContext("minimal", { url: "nats://localhost:4222" });
      const ctx = await load("minimal");
      expect(ctx.name).toBe("minimal");
      expect(ctx.servers).toEqual(["nats://localhost:4222"]);
      expect(ctx.connectionOptions).toEqual({});
    });

    it("splits comma-separated URLs into multiple servers", async () => {
      await writeContext("cluster", { url: "nats://a:4222, nats://b:4222 ,nats://c:4222" });
      const ctx = await load("cluster");
      expect(ctx.servers).toEqual(["nats://a:4222", "nats://b:4222", "nats://c:4222"]);
    });

    it("carries the description through", async () => {
      await writeContext("with-desc", {
        url: "nats://localhost:4222",
        description: "production cluster",
      });
      const ctx = await load("with-desc");
      expect(ctx.description).toBe("production cluster");
    });

    it("preserves `inbox_prefix`", async () => {
      await writeContext("inbox-prefix", {
        url: "nats://localhost:4222",
        inbox_prefix: "_CUSTOM.",
      });
      const ctx = await load("inbox-prefix");
      expect(ctx.connectionOptions.inboxPrefix).toBe("_CUSTOM.");
    });
  });

  describe("authentication", () => {
    it("loads creds bytes and installs an authenticator", async () => {
      await writeContext("with-creds", {
        url: "nats://localhost:4222",
        creds: credsFile,
      });
      const ctx = await load("with-creds");
      expect(ctx.connectionOptions.authenticator).toBeDefined();
      // Token / user / pass are NOT set when creds is present.
      expect(ctx.connectionOptions.token).toBeUndefined();
    });

    it("expands `~` in the creds path using $HOME", async () => {
      // Symlink-style trick: pretend $HOME is our tempdir root.
      await writeContext("tilde-creds", {
        url: "nats://localhost:4222",
        creds: "~/prod.creds",
      });
      const ctx = await load("tilde-creds", { HOME: root });
      expect(ctx.connectionOptions.authenticator).toBeDefined();
    });

    it("falls back to user_jwt when no creds file is given", async () => {
      await writeContext("jwt-only", {
        url: "nats://localhost:4222",
        user_jwt: "ey.some.jwt",
      });
      const ctx = await load("jwt-only");
      expect(ctx.connectionOptions.authenticator).toBeDefined();
    });

    it("supports token auth", async () => {
      await writeContext("token-auth", {
        url: "nats://localhost:4222",
        token: "s3cret-token",
      });
      const ctx = await load("token-auth");
      expect(ctx.connectionOptions.token).toBe("s3cret-token");
      expect(ctx.connectionOptions.authenticator).toBeUndefined();
    });

    it("supports user/password auth", async () => {
      await writeContext("userpass", {
        url: "nats://localhost:4222",
        user: "alice",
        password: "hunter2",
      });
      const ctx = await load("userpass");
      expect(ctx.connectionOptions.user).toBe("alice");
      expect(ctx.connectionOptions.pass).toBe("hunter2");
    });

    it("throws NatsContextInvalidError when creds path doesn't exist", async () => {
      await writeContext("bad-creds", {
        url: "nats://localhost:4222",
        creds: "/no/such/path.creds",
      });
      await expect(load("bad-creds")).rejects.toBeInstanceOf(NatsContextInvalidError);
    });
  });

  describe("`current` / true selector", () => {
    it("reads the currently-selected context from context.txt", async () => {
      await writeContext("selected", { url: "nats://selected:4222" });
      await writeFile(selectionFile, "selected\n");
      const ctx = await load("current");
      expect(ctx.name).toBe("selected");
      expect(ctx.servers).toEqual(["nats://selected:4222"]);
    });

    it("`true` is an alias for `current`", async () => {
      await writeContext("selected", { url: "nats://selected:4222" });
      await writeFile(selectionFile, "selected");
      const ctx = await load(true);
      expect(ctx.name).toBe("selected");
    });

    it("$NATS_CONTEXT env var wins over the selection file", async () => {
      await writeContext("env-winner", { url: "nats://env-winner:4222" });
      await writeContext("file-winner", { url: "nats://file-winner:4222" });
      await writeFile(selectionFile, "file-winner");
      const ctx = await load("current", { NATS_CONTEXT: "env-winner" });
      expect(ctx.name).toBe("env-winner");
    });

    it("throws NatsContextNotSelectedError when nothing is selected", async () => {
      await rm(selectionFile, { force: true });
      await expect(load("current")).rejects.toBeInstanceOf(NatsContextNotSelectedError);
    });
  });

  describe("errors", () => {
    it("NatsContextNotFoundError for an unknown name", async () => {
      await expect(load("does-not-exist")).rejects.toBeInstanceOf(NatsContextNotFoundError);
    });

    it("NatsContextInvalidError when the file is not JSON", async () => {
      await writeFile(joinPath(contextDir, "garbage.json"), "<not json>");
      await expect(load("garbage")).rejects.toBeInstanceOf(NatsContextInvalidError);
    });

    it("NatsContextInvalidError when `url` is missing", async () => {
      await writeContext("no-url", { description: "oops" });
      await expect(load("no-url")).rejects.toBeInstanceOf(NatsContextInvalidError);
    });

    it("NatsContextInvalidError when name contains path traversal", async () => {
      await expect(load("../../etc/passwd")).rejects.toBeInstanceOf(NatsContextInvalidError);
    });
  });
});
