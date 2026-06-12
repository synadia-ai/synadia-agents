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

// Identity env vars that influence resolveNatsAccount. Cleared per-test so
// values leaking in from the invoking shell can't skew expectations, and
// restored afterwards.
const IDENTITY_ENV_VARS = [
  "SYNADIA_OPENCLAW_OWNER",
  "SYNADIA_OWNER",
  "NATS_OWNER",
  "NATS_ORG",
  "SYNADIA_OPENCLAW_NAME",
  "SYNADIA_NAME",
  "NATS_AGENT_NAME",
  "NATS_CREDENTIALS",
  "NATS_CREDS",
] as const;

function snapshotIdentityEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const v of IDENTITY_ENV_VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
  return saved;
}

function restoreIdentityEnv(saved: Record<string, string | undefined>): void {
  for (const v of IDENTITY_ENV_VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
}

describe.skipIf(skip)("account resolution", () => {
  let savedIdentity: Record<string, string | undefined>;
  beforeEach(() => {
    savedIdentity = snapshotIdentityEnv();
  });
  afterEach(() => {
    restoreIdentityEnv(savedIdentity);
  });

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

describe.skipIf(skip)("identity env overrides (SYNADIA_* convention)", () => {
  let savedIdentity: Record<string, string | undefined>;
  beforeEach(() => {
    savedIdentity = snapshotIdentityEnv();
  });
  afterEach(() => {
    restoreIdentityEnv(savedIdentity);
  });

  const cfg = {
    channels: {
      nats: {
        accounts: {
          default: {
            agentName: "cfg-name",
            owner: "cfg-owner",
            credentials: "/cfg.creds",
          },
        },
      },
    },
  };

  it("SYNADIA_OPENCLAW_OWNER (per-agent) wins over fleet-wide, legacy, and config", () => {
    process.env.SYNADIA_OPENCLAW_OWNER = "per-agent";
    process.env.SYNADIA_OWNER = "fleet";
    process.env.NATS_OWNER = "legacy";
    expect(resolveNatsAccount(cfg, "default").owner).toBe("per-agent");
  });

  it("SYNADIA_OWNER (fleet-wide) wins over the legacy vars and config", () => {
    process.env.SYNADIA_OWNER = "fleet";
    process.env.NATS_OWNER = "legacy";
    process.env.NATS_ORG = "older";
    expect(resolveNatsAccount(cfg, "default").owner).toBe("fleet");
  });

  it("legacy NATS_OWNER and NATS_ORG keep working below the SYNADIA_* vars", () => {
    process.env.NATS_OWNER = "legacy";
    expect(resolveNatsAccount(cfg, "default").owner).toBe("legacy");
    delete process.env.NATS_OWNER;
    process.env.NATS_ORG = "older";
    expect(resolveNatsAccount(cfg, "default").owner).toBe("older");
  });

  it("agentName: SYNADIA_OPENCLAW_NAME > SYNADIA_NAME > NATS_AGENT_NAME > config", () => {
    expect(resolveNatsAccount(cfg, "default").agentName).toBe("cfg-name");
    process.env.NATS_AGENT_NAME = "legacy-name";
    expect(resolveNatsAccount(cfg, "default").agentName).toBe("legacy-name");
    process.env.SYNADIA_NAME = "fleet-name";
    expect(resolveNatsAccount(cfg, "default").agentName).toBe("fleet-name");
    process.env.SYNADIA_OPENCLAW_NAME = "per-agent-name";
    expect(resolveNatsAccount(cfg, "default").agentName).toBe("per-agent-name");
  });

  it("NATS_CREDS is accepted as an alias when NATS_CREDENTIALS is unset", () => {
    process.env.NATS_CREDS = "/alias.creds";
    expect(resolveNatsAccount(cfg, "default").credentials).toBe("/alias.creds");
  });

  it("NATS_CREDENTIALS (incumbent) wins when both creds vars are set", () => {
    process.env.NATS_CREDENTIALS = "/incumbent.creds";
    process.env.NATS_CREDS = "/alias.creds";
    expect(resolveNatsAccount(cfg, "default").credentials).toBe("/incumbent.creds");
  });
});

describe.skipIf(skip)("config.context resolution", () => {
  let baseHome: string;
  let savedHome: string | undefined;
  let savedEnvUrl: string | undefined;
  let savedEnvCtx: string | undefined;
  let savedIdentity: Record<string, string | undefined>;

  beforeEach(() => {
    baseHome = mkdtempSync(join(tmpdir(), "openclaw-cfgctx-"));
    mkdirSync(join(baseHome, ".config", "nats", "context"), { recursive: true });
    savedHome = process.env.HOME;
    savedEnvUrl = process.env.NATS_URL;
    savedEnvCtx = process.env.NATS_CONTEXT;
    // Also clears NATS_CREDENTIALS / NATS_CREDS, which these tests assert on.
    savedIdentity = snapshotIdentityEnv();
    process.env.HOME = baseHome;
    delete process.env.NATS_URL;
    delete process.env.NATS_CONTEXT;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedEnvUrl === undefined) delete process.env.NATS_URL;
    else process.env.NATS_URL = savedEnvUrl;
    if (savedEnvCtx === undefined) delete process.env.NATS_CONTEXT;
    else process.env.NATS_CONTEXT = savedEnvCtx;
    restoreIdentityEnv(savedIdentity);
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
