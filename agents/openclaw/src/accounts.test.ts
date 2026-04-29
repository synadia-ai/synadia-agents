// Account resolution tests. Requires the `openclaw` peer dependency (for the
// `OpenClawConfig` / `DEFAULT_ACCOUNT_ID` imports transitively pulled by
// `./accounts.js`). Skipped automatically when openclaw isn't resolvable, so
// the protocol tests can still run standalone on a fresh clone.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";

let resolveNatsAccount: typeof import("./accounts.js").resolveNatsAccount;
let listNatsAccountIds: typeof import("./accounts.js").listNatsAccountIds;
let skip = false;
try {
  const mod = await import("./accounts.js");
  resolveNatsAccount = mod.resolveNatsAccount;
  listNatsAccountIds = mod.listNatsAccountIds;
} catch {
  skip = true;
}

describe.skipIf(skip)("account resolution", () => {
  it("returns sensible defaults for empty config (owner falls back to \"default\")", () => {
    const account = resolveNatsAccount({});
    expect(account.url).toBe("");
    expect(account.agentName).toBe("");
    expect(account.description).toBe("");
    expect(account.enabled).toBe(true);
    expect(account.owner).toBe("default");
  });

  it("resolves a configured account using the new 'owner' field", () => {
    const cfg = {
      channels: {
        nats: {
          accounts: {
            default: {
              url: "nats://my-server:4222",
              agentName: "my-agent",
              description: "My agent",
              owner: "acme",
            },
          },
        },
      },
    };
    const account = resolveNatsAccount(cfg, "default");
    expect(account.url).toBe("nats://my-server:4222");
    expect(account.agentName).toBe("my-agent");
    expect(account.description).toBe("My agent");
    expect(account.owner).toBe("acme");
  });

  it("accepts legacy 'org' as an alias for 'owner'", () => {
    const cfg = {
      channels: {
        nats: {
          accounts: {
            default: { agentName: "x", org: "legacy-team" },
          },
        },
      },
    };
    expect(resolveNatsAccount(cfg, "default").owner).toBe("legacy-team");
  });

  it("lists account IDs", () => {
    expect(listNatsAccountIds({}).length).toBeGreaterThan(0);
    const cfg = { channels: { nats: { accounts: { a: {}, b: {} } } } };
    expect(listNatsAccountIds(cfg).sort()).toEqual(["a", "b"]);
  });
});

describe.skipIf(skip)("config.context resolution", () => {
  let baseHome: string;
  let savedHome: string | undefined;
  let savedEnvUrl: string | undefined;
  let savedEnvCreds: string | undefined;
  let savedEnvCtx: string | undefined;

  beforeEach(() => {
    baseHome = mkdtempSync(join(tmpdir(), "openclaw-cfgctx-"));
    mkdirSync(join(baseHome, ".config", "nats", "context"), { recursive: true });
    savedHome = process.env.HOME;
    savedEnvUrl = process.env.NATS_URL;
    savedEnvCreds = process.env.NATS_CREDENTIALS;
    savedEnvCtx = process.env.NATS_CONTEXT;
    process.env.HOME = baseHome;
    delete process.env.NATS_URL;
    delete process.env.NATS_CREDENTIALS;
    delete process.env.NATS_CONTEXT;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedEnvUrl === undefined) delete process.env.NATS_URL;
    else process.env.NATS_URL = savedEnvUrl;
    if (savedEnvCreds === undefined) delete process.env.NATS_CREDENTIALS;
    else process.env.NATS_CREDENTIALS = savedEnvCreds;
    if (savedEnvCtx === undefined) delete process.env.NATS_CONTEXT;
    else process.env.NATS_CONTEXT = savedEnvCtx;
  });

  function writeContext(name: string, body: Record<string, unknown>): void {
    writeFileSync(
      join(baseHome, ".config", "nats", "context", `${name}.json`),
      JSON.stringify(body),
    );
  }

  it("expands config.context into url + credentials", () => {
    writeContext("ngs", {
      url: "tls://connect.ngs.global",
      creds: "/abs/path/to.creds",
    });
    const cfg = {
      channels: { nats: { accounts: { default: { agentName: "x", context: "ngs" } } } },
    };
    const acct = resolveNatsAccount(cfg, "default");
    expect(acct.url).toBe("tls://connect.ngs.global");
    expect(acct.credentials).toBe("/abs/path/to.creds");
  });

  it("$NATS_URL overrides config.context.url (per-field env beats wizard context)", () => {
    writeContext("ngs", { url: "tls://connect.ngs.global", creds: "/c.creds" });
    process.env.NATS_URL = "nats://override.example.com:4222";
    const cfg = {
      channels: { nats: { accounts: { default: { agentName: "x", context: "ngs" } } } },
    };
    const acct = resolveNatsAccount(cfg, "default");
    expect(acct.url).toBe("nats://override.example.com:4222");
    // creds path from the context survives — only the url field was overridden.
    expect(acct.credentials).toBe("/c.creds");
  });

  it("$NATS_CREDENTIALS overrides config.context credentials (per-field env beats wizard context)", () => {
    writeContext("ngs", { url: "tls://connect.ngs.global", creds: "/from-context.creds" });
    process.env.NATS_CREDENTIALS = "/from-env.creds";
    const cfg = {
      channels: { nats: { accounts: { default: { agentName: "x", context: "ngs" } } } },
    };
    const acct = resolveNatsAccount(cfg, "default");
    // url stays from the context — only the credentials field was overridden.
    expect(acct.url).toBe("tls://connect.ngs.global");
    expect(acct.credentials).toBe("/from-env.creds");
  });

  it("$NATS_CONTEXT overrides config.context entirely", () => {
    writeContext("wizard-ctx", { url: "nats://wizard:4222", creds: "/w.creds" });
    writeContext("env-ctx", { url: "tls://env-context:4222", creds: "/e.creds" });
    process.env.NATS_CONTEXT = "env-ctx";
    const cfg = {
      channels: { nats: { accounts: { default: { agentName: "x", context: "wizard-ctx" } } } },
    };
    const acct = resolveNatsAccount(cfg, "default");
    expect(acct.url).toBe("tls://env-context:4222");
    expect(acct.credentials).toBe("/e.creds");
  });

  it("falls back to per-field config when context fails to load", () => {
    const cfg = {
      channels: {
        nats: {
          accounts: {
            default: {
              agentName: "x",
              context: "missing-ctx",
              url: "nats://fallback:4222",
            },
          },
        },
      },
    };
    const acct = resolveNatsAccount(cfg, "default");
    expect(acct.url).toBe("nats://fallback:4222");
  });
});
